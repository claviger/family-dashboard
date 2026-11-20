import { createHash, randomBytes } from 'node:crypto';
import { and, count, desc, eq, gt, isNotNull, isNull, lte, or } from 'drizzle-orm';
import {
  canImport, IMPORT_REPLACED_ROW, mostlyPossibleDuplicates, POSSIBLE_DUPLICATE, SPEND_MESSAGES, type CsvImportRecord, type ImportPreview, type ImportResult, type ImportUndoResult, type PreviewRow,
} from '../../../shared/spend.js';
import { AppError } from '../../core/errors.js';
import { csvImportPreviews, csvImports, transactions, users } from '../../db/schema.js';
import { BOFA_MESSAGES, readBofaCsv } from './bofa.js';
import { DuplicateMatcher, type DuplicateCandidate } from './duplicates.js';
import { categorize } from './rules.js';
import { restoreDuplicatesOf } from './twins.js';
import { cardOption, familyToday, loadCategorizer, requireActiveCard, requireCard, type SpendDeps } from './store.js';

/**
 * CSV import (spec §12.13): an admin uploads a file for a card, reviews a preview, and saves the
 * rows they keep. The preview is the parsed rows (never the file), stored for an hour under a
 * random id and bound to the admin. Saving skips reference numbers already stored, and applies
 * the rules. Logs carry counts only: nothing from the file is ever logged.
 */

export const PREVIEW_TTL_MS = 60 * 60 * 1000;

export const ALREADY_IMPORTED = 'Already imported.';

/** A preview id: 16 random bytes, base64url. */
export function isPreviewId(text: string): boolean {
  return /^[A-Za-z0-9_-]{22}$/.test(text);
}

/** Expired previews go whenever an import is touched, and with the `spend.pruneImports` job. */
export function pruneImportPreviews(deps: SpendDeps): number {
  return deps.db.delete(csvImportPreviews).where(lte(csvImportPreviews.expiresAt, deps.clock.now())).run().changes;
}

function toPreview(row: typeof csvImportPreviews.$inferSelect, card: ReturnType<typeof cardOption>, warnings: ImportPreview['warnings']): ImportPreview {
  const dates = row.rows.filter((r) => canImport(r.status) && r.date !== null).map((r) => r.date!).sort();
  return {
    id: row.id,
    card,
    fileName: row.fileName,
    rows: row.rows,
    dateRange: dates.length > 0 ? { from: dates[0]!, to: dates.at(-1)! } : null,
    warnings,
    expiresAt: row.expiresAt.toISOString(),
  };
}

/**
 * Only the last path segment of a browser-supplied name, without control or format characters (a
 * right-to-left override or a zero-width space could make it read as something else), and not too long.
 */
export function cleanFileName(name: string | null): string | null {
  const base = name?.replace(/[\p{Cc}\p{Cf}]/gu, '').split(/[\\/]/).at(-1)?.trim() ?? '';
  return base === '' ? null : base.slice(0, 200);
}

/**
 * A CSV row a bank transaction replaced whose import was undone (design departure 8): deleted,
 * with no `csv_import_id`, holding its reference number. A re-import of its file adopts it.
 */
function isOrphanedReplaced(row: { source: string; csvImportId: number | null; deletedAt: Date | null; replacedById: number | null; ref: string | null }): boolean {
  return row.source === 'csv' && row.csvImportId === null && row.deletedAt !== null && row.replacedById !== null && row.ref !== null;
}

/**
 * Reads the upload and stores its preview, replacing any earlier preview of the same admin. A file
 * that isn't a BofA credit-card CSV is refused with a plain message (validation).
 */
