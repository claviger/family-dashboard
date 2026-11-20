import { describe, expect, it } from 'vitest';
import type { SpendTransaction } from '../../../shared/spend.js';
import { parsePanelSearch } from '../../panelSearch.js';
import {
  bankReturnFromSearch, DEFAULT_SORT, filterTransactions, nextSort, searchForView, sortTransactions, spendViewFromSearch, type SpendView, type TransactionSort,
} from './spendSearch.js';

const DEFAULT: SpendView = { tab: 'overview', card: null, cycle: null, person: null, category: null, q: '', sort: DEFAULT_SORT };

describe('spendViewFromSearch', () => {
  it('reads every key, as the URL gives them', () => {
    expect(spendViewFromSearch({ tab: 'settings', card: '3', cycle: '2026-10-16', person: '7', category: '12', q: 'coffee', sort: 'amount', dir: 'asc' })).toEqual({
      tab: 'settings', card: 3, cycle: '2026-10-16', person: 7, category: 12, q: 'coffee', sort: { by: 'amount', dir: 'asc' },
    });
    // A column without a direction takes its own first direction.
    expect(spendViewFromSearch({ sort: 'name' }).sort).toEqual({ by: 'name', dir: 'asc' });
    expect(spendViewFromSearch({ dir: 'asc' }).sort).toEqual({ by: 'date', dir: 'asc' });
    expect(spendViewFromSearch(parsePanelSearch('?sort=amount&dir=desc')).sort).toEqual({ by: 'amount', dir: 'desc' });
    expect(spendViewFromSearch({ person: 'household' }).person).toBe('household');
  });

  it.each([
    [{ card: '1e3' }],
    [{ card: ' 3' }],
    [{ card: '0' }],
    [{ card: '-1' }],
    [{ cycle: '2026-02-30' }],
    [{ cycle: 20261016 }],
    [{ person: 'everyone' }],
    [{ category: '1.0' }],
    [{ tab: 'history' }],
    [{ q: true }],
    [{ sort: 'merchant' }],
    [{ sort: 'Amount' }],
    [{ sort: ['amount'] }],
    [{ dir: 'up' }],
    [{ dir: 'DESC' }],
  ])('drops what does not pass: %j', (search) => {
    expect(spendViewFromSearch(search)).toEqual(DEFAULT);
  });

  it('keeps the search to 100 characters, and takes one the router read as a number as text', () => {
    expect(spendViewFromSearch({ q: 'x'.repeat(150) }).q).toHaveLength(100);
    expect(spendViewFromSearch({ q: 42 }).q).toBe('42');
  });

  it('round-trips through searchForView, leaving out defaults, with ids as numbers', () => {
    const v: SpendView = { tab: 'settings', card: 3, cycle: '2026-10-16', person: 'household', category: 12, q: 'rei', sort: { by: 'name', dir: 'desc' } };
    expect(searchForView(v)).toEqual({ tab: 'settings', card: 3, cycle: '2026-10-16', person: 'household', category: 12, q: 'rei', sort: 'name', dir: 'desc' });
    // A column's own first direction isn't written.
    expect(searchForView({ ...DEFAULT, sort: { by: 'amount', dir: 'desc' } })).toEqual({ sort: 'amount' });
    expect(searchForView({ ...DEFAULT, sort: { by: 'date', dir: 'asc' } })).toEqual({ dir: 'asc' });
    for (const sort of [{ by: 'amount', dir: 'asc' }, { by: 'name', dir: 'asc' }, { by: 'date', dir: 'asc' }] as TransactionSort[]) {
      expect(spendViewFromSearch(parsePanelSearch(`?${new URLSearchParams(searchForView({ ...DEFAULT, sort }) as Record<string, string>)}`)).sort).toEqual(sort);
    }
    expect(searchForView({ ...v, person: 7 }).person).toBe(7);
    expect(spendViewFromSearch(searchForView(v))).toEqual(v);
    expect(searchForView(DEFAULT)).toEqual({});
  });
});

describe('bankReturnFromSearch', () => {
  it('reads the bank and the link error the Link page came back with', () => {
    expect(bankReturnFromSearch(parsePanelSearch('?tab=settings&bank=12'))).toEqual({ bank: 12, bankError: null });
    expect(bankReturnFromSearch(parsePanelSearch('?tab=settings&bank_error=trial_limit'))).toEqual({ bank: null, bankError: 'trial_limit' });
    // Update mode's finish found a sync holding the bank (the Link page's 503).
    expect(bankReturnFromSearch(parsePanelSearch('?tab=settings&bank_error=busy'))).toEqual({ bank: null, bankError: 'busy' });
  });

  it.each(['?bank=1e3', '?bank=%207', '?bank=0', '?bank=-1', '?bank=1.0', '?bank_error=nope', '?bank_error=toString', '?bank_error=1', '?bank=1&bank=2'])(
    'drops what does not pass: %s',
    (searchStr) => {
      expect(bankReturnFromSearch(parsePanelSearch(searchStr))).toEqual({ bank: null, bankError: null });
    },
  );

  it("isn't part of the view, so links built from the view leave it out", () => {
    expect(searchForView(spendViewFromSearch(parsePanelSearch('?tab=settings&bank=12&bank_error=failed')))).toEqual({ tab: 'settings' });
  });
});

