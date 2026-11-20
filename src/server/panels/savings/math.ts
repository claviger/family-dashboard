import { addDays, daysBetween } from '../../../shared/dates.js';
import { SAVINGS_GRAPH_MONTHS, type BalanceSeries, type MonthBreakdown, type SavingsBalanceSource, type SavingsFlowKind } from '../../../shared/savings.js';

/**
 * The Savings panel's numbers (the Savings spec, "Numbers shown" and "Line graph"; plan decisions
 * 11 and 12). Pure: snapshots and flows in, numbers out. Dates are family-time `YYYY-MM-DD`,
 * months `YYYY-MM`, money whole cents.
 */

/** One day's balance for one account. */
export interface Snapshot {
  date: string;
  cents: number;
  fetchedAt: Date;
  /** Where the balance came from; missing means Plaid's. */
  source?: SavingsBalanceSource;
}

/** One flow, as the numbers need it. `cents` is positive; `kind` says which way. */
export interface FlowPoint {
  date: string;
  kind: SavingsFlowKind;
  cents: number;
}

const EMPTY: MonthBreakdown = { start: null, end: null, depositsCents: null, withdrawalsCents: null, changeCents: null, totalChangeCents: null };

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** The month's first and last day. */
export function monthBounds(month: string): { first: string; last: string } {
  const year = Number(month.slice(0, 4));
  const m = Number(month.slice(5, 7));
  return { first: `${month}-01`, last: `${month}-${String(daysInMonth(year, m)).padStart(2, '0')}` };
}

