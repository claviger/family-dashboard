import { and, asc, desc, eq, gte, isNull, lte } from 'drizzle-orm';
import {
  BANK_STALE_AFTER_MS, SPEND_MESSAGES, type BankFreshness, type SpendCycle, type SpendOverview, type SpendPerson, type SpendSummary, type SpendTotals, type SpendTransaction,
  type CarriedField, type DuplicateRemoval, type DuplicateRestore, type TransactionBatchChange, type TransactionPatch,
} from '../../../shared/spend.js';
import { AppError } from '../../core/errors.js';
import type { Db } from '../../db/index.js';
import { cards, transactions, type CardRow, type CategoryRow, type DuplicateCarry, type TransactionRow } from '../../db/schema.js';
import { cardBanks, cardPlan, lastImports, type CardBank } from './cards.js';
import { previousCycle, type Cycle } from './cycles.js';
import { categorize } from './rules.js';
import {
  cardOption, categoriesById, categoryRef, familyToday, includedCards, loadCategorizer, peopleById, requireActivePerson, requireUsableCategory,
  specialCategoryId, type SpendDeps,
} from './store.js';
import { compareBreakdown, totalsOf } from './totals.js';
import { liveTwins, twinIdsOf } from './twins.js';

/**
 * Transactions as people see them (spec §12.10 to §12.12), and the edits anyone with the panel can
 * make: category, person, note, and Reset to automatic. Only included cards' transactions are
 * shown or changed; an excluded card's are kept but hidden until it's included.
 */

/** How many recent transactions the home card shows (spec §12.11). */
export const RECENT_COUNT = 8;

/** The merchant name, or the raw description when there's none. */
const merchantOf = (row: TransactionRow) => (row.merchant && row.merchant.trim() !== '' ? row.merchant : row.rawName);

function toTransaction(row: TransactionRow, cats: Map<number, CategoryRow>, people: Map<number, SpendPerson>, twins: ReadonlyMap<number, number[]>): SpendTransaction {
  return {
    id: row.id,
    cardId: row.cardId,
    source: row.source,
    date: row.date,
    merchant: merchantOf(row),
    rawName: row.rawName,
    amountCents: row.amountCents,
    currency: row.isoCurrencyCode ?? row.unofficialCurrencyCode ?? 'USD',
    pending: row.pending,
    category: categoryRef(cats.get(row.categoryId)!),
    categorySource: row.categorySource,
    person: row.personUserId !== null ? (people.get(row.personUserId) ?? null) : null,
    personSource: row.personSource,
    note: row.note,
    twinIds: twins.get(row.id) ?? [],
  };
}

/** Rows as people see them, with their twins found in one query. */
function toTransactions(db: Db, rows: readonly TransactionRow[]): SpendTransaction[] {
  const cats = categoriesById(db);
  const people = peopleById(db);
  const twins = twinIdsOf(db, rows.map((r) => r.id));
  return rows.map((r) => toTransaction(r, cats, people, twins));
}

function cycleOut(c: Cycle): SpendCycle {
  return { start: c.start, end: c.end, current: c.current, closingSource: c.closing?.source ?? null };
}

/*
 * Reads are by card and date range, on the (card_id, date) index, so a card with years of history
 * costs only the cycles shown. The builders are exported so a test can check the query plan.
 */

/** A card's live transactions dated `from` to `to` (inclusive), newest first. */
export function rowsInRangeQuery(db: Db, cardId: number, from: string, to: string) {
  return db
    .select()
    .from(transactions)
    .where(and(eq(transactions.cardId, cardId), gte(transactions.date, from), lte(transactions.date, to), isNull(transactions.deletedAt)))
    .orderBy(desc(transactions.date), desc(transactions.id));
}

function rowsIn(db: Db, cardId: number, cycle: Pick<Cycle, 'start' | 'end'>): TransactionRow[] {
  return rowsInRangeQuery(db, cardId, cycle.start, cycle.end).all();
}

/** The dates on which a card has live transactions, oldest first: which past cycles have data. */
export function datesWithDataQuery(db: Db, cardId: number) {
  return db
    .select({ date: transactions.date })
    .from(transactions)
    .where(and(eq(transactions.cardId, cardId), isNull(transactions.deletedAt)))
    .groupBy(transactions.date)
    .orderBy(asc(transactions.date));
}

