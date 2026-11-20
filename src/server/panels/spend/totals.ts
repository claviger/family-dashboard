/**
 * Spend totals (spec §12.10). Pure. Spend is the sum of amounts, leaving out the excluded category
 * (Payments and transfers). Refunds are negative, so they reduce their category's and person's
 * totals. Pending transactions count, and their share is reported on its own so the UI can say so.
 *
 * Amounts in a currency other than the one being totalled aren't added in (they'd make the sum
 * meaningless); they're counted so the UI can say they were left out.
 */

export interface TotalsRow {
  amountCents: number;
  categoryId: number;
  /** Null is Household. */
  personUserId: number | null;
  pending: boolean;
  /** ISO 4217; null counts as USD (what CSV rows are). */
  currency: string | null;
}

export interface Totals {
  totalCents: number;
  pendingCents: number;
  byCategory: Map<number, number>;
  byPerson: Map<number | null, number>;
  /** Rows left out because of their currency. */
  otherCurrencyCount: number;
}

export function totalsOf(rows: readonly TotalsRow[], opts: { excludedCategoryIds: ReadonlySet<number>; currency?: string }): Totals {
  const currency = opts.currency ?? 'USD';
  const t: Totals = { totalCents: 0, pendingCents: 0, byCategory: new Map(), byPerson: new Map(), otherCurrencyCount: 0 };
  for (const r of rows) {
    if (opts.excludedCategoryIds.has(r.categoryId)) continue;
    if ((r.currency ?? 'USD') !== currency) {
      t.otherCurrencyCount++;
      continue;
    }
    t.totalCents += r.amountCents;
    if (r.pending) t.pendingCents += r.amountCents;
    t.byCategory.set(r.categoryId, (t.byCategory.get(r.categoryId) ?? 0) + r.amountCents);
    t.byPerson.set(r.personUserId, (t.byPerson.get(r.personUserId) ?? 0) + r.amountCents);
  }
  return t;
}

/**
 * One row per key in either cycle, with this cycle's amount and the previous one's, largest first
 * (then by the previous amount). A key only the previous cycle had shows 0 this cycle.
 */
export function compareBreakdown<K>(current: ReadonlyMap<K, number>, previous: ReadonlyMap<K, number>): { key: K; cents: number; previousCents: number }[] {
  const keys = new Set<K>([...current.keys(), ...previous.keys()]);
  return [...keys]
    .map((key) => ({ key, cents: current.get(key) ?? 0, previousCents: previous.get(key) ?? 0 }))
    .sort((a, b) => b.cents - a.cents || b.previousCents - a.previousCents);
}
