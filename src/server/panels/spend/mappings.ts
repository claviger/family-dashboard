import { and, count, eq, isNotNull, isNull } from 'drizzle-orm';
import {
  MAPPING_MESSAGES, PFC_V2_PRIMARIES, pfcLabel, type MappingBatchChange, type MappingRow, type MappingView, type PfcKind, type UnmappedCode,
} from '../../../shared/plaid.js';
import { AppError } from '../../core/errors.js';
import type { Db } from '../../db/index.js';
import { categoryMappings, transactions } from '../../db/schema.js';
import { categoriesById, categoryRef, requireUsableCategory, type SpendDeps } from './store.js';

/**
 * The Plaid category mapping editor (spec §12.7): Plaid `personal_finance_category` codes to family
 * categories. `categorize` looks the detailed code up first, then the primary, so a detailed code
 * without a row of its own falls back to its primary's. Admins only; the routes check the role.
 *
 * - Every primary keeps a row (migration 0007 seeds the 18 v2 ones): it can be changed, never
 *   deleted, since it's what its detailed codes fall back to. A detailed row can be deleted.
 * - A code can be mapped once it has a row or Plaid has sent it on a transaction; the editor lists
 *   the codes seen without a row, with what they fall back to now.
 * - A change applies to transactions categorized from then on. Past ones keep their category
 *   until Spend settings' "Apply rules to past transactions", which decides them again with the
 *   mapping too (and never touches a value set by hand).
 */

interface SeenCode {
  kind: PfcKind;
  version: string | null;
  count: number;
}

/** Codes on live transactions, by code, with how many carry each and the taxonomy version they came with. */
function seenCodes(db: Db): Map<string, SeenCode> {
  const seen = new Map<string, SeenCode>();
  const add = (code: string | null, kind: PfcKind, version: string | null, n: number) => {
    if (code === null || code === '') return;
    const s = seen.get(code) ?? { kind, version: null, count: 0 };
    s.count += n;
    s.version ??= version;
    // A code seen as a primary anywhere is a primary.
    if (kind === 'primary') s.kind = 'primary';
    seen.set(code, s);
  };
  for (const [column, kind] of [[transactions.plaidPfcPrimary, 'primary'], [transactions.plaidPfcDetailed, 'detailed']] as const) {
    const rows = db
      .select({ code: column, version: transactions.plaidPfcVersion, n: count() })
      .from(transactions)
      .where(and(isNotNull(column), isNull(transactions.deletedAt)))
      .groupBy(column, transactions.plaidPfcVersion)
      .all();
    for (const r of rows) add(r.code, kind, r.version, r.n);
  }
  return seen;
}

/** Primary codes: PFC v2's, and any code a transaction carried as its primary. */
function primaries(seen: Map<string, SeenCode>): Set<string> {
  return new Set<string>([...PFC_V2_PRIMARIES, ...[...seen].filter(([, s]) => s.kind === 'primary').map(([code]) => code)]);
}

/** A detailed code's primary: the longest primary it starts with, then an underscore. */
function primaryOf(code: string, known: Set<string>): string | null {
  let best: string | null = null;
  for (const p of known) if (code.startsWith(`${p}_`) && (best === null || p.length > best.length)) best = p;
  return best;
}

export function mappingView(db: Db): MappingView {
  const seen = seenCodes(db);
  const known = primaries(seen);
  const cats = categoriesById(db);
  const stored = db.select().from(categoryMappings).all();
  const byCode = new Map(stored.map((m) => [m.plaidPfc, m]));
  const kindOf = (code: string): PfcKind => (known.has(code) ? 'primary' : 'detailed');
  const rows: MappingRow[] = stored
    .map((m) => {
      const kind = kindOf(m.plaidPfc);
      return {
        code: m.plaidPfc,
        kind,
        primary: kind === 'detailed' ? primaryOf(m.plaidPfc, known) : null,
        taxonomyVersion: m.taxonomyVersion,
        category: categoryRef(cats.get(m.categoryId)!),
        transactionCount: seen.get(m.plaidPfc)?.count ?? 0,
      };
    })
    .sort((a, b) => a.code.localeCompare(b.code));
  const unmapped: UnmappedCode[] = [...seen]
    .filter(([code]) => !byCode.has(code))
    .map(([code, s]) => {
      const kind = kindOf(code);
      const primary = kind === 'detailed' ? primaryOf(code, known) : null;
      const fallback = primary === null ? undefined : byCode.get(primary);
      return {
        code,
        kind,
        primary,
        taxonomyVersion: s.version,
        transactionCount: s.count,
        fallsBackTo: fallback ? categoryRef(cats.get(fallback.categoryId)!) : null,
      };
    })
    .sort((a, b) => a.code.localeCompare(b.code));
  return { rows, unmapped };
}

/**
 * Maps `code` to a category that isn't archived, adding the row for a code Plaid has sent that has
 * none yet (with the version its transactions carried, else v2). An unknown code is a 404.
 */
