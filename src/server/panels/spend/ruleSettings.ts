import { eq, isNull, max, min, sql } from 'drizzle-orm';
import type { z } from 'zod';
import { RULE_PROBLEMS, SPEND_MESSAGES, type MoveDirection, type Rule, type RuleInputSchema, type RuleSaveResponse } from '../../../shared/spend.js';
import { AppError } from '../../core/errors.js';
import type { Db } from '../../db/index.js';
import { cards, rules, transactions, type RuleRow } from '../../db/schema.js';
import { categorize, ruleProblems } from './rules.js';
import {
  assignable, cardOption, categoriesById, categoryRef, loadCategorizer, orderedRules, peopleById, requireActiveCard, requireActivePerson,
  requireUsableCategory, ruleSpec, type SpendDeps,
} from './store.js';

/** Rules (spec §12.8): admins only; the routes check the role. */

type RuleInput = z.output<typeof RuleInputSchema>;

export function listRules(db: Db): Rule[] {
  const people = peopleById(db);
  const cats = categoriesById(db);
  const cardRows = new Map(db.select().from(cards).all().map((c) => [c.id, c]));
  const can = assignable(db);
  return orderedRules(db).map((row) => {
    const problems = ruleProblems(ruleSpec(row), can);
    const card = row.cardId !== null ? cardRows.get(row.cardId) : undefined;
    const person = row.setPersonUserId !== null ? people.get(row.setPersonUserId) : undefined;
    return {
      id: row.id,
      position: row.position,
      matchText: row.matchText,
      matchType: row.matchType,
      card: card ? cardOption(card) : null,
      minCents: row.minCents,
      maxCents: row.maxCents,
      setCategory: row.setCategoryId !== null ? categoryRef(cats.get(row.setCategoryId)!) : null,
      setPerson: row.setPerson === 'household' ? { kind: 'household' } : person ? { kind: 'user', person } : null,
      problems: [
        ...(problems.category ? [RULE_PROBLEMS.archivedCategory] : []),
        ...(problems.person ? [RULE_PROBLEMS.inactivePerson] : []),
        ...(card?.archivedAt ? [RULE_PROBLEMS.archivedCard] : []),
      ],
    };
  });
}

function requireRule(db: Db, id: number): RuleRow {
  const row = db.select().from(rules).where(eq(rules.id, id)).get();
  if (!row) throw new AppError('not_found', SPEND_MESSAGES.ruleNotFound);
  return row;
}

/** Checks what the rule names. A value the rule already had may stay, even if it was archived or deactivated since (it stays flagged). */
function values(db: Db, input: RuleInput, current: RuleRow | null) {
  if (input.cardId !== null && input.cardId !== current?.cardId) requireActiveCard(db, input.cardId, 'validation');
  if (input.setCategoryId !== null && input.setCategoryId !== current?.setCategoryId) requireUsableCategory(db, input.setCategoryId);
  const userId = typeof input.setPerson === 'number' ? input.setPerson : null;
  if (userId !== null && userId !== current?.setPersonUserId) requireActivePerson(db, userId);
  return {
    matchText: input.matchText,
    matchType: input.matchType,
    cardId: input.cardId,
    minCents: input.minCents,
    maxCents: input.maxCents,
    setCategoryId: input.setCategoryId,
    setPerson: input.setPerson === null ? null : input.setPerson === 'household' ? ('household' as const) : ('user' as const),
    setPersonUserId: userId,
  };
}

function saved(deps: SpendDeps, id: number, applyToPast: boolean): RuleSaveResponse {
  const applied = applyToPast ? applyRulesToPast(deps) : null;
  return { rule: listRules(deps.db).find((r) => r.id === id)!, applied };
}

export function createRule(deps: SpendDeps, input: RuleInput): RuleSaveResponse {
  const now = deps.clock.now();
  const v = values(deps.db, input, null);
  const position = input.placeFirst
    ? (deps.db.select({ n: min(rules.position) }).from(rules).get()?.n ?? 1) - 1
    : (deps.db.select({ n: max(rules.position) }).from(rules).get()?.n ?? 0) + 1;
  const row = deps.db.insert(rules).values({ ...v, position, createdAt: now, updatedAt: now }).returning().get();
  return saved(deps, row.id, input.applyToPast);
}

export function updateRule(deps: SpendDeps, id: number, input: RuleInput): RuleSaveResponse {
  const current = requireRule(deps.db, id);
  deps.db.update(rules).set({ ...values(deps.db, input, current), updatedAt: deps.clock.now() }).where(eq(rules.id, id)).run();
  return saved(deps, id, input.applyToPast);
}

/** Deleting a rule leaves what it set on past transactions; "Apply rules to past transactions" undoes that. */
export function deleteRule(deps: SpendDeps, id: number): void {
  requireRule(deps.db, id);
  deps.db.delete(rules).where(eq(rules.id, id)).run();
}

/** Swaps the rule with the one before or after it. At either end, nothing changes. */
export function moveRule(deps: SpendDeps, id: number, direction: MoveDirection): Rule[] {
  requireRule(deps.db, id);
  deps.db.transaction((tx) => {
    const list = tx.select().from(rules).all().sort((a, b) => a.position - b.position || a.id - b.id);
    const i = list.findIndex((r) => r.id === id);
    const j = direction === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j]!, list[i]!];
    const now = deps.clock.now();
    list.forEach((r, n) => {
      if (r.position !== n + 1) tx.update(rules).set({ position: n + 1, updatedAt: now }).where(eq(rules.id, r.id)).run();
    });
  });
  return listRules(deps.db);
}

/**
 * "Apply to past transactions" (spec §12.8): decides every transaction's category and person again
 * by precedence, leaving fields someone set by hand alone. Returns how many transactions changed.
 * One transaction, reading only what `categorize` needs, with the rules' text normalized once and
 * one prepared update, so 20,000 rows against 100 rules stays well under a second.
 */
export function applyRulesToPast(deps: SpendDeps): number {
  const env = loadCategorizer(deps.db);
  const now = deps.clock.now();
  return deps.db.transaction((tx) => {
    const rows = tx
      .select({
        id: transactions.id,
        cardId: transactions.cardId,
        merchant: transactions.merchant,
        rawName: transactions.rawName,
        amountCents: transactions.amountCents,
        plaidPfcDetailed: transactions.plaidPfcDetailed,
        plaidPfcPrimary: transactions.plaidPfcPrimary,
        categoryId: transactions.categoryId,
        categorySource: transactions.categorySource,
        personUserId: transactions.personUserId,
        personSource: transactions.personSource,
      })
      .from(transactions)
      .where(isNull(transactions.deletedAt))
      .all();
    const update = tx
      .update(transactions)
      .set({
        // Wrapped in sql``, since set() is typed for values and SQL, not bare placeholders.
        categoryId: sql`${sql.placeholder('categoryId')}`,
        categorySource: sql`${sql.placeholder('categorySource')}`,
        personUserId: sql`${sql.placeholder('personUserId')}`,
        personSource: sql`${sql.placeholder('personSource')}`,
        updatedAt: now,
      })
      .where(eq(transactions.id, sql.placeholder('id')))
      .prepare();
    let changed = 0;
    for (const t of rows) {
      const next = categorize(t, t, env);
      if (next.categoryId === t.categoryId && next.categorySource === t.categorySource && next.personUserId === t.personUserId && next.personSource === t.personSource) continue;
      update.run({ id: t.id, ...next });
      changed++;
    }
    return changed;
  });
}
