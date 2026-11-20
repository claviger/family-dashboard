import { createHash, randomBytes } from 'node:crypto';
import { and, count, desc, eq, gt, gte, inArray, lte } from 'drizzle-orm';
import type { Logger } from 'pino';
import { addDays } from '../../../shared/dates.js';
import {
  SAVINGS_MESSAGES, SAVINGS_SAMPLE_ROWS, type SavingsFlowKind, type SavingsGroupChoice, type SavingsGroupChoices, type SavingsImportDraft, type SavingsImportDraftPlan,
  type SavingsImportFormat, type SavingsImportProfileView, type SavingsImportRecord, type SavingsImportResults, type SavingsImportUpdate, type SavingsMapping,
} from '../../../shared/savings.js';
import { localDate } from '../../core/clock.js';
import { AppError } from '../../core/errors.js';
import type { Db } from '../../db/index.js';
import {
  savingsAccounts, savingsBalances, savingsFlows, savingsImportPreviews, savingsImportProfiles, savingsImports, users, type SavingsAccountRow,
  type SavingsImportPreviewRow,
} from '../../db/schema.js';
import type { DbOrTx } from '../../integrations/connections.js';
import { getFamilySettings } from '../../settings.js';
import { cleanFileName } from '../spend/imports.js';
import { dateFormatsOf } from '../../csv/values.js';
import { guessMapping, readMapped, type ReadRow } from './csvMapping.js';
import { choicesFor, defaultChoice, groupsOf, importableBalances, PLAID_TWIN_DAYS, plaidTwins, readRows, type ReadPlan } from './csvRows.js';
import { decodeCsv, findCsvTable, CSV_TABLE_MESSAGES, type CsvTable } from '../../csv/table.js';
import { builtInFormat, builtInFormatFor } from './importFormats.js';
import type { SavingsReadDeps } from './views.js';

/**
 * CSV import (the CSV import spec, "Importing", "Reading any bank's CSV", "Overlap rules"; plan
 * decisions 4, 13 to 19). An admin uploads a file for an account; the draft keeps the table for an
 * hour, bound to them; the account's saved settings or a built-in format fill in what they can; the
 * admin maps the columns and says what each group of rows means; Import re-checks everything in one
 * transaction, records the import, and saves the settings. Undo deletes the record and, by cascade,
 * its rows. Logs carry ids, counts, and the format id: nothing from the file.
 */

const SAVINGS_PREVIEW_TTL_MS = 60 * 60 * 1000;
/** How many imports Savings settings lists per account. */
const SAVINGS_IMPORT_HISTORY = 10;

export interface SavingsImportDeps extends SavingsReadDeps {
  logger: Logger;
  /**
   * False when the server has no Plaid: a linked account's imports and saved settings are left out
   * of the settings view then, so they're refused here too (the routes set it). Unset: allowed.
   */
  plaidConfigured?: boolean;
}

/** A draft id: 16 random bytes, base64url, as Spend's. */
export function isSavingsPreviewId(text: string): boolean {
  return /^[A-Za-z0-9_-]{22}$/.test(text);
}

function liveAccount(db: DbOrTx, accountId: number, deps: Pick<SavingsImportDeps, 'plaidConfigured'>): SavingsAccountRow {
  const row = db.select().from(savingsAccounts).where(eq(savingsAccounts.id, accountId)).get();
  if (!row || row.removedAt !== null) throw new AppError('not_found', SAVINGS_MESSAGES.accountNotFound);
  if (deps.plaidConfigured === false && row.source === 'plaid') throw new AppError('not_found', SAVINGS_MESSAGES.linkedNeedsPlaid);
  return row;
}

function today(deps: SavingsReadDeps): string {
  return localDate(deps.clock.now(), getFamilySettings(deps.db).timeZone);
}

const sameHeader = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((h, i) => h === b[i]);

