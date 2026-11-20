import { createHash, randomBytes } from 'node:crypto';
import { and, count, desc, eq, gt, isNotNull, isNull, lte, or } from 'drizzle-orm';
import { CSV_SAMPLE_ROWS } from '../../../shared/csvImport.js';
import {
  canImport, IMPORT_REPLACED_ROW, mostlyPossibleDuplicates, POSSIBLE_DUPLICATE, SPEND_MESSAGES, type CardMapping, type CsvImportRecord, type ImportPreview,
  type ImportProfile, type ImportResult, type ImportUndoResult, type PreviewRow, type SpendImportDraftPlan, type SpendImportFormat,
} from '../../../shared/spend.js';
import { AppError } from '../../core/errors.js';
import { csvImportPreviews, csvImports, spendImportProfiles, transactions, users, type CardRow, type CsvImportPreviewRow } from '../../db/schema.js';
import { BOFA_MESSAGES, cardFormatFor, looksLikeBofaChecking } from './bofa.js';
import { CARD_CSV_MESSAGES, columnDateFormats, guessCardMapping, mappingProblem, readCardFile, readCardRows, realReference, type CardRows, type CardTable } from './cardCsv.js';
import { DuplicateMatcher, type DuplicateCandidate } from './duplicates.js';
import { categorize } from './rules.js';
import { restoreDuplicatesOf } from './twins.js';
import { cardOption, familyToday, loadCategorizer, requireActiveCard, requireCard, type SpendDeps } from './store.js';

/**
 * CSV import (spec §12.13, the generic import design): an admin uploads a card's file; the draft
 * keeps its table for an hour, bound to them; the card's saved columns or a built-in format fill in
 * the columns, or the admin chooses them; then the preview, and saving the rows they keep, with the
 * rules applied. Import records the import with its format and saves the card's columns. Logs carry
 * ids and counts only: nothing from the file is ever logged.
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

const sameHeader = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((h, i) => h === b[i]);

/** The same mapping, role by role (key order doesn't matter). */
function sameMapping(a: CardMapping, b: CardMapping): boolean {
  const canon = (m: CardMapping) => JSON.stringify([
    m.date.column, m.date.format,
    m.amount.kind === 'signed' ? ['signed', m.amount.column, m.amount.purchasesNegative] : ['split', m.amount.charges, m.amount.credits],
    m.description, m.reference, m.address,
  ]);
  return canon(a) === canon(b);
}

/** `bofa_credit` when the header and mapping are exactly the built-in format's, else `custom` (plan decision 12). */
export function formatOf(header: readonly string[], mapping: CardMapping): SpendImportFormat {
  const builtIn = cardFormatFor(header);
  return builtIn && sameMapping(builtIn.mapping, mapping) ? builtIn.id : 'custom';
}

const tableOf = (plan: SpendImportDraftPlan): CardTable => ({ header: plan.header, rows: plan.rows, bad: plan.bad, trailingSkipped: plan.trailingSkipped });

/** The file's own statuses for the draft's table read with `mapping`. Bank of America's quirks follow its header (plan decision 14). */
function readWith(deps: SpendDeps, card: CardRow, plan: SpendImportDraftPlan, mapping: CardMapping, fileName: string | null): CardRows {
  return readCardRows(tableOf(plan), mapping, { cardId: card.id, today: familyToday(deps), fileName, bofa: cardFormatFor(plan.header)?.id === 'bofa_credit' });
}

/**
 * The database's part of the preview (spec §12.13): rows whose reference number or key is stored
 * already, likely duplicates, possible duplicates with a different reference number, and replaced
 * rows to adopt. One to one, in file order.
 */
