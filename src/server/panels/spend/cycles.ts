import { addDays, daysBetween } from '../../../shared/dates.js';

/**
 * Billing cycles (spec §12.4). Pure; every date is a family-local YYYY-MM-DD.
 *
 * - Known closing dates are `manual` (an admin's) or `plaid` (phase 6b). A manual date wins over a
 *   Plaid one on the same day.
 * - Inferred dates are the usual closing day in every month, clamped to the month's length (the 31st
 *   is Feb 28 or 29, Apr 30). Each known date replaces the one inferred date nearest it, if that's
 *   within `INFERRED_MIN_GAP_DAYS`: that statement is already known. Only one, so a known date never
 *   swallows two statements. So inferred dates fill the time before the first known date (back to
 *   the earliest transaction), every gap between known dates, and the time since the last one.
 *   They're computed each time, never stored, so changing the usual day changes them all.
 * - With no usual day set, the day of the latest known date is used. With neither, transactions are
 *   grouped by calendar month (`mode: 'calendar_month'`), and the UI says why.
 * - A cycle runs from the day after one closing date through the next, inclusive. The current cycle
 *   is the one containing today; its `end` is the next closing date (it may be after today). There
 *   always is one: inferred dates run two months past today, and a known date replaces only one.
 * - The cycles listed run from the one containing the earliest transaction to the one containing the
 *   later of today and the latest transaction, so a transaction dated tomorrow still has a cycle.
 */

export const INFERRED_MIN_GAP_DAYS = 15;

export type ClosingSource = 'plaid' | 'manual' | 'inferred';
export interface Closing {
  date: string;
  source: ClosingSource;
}

export interface Cycle {
  start: string;
  end: string;
  /** The closing date that ends it; null for a calendar month. */
  closing: Closing | null;
  current: boolean;
}

export type CyclePlan =
  | { mode: 'cycles'; closingDay: number; closings: Closing[]; cycles: Cycle[] }
  | { mode: 'calendar_month'; closingDay: null; closings: Closing[]; cycles: Cycle[] };

export interface CycleInput {
  usualClosingDay: number | null;
  known: readonly { date: string; source: 'plaid' | 'manual' }[];
  /** The card's earliest transaction date, or null when it has none. */
  earliestDate: string | null;
  /** The card's latest transaction date, or null when it has none (then it's today). */
  latestDate: string | null;
  today: string;
}

function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** `day` in the given month (1 to 12), clamped to the month's length. */
export function clampedDate(year: number, month: number, day: number): string {
  const d = Math.min(day, lastDayOfMonth(year, month));
  return `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** [year, month] of a YYYY-MM-DD date, moved by `n` months. */
function monthOf(date: string, n = 0): [number, number] {
  const total = Number(date.slice(0, 4)) * 12 + (Number(date.slice(5, 7)) - 1) + n;
  return [Math.floor(total / 12), (total % 12) + 1];
}

function monthsBetween(from: string, to: string): number {
  const [fy, fm] = monthOf(from);
  const [ty, tm] = monthOf(to);
  return (ty - fy) * 12 + (tm - fm);
}

/** Known dates without repeats; manual wins over Plaid on the same day. Sorted. */
function knownClosings(known: CycleInput['known']): Closing[] {
  const byDate = new Map<string, Closing>();
  for (const k of known) {
    const had = byDate.get(k.date);
    if (!had || k.source === 'manual') byDate.set(k.date, { date: k.date, source: k.source });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

export function planCycles(input: CycleInput): CyclePlan {
  const { today } = input;
  const known = knownClosings(input.known);
  const first = [input.earliestDate ?? today, today].sort()[0]!;
  const last = [input.latestDate ?? today, today].sort()[1]!;
  const day = input.usualClosingDay ?? (known.length > 0 ? Number(known.at(-1)!.date.slice(8, 10)) : null);

  if (day === null) {
    const cycles: Cycle[] = [];
    for (let n = 0; n <= monthsBetween(first, last); n++) {
      const [y, m] = monthOf(first, n);
      const start = clampedDate(y, m, 1);
      const end = clampedDate(y, m, 31);
      cycles.push({ start, end, closing: null, current: start <= today && today <= end });
    }
    return { mode: 'calendar_month', closingDay: null, closings: [], cycles: cycles.reverse() };
  }

  // Two months before the earliest date (and before the first known one) to two months after the
  // later of today and the latest transaction, so there's always a closing before the first
  // transaction and one on or after the last.
  const from = [first, known[0]?.date ?? first].sort()[0]!;
  const inferred: Closing[] = [];
  for (let n = -2; n <= monthsBetween(from, last) + 2; n++) {
    const [y, m] = monthOf(from, n);
    inferred.push({ date: clampedDate(y, m, day), source: 'inferred' });
  }
  // Each known date replaces only the inferred date nearest it (the earlier on a tie), if within reach.
  for (const k of known) {
    let nearest = -1;
    for (let i = 0; i < inferred.length; i++) {
      const gap = Math.abs(daysBetween(inferred[i]!.date, k.date));
      if (gap <= INFERRED_MIN_GAP_DAYS && (nearest === -1 || gap < Math.abs(daysBetween(inferred[nearest]!.date, k.date)))) nearest = i;
    }
    if (nearest !== -1) inferred.splice(nearest, 1);
  }
  const closings = [...known, ...inferred].sort((a, b) => a.date.localeCompare(b.date));

  const cycles: Cycle[] = [];
  for (let i = 1; i < closings.length; i++) {
    const start = addDays(closings[i - 1]!.date, 1);
    const end = closings[i]!.date;
    if (end < first || start > last) continue;
    cycles.push({ start, end, closing: closings[i]!, current: start <= today && today <= end });
  }
  return { mode: 'cycles', closingDay: day, closings, cycles: cycles.reverse() };
}

/** The cycle that contains `date`, or null. */
export function cycleContaining(plan: CyclePlan, date: string): Cycle | null {
  return plan.cycles.find((c) => c.start <= date && date <= c.end) ?? null;
}

/** The cycle before `cycle` in the plan (cycles are newest first), or null. */
export function previousCycle(plan: CyclePlan, cycle: Cycle): Cycle | null {
  const i = plan.cycles.findIndex((c) => c.start === cycle.start);
  return i === -1 ? null : (plan.cycles[i + 1] ?? null);
}
