import { MonthSchema } from '../../../shared/savings.js';

/**
 * The Savings drill-down's state in the query string (main spec §7): `?tab=settings` for admins,
 * `?month=YYYY-MM` for a past month (a raw key in `parsePanelSearch`, so it's checked here as the
 * URL wrote it). Savings settings also reads Spend's `?bank=` and `?bank_error=` for the Link
 * page's return (`bankReturnFromSearch`, plan decision 16).
 */
export interface SavingsView {
  tab: 'overview' | 'settings';
  month: string | null;
}

export function savingsViewFromSearch(search: Record<string, unknown>): SavingsView {
  const month = typeof search.month === 'string' && MonthSchema.safeParse(search.month).success ? search.month : null;
  return { tab: search.tab === 'settings' ? 'settings' : 'overview', month };
}

/** The query string for a view, without its defaults. */
export function searchForSavingsView(v: SavingsView): Record<string, string> {
  return { ...(v.tab === 'settings' ? { tab: 'settings' } : {}), ...(v.month !== null ? { month: v.month } : {}) };
}
