import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Logger } from 'pino';
import { SPEND_MESSAGES, type CardOption, type CategoryRef, type SpendPerson } from '../../../shared/spend.js';
import { localDate, type Clock } from '../../core/clock.js';
import { AppError } from '../../core/errors.js';
import type { Db } from '../../db/index.js';
import { cards, categories, categoryMappings, rules, users, type CardRow, type CategoryRow, type RuleRow } from '../../db/schema.js';
import { getFamilySettings } from '../../settings.js';
import { prepareRules, type Assignable, type Categorizer, type RuleSpec } from './rules.js';

/** What the Spend panel needs. AppDeps has all of it. */
export interface SpendDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
}

/** Today in the family time zone: transaction and closing dates are family-local (spec §18). */
export function familyToday(deps: Pick<SpendDeps, 'db' | 'clock'>): string {
  return localDate(deps.clock.now(), getFamilySettings(deps.db).timeZone);
}

/** Everyone, deactivated people included, since past transactions keep their names (spec §12.6). */
export function peopleById(db: Db): Map<number, SpendPerson> {
  return new Map(
    db
      .select({ id: users.id, displayName: users.displayName, color: users.color, active: users.active })
      .from(users)
      .orderBy(asc(users.displayName), asc(users.id))
      .all()
      .map((p) => [p.id, p]),
  );
}

export function categoryRef(row: CategoryRow): CategoryRef {
  return { id: row.id, name: row.name, kind: row.kind, archived: row.archived };
}

export function categoriesById(db: Db): Map<number, CategoryRow> {
  return new Map(db.select().from(categories).all().map((c) => [c.id, c]));
}

/** The id of the one category of a special kind. Migration 0007 makes both, and they can't be deleted. */
export function specialCategoryId(db: Db, kind: 'excluded' | 'uncategorized'): number {
  return db.select({ id: categories.id }).from(categories).where(eq(categories.kind, kind)).get()!.id;
}

export function cardOption(row: CardRow): CardOption {
  return { id: row.id, nickname: row.nickname, mask: row.mask, archived: row.archivedAt !== null };
}

export function requireCard(db: Db, id: number): CardRow {
  const row = db.select().from(cards).where(eq(cards.id, id)).get();
  if (!row) throw new AppError('not_found', SPEND_MESSAGES.cardNotFound);
  return row;
}

/** Included cards: what the home card and the drill-down show. Archived ones last. */
export function includedCards(db: Db): CardRow[] {
  return db
    .select()
    .from(cards)
    .where(eq(cards.included, true))
    .all()
    .sort((a, b) => Number(a.archivedAt !== null) - Number(b.archivedAt !== null) || a.nickname.localeCompare(b.nickname) || a.id - b.id);
}

/** Categories that aren't archived, and active people: what can be assigned now. */
export function assignable(db: Db): Assignable {
  return {
    categoryIds: new Set(db.select({ id: categories.id }).from(categories).where(eq(categories.archived, false)).all().map((c) => c.id)),
    userIds: new Set(db.select({ id: users.id }).from(users).where(eq(users.active, true)).all().map((u) => u.id)),
  };
}

export function ruleSpec(row: RuleRow): RuleSpec {
  return {
    id: row.id,
    matchText: row.matchText,
    matchType: row.matchType,
    cardId: row.cardId,
    minCents: row.minCents,
    maxCents: row.maxCents,
    setCategoryId: row.setCategoryId,
    setPerson: row.setPerson === 'household' ? { kind: 'household' } : row.setPerson === 'user' ? { kind: 'user', userId: row.setPersonUserId! } : null,
  };
}

export function orderedRules(db: Db): RuleRow[] {
  return db.select().from(rules).orderBy(asc(rules.position), asc(rules.id)).all();
}

/** Everything `categorize` needs, read once for a batch of transactions. */
export function loadCategorizer(db: Db): Categorizer {
  return {
    rules: prepareRules(orderedRules(db).map(ruleSpec)),
    mapping: new Map(db.select().from(categoryMappings).all().map((m) => [m.plaidPfc, m.categoryId])),
    uncategorizedId: specialCategoryId(db, 'uncategorized'),
    can: assignable(db),
  };
}

/** An active person, for a new assignment; anything else is a validation error. */
export function requireActivePerson(db: Db, userId: number): void {
  const row = db.select({ id: users.id }).from(users).where(and(eq(users.id, userId), eq(users.active, true))).get();
  if (!row) throw new AppError('validation', SPEND_MESSAGES.personInactive);
}

/** A category that isn't archived, for a new assignment. */
export function requireUsableCategory(db: Db, id: number): CategoryRow {
  const row = db.select().from(categories).where(eq(categories.id, id)).get();
  if (!row) throw new AppError('validation', SPEND_MESSAGES.categoryNotFound);
  if (row.archived) throw new AppError('validation', SPEND_MESSAGES.categoryArchived);
  return row;
}

/** A card that can take new data: it exists and isn't archived. */
export function requireActiveCard(db: Db, id: number, notFound: 'not_found' | 'validation' = 'not_found'): CardRow {
  const row = db.select().from(cards).where(and(eq(cards.id, id), isNull(cards.archivedAt))).get();
  if (row) return row;
  if (db.select({ id: cards.id }).from(cards).where(eq(cards.id, id)).get()) throw new AppError('validation', SPEND_MESSAGES.cardArchived);
  throw new AppError(notFound, SPEND_MESSAGES.cardNotFound);
}