function markStored(deps: SpendDeps, card: CardRow, fileRows: readonly PreviewRow[]): PreviewRow[] {
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
  const fileRefs = new Set(fileRows.map((r) => r.reference).filter((ref) => ref !== null));
  // One to one, in file order: a stored transaction matched by one row isn't offered to the next.
  const matcher = new DuplicateMatcher(
    stored
      .filter((s) => s.deletedAt === null && !(s.ref !== null && fileRefs.has(s.ref)))
      .map((s) => ({ id: s.id, cardId: card.id, date: s.date, amountCents: s.amountCents, merchant: s.merchant ?? s.rawName, rawName: s.rawName, reference: realReference(s.ref) })),
  );
  // Shown by the merchant name, as the table shows it, even when it was the raw name that matched.
  const shownAs = (c: DuplicateCandidate) => ({ id: c.id, date: c.date, merchant: c.merchant, amountCents: c.amountCents });

  return fileRows.map((r) => {
    if ((r.status === 'new' || r.status === 'repeated') && refs.has(r.reference!)) return { ...r, status: 'already_imported', reason: ALREADY_IMPORTED };
    if (r.status !== 'new') return r;
    if (orphaned.has(r.reference!)) return { ...r, reason: IMPORT_REPLACED_ROW };
    // A key isn't the bank's word that two rows differ: only real reference numbers count (plan decision 11).
    const candidate = { cardId: card.id, date: r.date!, amountCents: r.amountCents!, merchant: r.payee!, reference: realReference(r.reference) };
    const dup = matcher.match(candidate);
    if (dup) return { ...r, status: 'duplicate', duplicateOf: shownAs(dup) };
    // Not a duplicate, since the bank numbered them differently, but shown, so a bank that changes
    // reference numbers between downloads is noticed. Ticked, unless they're most of the new rows.
    const near = matcher.differentReference(candidate);
    return near ? { ...r, reason: POSSIBLE_DUPLICATE, duplicateOf: shownAs(near) } : r;
  });
}

function warningsFor(card: CardRow, format: SpendImportFormat, file: { mostlyCredits: boolean; fileMask: string | null }, rows: readonly PreviewRow[]): ImportPreview['warnings'] {
  const warnings: ImportPreview['warnings'] = [];
  if (file.mostlyCredits) warnings.push({ id: 'mostly_credits', message: format === 'bofa_credit' ? BOFA_MESSAGES.mostlyCredits : CARD_CSV_MESSAGES.mostlyCredits });
  if (file.fileMask && card.mask && !card.mask.endsWith(file.fileMask) && !file.fileMask.endsWith(card.mask)) {
    warnings.push({ id: 'card_mismatch', message: SPEND_MESSAGES.importCardMismatch(file.fileMask, card.mask) });
  }
  if (mostlyPossibleDuplicates(rows)) warnings.push({ id: 'mostly_possible_duplicates', message: SPEND_MESSAGES.importMostlyPossibleDuplicates });
  return warnings;
}

function logPreview(deps: SpendDeps, card: CardRow, rows: readonly PreviewRow[]): void {
  const count = (s: PreviewRow['status']) => rows.filter((r) => r.status === s).length;
  deps.logger.info(
    { cardId: card.id, rows: rows.length, new: count('new'), duplicates: count('duplicate'), possibleDuplicates: rows.filter((r) => r.reason === POSSIBLE_DUPLICATE).length, alreadyImported: count('already_imported'), unreadable: rows.length - count('new') - count('duplicate') - count('already_imported') },
    'spend csv preview',
  );
}

/** The draft as the web sees it: the columns step's material always, and the rows once it's mapped. */
function view(row: CsvImportPreviewRow, card: CardRow, extra: Pick<ImportPreview, 'warnings'> & Pick<ImportPreview['columns'], 'suggested' | 'problem' | 'hint'>): ImportPreview {
  const plan = row.plan!;
  const dates = row.rows.filter((r) => canImport(r.status) && r.date !== null).map((r) => r.date!).sort();
  return {
    id: row.id,
    card: cardOption(card),
    fileName: row.fileName,
    step: plan.mapping ? 'preview' : 'columns',
    format: plan.format,
    prefilled: plan.prefilled,
    mapping: plan.mapping,
    columns: {
      header: plan.header,
      sample: plan.rows.slice(0, CSV_SAMPLE_ROWS).map((r) => r.cells),
      rowCount: plan.rows.length + plan.bad.length,
      trailingSkipped: plan.trailingSkipped,
      dateFormats: plan.dateFormats ?? columnDateFormats(tableOf(plan)),
      suggested: extra.suggested,
      problem: extra.problem,
      hint: extra.hint,
    },
    rows: row.rows,
    dateRange: dates.length > 0 ? { from: dates[0]!, to: dates.at(-1)! } : null,
    warnings: extra.warnings,
    expiresAt: row.expiresAt.toISOString(),
  };
}

