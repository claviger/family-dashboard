import { isLocalDate } from '../../../shared/dates.js';
import { PLAID_LINK_ERRORS, type PlaidLinkError } from '../../../shared/plaid.js';
import type { SpendTransaction } from '../../../shared/spend.js';

/**
 * The drill-down's state in the query string (spec §7: `/spend?card=…&cycle=…`): the tab, the
 * card and cycle, and the table's filters. Each value is checked strictly, and one that doesn't
 * pass is dropped, so an old or edited link still opens.
 */
export interface SpendView {
  tab: 'overview' | 'settings';
  card: number | null;
  /** A cycle's start date. */
  cycle: string | null;
  /** Household, a person's id, or null for everyone. */
  person: 'household' | number | null;
  category: number | null;
  /** Merchant search, as typed. */
  q: string;
  /** How the table is sorted (`?sort=` and `?dir=`). */
  sort: TransactionSort;
}

export const SORT_COLUMNS = ['date', 'name', 'amount'] as const;
export type SortColumn = (typeof SORT_COLUMNS)[number];
export type SortDirection = 'asc' | 'desc';
export interface TransactionSort {
  by: SortColumn;
  dir: SortDirection;
}

/** Each column's first direction when it's picked: newest first, A to Z, biggest first. */
export const FIRST_DIRECTION: Record<SortColumn, SortDirection> = { date: 'desc', name: 'asc', amount: 'desc' };

/** As the table has always been: newest first. */
export const DEFAULT_SORT: TransactionSort = { by: 'date', dir: 'desc' };

export const SEARCH_MAX = 100;

/** A positive safe integer: a number, or plain digits as the URL gives them. */
function idFrom(raw: unknown): number | null {
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw : '';
  if (!/^\d+$/.test(text)) return null;
  const id = Number(text);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function spendViewFromSearch(search: Record<string, unknown>): SpendView {
  return {
    tab: search.tab === 'settings' ? 'settings' : 'overview',
    card: idFrom(search.card),
    cycle: typeof search.cycle === 'string' && isLocalDate(search.cycle) ? search.cycle : null,
    person: search.person === 'household' ? 'household' : idFrom(search.person),
    category: idFrom(search.category),
    // The router's own parsing gives text back as text (a search for "123" is written as "%22123%22").
    q: typeof search.q === 'string' ? search.q.slice(0, SEARCH_MAX) : typeof search.q === 'number' ? String(search.q) : '',
    sort: sortFromSearch(search),
  };
}

/** `?sort=` is one of the columns exactly (date when it isn't), and `?dir=` asc or desc (the column's first direction when it isn't). */
function sortFromSearch(search: Record<string, unknown>): TransactionSort {
  const by = (SORT_COLUMNS as readonly unknown[]).includes(search.sort) ? (search.sort as SortColumn) : 'date';
  const dir = search.dir === 'asc' || search.dir === 'desc' ? search.dir : FIRST_DIRECTION[by];
  return { by, dir };
}

/**
 * Where the Link page sent the admin back to Spend settings (the design's departure 11):
 * `?bank=<id>` after a link or reconnect, which opens that bank's pick, or `?bank_error=<code>`,
 * whose message is shown. Both are checked strictly, like the view's keys: an id that isn't plain
 * digits, or a code that isn't one of `PLAID_LINK_ERRORS`, is dropped. They aren't part of the
 * view: Spend settings reads them once and takes them out of the URL.
 */
export function bankReturnFromSearch(search: Record<string, unknown>): { bank: number | null; bankError: PlaidLinkError | null } {
  const code = search.bank_error;
  return {
    bank: idFrom(search.bank),
    bankError: typeof code === 'string' && Object.hasOwn(PLAID_LINK_ERRORS, code) ? (code as PlaidLinkError) : null,
  };
}

/**
 * The search params for a view, leaving out what's at its default. Ids stay numbers. Card, cycle,
 * person, and category are written as raw text either way (`stringifyPanelSearch`); `q` isn't, so
 * a search for "123" is written in quotes and read back as text.
 */
export function searchForView(v: SpendView): Record<string, string | number> {
  const s: Record<string, string | number> = {};
  if (v.tab === 'settings') s.tab = 'settings';
  if (v.card !== null) s.card = v.card;
  if (v.cycle !== null) s.cycle = v.cycle;
  if (v.person !== null) s.person = v.person;
  if (v.category !== null) s.category = v.category;
  if (v.q !== '') s.q = v.q;
  if (v.sort.by !== 'date') s.sort = v.sort.by;
  if (v.sort.dir !== FIRST_DIRECTION[v.sort.by]) s.dir = v.sort.dir;
  return s;
}

/** Clicking a column's header: the column sorted turns around; another starts in its first direction. */
export function nextSort(current: TransactionSort, by: SortColumn): TransactionSort {
  if (current.by === by) return { by, dir: current.dir === 'asc' ? 'desc' : 'asc' };
  return { by, dir: FIRST_DIRECTION[by] };
}

const names = new Intl.Collator('en', { sensitivity: 'accent', numeric: true });

/**
 * The table's order (spec §12.12), over every row the filters keep (the drill-down has the whole
 * cycle, so this is all of them). Date sorts by date, then id, the same way. Name (the merchant, or
 * the raw name when there's none, ignoring case) and Amount break ties newest first, then by id, so
 * the order is stable and twins (same date and amount) sit together. A new array.
 */
export function sortTransactions(rows: readonly SpendTransaction[], sort: TransactionSort): SpendTransaction[] {
  const sign = sort.dir === 'asc' ? 1 : -1;
  const newest = (a: SpendTransaction, b: SpendTransaction) => b.date.localeCompare(a.date) || b.id - a.id;
  const compare = (a: SpendTransaction, b: SpendTransaction): number => {
    switch (sort.by) {
      case 'date':
        return sign * (a.date.localeCompare(b.date) || a.id - b.id);
      case 'name':
        return sign * names.compare(a.merchant || a.rawName, b.merchant || b.rawName) || newest(a, b);
      case 'amount':
        return sign * (a.amountCents - b.amountCents) || newest(a, b);
    }
  };
  return [...rows].sort(compare);
}

/** The table's filters (spec §12.12): person, category, and merchant search, ignoring case. */
export function filterTransactions(rows: readonly SpendTransaction[], v: Pick<SpendView, 'person' | 'category' | 'q'>): SpendTransaction[] {
  const q = v.q.trim().toLowerCase();
  return rows.filter((t) => {
    if (v.person === 'household' && t.person !== null) return false;
    if (typeof v.person === 'number' && t.person?.id !== v.person) return false;
    if (v.category !== null && t.category.id !== v.category) return false;
    if (q !== '' && !t.merchant.toLowerCase().includes(q) && !t.rawName.toLowerCase().includes(q)) return false;
    return true;
  });
}