/** The month `n` months after `month` (negative: before). */
export function addMonths(month: string, n: number): string {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + n;
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** The same day six months before `date`, clamped to that month's length: the graph's range start. */
export function sixMonthsBefore(date: string, months = SAVINGS_GRAPH_MONTHS): string {
  const month = addMonths(date.slice(0, 7), -months);
  const last = Number(monthBounds(month).last.slice(8, 10));
  return `${month}-${String(Math.min(Number(date.slice(8, 10)), last)).padStart(2, '0')}`;
}

/**
 * One account's month (spec "Numbers shown"). `snapshots` sorted oldest first.
 * - Start: the last snapshot dated before the month; in the first month after linking, the first
 *   snapshot in the month (`sinceFirstSnapshot`), and then only flows dated after its day count
 *   (one on that day may already be in the first balance; decision 11).
 * - End ("Now" for the current month): the last snapshot dated in the month. In the current month
 *   (`current`) before its first snapshot (the 1st before the daily job, or a connection that needs
 *   reconnecting), the month holds at the last snapshot before it: start and end are both that
 *   snapshot, and the month's flows so far still count, so the balance change is zero and the flows
 *   show against it until the next snapshot. A past month with no snapshot is empty.
 * - Deposits and withdrawals: the flows dated in the month. When the start snapshot is from before
 *   the previous month (the months between have no snapshot, so no breakdown counted their flows),
 *   every flow dated after the start's day counts instead, so a gap month's deposits don't land in
 *   Market change. Without flows (`flowsAvailable` false), only the total change.
 */
export function monthBreakdown(
  snapshots: readonly Snapshot[],
  flows: readonly FlowPoint[],
  month: string,
  opts: { flowsAvailable: boolean; current: boolean },
): MonthBreakdown {
  const { first, last } = monthBounds(month);
  const inMonth = snapshots.filter((s) => s.date >= first && s.date <= last);
  const before = snapshots.filter((s) => s.date < first).at(-1);
  const endSnap = inMonth.at(-1) ?? (opts.current ? before : undefined);
  if (!endSnap) return { ...EMPTY };
  const startSnap = before ?? inMonth[0]!;
  const sinceFirstSnapshot = before === undefined;
  const start = { cents: startSnap.cents, date: startSnap.date, sinceFirstSnapshot };
  const end = { cents: endSnap.cents, date: endSnap.date, fetchedAt: endSnap.fetchedAt.toISOString(), source: endSnap.source ?? 'plaid' };
  const totalChangeCents = end.cents - start.cents;
  if (!opts.flowsAvailable) return { start, end, depositsCents: null, withdrawalsCents: null, changeCents: null, totalChangeCents };
  // Flows count from the month's first day, or after the start's day when it is in this month
  // (the first month) or before the previous one (a gap).
  const afterStart = sinceFirstSnapshot || start.date.slice(0, 7) < addMonths(month, -1);
  let depositsCents = 0;
  let withdrawalsCents = 0;
  for (const f of flows) {
    if (f.date > last || (afterStart ? f.date <= start.date : f.date < first)) continue;
    if (f.kind === 'deposit') depositsCents += f.cents;
    else withdrawalsCents += f.cents;
  }
  return { start, end, depositsCents, withdrawalsCents, changeCents: totalChangeCents - depositsCents + withdrawalsCents, totalChangeCents };
}

/**
 * The total row (decision 11): start, end, and total change add up over the accounts with data
 * that month; deposits, withdrawals, and change only when every one of them has flows. When any
 * account started that month, the total is "since" the latest of those first snapshots (the day
 * from which every account is in it); otherwise its start's date is the earliest. Its end's date and
 * fetch time are the latest and the oldest of the accounts' (the oldest fetch is what "as of" means
 * for a sum).
 */
export function sumBreakdowns(list: readonly MonthBreakdown[]): MonthBreakdown {
  const withData = list.filter((b) => b.start !== null && b.end !== null);
  if (withData.length === 0) return { ...EMPTY };
  const flows = withData.every((b) => b.depositsCents !== null);
  const sum = (pick: (b: MonthBreakdown) => number) => withData.reduce((n, b) => n + pick(b), 0);
  const starts = withData.map((b) => b.start!);
  const sinceStarts = starts.filter((s) => s.sinceFirstSnapshot);
  const ends = withData.map((b) => b.end!);
  return {
    start: {
      cents: sum((b) => b.start!.cents),
      date: sinceStarts.length > 0 ? sinceStarts.map((s) => s.date).sort().at(-1)! : starts.map((s) => s.date).sort()[0]!,
      sinceFirstSnapshot: sinceStarts.length > 0,
    },
    end: { cents: sum((b) => b.end!.cents), date: ends.map((e) => e.date).sort().at(-1)!, fetchedAt: ends.map((e) => e.fetchedAt).sort()[0]!,
      source: ends.every((e) => e.source === ends[0]!.source) ? ends[0]!.source : 'mixed',
    },
    depositsCents: flows ? sum((b) => b.depositsCents!) : null,
    withdrawalsCents: flows ? sum((b) => b.withdrawalsCents!) : null,
    changeCents: flows ? sum((b) => b.changeCents!) : null,
    totalChangeCents: sum((b) => b.totalChangeCents!),
  };
}

/** One account's flows for the graph (spec "Line graph", flow lines). */
export interface AccountFlows {
  flows: readonly FlowPoint[];
  /** Whether the month's flows are known (the panel's flowsAvailable); an unknown month's flows aren't drawn or paired. */
  known: (month: string) => boolean;
  /** Only flows dated after this day are drawn: the account's first balance (one that day may already be in it, decision 11). */
  after: string | null;
}

/** How many days apart a withdrawal and a deposit of the same amount can be and still be one transfer. */
export const TRANSFER_DAYS = 2;

/**
 * Each day's deposits and withdrawals across `accounts`, `from` through `to`, only days with one,
 * oldest first. A transfer between two of the accounts isn't money in or out of the total: a
 * withdrawal from one and a deposit of the same amount into another within TRANSFER_DAYS are
 * paired, one to one, the nearest dates first (ties: the earlier withdrawal, then the earlier
 * deposit), and left out of both. Pairing looks TRANSFER_DAYS past the window's edges, so half a
 * transfer just inside it isn't drawn.
 */
export function dailyFlows(accounts: readonly AccountFlows[], from: string, to: string): BalanceSeries['flows'] {
  const lo = addDays(from, -TRANSFER_DAYS);
  const hi = addDays(to, TRANSFER_DAYS);
  type Item = { account: number; flow: FlowPoint; paired: boolean; drawn: boolean };
  const items: Item[] = [];
  accounts.forEach((a, account) => {
    for (const flow of a.flows) {
      if (flow.date < lo || flow.date > hi || !a.known(flow.date.slice(0, 7))) continue;
      items.push({ account, flow, paired: false, drawn: a.after === null || flow.date > a.after });
    }
  });
  const deposits = new Map<number, Item[]>();
  for (const it of items) if (it.flow.kind === 'deposit') deposits.set(it.flow.cents, [...(deposits.get(it.flow.cents) ?? []), it]);
  const candidates: { w: Item; d: Item; gap: number }[] = [];
  for (const w of items) {
    if (w.flow.kind !== 'withdrawal') continue;
    for (const d of deposits.get(w.flow.cents) ?? []) {
      const gap = Math.abs(daysBetween(w.flow.date, d.flow.date));
      if (d.account !== w.account && gap <= TRANSFER_DAYS) candidates.push({ w, d, gap });
    }
  }
  const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  candidates.sort((a, b) => a.gap - b.gap || order(a.w.flow.date, b.w.flow.date) || order(a.d.flow.date, b.d.flow.date));
  for (const c of candidates) {
    if (c.w.paired || c.d.paired) continue;
    c.w.paired = true;
    c.d.paired = true;
  }
  const byDay = new Map<string, { date: string; depositCents: number; withdrawalCents: number }>();
  for (const it of items) {
    if (it.paired || !it.drawn || it.flow.date < from || it.flow.date > to) continue;
    const day = byDay.get(it.flow.date) ?? { date: it.flow.date, depositCents: 0, withdrawalCents: 0 };
    if (it.flow.kind === 'deposit') day.depositCents += it.flow.cents;
    else day.withdrawalCents += it.flow.cents;
    byDay.set(it.flow.date, day);
  }
  return [...byDay.values()].filter((d) => d.depositCents > 0 || d.withdrawalCents > 0).sort((a, b) => order(a.date, b.date));
}

/**
 * The graph's series (spec "Line graph", decision 12): the total of `accounts` (each one's
 * snapshots, oldest first) for every day from `months` months (six for the drill-down, one for the
 * home card) before `today` through `today`. A day with no snapshot carries the account's last
 * balance forward, never before its first snapshot. Days before any account's first snapshot
 * aren't points. Snapshots after `today` are ignored. `joins` names (by `nicknames`, parallel to
 * `accounts`) each account whose first snapshot comes after the line's first day, so the graph can
 * say why the total steps up there. `flows` (parallel to `accounts`) gives the line's per-day
 * deposits and withdrawals (dailyFlows), from its first day through today.
 */
export function balanceSeries(
  accounts: readonly (readonly Snapshot[])[],
  today: string,
  nicknames: readonly string[] = [],
  opts: { months?: number; flows?: readonly AccountFlows[] } = {},
): BalanceSeries {
  const rangeStart = sixMonthsBefore(today, opts.months ?? SAVINGS_GRAPH_MONTHS);
  const lists = accounts.map((list) => list.filter((s) => s.date <= today));
  const firsts = lists.flatMap((list) => (list.length > 0 ? [list[0]!.date] : []));
  if (firsts.length === 0) return { points: [], rangeStart, startsOn: null, monthEnds: [], joins: [], flows: [] };
  const earliest = firsts.sort()[0]!;
  const startsOn = earliest > rangeStart ? earliest : rangeStart;

  const index = lists.map(() => -1);
  const advance = (day: string) => {
    lists.forEach((list, i) => {
      while (index[i]! + 1 < list.length && list[index[i]! + 1]!.date <= day) index[i]!++;
    });
  };
  // Bring every account up to the day before the first point, so carry-forward starts right.
  advance(addDays(startsOn, -1));
  const points: BalanceSeries['points'] = [];
  for (let day = startsOn; day <= today; day = addDays(day, 1)) {
    advance(day);
    let cents = 0;
    let any = false;
    lists.forEach((list, i) => {
      if (index[i]! >= 0) {
        cents += list[index[i]!]!.cents;
        any = true;
      }
    });
    if (any) points.push({ date: day, cents });
  }

  const monthEnds: BalanceSeries['monthEnds'] = [];
  for (const p of points) {
    const month = p.date.slice(0, 7);
    const lastSeen = monthEnds.at(-1);
    if (lastSeen?.month === month) {
      lastSeen.date = p.date;
      lastSeen.cents = p.cents;
    } else {
      monthEnds.push({ month, date: p.date, cents: p.cents });
    }
  }
  // An account whose first balance comes after the line starts steps the total up that day (its first balance).
  const first = points[0]?.date ?? null;
  const joins: BalanceSeries['joins'] = first === null ? [] : lists
    .flatMap((list, i) => (list.length > 0 && list[0]!.date > first ? [{ date: list[0]!.date, nickname: nicknames[i] ?? '' }] : []))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const flows = first === null || !opts.flows ? [] : dailyFlows(opts.flows, first, today);
  return { points, rangeStart, startsOn: first, monthEnds, joins, flows };
}