/**
 * The upload (plan decision 6): finds the table, then fills in the columns. The card's saved
 * columns first, when the header matches and they read the file; then a built-in format by its
 * header; then saved columns that matched but don't fit, shown with why; else a guess. With columns
 * it reads the rows, and a file none of whose rows can be imported is refused, as before. Replaces
 * the admin's earlier draft.
 */
export function previewImport(deps: SpendDeps, userId: number, input: { cardId: number; fileName: string | null; bytes: Uint8Array }): ImportPreview {
  const card = requireActiveCard(deps.db, input.cardId, 'validation');
  const fileName = cleanFileName(input.fileName);
  const refuse = (message: string): never => {
    deps.logger.info({ cardId: card.id, bytes: input.bytes.length }, 'spend csv refused');
    throw new AppError('validation', message);
  };
  const file = readCardFile(input.bytes);
  if (!file.ok) return refuse(file.message);
  const table = file.table;
  const profile = deps.db.select().from(spendImportProfiles).where(eq(spendImportProfiles.cardId, card.id)).get();
  const saved = profile && sameHeader(profile.header, table.header) ? profile.mapping : null;
  // Saved columns that are exactly a built-in format's apply on the header alone, as that format does
  // (and as updateImport takes them): odd rows are listed, not a reason to set the columns aside.
  // Worked out once, here, and kept with the draft (the final review's M3).
  const dateFormats = columnDateFormats(table);
  let savedProblem = saved && formatOf(table.header, saved) === 'custom' ? mappingProblem(table, saved) : null;
  const builtIn = cardFormatFor(table.header);
  const readTable = (m: CardMapping) => readCardRows(table, m, { cardId: card.id, today: familyToday(deps), fileName, bofa: builtIn?.id === 'bofa_credit' });
  let mapping: CardMapping | null = null;
  let read: CardRows | null = null;
  let prefilled: SpendImportDraftPlan['prefilled'] = 'guess';
  let suggested: CardMapping | null = null;
  let problem: string | null = null;
  let keepProfile = false;
  if (saved && savedProblem === null) {
    const r = readTable(saved);
    // Saved columns that read the dates and amounts but no row (the Batch B review): not a dead
    // end, but the next choice, with why. A file of pending holds only is still refused.
    if (!r.ok && r.message === CARD_CSV_MESSAGES.noneReadable) savedProblem = SPEND_MESSAGES.importSavedReadNothing;
    else {
      prefilled = 'profile';
      mapping = saved;
      read = r;
    }
  }
  if (mapping) {
    // The saved columns, above.
  } else if (builtIn) {
    // A built-in format applies on its header alone, as Bank of America's always has (plan decision 7).
    prefilled = 'builtin';
    mapping = builtIn.mapping;
    read = readTable(mapping);
    if (saved) {
      // Saved columns that don't fit: said so, and Import keeps them unless the admin chooses columns (the Batch B review).
      problem = SPEND_MESSAGES.importSavedNotUsed;
      keepProfile = true;
    }
  } else if (saved) {
    prefilled = 'profile';
    suggested = saved;
    problem = SPEND_MESSAGES.importSavedDoesntFit(savedProblem!);
  } else {
    suggested = guessCardMapping(table, dateFormats);
  }
  const plan: SpendImportDraftPlan = {
    header: table.header, rows: table.rows, bad: table.bad, trailingSkipped: table.trailingSkipped, dateFormats, mapping, format: mapping ? formatOf(table.header, mapping) : 'custom', prefilled,
    ...(keepProfile ? { keepProfile } : {}),
  };
  let rows: PreviewRow[] = [];
  let warnings: ImportPreview['warnings'] = [];
  if (read) {
    if (!read.ok) return refuse(read.message);
    rows = markStored(deps, card, read.rows);
    warnings = warningsFor(card, plan.format, read, rows);
  }

  const now = deps.clock.now();
  const row: CsvImportPreviewRow = {
    id: randomBytes(16).toString('base64url'),
    userId,
    cardId: card.id,
    fileName,
    fileSha256: createHash('sha256').update(input.bytes).digest('hex'),
    rows,
    plan,
    createdAt: now,
    expiresAt: new Date(now.getTime() + PREVIEW_TTL_MS),
  };
  deps.db.transaction((tx) => {
    tx.delete(csvImportPreviews).where(eq(csvImportPreviews.userId, userId)).run();
    tx.insert(csvImportPreviews).values(row).run();
  });
  pruneImportPreviews(deps);
  deps.logger.info(
    {
      cardId: card.id, format: plan.format, prefilled, rows: plan.rows.length + plan.bad.length, trailingSkipped: plan.trailingSkipped, columns: plan.header.length,
      savedFits: saved ? savedProblem === null : null, mapped: mapping !== null,
    },
    'spend csv draft',
  );
  if (mapping) logPreview(deps, card, rows);
  return view(row, card, { warnings, suggested, problem, hint: looksLikeBofaChecking(table.header) ? SPEND_MESSAGES.importCheckingHint : null });
}

