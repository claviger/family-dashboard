import { and, asc, count, eq, isNotNull, isNull, max, min, ne } from 'drizzle-orm';
import { daysBetween } from '../../../shared/dates.js';
import { SPEND_MESSAGES, type Card, type CardStatements, type CardInput } from '../../../shared/spend.js';
import { AppError } from '../../core/errors.js';
import type { Db } from '../../db/index.js';
import { cards, connections, csvImports, plaidItems, rules, statements, transactions, type CardRow, type ConnectionRow, type StatementRow } from '../../db/schema.js';
import { isUniqueViolation } from '../todo/internalBackend.js';
import { EARLIEST_DATE } from './bofa.js';
import { planCycles, type CyclePlan } from './cycles.js';
import { cardOption, familyToday, requireCard, type SpendDeps } from './store.js';

/** Cards and their closing dates (spec §12.2, §12.4). Admins only; the routes check the role. */

/** The furthest ahead a manual closing date may be: about two statements. */
const CLOSING_MAX_DAYS_AHEAD = 62;

/** When a CSV was last imported into each card: "Updated X ago" for a card with only CSV data. */
export function lastImports(db: Db): Map<number, Date> {
  return new Map(
    db
      .select({ cardId: csvImports.cardId, at: max(csvImports.uploadedAt) })
      .from(csvImports)
      .groupBy(csvImports.cardId)
      .all()
      .filter((r) => r.at !== null)
      .map((r) => [r.cardId, r.at!]),
  );
}

/**
 * A linked card's bank, for "Updated X ago" and the stale warning (the design's "Freshness").
 * `lastSyncAt` is the Item's last saved sync run: the connection's `last_success_at` also moves
 * for a reconnect, which brings no transactions, so it isn't what "Updated" means.
 */
export interface CardBank {
  itemId: number;
  institutionName: string | null;
  status: ConnectionRow['status'];
  lastSyncAt: Date | null;
}

/**
 * Each card attached to a bank that's still linked: card id to its bank's state. A card whose bank
 * was removed (`cards.removed_at`) has none: its data no longer changes.
 */
export function cardBanks(db: Db): Map<number, CardBank> {
  return new Map(
    db
      .select({
        cardId: cards.id, itemId: plaidItems.id, institutionName: plaidItems.institutionName, lastSyncAt: plaidItems.lastSyncAt,
        status: connections.status,
      })
      .from(cards)
      .innerJoin(plaidItems, eq(plaidItems.id, cards.plaidItemId))
      .innerJoin(connections, eq(connections.id, plaidItems.connectionId))
      .where(and(isNotNull(cards.plaidAccountId), isNull(cards.removedAt), isNull(plaidItems.removedAt)))
      .all()
      .map(({ cardId, ...bank }) => [cardId, bank]),
  );
}

export function listCards(db: Db): Card[] {
  const counts = new Map(
    db
      .select({ cardId: transactions.cardId, n: count() })
      .from(transactions)
      .where(isNull(transactions.deletedAt))
      .groupBy(transactions.cardId)
      .all()
      .map((r) => [r.cardId, r.n]),
  );
  // Deleted transactions aren't counted, but they still keep a card from being deleted.
  const everUsed = new Set(db.selectDistinct({ cardId: transactions.cardId }).from(transactions).all().map((r) => r.cardId));
  const inRules = new Set(db.selectDistinct({ cardId: rules.cardId }).from(rules).all().map((r) => r.cardId));
  const imports = lastImports(db);
  return db
    .select()
    .from(cards)
    .orderBy(asc(cards.nickname), asc(cards.id))
    .all()
    .sort((a, b) => Number(a.archivedAt !== null) - Number(b.archivedAt !== null))
    .map((row) => {
      // The same order as deleteCard's checks.
      const deleteBlocker = everUsed.has(row.id) ? ('transactions' as const) : inRules.has(row.id) ? ('rules' as const) : null;
      return {
        ...cardOption(row),
        included: row.included,
        usualClosingDay: row.usualClosingDay,
        plaidLinked: row.plaidAccountId !== null && row.removedAt === null,
        bankRemovedAt: row.removedAt?.toISOString() ?? null,
        transactionCount: counts.get(row.id) ?? 0,
        lastImportAt: imports.get(row.id)?.toISOString() ?? null,
        deletable: deleteBlocker === null,
        deleteBlocker,
      };
    });
}

function toCard(db: Db, id: number): Card {
  return listCards(db).find((c) => c.id === id)!;
}

/** `input` is CardInputSchema's output. */
export function createCard(deps: SpendDeps, input: Required<CardInput> & { mask: string | null }): Card {
  const now = deps.clock.now();
  const row = deps.db
    .insert(cards)
    .values({ nickname: input.nickname, mask: input.mask, included: input.included, usualClosingDay: input.usualClosingDay, createdAt: now, updatedAt: now })
    .returning()
    .get();
  return toCard(deps.db, row.id);
}

export function updateCard(deps: SpendDeps, id: number, input: Required<CardInput> & { mask: string | null }): Card {
  requireCard(deps.db, id);
  deps.db
    .update(cards)
    .set({ nickname: input.nickname, mask: input.mask, included: input.included, usualClosingDay: input.usualClosingDay, updatedAt: deps.clock.now() })
    .where(eq(cards.id, id))
    .run();
  return toCard(deps.db, id);
}

