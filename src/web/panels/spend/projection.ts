import type { SpendCycle } from '../../../shared/spend.js';
import { money, shortDate } from './format.js';

/**
 * "On track for $X by <end>" (spec §12.11, §12.12). Pure, so it's unit-tested. At the current
 * rate: spent so far ÷ days elapsed (today counts, on the family's calendar) × days in the cycle.
 * Dates are family-local YYYY-MM-DD strings; the cycle's start and end both count as days.
 *
 * Null (nothing to show) when:
 * - the cycle isn't the current one, or today isn't inside it;
 * - it's the cycle's first day: one day's spending times thirty is noise, not a forecast;
 * - nothing has been spent (zero, or more credits than spending): there's no rate to project.
 */
export function projectedCents(cycle: Pick<SpendCycle, 'start' | 'end' | 'current'>, today: string, totalCents: number): number | null {
  if (!cycle.current || today < cycle.start || today > cycle.end) return null;
  if (totalCents <= 0) return null;
  const elapsed = daysBetween(cycle.start, today) + 1;
  if (elapsed < 2) return null;
  const length = daysBetween(cycle.start, cycle.end) + 1;
  return Math.round((totalCents / elapsed) * length);
}

/** "On track for $1,234.56 by Dec 15", or null when projectedCents is. */
export function onTrackLine(cycle: Pick<SpendCycle, 'start' | 'end' | 'current'>, today: string, totalCents: number, currency = 'USD'): string | null {
  const cents = projectedCents(cycle, today, totalCents);
  return cents === null ? null : `On track for ${money(cents, currency)} by ${shortDate(cycle.end)}`;
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
