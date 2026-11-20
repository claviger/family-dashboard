import { eq, inArray } from 'drizzle-orm';
import { NOTE_MAX } from '../../../shared/spend.js';
import { transactions, type TransactionRow } from '../../db/schema.js';
import type { DbOrTx } from '../../integrations/connections.js';
import { categorize, type Categorizer, type DecidedField } from './rules.js';
import { restoreDuplicatesOf } from './twins.js';

/** How many ids go in one `IN (...)`, well under SQLite's limit on bound values. */
const ID_CHUNK = 500;

function chunked<T>(values: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += ID_CHUNK) out.push(values.slice(i, i + ID_CHUNK));
  return out;
}

/**
 * The note a restored row comes back with (review C-S-M1): the replacing row's, which is the
 * latest edit (taking the replaced row's note when it had none), except when both have a note and
 * they differ. Then neither is lost: its own note, then the replacing row's on a new line, cut at
 * NOTE_MAX (never in the middle of a surrogate pair).
 */
export function restoredNote(own: string | null, replacer: string | null): string | null {
  if (own === null || replacer === null || own === replacer) return replacer;
  let both = `${own}\n${replacer}`;
  if (both.length <= NOTE_MAX) return both;
  both = both.slice(0, NOTE_MAX);
  return /[\uD800-\uDBFF]$/.test(both) ? both.slice(0, -1) : both;
}

/**
 * Before rows are deleted for good, or once Plaid removed them, each row they replaced
 * (`replaced_by_id`) that isn't one of them comes back as it was before, so losing a replacing row
 * never hides what the family had before it. Used by Remove with "Also delete its transactions",
 * by a sync run that removes a posted row nothing re-pointed, and by the prune. `env` is loaded
 * at most once, and only when a field needs deciding again.
 * - a CSV row comes back live, with the replacing row's manual category and manual person (what
 *   the family saw and set on the pair, the latest edit) and its note, or both notes when they
 *   differ (`restoredNote`). A field the family reset to automatic on the
 *   replacing row is decided again on the restored row (`categorize`), so a stale manual value it
 *   had before the replacement doesn't come back;
 * - unless its import was undone (`csv_import_id` null): then it's hard-deleted, which frees its
 *   reference number for the file's re-import;
 * - an older, removed Item's posted row comes back the same way;
 * - a pending row (or one Plaid had removed) stays deleted, with `removed_at` set so the prune
 *   takes it: nothing will ever post or send it again.
 * - a row removed by hand as a duplicate of one of them comes back too, unless it has another live
 *   twin (`restoreDuplicatesOf`).
 * Two copies someone can fix by hand beat one that's silently hidden.
 */
export function restoreReplaced(tx: DbOrTx, gone: readonly TransactionRow[], now: Date, env: () => Categorizer): { restored: number; purged: number } {
  const goneById = new Map(gone.map((r) => [r.id, r]));
  if (goneById.size === 0) return { restored: 0, purged: 0 };
  const replaced = chunked([...goneById.keys()])
    .flatMap((ids) => tx.select().from(transactions).where(inArray(transactions.replacedById, ids)).all())
    .filter((r) => !goneById.has(r.id));
  let restored = 0;
  let purged = 0;
  let loaded: Categorizer | undefined;
  const categorizer = () => (loaded ??= env());
  for (const row of replaced) {
    const by = goneById.get(row.replacedById!)!;
    if (row.source === 'csv' && row.csvImportId === null) {
      tx.delete(transactions).where(eq(transactions.id, row.id)).run();
      purged++;
      continue;
    }
    if (row.source === 'plaid' && (row.pending || row.removedAt !== null)) {
      tx.update(transactions)
        .set({ deletedAt: row.deletedAt ?? now, removedAt: row.removedAt ?? now, updatedAt: now })
        .where(eq(transactions.id, row.id))
        .run();
      continue;
    }
    const reset: DecidedField[] = [];
    if (by.categorySource !== 'manual' && row.categorySource === 'manual') reset.push('category');
    if (by.personSource !== 'manual' && row.personSource === 'manual') reset.push('person');
    const decided = reset.length > 0 ? categorize(row, row, categorizer(), reset) : null;
    tx.update(transactions)
      .set({
        replacedById: null, deletedAt: null, note: restoredNote(row.note, by.note), updatedAt: now,
        ...(by.categorySource === 'manual' ? { categoryId: by.categoryId, categorySource: 'manual' as const } : {}),
        ...(by.personSource === 'manual' ? { personUserId: by.personUserId, personSource: 'manual' as const } : {}),
        ...(decided && reset.includes('category') ? { categoryId: decided.categoryId, categorySource: decided.categorySource } : {}),
        ...(decided && reset.includes('person') ? { personUserId: decided.personUserId, personSource: decided.personSource } : {}),
      })
      .where(eq(transactions.id, row.id))
      .run();
    restored++;
  }
  // And what was removed by hand as a duplicate of a row that's going (spec §12.12).
  restored += restoreDuplicatesOf(tx, [...goneById.keys()], now);
  return { restored, purged };
}