export function setCardArchived(deps: SpendDeps, id: number, archived: boolean): Card {
  const row = requireCard(deps.db, id);
  if ((row.archivedAt !== null) !== archived) {
    const now = deps.clock.now();
    deps.db.update(cards).set({ archivedAt: archived ? now : null, updatedAt: now }).where(eq(cards.id, id)).run();
  }
  return toCard(deps.db, id);
}

/**
 * Deletes a card that has never had a transaction (decision: one with transactions is archived
 * instead). Its closing dates and import records go with it; a rule that names it blocks it.
 */
export function deleteCard(deps: SpendDeps, id: number): void {
  requireCard(deps.db, id);
  deps.db.transaction((tx) => {
    if (tx.select({ id: transactions.id }).from(transactions).where(eq(transactions.cardId, id)).limit(1).get()) {
      throw new AppError('conflict', SPEND_MESSAGES.cardHasTransactions);
    }
    if (tx.select({ id: rules.id }).from(rules).where(eq(rules.cardId, id)).limit(1).get()) throw new AppError('conflict', SPEND_MESSAGES.cardInRules);
    tx.delete(statements).where(eq(statements.cardId, id)).run();
    tx.delete(csvImports).where(eq(csvImports.cardId, id)).run();
    tx.delete(cards).where(eq(cards.id, id)).run();
  });
}

/** The card's known closing dates (manual and, from 6b, Plaid). */
function knownStatements(db: Db, cardId: number): StatementRow[] {
  return db
    .select()
    .from(statements)
    .where(and(eq(statements.cardId, cardId), ne(statements.source, 'inferred')))
    .orderBy(asc(statements.closingDate))
    .all();
}

/** The card's billing cycles today (spec §12.4). */
export function cardPlan(db: Db, card: CardRow, today: string): CyclePlan {
  const known = knownStatements(db, card.id).map((s) => ({ date: s.closingDate, source: s.source === 'plaid' ? ('plaid' as const) : ('manual' as const) }));
  const range = db
    .select({ earliest: min(transactions.date), latest: max(transactions.date) })
    .from(transactions)
    .where(and(eq(transactions.cardId, card.id), isNull(transactions.deletedAt)))
    .get();
  return planCycles({
    usualClosingDay: card.usualClosingDay, known, earliestDate: range?.earliest ?? null, latestDate: range?.latest ?? null, today,
  });
}

/**
 * The closing dates Spend settings lists: every one that ends a cycle with data, and the one that
 * ends the current cycle, newest first. Inferred ones have no id; editing one is adding a manual date.
 * Known dates outside that range are listed too, so they can be fixed.
 */
export function cardStatements(deps: SpendDeps, cardId: number): CardStatements {
  const card = requireCard(deps.db, cardId);
  const plan = cardPlan(deps.db, card, familyToday(deps));
  const rows = knownStatements(deps.db, cardId);
  const ids = new Map(rows.map((s) => [s.closingDate, s.id]));
  const ending = new Set(plan.cycles.map((c) => c.closing?.date).filter((d): d is string => d !== undefined));
  const closings = plan.closings
    .filter((c) => c.source !== 'inferred' || ending.has(c.date))
    .map((c) => ({ id: c.source === 'inferred' ? null : (ids.get(c.date) ?? null), date: c.date, source: c.source }))
    .reverse();
  return { mode: plan.mode, closingDay: plan.closingDay, closings };
}

/**
 * A manual closing date is from 2000 on, like a CSV row's posted date (a year like 0001 would make
 * thousands of inferred months), and at most two months ahead.
 */
function checkClosingDate(deps: SpendDeps, date: string): void {
  if (date < EARLIEST_DATE) throw new AppError('validation', SPEND_MESSAGES.closingTooEarly);
  if (daysBetween(familyToday(deps), date) > CLOSING_MAX_DAYS_AHEAD) throw new AppError('validation', SPEND_MESSAGES.closingTooLate);
}

export function addClosingDate(deps: SpendDeps, cardId: number, closingDate: string): CardStatements {
  requireCard(deps.db, cardId);
  checkClosingDate(deps, closingDate);
  const now = deps.clock.now();
  try {
    deps.db.insert(statements).values({ cardId, closingDate, source: 'manual', createdAt: now, updatedAt: now }).run();
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError('conflict', SPEND_MESSAGES.closingExists);
    throw err;
  }
  return cardStatements(deps, cardId);
}

function requireStatement(db: Db, id: number): StatementRow {
  const row = db.select().from(statements).where(eq(statements.id, id)).get();
  if (!row) throw new AppError('not_found', SPEND_MESSAGES.closingNotFound);
  return row;
}

/** Changes a closing date. One that came from the bank becomes a manual date (spec §12.4). */
export function editClosingDate(deps: SpendDeps, id: number, closingDate: string): CardStatements {
  const row = requireStatement(deps.db, id);
  checkClosingDate(deps, closingDate);
  try {
    deps.db.update(statements).set({ closingDate, source: 'manual', updatedAt: deps.clock.now() }).where(eq(statements.id, id)).run();
  } catch (err) {
    if (isUniqueViolation(err)) throw new AppError('conflict', SPEND_MESSAGES.closingExists);
    throw err;
  }
  return cardStatements(deps, row.cardId);
}

/** Deletes a manual closing date. A bank's would only come back with the next sync, so it can be edited instead. */
export function deleteClosingDate(deps: SpendDeps, id: number): CardStatements {
  const row = requireStatement(deps.db, id);
  if (row.source === 'plaid') throw new AppError('conflict', SPEND_MESSAGES.closingPlaid);
  deps.db.delete(statements).where(eq(statements.id, id)).run();
  return cardStatements(deps, row.cardId);
}