/** The same mapping, field by field (key order doesn't matter). */
function sameMapping(a: SavingsMapping, b: SavingsMapping): boolean {
  const canon = (m: SavingsMapping) => JSON.stringify([
    m.date.column, m.date.format,
    m.amount.kind === 'signed' ? ['signed', m.amount.column, m.amount.inIsNegative] : ['split', m.amount.debit, m.amount.credit],
    m.balance ? [m.balance.column, m.balance.isValue] : null, m.description,
  ]);
  return canon(a) === canon(b);
}

/** `fidelity_*` when the header and mapping are exactly a built-in format's, else `custom` (plan decision 2). */
function formatOf(header: readonly string[], mapping: SavingsMapping): SavingsImportFormat {
  const builtIn = builtInFormatFor(header);
  return builtIn && sameMapping(builtIn.mapping, mapping) ? builtIn.id : 'custom';
}

function tableOf(plan: SavingsImportDraftPlan): CsvTable {
  return { header: plan.header, rows: plan.rows };
}

/** The mapped rows; the mapping was checked when it was set, so a failure here is a bug. */
function mappedRows(deps: SavingsReadDeps, plan: SavingsImportDraftPlan): ReadRow[] {
  const read = readMapped(tableOf(plan), plan.mapping!, today(deps));
  if (!read.ok) throw new AppError('validation', read.message);
  return read.rows;
}

/** Fidelity's warnings (plan decision 19): its format on the other kind of account, or a file named for another account. */
function warningsFor(account: SavingsAccountRow, format: SavingsImportFormat, fileName: string | null): SavingsImportResults['warnings'] {
  const out: SavingsImportResults['warnings'] = [];
  if (format === 'fidelity_cash' && account.kind === 'investment') out.push({ id: 'format', message: SAVINGS_MESSAGES.importCashFormatOnInvestment(account.nickname) });
  if (format === 'fidelity_brokerage' && account.kind === 'cash') out.push({ id: 'format', message: SAVINGS_MESSAGES.importBrokerageFormatOnCash(account.nickname) });
  if (format !== 'custom') {
    const digits = (fileName ? /^History_for_Account_([A-Za-z0-9-]+)\.csv$/i.exec(fileName)?.[1] ?? '' : '').replace(/\D/g, '');
    if (account.mask && digits.length >= 4 && !digits.endsWith(account.mask)) {
      out.push({ id: 'account_mismatch', message: SAVINGS_MESSAGES.importAccountMismatch(digits.slice(-4), account.mask) });
    }
  }
  return out;
}

interface Weighed {
  flows: ReadPlan['flows'];
  balances: ReadPlan['balances'];
  already: Record<SavingsFlowKind, number>;
  balancesSkipped: number;
}

/** What importing `plan` now would add, against what's stored: earlier imports' keys, Plaid's flows, the account's balances. */
function weigh(db: DbOrTx, account: SavingsAccountRow, plan: ReadPlan): Weighed {
  const keys = new Set(
    db.select({ key: savingsFlows.plaidId }).from(savingsFlows).where(and(eq(savingsFlows.accountId, account.id), eq(savingsFlows.source, 'csv'))).all().map((r) => r.key),
  );
  const fresh = plan.flows.filter((f) => !keys.has(f.key));
  const dates = fresh.map((f) => f.date).sort();
  const plaid = dates.length === 0 ? [] : db
    .select({ id: savingsFlows.id, date: savingsFlows.date, kind: savingsFlows.kind, cents: savingsFlows.amountCents })
    .from(savingsFlows)
    .where(and(
      eq(savingsFlows.accountId, account.id), inArray(savingsFlows.source, ['transactions', 'investments']),
      gte(savingsFlows.date, addDays(dates[0]!, -PLAID_TWIN_DAYS)), lte(savingsFlows.date, addDays(dates.at(-1)!, PLAID_TWIN_DAYS)),
    ))
    .all();
  const covered = plaidTwins(fresh, plaid);
  const flows = fresh.filter((_, i) => !covered.has(i));
  const existing = db.select({ date: savingsBalances.date, source: savingsBalances.source }).from(savingsBalances).where(eq(savingsBalances.accountId, account.id)).all();
  const balances = importableBalances(plan.balances, existing);
  const already = (k: SavingsFlowKind) => plan.flows.filter((f) => f.kind === k).length - flows.filter((f) => f.kind === k).length;
  return { flows, balances: balances.add, already: { deposit: already('deposit'), withdrawal: already('withdrawal') }, balancesSkipped: balances.skipped };
}