describe('filterTransactions', () => {
  const kid = { id: 7, displayName: 'Kid', color: '#000', active: true };
  const cat = (id: number) => ({ id, name: `C${id}`, kind: 'normal' as const, archived: false });
  const t = (id: number, patch: Partial<SpendTransaction>): SpendTransaction => ({
    id, cardId: 1, source: 'csv', date: '2026-11-01', merchant: 'SHOP', rawName: 'SHOP', amountCents: 100, currency: 'USD', pending: false,
    category: cat(1), categorySource: 'default', person: null, personSource: 'default', note: null, twinIds: [], ...patch,
  });
  const rows = [t(1, { merchant: 'Blue Bottle', rawName: 'BLUE BOTTLE COFFEE OAKLAND' }), t(2, { person: kid, category: cat(2) }), t(3, { category: cat(2), rawName: 'REI #12', merchant: 'REI #12' })];
  const ids = (v: Partial<SpendView>) => filterTransactions(rows, { ...DEFAULT, ...v }).map((r) => r.id);

  it('filters by person, Household, category, and merchant text in either name, ignoring case', () => {
    expect(ids({})).toEqual([1, 2, 3]);
    expect(ids({ person: 7 })).toEqual([2]);
    expect(ids({ person: 'household' })).toEqual([1, 3]);
    expect(ids({ category: 2 })).toEqual([2, 3]);
    expect(ids({ category: 2, person: 'household' })).toEqual([3]);
    expect(ids({ q: '  oakland ' })).toEqual([1]);
    expect(ids({ q: 'rei' })).toEqual([3]);
  });
});

describe('sortTransactions', () => {
  const cat = { id: 1, name: 'C', kind: 'normal' as const, archived: false };
  const t = (id: number, date: string, merchant: string, amountCents: number): SpendTransaction => ({
    id, cardId: 1, source: 'csv', date, merchant, rawName: merchant.toUpperCase(), amountCents, currency: 'USD', pending: false,
    category: cat, categorySource: 'default', person: null, personSource: 'default', note: null, twinIds: [],
  });
  const rows = [
    t(1, '2026-11-02', "McDonald's", 1099),
    t(2, '2026-11-03', 'apple', 500),
    t(3, '2026-11-02', 'McDonalds 5795 142-5483579 W', 1099),
    t(4, '2026-11-01', 'Zeta', 1099),
    t(5, '2026-11-03', 'Apple', -500),
  ];
  const ids = (sort: TransactionSort) => sortTransactions(rows, sort).map((r) => r.id);

  it('sorts by date, newest first by default, ties by id the same way', () => {
    expect(ids(DEFAULT_SORT)).toEqual([5, 2, 3, 1, 4]);
    expect(ids({ by: 'date', dir: 'asc' })).toEqual([4, 1, 3, 2, 5]);
  });

  it('sorts by amount, so twins (same date and amount) sit together, then by date and id', () => {
    expect(ids({ by: 'amount', dir: 'desc' })).toEqual([3, 1, 4, 2, 5]);
    // Within a tie, newest first whichever way: the same order as the default.
    expect(ids({ by: 'amount', dir: 'asc' })).toEqual([5, 2, 3, 1, 4]);
  });

  it('sorts by name ignoring case, ties by date then id', () => {
    expect(ids({ by: 'name', dir: 'asc' })).toEqual([5, 2, 1, 3, 4]);
    expect(ids({ by: 'name', dir: 'desc' })).toEqual([4, 3, 1, 5, 2]);
  });

  it("doesn't change the rows it's given", () => {
    sortTransactions(rows, { by: 'amount', dir: 'asc' });
    expect(rows.map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe('nextSort', () => {
  it('turns the column around when it is the one sorted, else starts it in its own first direction', () => {
    expect(nextSort(DEFAULT_SORT, 'date')).toEqual({ by: 'date', dir: 'asc' });
    expect(nextSort({ by: 'date', dir: 'asc' }, 'date')).toEqual({ by: 'date', dir: 'desc' });
    expect(nextSort(DEFAULT_SORT, 'name')).toEqual({ by: 'name', dir: 'asc' });
    expect(nextSort(DEFAULT_SORT, 'amount')).toEqual({ by: 'amount', dir: 'desc' });
    expect(nextSort({ by: 'amount', dir: 'desc' }, 'amount')).toEqual({ by: 'amount', dir: 'asc' });
  });
});
