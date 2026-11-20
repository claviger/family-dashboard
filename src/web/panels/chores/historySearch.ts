import { HISTORY_RANGES, type HistoryRange } from '../../../shared/chores.js';
import { isLocalDate } from '../../../shared/dates.js';

/** The History tab's filters (spec §11.7). `from` and `to` are '' until picked. */
export interface HistoryFilter {
  person: 'all' | number;
  range: HistoryRange;
  from: string;
  to: string;
  choreId: number | null;
  skipped: boolean;
}

/** The query-string keys the History tab owns, next to `?tab=history`. */
export const HISTORY_SEARCH_KEYS = ['person', 'range', 'from', 'to', 'choreId', 'skipped'] as const;

export function defaultHistoryFilter(meId: number): HistoryFilter {
  return { person: meId, range: 'last_30_days', from: '', to: '', choreId: null, skipped: true };
}

/**
 * A positive safe integer id: a number, or plain digits as the URL gives them (see
 * `parsePanelSearch`). Not "1e3", " 7", "0x1f", "1.0", or "-1".
 */
function idFrom(raw: unknown): number | null {
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw : '';
  if (!/^\d+$/.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function dateFrom(raw: unknown): string {
  return typeof raw === 'string' && isLocalDate(raw) ? raw : '';
}

/**
 * Reads the History filters from the drill-down's search params (spec §7), so they survive reloads
 * and back/forward. Each value is checked strictly, and one that doesn't pass falls back to its
 * default: you, the last 30 days, all chores, skips shown. The dates count only for a custom range,
 * and are both dropped if the start is after the end.
 */
export function historyFilterFromSearch(search: Record<string, unknown>, meId: number): HistoryFilter {
  const f = defaultHistoryFilter(meId);
  if (search.person === 'all') f.person = 'all';
  else f.person = idFrom(search.person) ?? f.person;
  if (typeof search.range === 'string' && (HISTORY_RANGES as readonly string[]).includes(search.range)) {
    f.range = search.range as HistoryRange;
  }
  if (f.range === 'custom') {
    const from = dateFrom(search.from);
    const to = dateFrom(search.to);
    if (from === '' || to === '' || from <= to) {
      f.from = from;
      f.to = to;
    }
  }
  f.choreId = idFrom(search.choreId);
  if (search.skipped === false || search.skipped === 'false') f.skipped = false;
  return f;
}

/**
 * The search params for `filter`, to spread over the current ones (other keys, such as `tab`, are
 * left alone). Defaults come out as `undefined`, which drops them from the URL.
 */
export function historySearchFor(filter: HistoryFilter, meId: number): Record<(typeof HISTORY_SEARCH_KEYS)[number], unknown> {
  const d = defaultHistoryFilter(meId);
  const custom = filter.range === 'custom';
  return {
    person: filter.person === d.person ? undefined : filter.person,
    range: filter.range === d.range ? undefined : filter.range,
    from: custom && filter.from !== '' ? filter.from : undefined,
    to: custom && filter.to !== '' ? filter.to : undefined,
    choreId: filter.choreId ?? undefined,
    skipped: filter.skipped ? undefined : false,
  };
}