/** A card's latest `limit` live transactions, newest first. */
export function recentRowsQuery(db: Db, cardId: number, limit: number) {
  return db
    .select()
    .from(transactions)
    .where(and(eq(transactions.cardId, cardId), isNull(transactions.deletedAt)))
    .orderBy(desc(transactions.date), desc(transactions.id))
    .limit(limit);
}

/** The latest `limit` across the cards: each card's latest few, merged. */
function recentRows(db: Db, cardIds: number[], limit: number): TransactionRow[] {
  return cardIds
    .flatMap((id) => recentRowsQuery(db, id, limit).all())
    .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id)
    .slice(0, limit);
}

/** Whether any of `dates` (sorted) falls in the cycle. */
function hasDateIn(dates: readonly string[], c: Pick<Cycle, 'start' | 'end'>): boolean {
  let lo = 0;
  let hi = dates.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (dates[mid]! < c.start) lo = mid + 1;
    else hi = mid;
  }
  return lo < dates.length && dates[lo]! <= c.end;
}

/** A row as totals see it: its currency is the official code, or else the unofficial one (Plaid sets one or the other). */
const forTotals = (r: TransactionRow) => ({ ...r, currency: r.isoCurrencyCode ?? r.unofficialCurrencyCode });

/** The card's currency: every total is in it. */
const cardCurrency = (card: CardRow) => card.isoCurrencyCode ?? 'USD';

function totalsFor(db: Db, card: CardRow, current: TransactionRow[], previous: TransactionRow[] | null): SpendTotals {
  const excludedCategoryIds = new Set([specialCategoryId(db, 'excluded')]);
  const opts = { excludedCategoryIds, currency: cardCurrency(card) };
  const now = totalsOf(current.map(forTotals), opts);
  const before = totalsOf((previous ?? []).map(forTotals), opts);
  const cats = categoriesById(db);
  const people = peopleById(db);
  return {
    currency: opts.currency,
    totalCents: now.totalCents,
    pendingCents: now.pendingCents,
    previousCents: previous ? before.totalCents : null,
    otherCurrencyCount: now.otherCurrencyCount,
    byCategory: compareBreakdown(now.byCategory, before.byCategory).map((b) => ({ category: categoryRef(cats.get(b.key)!), cents: b.cents, previousCents: b.previousCents })),
    byPerson: compareBreakdown(now.byPerson, before.byPerson).map((b) => ({
      person: b.key === null ? null : (people.get(b.key) ?? null),
      cents: b.cents,
      previousCents: b.previousCents,
    })),
  };
}

/**
 * When a card's data last changed from its source, and its bank's freshness (the design's
 * "Freshness"): the later of its bank's last saved sync run (`plaid_items.last_sync_at`, not the
 * connection's last success, which a reconnect also sets without bringing any transactions) and its
 * last CSV import, stale after BANK_STALE_AFTER_MS, twice the 6-hour sync (spec §8). A card with
 * no linked bank is never stale.
 */
function freshness(now: Date, imported: Date | undefined, bank: CardBank | undefined): { updatedAt: string | null; bank: BankFreshness | null } {
  const times = [imported, bank?.lastSyncAt ?? undefined].filter((d): d is Date => d !== undefined);
  const latest = times.length === 0 ? null : new Date(Math.max(...times.map((d) => d.getTime())));
  return {
    updatedAt: latest?.toISOString() ?? null,
    bank: bank
      ? {
          itemId: bank.itemId,
          institutionName: bank.institutionName,
          status: bank.status,
          lastSyncAt: bank.lastSyncAt?.toISOString() ?? null,
          stale: latest === null || now.getTime() - latest.getTime() > BANK_STALE_AFTER_MS,
        }
      : null,
  };
}

