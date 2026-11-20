import { asc, eq, max } from 'drizzle-orm';
import { SPEND_MESSAGES, type Category, type MoveDirection } from '../../../shared/spend.js';
import { AppError } from '../../core/errors.js';
import type { Db } from '../../db/index.js';
import { categories, categoryMappings, rules, transactions, type CategoryRow } from '../../db/schema.js';
import type { DbOrTx } from '../../integrations/connections.js';
import { isUniqueViolation } from '../todo/internalBackend.js';
import { categoryRef, type SpendDeps } from './store.js';

/**
 * The category list (spec §12.5). Everyone with the panel reads it (for the pickers); only admins
 * change it, and the routes check that. The two special categories can be renamed and moved, but
 * not archived or deleted. A category in use (by a transaction, deleted ones included, a rule, or
 * the Plaid mapping) can be archived but not deleted.
 */

function inUseIds(db: DbOrTx): Set<number> {
  const ids = new Set<number>();
  for (const r of db.selectDistinct({ id: transactions.categoryId }).from(transactions).all()) ids.add(r.id);
  for (const r of db.selectDistinct({ id: rules.setCategoryId }).from(rules).all()) if (r.id !== null) ids.add(r.id);
  for (const r of db.selectDistinct({ id: categoryMappings.categoryId }).from(categoryMappings).all()) ids.add(r.id);
  return ids;
}

function ordered(db: DbOrTx): CategoryRow[] {
  return db.select().from(categories).orderBy(asc(categories.sortOrder), asc(categories.id)).all();
}

export function listCategories(db: Db): Category[] {
  const used = inUseIds(db);
  return ordered(db).map((c) => ({ ...categoryRef(c), inUse: used.has(c.id) }));
}

function requireCategory(db: Db, id: number): CategoryRow {
  const row = db.select().from(categories).where(eq(categories.id, id)).get();
  if (!row) throw new AppError('not_found', SPEND_MESSAGES.categoryNotFound);
  return row;
}

function category(db: Db, id: number): Category {
  return listCategories(db).find((c) => c.id === id)!;
}

/**
 * Names are unique ignoring case. SQLite's lower() folds only ASCII, so "Épicerie" and "épicerie"
 * would both get past the index; this check folds the way JavaScript does first, and the index
 * stays as a backstop.
 */
function uniqueName<T>(db: Db, name: string, self: number | null, fn: () => T): T {
  const folded = name.toLowerCase();
  const clash = db.select({ id: categories.id, name: categories.name }).from(categories).all().some((c) => c.id !== self && c.name.toLowerCase() === folded);
  if (clash) throw new AppError('conflict', SPEND_MESSAGES.categoryExists);
  try {
    return fn();
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError('conflict', SPEND_MESSAGES.categoryExists);
    throw err;
  }
}

/** A new category goes at the end of the list. */
export function createCategory(deps: SpendDeps, name: string): Category {
  const now = deps.clock.now();
  const last = deps.db.select({ n: max(categories.sortOrder) }).from(categories).get()?.n ?? 0;
  const row = uniqueName(deps.db, name, null, () => deps.db.insert(categories).values({ name, sortOrder: last + 1, createdAt: now, updatedAt: now }).returning().get());
  return category(deps.db, row.id);
}

export function renameCategory(deps: SpendDeps, id: number, name: string): Category {
  requireCategory(deps.db, id);
  uniqueName(deps.db, name, id, () => deps.db.update(categories).set({ name, updatedAt: deps.clock.now() }).where(eq(categories.id, id)).run());
  return category(deps.db, id);
}

/** Archived: transactions keep it and show it as archived, but it can't be picked for anything new. */
export function setCategoryArchived(deps: SpendDeps, id: number, archived: boolean): Category {
  const row = requireCategory(deps.db, id);
  if (row.kind !== 'normal') throw new AppError('conflict', SPEND_MESSAGES.categorySpecial);
  deps.db.update(categories).set({ archived, updatedAt: deps.clock.now() }).where(eq(categories.id, id)).run();
  return category(deps.db, id);
}

/** Swaps the category with the one above or below it. At either end, nothing changes. */
export function moveCategory(deps: SpendDeps, id: number, direction: MoveDirection): Category[] {
  requireCategory(deps.db, id);
  deps.db.transaction((tx) => {
    const list = ordered(tx);
    const i = list.findIndex((c) => c.id === id);
    const j = direction === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= list.length) return;
    // Renumber the whole list, so equal sort orders (never made here, but possible by hand) can't stall a move.
    const next = [...list];
    [next[i], next[j]] = [next[j]!, next[i]!];
    const now = deps.clock.now();
    next.forEach((c, n) => {
      if (c.sortOrder !== n + 1) tx.update(categories).set({ sortOrder: n + 1, updatedAt: now }).where(eq(categories.id, c.id)).run();
    });
  });
  return listCategories(deps.db);
}

export function deleteCategory(deps: SpendDeps, id: number): void {
  const row = requireCategory(deps.db, id);
  if (row.kind !== 'normal') throw new AppError('conflict', SPEND_MESSAGES.categorySpecial);
  deps.db.transaction((tx) => {
    if (inUseIds(tx).has(id)) throw new AppError('conflict', SPEND_MESSAGES.categoryInUse);
    tx.delete(categories).where(eq(categories.id, id)).run();
  });
}