/** Every group of the mapped rows has a choice. */
function decided(rows: readonly ReadRow[], choices: SavingsGroupChoices): boolean {
  return groupsOf(rows).every((g) => choices[g.label] !== undefined);
}

/** What the groups step starts a group with that has no choice yet: the built-in format's rule when the draft is one, else the account kind's default. */
function suggestionFor(format: SavingsImportFormat, kind: SavingsAccountRow['kind'], label: string): SavingsGroupChoice {
  const builtIn = builtInFormat(format);
  return builtIn ? builtIn.rules[label] ?? builtIn.otherwise : defaultChoice(kind, label);
}

/** The draft as the web sees it: the sample and columns, the groups once mapped, and the results once every group is decided. */
function draftView(deps: SavingsReadDeps, row: SavingsImportPreviewRow, account: SavingsAccountRow, extra: { suggested: SavingsMapping | null; problem: string | null }): SavingsImportDraft {
  const plan = row.plan;
  let groups: SavingsImportDraft['groups'] = null;
  let results: SavingsImportDraft['results'] = null;
  if (plan.mapping) {
    const rows = mappedRows(deps, plan);
    groups = groupsOf(rows).map((g) => ({ ...g, choice: plan.choices[g.label] ?? null, suggested: plan.choices[g.label] ?? suggestionFor(row.layout, account.kind, g.label) }));
    if (!plan.groupsPending && decided(rows, plan.choices)) {
      const w = weigh(deps.db, account, readRows(account.id, account.kind, rows, plan.mapping, plan.choices));
      const added = (k: SavingsFlowKind) => w.flows.filter((f) => f.kind === k).length;
      const dates = rows.map((r) => r.date).sort();
      results = {
        dateRange: { from: dates[0]!, to: dates.at(-1)! },
        deposits: { add: added('deposit'), already: w.already.deposit },
        withdrawals: { add: added('withdrawal'), already: w.already.withdrawal },
        balances: { add: w.balances.length, skipped: w.balancesSkipped },
        warnings: warningsFor(account, row.layout, row.fileName),
      };
    }
  }
  return {
    id: row.id,
    account: { id: account.id, nickname: account.nickname, kind: account.kind },
    fileName: row.fileName,
    rows: plan.rows.length,
    header: plan.header,
    sample: plan.rows.slice(0, SAVINGS_SAMPLE_ROWS).map((r) => r.cells),
    dateFormats: plan.header.map((_, c) => dateFormatsOf(plan.rows.map((r) => r.cells[c]!))),
    format: row.layout,
    prefilled: plan.prefilled ?? 'guess',
    ...extra,
    mapping: plan.mapping,
    groups,
    results,
    expiresAt: row.expiresAt.toISOString(),
  };
}

/** Expired drafts go on every upload, and with the `savings.pruneImports` job. */
export function pruneSavingsImportPreviews(deps: Pick<SavingsReadDeps, 'db' | 'clock'>): number {
  return deps.db.delete(savingsImportPreviews).where(lte(savingsImportPreviews.expiresAt, deps.clock.now())).run().changes;
}

/**
 * The upload: finds the table, then fills in what it can (plan decisions 13 to 15). The account's
 * saved settings first, when the header matches and their mapping fits; then a built-in format by
 * its header; else a suggested mapping for the admin to confirm. Replaces the admin's earlier draft.
 */