/** The home card (spec §12.11): each included card's current cycle, and the latest transactions. */
export function spendSummary(deps: SpendDeps): SpendSummary {
  const today = familyToday(deps);
  const now = deps.clock.now();
  const shown = includedCards(deps.db).filter((c) => c.archivedAt === null);
  const imports = lastImports(deps.db);
  const banks = cardBanks(deps.db);
  const excluded = new Set([specialCategoryId(deps.db, 'excluded')]);
  return {
    serverNow: now.toISOString(),
    cards: shown.map((card) => {
      const plan = cardPlan(deps.db, card, today);
      const cycle = plan.cycles.find((c) => c.current)!;
      const t = totalsOf(rowsIn(deps.db, card.id, cycle).map(forTotals), { excludedCategoryIds: excluded, currency: cardCurrency(card) });
      return {
        ...cardOption(card),
        mode: plan.mode,
        cycle: cycleOut(cycle),
        currency: cardCurrency(card),
        totalCents: t.totalCents,
        pendingCents: t.pendingCents,
        otherCurrencyCount: t.otherCurrencyCount,
        ...freshness(now, imports.get(card.id), banks.get(card.id)),
      };
    }),
    recent: toTransactions(deps.db, recentRows(deps.db, shown.map((c) => c.id), RECENT_COUNT)),
  };
}

const EMPTY_TOTALS: SpendTotals = { currency: 'USD', totalCents: 0, pendingCents: 0, previousCents: null, otherCurrencyCount: 0, byCategory: [], byPerson: [] };

/**
 * The drill-down (spec §12.12) for one card and cycle. The card defaults to the first included one
 * that isn't archived; the cycle to the current one. A card or cycle the query names that isn't
 * shown (excluded, gone, or not a cycle start) falls back the same way, so an old link still opens.
 */
export function spendOverview(deps: SpendDeps, query: { card?: number; cycle?: string }): SpendOverview {
  const now = deps.clock.now();
  const serverNow = now.toISOString();
  const shown = includedCards(deps.db);
  const card = shown.find((c) => c.id === query.card) ?? shown.find((c) => c.archivedAt === null) ?? shown[0];
  const base = { serverNow, cards: shown.map(cardOption) };
  if (!card) return { ...base, card: null, mode: 'cycles', cycles: [], cycle: null, previous: null, totals: EMPTY_TOTALS, transactions: [], updatedAt: null, bank: null };

  const plan = cardPlan(deps.db, card, familyToday(deps));
  const cycle = plan.cycles.find((c) => c.start === query.cycle) ?? plan.cycles.find((c) => c.current)!;
  const previous = previousCycle(plan, cycle);
  const inThis = rowsIn(deps.db, card.id, cycle);
  const dates = datesWithDataQuery(deps.db, card.id).all().map((r) => r.date);
  return {
    ...base,
    card: cardOption(card),
    mode: plan.mode,
    // The current cycle, and every past one with transactions.
    cycles: plan.cycles.filter((c) => c.current || c.start === cycle.start || hasDateIn(dates, c)).map(cycleOut),
    cycle: cycleOut(cycle),
    previous: previous ? cycleOut(previous) : null,
    totals: totalsFor(deps.db, card, inThis, previous ? rowsIn(deps.db, card.id, previous) : null),
    transactions: toTransactions(deps.db, inThis),
    ...freshness(now, lastImports(deps.db).get(card.id), cardBanks(deps.db).get(card.id)),
  };
}

/** A transaction that's shown: not deleted, on an included card. */
function findShownTransaction(db: Db, id: number): TransactionRow | undefined {
  return db
    .select({ t: transactions })
    .from(transactions)
    .innerJoin(cards, eq(cards.id, transactions.cardId))
    .where(and(eq(transactions.id, id), isNull(transactions.deletedAt), eq(cards.included, true)))
    .get()?.t;
}

/** A replaced row's chain is followed this far at most: a real one is a hop or two (CSV to Plaid, pending to posted). */
export const MAX_REPLACEMENT_HOPS = 8;

/**
 * For gone rows that something replaced (a Plaid row took a CSV row's place, a posted row its
 * pending version's): the shown row that holds their place now, following `replaced_by_id` through
 * a chain if there is one, at most MAX_REPLACEMENT_HOPS. A row whose chain ends at nothing shown
 * isn't listed. Keys are the old ids.
 */
function replacementsOf(db: Db, ids: readonly number[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of ids) {
    const seen = new Set([id]);
    let next = db.select({ by: transactions.replacedById }).from(transactions).where(eq(transactions.id, id)).get()?.by ?? null;
    for (let hop = 0; next !== null && hop < MAX_REPLACEMENT_HOPS && !seen.has(next); hop++) {
      if (findShownTransaction(db, next)) {
        out[String(id)] = next;
        break;
      }
      seen.add(next);
      next = db.select({ by: transactions.replacedById }).from(transactions).where(eq(transactions.id, next)).get()?.by ?? null;
    }
  }
  return out;
}