export function setMapping(deps: SpendDeps, code: string, categoryId: number): MappingView {
  requireUsableCategory(deps.db, categoryId);
  const now = deps.clock.now();
  deps.db.transaction((tx) => {
    const existing = tx.select().from(categoryMappings).where(eq(categoryMappings.plaidPfc, code)).get();
    if (existing) {
      if (existing.categoryId !== categoryId) tx.update(categoryMappings).set({ categoryId, updatedAt: now }).where(eq(categoryMappings.plaidPfc, code)).run();
      return;
    }
    const seen = seenCodes(deps.db).get(code);
    if (!seen) throw new AppError('not_found', MAPPING_MESSAGES.unknownCode);
    tx.insert(categoryMappings).values({ plaidPfc: code, taxonomyVersion: seen.version ?? 'v2', categoryId, updatedAt: now }).run();
  });
  deps.logger.info({ code, categoryId }, 'spend plaid mapping saved');
  return mappingView(deps.db);
}

/**
 * The editor's one Save (review G4-I3; PATCH /mappings): every change in one transaction, all or
 * nothing, like the transactions' batch PATCH. In order, each refusal saving nothing:
 * - a code with no row that Plaid has never sent here: 404, `{ missingCodes }`;
 * - a code someone else changed since the page saw it (`expected`), to anything but this change's
 *   own value: 409, `{ conflicts: [{ code, current }] }`;
 * - a category that can't be used (archived, or not there), or deleting a primary's row: 400,
 *   `{ code, problem }`, the message naming the code as people read it.
 * Mapping a code to what it already has, or deleting a row that's already gone, changes nothing.
 */
export function saveMappings(deps: SpendDeps, changes: readonly MappingBatchChange[]): MappingView {
  const { db } = deps;
  // better-sqlite3 is synchronous on one connection: every read and write here is inside the transaction.
  const counts = db.transaction(() => {
    const seen = seenCodes(db);
    const known = primaries(seen);
    const stored = new Map(db.select().from(categoryMappings).all().map((m) => [m.plaidPfc, m]));
    const label = (code: string) => pfcLabel(code, known.has(code) ? null : primaryOf(code, known));

    const missingCodes = changes.filter((c) => !stored.has(c.code) && !seen.has(c.code)).map((c) => c.code);
    if (missingCodes.length > 0) throw new AppError('not_found', MAPPING_MESSAGES.unknownCodes(missingCodes.length), { missingCodes });

    const conflicts = changes.flatMap((c) => {
      const current = stored.get(c.code)?.categoryId ?? null;
      return c.expected !== undefined && current !== c.expected && current !== c.categoryId ? [{ code: c.code, current }] : [];
    });
    if (conflicts.length > 0) throw new AppError('conflict', MAPPING_MESSAGES.changedMeanwhile(conflicts.length), { conflicts });

    for (const c of changes) {
      const current = stored.get(c.code)?.categoryId ?? null;
      if (c.categoryId === current) continue;
      let problem: string | null = null;
      if (c.categoryId === null) {
        if (known.has(c.code)) problem = MAPPING_MESSAGES.primaryStays;
      } else {
        try {
          requireUsableCategory(db, c.categoryId);
        } catch (err) {
          if (!(err instanceof AppError) || err.code !== 'validation') throw err;
          problem = err.message;
        }
      }
      if (problem !== null) throw new AppError('validation', `${label(c.code)}: ${problem}`, { code: c.code, problem });
    }

    const now = deps.clock.now();
    let set = 0;
    let deleted = 0;
    for (const c of changes) {
      const row = stored.get(c.code);
      if (c.categoryId === (row?.categoryId ?? null)) continue;
      if (c.categoryId === null) {
        db.delete(categoryMappings).where(eq(categoryMappings.plaidPfc, c.code)).run();
        deleted++;
      } else if (row) {
        db.update(categoryMappings).set({ categoryId: c.categoryId, updatedAt: now }).where(eq(categoryMappings.plaidPfc, c.code)).run();
        set++;
      } else {
        db.insert(categoryMappings).values({ plaidPfc: c.code, taxonomyVersion: seen.get(c.code)?.version ?? 'v2', categoryId: c.categoryId, updatedAt: now }).run();
        set++;
      }
    }
    return { set, deleted };
  });
  deps.logger.info({ changes: changes.length, ...counts }, 'spend plaid mappings saved');
  return mappingView(db);
}

/** Deletes a detailed code's own row, so it falls back to its primary's. A primary's row stays. */
export function deleteMapping(deps: SpendDeps, code: string): MappingView {
  const existing = deps.db.select().from(categoryMappings).where(eq(categoryMappings.plaidPfc, code)).get();
  if (!existing) throw new AppError('not_found', MAPPING_MESSAGES.notFound);
  if (primaries(seenCodes(deps.db)).has(code)) throw new AppError('conflict', MAPPING_MESSAGES.primaryStays);
  deps.db.delete(categoryMappings).where(eq(categoryMappings.plaidPfc, code)).run();
  deps.logger.info({ code }, 'spend plaid mapping deleted');
  return mappingView(deps.db);
}