export function startSavingsImport(deps: SavingsImportDeps, userId: number, input: { accountId: number; fileName: string | null; bytes: Uint8Array }): SavingsImportDraft {
  const account = liveAccount(deps.db, input.accountId, deps);
  const fileName = cleanFileName(input.fileName);
  const text = decodeCsv(input.bytes);
  const found = text === null ? { ok: false as const, message: CSV_TABLE_MESSAGES.notText } : findCsvTable(text);
  if (!found.ok) {
    deps.logger.info({ accountId: account.id, bytes: input.bytes.length }, 'savings csv refused');
    throw new AppError('validation', found.message);
  }
  const table = found.table;
  const profile = deps.db.select().from(savingsImportProfiles).where(eq(savingsImportProfiles.accountId, account.id)).get();
  const builtIn = builtInFormatFor(table.header);
  let mapping: SavingsMapping | null = null;
  let choices: SavingsGroupChoices = {};
  let prefilled: SavingsImportDraft['prefilled'] = 'guess';
  let suggested: SavingsMapping | null = null;
  let problem: string | null = null;
  const fits = (m: SavingsMapping) => readMapped(table, m, today(deps));
  if (profile && sameHeader(profile.header, table.header)) {
    prefilled = 'profile';
    const read = fits(profile.mapping);
    if (read.ok) {
      mapping = profile.mapping;
      // Only the groups in this file: Import merges these into the profile as it is then, so a label
      // the file doesn't have never carries a stale copy over an Edit made meanwhile.
      choices = Object.fromEntries(groupsOf(read.rows).filter((g) => profile.choices[g.label] !== undefined).map((g) => [g.label, profile.choices[g.label]!]));
    } else {
      suggested = profile.mapping;
      problem = SAVINGS_MESSAGES.savedMappingDoesntFit(read.message);
    }
  } else if (builtIn) {
    prefilled = 'builtin';
    const read = fits(builtIn.mapping);
    if (read.ok) {
      mapping = builtIn.mapping;
      choices = choicesFor(groupsOf(read.rows), builtIn);
    } else {
      suggested = builtIn.mapping;
      problem = SAVINGS_MESSAGES.savedMappingDoesntFit(read.message);
    }
  } else {
    suggested = guessMapping(table, account.kind);
  }
  const now = deps.clock.now();
  const row: SavingsImportPreviewRow = {
    id: randomBytes(16).toString('base64url'),
    userId,
    accountId: account.id,
    fileName,
    fileSha256: createHash('sha256').update(input.bytes).digest('hex'),
    layout: mapping ? formatOf(table.header, mapping) : builtIn?.id ?? 'custom',
    plan: { header: table.header, rows: table.rows, mapping, choices, prefilled },
    createdAt: now,
    expiresAt: new Date(now.getTime() + SAVINGS_PREVIEW_TTL_MS),
  };
  deps.db.transaction((tx) => {
    tx.delete(savingsImportPreviews).where(eq(savingsImportPreviews.userId, userId)).run();
    tx.insert(savingsImportPreviews).values(row).run();
  });
  pruneSavingsImportPreviews(deps);
  deps.logger.info({ accountId: account.id, format: row.layout, prefilled, rows: table.rows.length, columns: table.header.length, fits: problem === null }, 'savings csv draft');
  return draftView(deps, row, account, { suggested, problem });
}

function requireDraft(db: DbOrTx, userId: number, id: string, now: Date): SavingsImportPreviewRow {
  const row = db.select().from(savingsImportPreviews)
    .where(and(eq(savingsImportPreviews.id, id), eq(savingsImportPreviews.userId, userId), gt(savingsImportPreviews.expiresAt, now)))
    .get();
  if (!row) throw new AppError('not_found', SAVINGS_MESSAGES.importNotFound);
  return row;
}

/**
 * The columns step (a mapping alone), or the groups step (the mapping and every group's choice). A
 * columns-only answer keeps the draft's choices for groups still in the file, whatever the mapping
 * (a saved or edited choice is never reset to a built-in rule), leaves a new group undecided with
 * a suggestion, and always goes back to the groups step (plan decision 14): no results and no
 * Import until the choices are sent. A mapping that doesn't fit is refused with its line number,
 * and the draft is unchanged.
 */