function requireShownTransaction(db: Db, id: number): TransactionRow {
  const row = findShownTransaction(db, id);
  if (!row) throw new AppError('not_found', SPEND_MESSAGES.transactionNotFound);
  return row;
}

function shown(db: Db, id: number): SpendTransaction {
  return toTransactions(db, [requireShownTransaction(db, id)])[0]!;
}

/**
 * Sets the category, the person, or the note by hand (spec §12.6, §12.9). A new category can't be
 * an archived one, and a new person must be active. Sending the value a field already has leaves
 * it, and where it came from, alone, so a deactivated person stays on the rows they had.
 */
export function patchTransaction(deps: SpendDeps, id: number, patch: TransactionPatch): SpendTransaction {
  applyPatch(deps, requireShownTransaction(deps.db, id), patch);
  return shown(deps.db, id);
}

/**
 * The drill-down's one Save (spec §12.12): each change is checked and made as `patchTransaction`
 * makes it, all in one database transaction, so a single refusal saves nothing. The saved rows
 * come back in the order sent. Each refusal's `details` (`TransactionBatchProblem`) say which rows,
 * by the ids the client sent, so the page can act on them:
 *
 * - 404 when any transaction is gone or hidden (all of them listed), with `replacedBy` naming the
 *   row that took a gone one's place, so the page can move its draft there (a sync replaced it);
 * - 409 when someone else changed a field since the page saw it (`expected`), unless it already
 *   holds the new value (all of them listed, with what's saved now);
 * - 400 for a value that can't be assigned: an archived category or a deactivated person (the
 *   first one met). The message names the merchant, since the person may have edited many.
 */
export function patchTransactions(deps: SpendDeps, changes: readonly TransactionBatchChange[]): SpendTransaction[] {
  // better-sqlite3 is synchronous on one connection, so every read and write through deps.db in
  // here is inside the transaction, and a throw rolls all of it back.
  return deps.db.transaction(() => {
    const rows = changes.map((c) => findShownTransaction(deps.db, c.id));
    const missingIds = changes.filter((_, i) => !rows[i]).map((c) => c.id);
    if (missingIds.length > 0) {
      const message = missingIds.length === 1 ? SPEND_MESSAGES.transactionNotFound : SPEND_MESSAGES.transactionsNotFound(missingIds.length);
      const replacedBy = replacementsOf(deps.db, missingIds);
      throw new AppError('not_found', message, Object.keys(replacedBy).length > 0 ? { missingIds, replacedBy } : { missingIds });
    }
    const found = rows as TransactionRow[];

    const conflicts: { transactionId: number; field: 'category' | 'person'; current: number | null }[] = [];
    changes.forEach((c, i) => {
      const row = found[i]!;
      const e = c.expected;
      if (c.categoryId !== undefined && e?.categoryId !== undefined && row.categoryId !== e.categoryId && row.categoryId !== c.categoryId) {
        conflicts.push({ transactionId: c.id, field: 'category', current: row.categoryId });
      }
      if (c.personUserId !== undefined && e?.personUserId !== undefined && row.personUserId !== e.personUserId && row.personUserId !== c.personUserId) {
        conflicts.push({ transactionId: c.id, field: 'person', current: row.personUserId });
      }
    });
    if (conflicts.length > 0) {
      const changed = [...new Set(conflicts.map((x) => x.transactionId))];
      const message =
        changed.length === 1
          ? SPEND_MESSAGES.transactionChangedMeanwhile(merchantOf(found[changes.findIndex((c) => c.id === changed[0])]!))
          : SPEND_MESSAGES.transactionsChangedMeanwhile(changed.length);
      throw new AppError('conflict', message, { conflicts });
    }

    changes.forEach((c, i) => {
      const row = found[i]!;
      // Each field is checked on its own first, so the refusal can say which picker it's about.
      const check = (field: 'category' | 'person', run: () => unknown) => {
        try {
          run();
        } catch (err) {
          if (err instanceof AppError && err.code === 'validation') {
            throw new AppError('validation', `${merchantOf(row)}: ${err.message}`, { transactionId: c.id, field, problem: err.message });
          }
          throw err;
        }
      };
      const { categoryId, personUserId } = c;
      if (categoryId !== undefined && categoryId !== row.categoryId) check('category', () => requireUsableCategory(deps.db, categoryId));
      if (personUserId != null && personUserId !== row.personUserId) check('person', () => requireActivePerson(deps.db, personUserId));
      applyPatch(deps, row, { categoryId, personUserId });
    });
    return toTransactions(deps.db, changes.map((c) => requireShownTransaction(deps.db, c.id)));
  });
}

