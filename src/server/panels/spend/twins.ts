import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm';
import { alias, type SQLiteColumn } from 'drizzle-orm/sqlite-core';
import { transactions, type TransactionRow } from '../../db/schema.js';
import type { DbOrTx } from '../../integrations/connections.js';

/**
 * Twins (spec §12.12): two live transactions on one card with the same date and the same amount,
 * whatever their names. Live means neither deleted nor removed by the bank. Twins are what
 * **Remove duplicate** offers to clean up: a CSV row beside the Plaid row the duplicate test
 * missed, say. Many are genuine repeat purchases (two coffees), so nothing here removes one by
 * itself; an admin decides.
 */

/** How many ids go in one `IN (...)`, well under SQLite's limit on bound values. */
const ID_CHUNK = 500;

function chunked<T>(values: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += ID_CHUNK) out.push(values.slice(i, i + ID_CHUNK));
  return out;
}

const live = (t: { deletedAt: SQLiteColumn; removedAt: SQLiteColumn }) => and(isNull(t.deletedAt), isNull(t.removedAt));

/**
 * Each of `ids`' live twins, by id (ascending); an id without twins maps to []. One self-join per
 * 500 ids: each id is found by its key, and its twins on the (card_id, date) index.
 */
export function twinIdsOf(db: DbOrTx, ids: readonly number[]): Map<number, number[]> {
  const out = new Map<number, number[]>(ids.map((id) => [id, []]));
  const twin = alias(transactions, 'twin');
  for (const chunk of chunked([...new Set(ids)])) {
    const pairs = db
      .select({ id: transactions.id, twinId: twin.id })
      .from(transactions)
      .innerJoin(
        twin,
        and(eq(twin.cardId, transactions.cardId), eq(twin.date, transactions.date), eq(twin.amountCents, transactions.amountCents), ne(twin.id, transactions.id), live(twin)),
      )
      .where(inArray(transactions.id, chunk))
      .orderBy(asc(twin.id))
      .all();
    for (const p of pairs) out.get(p.id)!.push(p.twinId);
  }
  return out;
}

/** `row`'s live twins, ascending, leaving out `except` (rows on their way out). */
export function liveTwins(db: DbOrTx, row: Pick<TransactionRow, 'id' | 'cardId' | 'date' | 'amountCents'>, except: ReadonlySet<number> = new Set()): TransactionRow[] {
  return db
    .select()
    .from(transactions)
    .where(and(eq(transactions.cardId, row.cardId), eq(transactions.date, row.date), eq(transactions.amountCents, row.amountCents), ne(transactions.id, row.id), live(transactions)))
    .orderBy(asc(transactions.id))
    .all()
    .filter((r) => !except.has(r.id));
}

/**
 * Before rows go for good (hard-deleted, or removed by the bank and nothing took their place), each
 * row removed as a duplicate of one of them (`duplicate_of_id`) is settled (`settleDuplicate`): it
 * points at another live twin, comes back, or (an undone import's CSV row) is deleted for good, so
 * losing a twin never hides the only copy left. A row the bank removed, or one something replaced,
 * stays as it is. `keep` names rows left alone (an undone import's own rows, while it goes).
 * Returns how many came back.
 */
export function restoreDuplicatesOf(tx: DbOrTx, goneIds: readonly number[], now: Date, keep: (row: TransactionRow) => boolean = () => false): number {
  const gone = new Set(goneIds);
  if (gone.size === 0) return 0;
  let restored = 0;
  for (const row of removedAgainst(tx, [...gone]).filter((r) => !gone.has(r.id) && !keep(r))) {
    if (settleDuplicate(tx, row, now, { except: gone }) === 'restored') restored++;
  }
  return restored;
}

/** Rows removed as duplicates of `ids` that a change to their twin settles: not removed by the bank, not replaced. */
function removedAgainst(tx: DbOrTx, ids: readonly number[]): TransactionRow[] {
  return chunked([...new Set(ids)])
    .flatMap((chunk) => tx.select().from(transactions).where(and(inArray(transactions.duplicateOfId, chunk), eq(transactions.deletedReason, 'duplicate'))).all())
    .filter((r) => r.removedAt === null && r.replacedById === null);
}

/**
 * Where a row removed as a duplicate stands once something about its twins changed. While it has a
 * live twin (other than `except`) it stays removed, pointing at `prefer` when that's one of them,
 * else at the twin it named, else the lowest id; its carry is kept only for the twin it named
 * (another never got the copies). With none left it comes back, unless it's a CSV row whose import
 * was undone (no `csv_import_id`): nothing could remove it again, so it's hard-deleted, which frees
 * its reference number for the file's re-import (as `restoreReplaced` does).
 */
export function settleDuplicate(
  tx: DbOrTx, row: TransactionRow, now: Date, opts: { except?: ReadonlySet<number>; prefer?: number | null } = {},
): 'kept' | 'restored' | 'purged' {
  const twins = liveTwins(tx, row, opts.except);
  if (twins.length > 0) {
    const to = twins.find((t) => t.id === opts.prefer) ?? twins.find((t) => t.id === row.duplicateOfId) ?? twins[0]!;
    const carry = to.id === row.duplicateOfId ? row.duplicateCarry : null;
    tx.update(transactions).set({ duplicateOfId: to.id, duplicateCarry: carry, updatedAt: now }).where(eq(transactions.id, row.id)).run();
    return 'kept';
  }
  if (row.source === 'csv' && row.csvImportId === null) {
    tx.delete(transactions).where(eq(transactions.id, row.id)).run();
    return 'purged';
  }
  tx.update(transactions)
    .set({ deletedAt: null, deletedReason: null, duplicateOfId: null, duplicateCarry: null, updatedAt: now })
    .where(eq(transactions.id, row.id))
    .run();
  return 'restored';
}

/**
 * A row took `from`'s place for good (a pending row posted, or a churned row came back under a new
 * id). Rows removed as `from`'s duplicate point at `to` while it's still their twin; when its amount
 * or date changed (a tip, a fuel hold), they point at another live twin or come back
 * (`settleDuplicate`), so a real charge is never hidden behind one it no longer matches. Rows the
 * bank removed, or that something replaced, just follow.
 */
export function repointDuplicates(tx: DbOrTx, from: number, to: number, now: Date): void {
  for (const row of removedAgainst(tx, [from])) settleDuplicate(tx, row, now, { prefer: to });
  tx.update(transactions).set({ duplicateOfId: to, updatedAt: now }).where(and(eq(transactions.duplicateOfId, from), eq(transactions.deletedReason, 'duplicate'))).run();
}