export function updateSavingsImport(deps: SavingsImportDeps, userId: number, id: string, input: SavingsImportUpdate): SavingsImportDraft {
  const row = requireDraft(deps.db, userId, id, deps.clock.now());
  const account = liveAccount(deps.db, row.accountId, deps);
  const read = readMapped(tableOf(row.plan), input.mapping, today(deps));
  if (!read.ok) throw new AppError('validation', read.message);
  const labels = groupsOf(read.rows).map((g) => g.label);
  let choices: SavingsGroupChoices;
  if (input.choices) {
    if (labels.some((l) => input.choices![l] === undefined)) throw new AppError('validation', SAVINGS_MESSAGES.importChooseEvery);
    choices = Object.fromEntries(labels.map((l) => [l, input.choices![l]!]));
  } else {
    choices = Object.fromEntries(labels.filter((l) => row.plan.choices[l] !== undefined).map((l) => [l, row.plan.choices[l]!]));
  }
  const plan: SavingsImportDraftPlan = { ...row.plan, mapping: input.mapping, choices, groupsPending: input.choices === undefined };
  const next: SavingsImportPreviewRow = { ...row, layout: formatOf(row.plan.header, input.mapping), plan };
  deps.db.update(savingsImportPreviews).set({ layout: next.layout, plan: next.plan }).where(eq(savingsImportPreviews.id, row.id)).run();
  return draftView(deps, next, account, { suggested: null, problem: null });
}

/** Import: what the draft still adds, recorded as one import, and the account's settings saved, in one transaction. Answers the line Savings settings shows. */
export function commitSavingsImport(deps: SavingsImportDeps, userId: number, id: string): string {
  const now = deps.clock.now();
  const r = deps.db.transaction((tx) => {
    const draft = requireDraft(tx, userId, id, now);
    const account = liveAccount(tx, draft.accountId, deps);
    const mapping = draft.plan.mapping;
    if (!mapping) throw new AppError('validation', SAVINGS_MESSAGES.importNotReady);
    const rows = mappedRows(deps, draft.plan);
    if (draft.plan.groupsPending || !decided(rows, draft.plan.choices)) throw new AppError('validation', SAVINGS_MESSAGES.importNotReady);
    const w = weigh(tx, account, readRows(account.id, account.kind, rows, mapping, draft.plan.choices));
    if (w.flows.length === 0 && w.balances.length === 0) throw new AppError('validation', SAVINGS_MESSAGES.importNothingNew);
    const deposits = w.flows.filter((f) => f.kind === 'deposit').length;
    const withdrawals = w.flows.length - deposits;
    const skipped = w.already.deposit + w.already.withdrawal + w.balancesSkipped;
    // The file's own first and last day (every mapped row, stored or not): the months it covers.
    const days = rows.map((r) => r.date).sort();
    const record = tx.insert(savingsImports).values({
      accountId: account.id, fileName: draft.fileName, fileSha256: draft.fileSha256, layout: draft.layout, uploadedByUserId: userId, uploadedAt: now,
      depositsAdded: deposits, withdrawalsAdded: withdrawals, balancesAdded: w.balances.length, skipped,
      firstDate: days[0] ?? null, lastDate: days.at(-1) ?? null,
    }).returning().get();
    for (const f of w.flows) {
      tx.insert(savingsFlows).values({ accountId: account.id, source: 'csv', plaidId: f.key, date: f.date, kind: f.kind, amountCents: f.cents, importId: record.id, createdAt: now, updatedAt: now }).run();
    }
    for (const b of w.balances) {
      tx.insert(savingsBalances).values({ accountId: account.id, date: b.date, currentCents: b.cents, availableCents: null, fetchedAt: now, source: 'csv', importId: record.id }).run();
    }
    // The account's settings (plan decision 16), read now inside the transaction: the same header keeps
    // the profile's choices as they are now, with this file's groups (and only them) over them.
    const old = tx.select().from(savingsImportProfiles).where(eq(savingsImportProfiles.accountId, account.id)).get();
    const choices = old && sameHeader(old.header, draft.plan.header) ? { ...old.choices, ...draft.plan.choices } : draft.plan.choices;
    const saved = { header: draft.plan.header, format: draft.layout, mapping, choices, updatedByUserId: userId, updatedAt: now };
    tx.insert(savingsImportProfiles).values({ accountId: account.id, ...saved, createdAt: now })
      .onConflictDoUpdate({ target: savingsImportProfiles.accountId, set: saved }).run();
    tx.delete(savingsImportPreviews).where(eq(savingsImportPreviews.id, draft.id)).run();
    return { accountId: account.id, importId: record.id, format: draft.layout, fileName: draft.fileName, deposits, withdrawals, balances: w.balances.length, skipped };
  });
  deps.logger.info(
    { userId, accountId: r.accountId, importId: r.importId, format: r.format, deposits: r.deposits, withdrawals: r.withdrawals, balances: r.balances, skipped: r.skipped },
    'savings csv imported',
  );
  return SAVINGS_MESSAGES.imported(r);
}

