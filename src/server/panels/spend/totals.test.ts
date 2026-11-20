import { describe, expect, it } from 'vitest';
import { compareBreakdown, totalsOf, type TotalsRow } from './totals.js';

const GROCERIES = 1;
const DINING = 2;
const PAYMENTS = 15;
const KID = 7;

function row(amountCents: number, patch: Partial<TotalsRow> = {}): TotalsRow {
  return { amountCents, categoryId: GROCERIES, personUserId: null, pending: false, currency: 'USD', ...patch };
}

describe('totalsOf', () => {
  const excluded = new Set([PAYMENTS]);

  it('adds up spend by category and person, with refunds subtracting', () => {
    const t = totalsOf(
      [row(10_000), row(-2_500), row(4_000, { categoryId: DINING, personUserId: KID }), row(1_000, { personUserId: KID })],
      { excludedCategoryIds: excluded },
    );
    expect(t.totalCents).toBe(12_500);
    expect([...t.byCategory]).toEqual([[GROCERIES, 8_500], [DINING, 4_000]]);
    expect([...t.byPerson]).toEqual([[null, 7_500], [KID, 5_000]]);
  });

  it('leaves out Payments and transfers entirely', () => {
    const t = totalsOf([row(10_000), row(-50_000, { categoryId: PAYMENTS }), row(20_000, { categoryId: PAYMENTS, personUserId: KID })], {
      excludedCategoryIds: excluded,
    });
    expect(t.totalCents).toBe(10_000);
    expect(t.byCategory.has(PAYMENTS)).toBe(false);
    expect(t.byPerson.has(KID)).toBe(false);
  });

  it('counts pending transactions, and reports their share', () => {
    const t = totalsOf([row(10_000), row(3_000, { pending: true })], { excludedCategoryIds: excluded });
    expect(t.totalCents).toBe(13_000);
    expect(t.pendingCents).toBe(3_000);
  });

  it('leaves out other currencies and counts them; a missing currency is USD', () => {
    const t = totalsOf([row(1_000, { currency: null }), row(5_000, { currency: 'EUR' })], { excludedCategoryIds: excluded });
    expect(t.totalCents).toBe(1_000);
    expect(t.otherCurrencyCount).toBe(1);
    expect(totalsOf([row(5_000, { currency: 'EUR' })], { excludedCategoryIds: excluded, currency: 'EUR' }).totalCents).toBe(5_000);
  });

  it('is zero for nothing', () => {
    expect(totalsOf([], { excludedCategoryIds: excluded })).toEqual({
      totalCents: 0, pendingCents: 0, byCategory: new Map(), byPerson: new Map(), otherCurrencyCount: 0,
    });
  });

  it('is exact over many cents', () => {
    const rows = Array.from({ length: 10_000 }, () => row(1));
    expect(totalsOf(rows, { excludedCategoryIds: excluded }).totalCents).toBe(10_000);
  });
});

describe('compareBreakdown', () => {
  it('lists every key in either cycle, largest first, then by the previous amount', () => {
    const current = new Map([[GROCERIES, 5_000], [DINING, 9_000], [3, 0]]);
    const previous = new Map([[GROCERIES, 4_000], [4, 2_000], [3, 100]]);
    expect(compareBreakdown(current, previous)).toEqual([
      { key: DINING, cents: 9_000, previousCents: 0 },
      { key: GROCERIES, cents: 5_000, previousCents: 4_000 },
      { key: 4, cents: 0, previousCents: 2_000 },
      { key: 3, cents: 0, previousCents: 100 },
    ]);
  });

  it('keeps Household as its own key', () => {
    expect(compareBreakdown(new Map([[null, 1]]), new Map([[KID, 2]]))).toEqual([
      { key: null, cents: 1, previousCents: 0 },
      { key: KID, cents: 0, previousCents: 2 },
    ]);
  });
});