export function previewImport(deps: SpendDeps, userId: number, input: { cardId: number; fileName: string | null; bytes: Uint8Array }): ImportPreview {
  const card = requireActiveCard(deps.db, input.cardId, 'validation');
  const fileName = cleanFileName(input.fileName);
  const file = readBofaCsv(input.bytes, fileName, familyToday(deps));
  if (!file.ok) {
    deps.logger.info({ cardId: card.id, bytes: input.bytes.length }, 'spend csv refused');
    throw new AppError('validation', file.message);
  }

  const stored = deps.db
    .select({
      id: transactions.id, date: transactions.date, amountCents: transactions.amountCents, merchant: transactions.merchant, rawName: transactions.rawName,
      ref: transactions.csvReference, deletedAt: transactions.deletedAt, source: transactions.source, csvImportId: transactions.csvImportId,
      replacedById: transactions.replacedById,
    })
    .from(transactions)
    .where(eq(transactions.cardId, card.id))
    .all();
  // Deleted rows' references count, so a CSV row that something replaced never comes back. One
  // whose import was undone is part of this import instead: saving adopts it, still hidden.
  const refs = new Set(stored.filter((s) => s.ref !== null && !isOrphanedReplaced(s)).map((s) => s.ref!));
  const orphaned = new Set(stored.filter((s) => isOrphanedReplaced(s) && !refs.has(s.ref!)).map((s) => s.ref!));
  // A stored row whose reference is in this file is accounted for by its own row (already
  // imported), so it isn't offered to the others, not even as a near match.
  const fileRefs = new Set(file.rows.map((r) => r.reference).filter((ref) => ref !== null));
  // One to one, in file order: a stored transaction matched by one row isn't offered to the next.
  const matcher = new DuplicateMatcher(
    stored
      .filter((s) => s.deletedAt === null && !(s.ref !== null && fileRefs.has(s.ref)))
      .map((s) => ({ id: s.id, cardId: card.id, date: s.date, amountCents: s.amountCents, merchant: s.merchant ?? s.rawName, rawName: s.rawName, reference: s.ref })),
  );
  // Shown by the merchant name, as the table shows it, even when it was the raw name that matched.
  const shownAs = (c: DuplicateCandidate) => ({ id: c.id, date: c.date, merchant: c.merchant, amountCents: c.amountCents });

  const rows: PreviewRow[] = file.rows.map((r) => {
    if ((r.status === 'new' || r.status === 'repeated') && refs.has(r.reference!)) return { ...r, status: 'already_imported', reason: ALREADY_IMPORTED };
    if (r.status !== 'new') return r;
    if (orphaned.has(r.reference!)) return { ...r, reason: IMPORT_REPLACED_ROW };
    const candidate = { cardId: card.id, date: r.date!, amountCents: r.amountCents!, merchant: r.payee!, reference: r.reference };
    const dup = matcher.match(candidate);
    if (dup) return { ...r, status: 'duplicate', duplicateOf: shownAs(dup) };
    // Not a duplicate, since the bank numbered them differently, but shown, so a bank that changes
    // reference numbers between downloads is noticed. Ticked, unless they're most of the new rows.
    const near = matcher.differentReference(candidate);
    return near ? { ...r, reason: POSSIBLE_DUPLICATE, duplicateOf: shownAs(near) } : r;
  });

  const warnings: ImportPreview['warnings'] = [];
  if (file.mostlyCredits) warnings.push({ id: 'mostly_credits', message: BOFA_MESSAGES.mostlyCredits });
  if (file.fileMask && card.mask && !card.mask.endsWith(file.fileMask) && !file.fileMask.endsWith(card.mask)) {
    warnings.push({ id: 'card_mismatch', message: SPEND_MESSAGES.importCardMismatch(file.fileMask, card.mask) });
  }
  if (mostlyPossibleDuplicates(rows)) warnings.push({ id: 'mostly_possible_duplicates', message: SPEND_MESSAGES.importMostlyPossibleDuplicates });

  const now = deps.clock.now();
  const row = {
    id: randomBytes(16).toString('base64url'),
    userId,
    cardId: card.id,
    fileName,
    fileSha256: createHash('sha256').update(input.bytes).digest('hex'),
    rows,
    createdAt: now,
    expiresAt: new Date(now.getTime() + PREVIEW_TTL_MS),
  };
  deps.db.transaction((tx) => {
    tx.delete(csvImportPreviews).where(eq(csvImportPreviews.userId, userId)).run();
    tx.insert(csvImportPreviews).values(row).run();
  });
  pruneImportPreviews(deps);
  const count = (s: PreviewRow['status']) => rows.filter((r) => r.status === s).length;
  deps.logger.info(
    { cardId: card.id, rows: rows.length, new: count('new'), duplicates: count('duplicate'), possibleDuplicates: rows.filter((r) => r.reason === POSSIBLE_DUPLICATE).length, alreadyImported: count('already_imported'), unreadable: rows.length - count('new') - count('duplicate') - count('already_imported') },
    'spend csv preview',
  );
  return toPreview(row, cardOption(card), warnings);
}