/** Cancel: forgets the draft. The same answer whether or not there was one. */
export function cancelSavingsImport(deps: SavingsImportDeps, userId: number, id: string): void {
  deps.db.delete(savingsImportPreviews).where(and(eq(savingsImportPreviews.id, id), eq(savingsImportPreviews.userId, userId))).run();
}

/** Undo: deletes the import's record; its flows and balances go with it (ON DELETE CASCADE). One Plaid or Set balance took over isn't its any more. */
export function undoSavingsImport(deps: SavingsImportDeps, userId: number, accountId: number, importId: number): string {
  const r = deps.db.transaction((tx) => {
    const record = tx.select().from(savingsImports).where(and(eq(savingsImports.id, importId), eq(savingsImports.accountId, accountId))).get();
    if (!record) throw new AppError('not_found', SAVINGS_MESSAGES.importRecordNotFound);
    const owner = tx.select({ source: savingsAccounts.source }).from(savingsAccounts).where(eq(savingsAccounts.id, accountId)).get();
    if (deps.plaidConfigured === false && owner?.source === 'plaid') throw new AppError('not_found', SAVINGS_MESSAGES.linkedNeedsPlaid);
    const flows = tx.select({ n: count() }).from(savingsFlows).where(eq(savingsFlows.importId, importId)).get()!.n;
    const balances = tx.select({ n: count() }).from(savingsBalances).where(eq(savingsBalances.importId, importId)).get()!.n;
    const overlaps = laterSkippingImports(tx, accountId, importId);
    tx.delete(savingsImports).where(eq(savingsImports.id, importId)).run();
    return { fileName: record.fileName, flows, balances, overlaps };
  });
  deps.logger.info({ userId, accountId, importId, flows: r.flows, balances: r.balances, overlaps: r.overlaps }, 'savings csv import undone');
  return SAVINGS_MESSAGES.importUndone(r);
}

/**
 * How many later imports of the account (a higher id) skipped rows as already here: the record's
 * `overlaps` hint. Imports don't keep which rows they skipped or why, so this can over-warn (a skip
 * of Plaid's flow or a hand-set day counts too); it never misses a later import that relied on this one.
 */
function laterSkippingImports(db: DbOrTx, accountId: number, importId: number): number {
  return db.select({ n: count() }).from(savingsImports)
    .where(and(eq(savingsImports.accountId, accountId), gt(savingsImports.id, importId), gt(savingsImports.skipped, 0))).get()!.n;
}

