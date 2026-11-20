import { defaultParseSearch, defaultStringifySearch } from '@tanstack/react-router';

/**
 * Drill-down state in the query string (spec §7). `userId` is the To-do admin person picker.
 * Other keys pass through untouched, so later panels can add their own (e.g. Spend's card and cycle).
 */
export type PanelSearch = Record<string, unknown> & { userId?: number };

/**
 * Keys whose value stays the raw URL text, so the code that owns them can check them strictly:
 * `userId` (below), the Chores History filters (`historyFilterFromSearch`) and Board filter
 * (`boardWhoFromSearch`), the Calendar's
 * view, day, and open event (`viewFromSearch` and `openEventId`; an event id can look like a
 * number), the home Calendar card's open event (`calendarEvent`, named for its panel because
 * every card shares the home page's query string), Spend's card, cycle, category, and the
 * table's sort and its direction (`spendViewFromSearch`), the Savings drill-down's month
 * (`savingsViewFromSearch`), and the bank and link error the Link page comes back with
 * (`bankReturnFromSearch`).
 */
const RAW_KEYS = ['userId', 'person', 'range', 'from', 'to', 'choreId', 'skipped', 'who', 'view', 'date', 'event', 'calendarEvent', 'card', 'cycle', 'category', 'sort', 'dir', 'month', 'bank', 'bank_error'];

/**
 * The router's `parseSearch`: the default JSON parsing for every key except the `RAW_KEYS`, each of
 * which stays the raw URL text when it appears once. The default would turn " 7", "1e3", and
 * "1.0" into numbers and '"x"' into x, hiding them from the strict checks.
 */
export function parsePanelSearch(searchStr: string): Record<string, unknown> {
  const parsed: Record<string, unknown> = { ...defaultParseSearch(searchStr) };
  const params = new URLSearchParams(searchStr.startsWith('?') ? searchStr.slice(1) : searchStr);
  for (const key of RAW_KEYS) {
    const raw = params.getAll(key);
    if (raw.length === 1) parsed[key] = raw[0];
  }
  return parsed;
}

/**
 * The router's `stringifySearch`, the other half of `parsePanelSearch`: a `RAW_KEYS` value that's
 * text is written as that text. The default would write a text value that looks like JSON in
 * quotes (an event id "1e3" as `%221e3%22`), which `parsePanelSearch` would then read back with
 * the quotes. Every other value is written as the default writes it, and the keys keep their order.
 */
export function stringifyPanelSearch(search: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (value === undefined) continue;
    if (typeof value === 'string' && RAW_KEYS.includes(key)) {
      params.set(key, value);
      continue;
    }
    const written = new URLSearchParams(defaultStringifySearch({ [key]: value })).get(key);
    if (written !== null) params.set(key, written);
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

/**
 * Keeps `userId` only when it is a plain positive safe integer: `/^\d+$/`, so not "1e3", " 7",
 * "0x1f", or "-1". From the URL it arrives as a string (see `parsePanelSearch`); from
 * `navigate({ search })` it may be a number.
 */
export function validatePanelSearch(search: Record<string, unknown>): PanelSearch {
  const { userId: raw, ...rest } = search;
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw : '';
  if (!/^\d+$/.test(text)) return rest;
  const userId = Number(text);
  return Number.isSafeInteger(userId) && userId > 0 ? { ...rest, userId } : rest;
}