function requirePreview(deps: SpendDeps, userId: number, id: string) {
  const row = deps.db
    .select()
    .from(csvImportPreviews)
    .where(and(eq(csvImportPreviews.id, id), eq(csvImportPreviews.userId, userId), gt(csvImportPreviews.expiresAt, deps.clock.now())))
    .get();
  if (!row) throw new AppError('not_found', SPEND_MESSAGES.importNotFound);
  return row;
}

/**
 * Saves the rows the admin kept (by line number; rows that can't be imported are ignored, and a save
 * where none of them can be is refused, keeping the preview), skipping
 * any whose reference number is stored by now, with rules applied (spec §12.13). Records the import,
 * so the card's "Updated X ago" is now, and deletes the preview. A kept row whose reference number
 * is held by a replaced CSV row whose import was undone adopts that row (its `csv_import_id` set to
 * this import) instead of adding another: it stays hidden behind its bank twin, and if that twin
 * goes (Remove with "Also delete its transactions"), it comes back as this import's row rather
 * than being deleted as an undone import's.
 */
export function commitImport(deps: SpendDeps, userId: number, id: string, include: readonly number[]): ImportResult {
  const preview = requirePreview(deps, userId, id);
  const card = requireActiveCard(deps.db, preview.cardId, 'validation');
  const wanted = new Set(include);
  const chosen = preview.rows.filter((r) => wanted.has(r.line) && canImport(r.status));
  if (chosen.length === 0) throw new AppError('validation', SPEND_MESSAGES.importNothingPicked);
  const env = loadCategorizer(deps.db);
  const now = deps.clock.now();
  const result = deps.db.transaction((tx) => {
    const importRow = tx
      .insert(csvImports)
      .values({ cardId: card.id, fileName: preview.fileName, fileSha256: preview.fileSha256, uploadedByUserId: userId, uploadedAt: now, rowCount: preview.rows.length, importedCount: 0, skippedCount: 0 })
      .returning()
      .get();
    const held = tx
      .select({
        id: transactions.id, ref: transactions.csvReference, source: transactions.source, csvImportId: transactions.csvImportId, deletedAt: transactions.deletedAt,
        replacedById: transactions.replacedById,
      })
      .from(transactions)
      .where(and(eq(transactions.cardId, card.id), isNotNull(transactions.csvReference)))
      .all();
    const refs = new Set(held.filter((r) => !isOrphanedReplaced(r)).map((r) => r.ref!));
    const orphans = new Map(held.filter((r) => isOrphanedReplaced(r) && !refs.has(r.ref!)).map((r) => [r.ref!, r.id]));
    let imported = 0;
    let adopted = 0;
    for (const r of chosen) {
      if (refs.has(r.reference!)) continue;
      refs.add(r.reference!);
      const orphan = orphans.get(r.reference!);
      if (orphan !== undefined) {
        tx.update(transactions).set({ csvImportId: importRow.id, updatedAt: now }).where(eq(transactions.id, orphan)).run();
        imported++;
        adopted++;
        continue;
      }
      const target = { cardId: card.id, merchant: null, rawName: r.payee!, amountCents: r.amountCents!, plaidPfcDetailed: null, plaidPfcPrimary: null };
      tx.insert(transactions)
        .values({
          ...categorize(target, null, env),
          cardId: card.id,
          source: 'csv',
          date: r.date!,
          amountCents: r.amountCents!,
          isoCurrencyCode: card.isoCurrencyCode ?? 'USD',
          rawName: r.payee!,
          csvAddress: r.address,
          csvReference: r.reference,
          csvImportId: importRow.id,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      imported++;
    }
    const skipped = preview.rows.length - imported;
    tx.update(csvImports).set({ importedCount: imported, skippedCount: skipped }).where(eq(csvImports.id, importRow.id)).run();
    tx.delete(csvImportPreviews).where(eq(csvImportPreviews.id, preview.id)).run();
    return { imported, skipped, adopted };
  });
  deps.logger.info({ cardId: card.id, ...result }, 'spend csv imported');
  return { imported: result.imported, skipped: result.skipped };
}

/** Cancel: forgets the preview. Answers the same whether or not there was one. */
export function cancelImport(deps: SpendDeps, userId: number, id: string): void {
  deps.db.delete(csvImportPreviews).where(and(eq(csvImportPreviews.id, id), eq(csvImportPreviews.userId, userId))).run();
}

/** How many imports "Undo this import" lists for a card. */
export const IMPORT_HISTORY_COUNT = 10;

/** A card's recent imports, newest first, with how many of their transactions are still stored. */
export function listImports(deps: SpendDeps, cardId: number): CsvImportRecord[] {
  requireCard(deps.db, cardId);
  const rows = deps.db
    .select({ id: csvImports.id, fileName: csvImports.fileName, uploadedAt: csvImports.uploadedAt, uploadedBy: users.displayName, importedCount: csvImports.importedCount })
    .from(csvImports)
    .leftJoin(users, eq(users.id, csvImports.uploadedByUserId))
    .where(eq(csvImports.cardId, cardId))
    .orderBy(desc(csvImports.uploadedAt), desc(csvImports.id))
    .limit(IMPORT_HISTORY_COUNT)
    .all();
  const counts = new Map(
    deps.db
      .select({ importId: transactions.csvImportId, n: count() })
      .from(transactions)
      // Live rows only: what an undo deletes. A row a Plaid transaction replaced is kept (see undoImport).
      .where(and(eq(transactions.cardId, cardId), isNotNull(transactions.csvImportId), isNull(transactions.deletedAt)))
      .groupBy(transactions.csvImportId)
      .all()
      .map((r) => [r.importId!, r.n]),
  );
  return rows.map((r) => ({ ...r, uploadedAt: r.uploadedAt.toISOString(), transactionCount: counts.get(r.id) ?? 0 }));
}

/**
 * Undo this import (review C-I1): hard-deletes the import's live transactions and its record, in
 * one transaction, so the right file can be imported again (a hard delete frees the reference
 * numbers; a soft delete would keep them taken). Refused, with nothing changed, when any of them
 * has a category or person set by hand, or a note: that's work an undo would throw away.
 *
 * After a replacement (the design's departure 8): a CSV row a Plaid transaction replaced is
 * soft-deleted and keeps its reference number. The undo keeps it, with `csv_import_id` cleared, so
 * the CSV row never comes back beside its Plaid twin; re-importing the file adopts it into the new
 * import, still hidden (`commitImport`). It doesn't count toward the "edited" check either: its
 * manual fields already moved to the Plaid row.
 */
export function undoImport(deps: SpendDeps, userId: number, cardId: number, importId: number): ImportUndoResult {
  const result = deps.db.transaction((tx) => {
    const record = tx.select({ id: csvImports.id }).from(csvImports).where(and(eq(csvImports.id, importId), eq(csvImports.cardId, cardId))).get();
    if (!record) throw new AppError('not_found', SPEND_MESSAGES.importRecordNotFound);
    const mine = eq(transactions.csvImportId, importId);
    const live = and(mine, isNull(transactions.deletedAt));
    const total = tx.select({ n: count() }).from(transactions).where(live).get()!.n;
    const edited = tx
      .select({ n: count() })
      .from(transactions)
      .where(and(live, or(eq(transactions.categorySource, 'manual'), eq(transactions.personSource, 'manual'), isNotNull(transactions.note))))
      .get()!.n;
    if (edited > 0) throw new AppError('conflict', SPEND_MESSAGES.importUndoEdited(edited, total));
    // A row elsewhere removed as a duplicate of one of these comes back, so the undo never leaves
    // neither copy (spec §12.12). The import's own removed duplicates stay hidden with it (below).
    const going = tx.select({ id: transactions.id }).from(transactions).where(live).all().map((r) => r.id);
    restoreDuplicatesOf(tx, going, deps.clock.now(), (r) => r.csvImportId === importId);
    const removed = tx.delete(transactions).where(live).run().changes;
    // The replaced ones, and those removed as duplicates, stay, holding their reference numbers,
    // without the import that's going.
    const kept = tx.update(transactions).set({ csvImportId: null }).where(and(mine, isNotNull(transactions.deletedAt))).run().changes;
    tx.delete(csvImports).where(eq(csvImports.id, importId)).run();
    return { removed, kept };
  });
  deps.logger.info({ cardId, importId, userId, ...result }, 'spend csv import undone');
  return { removed: result.removed };
}