function requirePreview(deps: SpendDeps, userId: number, id: string): CsvImportPreviewRow {
  const row = deps.db
    .select()
    .from(csvImportPreviews)
    // A preview from before 0015 has no plan, and is treated as expired (plan decision 4).
    .where(and(eq(csvImportPreviews.id, id), eq(csvImportPreviews.userId, userId), gt(csvImportPreviews.expiresAt, deps.clock.now()), isNotNull(csvImportPreviews.plan)))
    .get();
  if (!row) throw new AppError('not_found', SPEND_MESSAGES.importNotFound);
  return row;
}

/**
 * The columns step: reads the draft's rows with the admin's mapping and answers the preview. A
 * mapping that can't read the file (plan decision 7), or one under which no row can be imported, is
 * refused with a plain message, and the draft is unchanged.
 */
export function updateImport(deps: SpendDeps, userId: number, id: string, mapping: CardMapping): ImportPreview {
  const row = requirePreview(deps, userId, id);
  const card = requireActiveCard(deps.db, row.cardId, 'validation');
  const plan = row.plan!;
  const format = formatOf(plan.header, mapping);
  // A built-in format's own columns apply on the header alone, as at upload: rows they can't read are
  // listed, not refused (the Batch B review). Any other columns must read every row's date and amount.
  const why = format === 'custom' ? mappingProblem(tableOf(plan), mapping) : null;
  if (why) throw new AppError('validation', why);
  // The admin chose these columns, so Import saves them.
  const { keepProfile: _kept, ...rest } = plan;
  const next: SpendImportDraftPlan = { ...rest, mapping, format };
  const read = readWith(deps, card, next, mapping, row.fileName);
  if (!read.ok) throw new AppError('validation', read.message);
  const rows = markStored(deps, card, read.rows);
  deps.db.update(csvImportPreviews).set({ plan: next, rows }).where(eq(csvImportPreviews.id, row.id)).run();
  logPreview(deps, card, rows);
  return view({ ...row, plan: next, rows }, card, { warnings: warningsFor(card, next.format, read, rows), suggested: null, problem: null, hint: null });
}