/** The one path both PATCHes take: checks every value given before writing any. */
function applyPatch(deps: SpendDeps, row: TransactionRow, patch: TransactionPatch): void {
  const id = row.id;
  const set: Partial<typeof transactions.$inferInsert> = { updatedAt: deps.clock.now() };
  // A value that's already there changes nothing, so its source stays (a rule's stays a rule's).
  if (patch.categoryId !== undefined && patch.categoryId !== row.categoryId) {
    requireUsableCategory(deps.db, patch.categoryId);
    Object.assign(set, { categoryId: patch.categoryId, categorySource: 'manual' });
  }
  if (patch.personUserId !== undefined && patch.personUserId !== row.personUserId) {
    if (patch.personUserId !== null) requireActivePerson(deps.db, patch.personUserId);
    Object.assign(set, { personUserId: patch.personUserId, personSource: 'manual' });
  }
  if (patch.note !== undefined) set.note = patch.note === null || patch.note.trim() === '' ? null : patch.note.trim();
  deps.db.update(transactions).set(set).where(eq(transactions.id, id)).run();
}

/**
 * Reset to automatic (spec §12.9): decides each field given again, whatever it holds: a value set by
 * hand, or one that can't be assigned any more, which deciding again otherwise keeps. A field not
 * named stays exactly as it is.
 */
export function resetTransaction(deps: SpendDeps, id: number, fields: ('category' | 'person')[]): SpendTransaction {
  const row = requireShownTransaction(deps.db, id);
  const next = categorize(row, row, loadCategorizer(deps.db), fields);
  // Only the fields named: categorize decides the other again too, unless it's kept.
  const set: Partial<typeof transactions.$inferInsert> = { updatedAt: deps.clock.now() };
  if (fields.includes('category')) Object.assign(set, { categoryId: next.categoryId, categorySource: next.categorySource });
  if (fields.includes('person')) Object.assign(set, { personUserId: next.personUserId, personSource: next.personSource });
  deps.db.update(transactions).set(set).where(eq(transactions.id, id)).run();
  return shown(deps.db, id);
}

/** A transaction on an included card, deleted or not: what Remove duplicate and its Undo act on. */
function findOnShownCard(db: Db, id: number): TransactionRow {
  const row = db
    .select({ t: transactions })
    .from(transactions)
    .innerJoin(cards, eq(cards.id, transactions.cardId))
    .where(and(eq(transactions.id, id), eq(cards.included, true)))
    .get()?.t;
  if (!row) throw new AppError('not_found', SPEND_MESSAGES.transactionNotFound);
  return row;
}

/** The fields a carry names, in a fixed order. */
const carriedFields = (carry: DuplicateCarry): CarriedField[] =>
  (['category', 'person', 'note'] as const).filter((f) => (f === 'category' ? carry.categoryId !== undefined : f === 'person' ? 'personUserId' in carry : carry.note !== undefined));

/**
 * Remove duplicate (spec §12.12, admins): soft-deletes a shown transaction that has a live twin
 * (same card, date, and amount), recording why (`deleted_reason` 'duplicate') and the twin it was
 * removed against (`duplicate_of_id`, the lowest id when there are several). With exactly one
 * twin, its manual category, manual person, and note are copied to the twin where the twin has none
 * of its own yet (as a replacement copies a CSV row's, §12.13), and what was copied is kept
 * (`duplicate_carry`) for Undo. All in one transaction. 409 when it's already deleted or has no twin.
 */