/** These accounts' recent imports, newest first, at most SAVINGS_IMPORT_HISTORY each, with what Undo would delete now. */
export function listSavingsImports(db: Db, accountIds: readonly number[]): SavingsImportRecord[] {
  if (accountIds.length === 0) return [];
  const rows = db
    .select({
      id: savingsImports.id, accountId: savingsImports.accountId, fileName: savingsImports.fileName, format: savingsImports.layout, uploadedAt: savingsImports.uploadedAt,
      uploadedBy: users.displayName, depositsAdded: savingsImports.depositsAdded, withdrawalsAdded: savingsImports.withdrawalsAdded,
      balancesAdded: savingsImports.balancesAdded, skipped: savingsImports.skipped,
    })
    .from(savingsImports)
    .leftJoin(users, eq(users.id, savingsImports.uploadedByUserId))
    .where(inArray(savingsImports.accountId, [...accountIds]))
    .orderBy(desc(savingsImports.uploadedAt), desc(savingsImports.id))
    .all();
  const seen = new Map<number, number>();
  const kept = rows.filter((r) => {
    const n = seen.get(r.accountId) ?? 0;
    seen.set(r.accountId, n + 1);
    return n < SAVINGS_IMPORT_HISTORY;
  });
  const ids = kept.map((r) => r.id);
  const flowsLeft = new Map(ids.length === 0 ? [] : db.select({ id: savingsFlows.importId, n: count() }).from(savingsFlows)
    .where(inArray(savingsFlows.importId, ids)).groupBy(savingsFlows.importId).all().map((r) => [r.id!, r.n] as const));
  const balancesLeft = new Map(ids.length === 0 ? [] : db.select({ id: savingsBalances.importId, n: count() }).from(savingsBalances)
    .where(inArray(savingsBalances.importId, ids)).groupBy(savingsBalances.importId).all().map((r) => [r.id!, r.n] as const));
  // Every import of these accounts that skipped something, for each record's `overlaps` (see laterSkippingImports).
  const skippers = db.select({ id: savingsImports.id, accountId: savingsImports.accountId }).from(savingsImports)
    .where(and(inArray(savingsImports.accountId, [...accountIds]), gt(savingsImports.skipped, 0))).all();
  const overlaps = (r: { id: number; accountId: number }) => skippers.filter((k) => k.accountId === r.accountId && k.id > r.id).length;
  return kept.map((r) => ({
    ...r, uploadedAt: r.uploadedAt.toISOString(), flowsLeft: flowsLeft.get(r.id) ?? 0, balancesLeft: balancesLeft.get(r.id) ?? 0, overlaps: overlaps(r),
  }));
}

/** These accounts' saved import settings, for Savings settings. Groups by label, the no-description group first. */
export function importProfilesOf(db: Db, accountIds: readonly number[]): SavingsImportProfileView[] {
  if (accountIds.length === 0) return [];
  return db.select().from(savingsImportProfiles).where(inArray(savingsImportProfiles.accountId, [...accountIds])).all().map((p) => ({
    accountId: p.accountId, format: p.format, header: p.header, mapping: p.mapping, updatedAt: p.updatedAt.toISOString(),
    groups: Object.entries(p.choices).map(([label, choice]) => ({ label, choice })).sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0)),
  }));
}

function requireProfile(db: DbOrTx, accountId: number) {
  const p = db.select().from(savingsImportProfiles).where(eq(savingsImportProfiles.accountId, accountId)).get();
  if (!p) throw new AppError('not_found', SAVINGS_MESSAGES.profileNotFound);
  return p;
}

/** Edit: new choices for groups already saved (plan decision 16). The mapping changes on the next import. */
export function updateImportProfile(deps: SavingsImportDeps, userId: number, accountId: number, choices: SavingsGroupChoices): void {
  liveAccount(deps.db, accountId, deps);
  const p = requireProfile(deps.db, accountId);
  // Only the profile's own labels: Object.hasOwn, so "constructor" or "__proto__" never passes as one.
  if (Object.keys(choices).some((l) => !Object.hasOwn(p.choices, l))) throw new AppError('validation', SAVINGS_MESSAGES.profileUnknownGroup);
  const now = deps.clock.now();
  deps.db.update(savingsImportProfiles).set({ choices: { ...p.choices, ...choices }, updatedByUserId: userId, updatedAt: now }).where(eq(savingsImportProfiles.id, p.id)).run();
  deps.logger.info({ userId, accountId, groups: Object.keys(choices).length }, 'savings import settings edited');
}

/** Clear: the next import starts from a built-in format or a guess. */
export function clearImportProfile(deps: SavingsImportDeps, userId: number, accountId: number): void {
  liveAccount(deps.db, accountId, deps);
  const p = requireProfile(deps.db, accountId);
  deps.db.delete(savingsImportProfiles).where(eq(savingsImportProfiles.id, p.id)).run();
  deps.logger.info({ userId, accountId }, 'savings import settings cleared');
}