/**
 * Saves the rows the admin kept (by line number; rows that can't be imported are ignored, and a save
 * where none of them can be is refused, keeping the preview), skipping
 * any whose reference number is stored by now, with rules applied (spec §12.13). Records the import,
 * so the card's "Updated X ago" is now, and deletes the preview. A kept row whose reference number
 * is held by a replaced CSV row whose import was undone adopts that row (its `csv_import_id` set to
 * this import) instead of adding another: it stays hidden behind its bank twin, and if that twin
 * goes (Remove with "Also delete its transactions"), it comes back as this import's row rather
 * than being deleted as an undone import's. Records the format it was read with, and saves the
 * card's columns (plan decision 13). Refused before the columns are chosen.
 */
export function commitImport(deps: SpendDeps, userId: number, id: string, include: readonly number[]): ImportResult {
  const preview = requirePreview(deps, userId, id);
  const card = requireActiveCard(deps.db, preview.cardId, 'validation');
  const plan = preview.plan!;
  const mapping = plan.mapping;
  if (!mapping) throw new AppError('validation', SPEND_MESSAGES.importNotReady);
  const wanted = new Set(include);
  const chosen = preview.rows.filter((r) => wanted.has(r.line) && canImport(r.status));
  if (chosen.length === 0) throw new AppError('validation', SPEND_MESSAGES.importNothingPicked);
  const env = loadCategorizer(deps.db);
  const now = deps.clock.now();
  const result = deps.db.transaction((tx) => {
    const importRow = tx
      .insert(csvImports)
      .values({
        cardId: card.id, fileName: preview.fileName, fileSha256: preview.fileSha256, uploadedByUserId: userId, uploadedAt: now, rowCount: preview.rows.length, importedCount: 0, skippedCount: 0,
        format: plan.format,
      })
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
    // The card's columns (plan decision 13), for the next file with this header. Not when the built-in
    // format stood in for saved columns that didn't fit: those stay (the Batch B review).
    if (!plan.keepProfile) {
      const saved = { header: plan.header, mapping, updatedByUserId: userId, updatedAt: now };
      tx.insert(spendImportProfiles).values({ cardId: card.id, ...saved, createdAt: now }).onConflictDoUpdate({ target: spendImportProfiles.cardId, set: saved }).run();
    }
    tx.delete(csvImportPreviews).where(eq(csvImportPreviews.id, preview.id)).run();
    return { imported, skipped, adopted };
  });
  deps.logger.info({ cardId: card.id, format: plan.format, ...result }, 'spend csv imported');
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
    .select({
      id: csvImports.id, fileName: csvImports.fileName, uploadedAt: csvImports.uploadedAt, uploadedBy: users.displayName, importedCount: csvImports.importedCount, format: csvImports.format,
    })
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
  return rows.map((r) => ({ ...r, format: r.format ?? 'bofa_credit', uploadedAt: r.uploadedAt.toISOString(), transactionCount: counts.get(r.id) ?? 0 }));
}

/** A card's saved columns (the generic import design, "Saved per card"), or null. */
export function importProfileOf(deps: SpendDeps, cardId: number): ImportProfile | null {
  requireCard(deps.db, cardId);
  const p = deps.db
    .select({ header: spendImportProfiles.header, mapping: spendImportProfiles.mapping, updatedAt: spendImportProfiles.updatedAt, updatedBy: users.displayName })
    .from(spendImportProfiles)
    .leftJoin(users, eq(users.id, spendImportProfiles.updatedByUserId))
    .where(eq(spendImportProfiles.cardId, cardId))
    .get();
  return p ? { cardId, format: formatOf(p.header, p.mapping), header: p.header, mapping: p.mapping, updatedAt: p.updatedAt.toISOString(), updatedBy: p.updatedBy } : null;
}

/** Clear saved columns: the next file starts from a built-in format or a guess. */
export function clearImportProfile(deps: SpendDeps, userId: number, cardId: number): void {
  requireCard(deps.db, cardId);
  const gone = deps.db.delete(spendImportProfiles).where(eq(spendImportProfiles.cardId, cardId)).run().changes;
  if (gone === 0) throw new AppError('not_found', SPEND_MESSAGES.importProfileNotFound);
  deps.logger.info({ userId, cardId }, 'spend import columns cleared');
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