export function removeDuplicate(deps: SpendDeps, id: number): DuplicateRemoval {
  const result = deps.db.transaction((tx) => {
    const row = findOnShownCard(deps.db, id);
    if (row.deletedAt !== null) throw new AppError('conflict', SPEND_MESSAGES.duplicateAlreadyRemoved);
    const twins = liveTwins(tx, row);
    if (twins.length === 0) throw new AppError('conflict', SPEND_MESSAGES.duplicateNoTwin);
    const now = deps.clock.now();
    const carry: DuplicateCarry = {};
    const twin = twins.length === 1 ? twins[0]! : null;
    if (twin) {
      const set: Partial<typeof transactions.$inferInsert> = {};
      if (row.categorySource === 'manual' && twin.categorySource !== 'manual') {
        Object.assign(set, { categoryId: row.categoryId, categorySource: 'manual' });
        carry.categoryId = row.categoryId;
      }
      if (row.personSource === 'manual' && twin.personSource !== 'manual') {
        Object.assign(set, { personUserId: row.personUserId, personSource: 'manual' });
        carry.personUserId = row.personUserId;
      }
      if (row.note !== null && twin.note === null) {
        set.note = row.note;
        carry.note = row.note;
      }
      if (Object.keys(set).length > 0) tx.update(transactions).set({ ...set, updatedAt: now }).where(eq(transactions.id, twin.id)).run();
    }
    const copied = carriedFields(carry);
    tx.update(transactions)
      .set({ deletedAt: now, deletedReason: 'duplicate', duplicateOfId: twin?.id ?? twins[0]!.id, duplicateCarry: copied.length > 0 ? carry : null, updatedAt: now })
      .where(eq(transactions.id, row.id))
      .run();
    return { id: row.id, copiedTo: copied.length > 0 ? twin!.id : null, copied };
  });
  deps.logger.info({ transactionId: id, copiedTo: result.copiedTo, copied: result.copied }, 'spend duplicate removed');
  return result;
}

/**
 * Undo of Remove duplicate (admins): the row comes back (`deleted_at`, the reason, the twin, and
 * the carry cleared), and each field it copied to its twin is taken back, only where the twin still
 * holds exactly the copied value: a category or person is decided again (as Remove rule decides it),
 * a note is cleared. A field someone changed on the twin since stays as they left it. 409 when the
 * row isn't a removed duplicate, or the bank has removed it since, or something replaced it.
 */
export function restoreDuplicate(deps: SpendDeps, id: number): DuplicateRestore {
  const reverted = deps.db.transaction((tx) => {
    const row = findOnShownCard(deps.db, id);
    if (row.deletedAt === null || row.deletedReason !== 'duplicate' || row.replacedById !== null) throw new AppError('conflict', SPEND_MESSAGES.duplicateNotRemoved);
    if (row.removedAt !== null) throw new AppError('conflict', SPEND_MESSAGES.duplicateBankRemoved);
    // Its import was undone: nothing could remove it again, so it stays gone with that import.
    if (row.source === 'csv' && row.csvImportId === null) throw new AppError('conflict', SPEND_MESSAGES.duplicateImportUndone);
    const now = deps.clock.now();
    const carry = row.duplicateCarry;
    const back: CarriedField[] = [];
    const twin = carry && row.duplicateOfId !== null ? tx.select().from(transactions).where(eq(transactions.id, row.duplicateOfId)).get() : undefined;
    if (carry && twin) {
      if (carry.categoryId !== undefined && twin.categorySource === 'manual' && twin.categoryId === carry.categoryId) back.push('category');
      if ('personUserId' in carry && twin.personSource === 'manual' && twin.personUserId === carry.personUserId) back.push('person');
      if (carry.note !== undefined && twin.note === carry.note) back.push('note');
      const fields = back.filter((f): f is 'category' | 'person' => f !== 'note');
      const set: Partial<typeof transactions.$inferInsert> = {};
      if (fields.length > 0) {
        const next = categorize(twin, twin, loadCategorizer(deps.db), fields);
        if (fields.includes('category')) Object.assign(set, { categoryId: next.categoryId, categorySource: next.categorySource });
        if (fields.includes('person')) Object.assign(set, { personUserId: next.personUserId, personSource: next.personSource });
      }
      if (back.includes('note')) set.note = null;
      if (Object.keys(set).length > 0) tx.update(transactions).set({ ...set, updatedAt: now }).where(eq(transactions.id, twin.id)).run();
    }
    tx.update(transactions)
      .set({ deletedAt: null, deletedReason: null, duplicateOfId: null, duplicateCarry: null, updatedAt: now })
      .where(eq(transactions.id, row.id))
      .run();
    return back;
  });
  deps.logger.info({ transactionId: id, reverted }, 'spend duplicate restored');
  return { transaction: shown(deps.db, id), reverted };
}
