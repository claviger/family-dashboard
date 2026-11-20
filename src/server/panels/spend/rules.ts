import type { FieldSource } from '../../../shared/spend.js';

/**
 * Categorization rules and precedence (spec §12.8, §12.9). Pure: the service loads the rules,
 * the mapping, and who and what can still be assigned, and stores what this decides.
 *
 * - A rule matches text (`contains` or `exact`, ignoring case, Unicode compatibility forms (NFKC),
 *   and runs of spaces) against the
 *   merchant name, or the raw description when there's no merchant name; and, when it says so, a
 *   card and an amount range (inclusive, positive for money spent).
 * - Category and person are decided separately: for each, the first matching rule, in order, that
 *   sets it wins. A rule that only sets the person doesn't stop a later rule from setting the category.
 * - A rule naming an archived category or a deactivated person skips that action (it's flagged in
 *   Spend settings) and still applies its other one.
 * - Category: a manual edit, else the first matching rule, else the Plaid mapping (detailed code,
 *   then primary; an archived category is skipped), else Uncategorized.
 * - Person: a manual edit, else the first matching rule, else Household.
 * - Deciding a stored transaction again (Apply to past transactions, and 6b's sync) never erases
 *   history: a field whose value can't be assigned any more (an archived category, a deactivated
 *   person) keeps it, whatever set it. Only Reset to automatic decides such a field again.
 */

export type PersonAction = { kind: 'household' } | { kind: 'user'; userId: number };

export interface RuleSpec {
  id: number;
  matchText: string;
  matchType: 'contains' | 'exact';
  cardId: number | null;
  minCents: number | null;
  maxCents: number | null;
  setCategoryId: number | null;
  setPerson: PersonAction | null;
}

export interface RuleTarget {
  cardId: number;
  merchant: string | null;
  rawName: string;
  amountCents: number;
}

/** What can still be assigned: categories that aren't archived, and active people. */
export interface Assignable {
  categoryIds: ReadonlySet<number>;
  userIds: ReadonlySet<number>;
}

/**
 * NFKC (so full-width letters and ligatures read as plain ones, and accents compare however
 * they're encoded), lowercase, trimmed, with runs of whitespace as one space.
 */
export function normalizeRuleText(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** The text a rule is matched against: the merchant name, or the raw description when there's none. */
export function matchTextOf(t: Pick<RuleTarget, 'merchant' | 'rawName'>): string {
  return t.merchant && t.merchant.trim() !== '' ? t.merchant : t.rawName;
}

/** A rule with its match text normalized once, when the categorizer is built, rather than per transaction. */
export interface PreparedRule extends RuleSpec {
  want: string;
}

export function prepareRules(rules: readonly RuleSpec[]): PreparedRule[] {
  return rules.map((r) => ({ ...r, want: normalizeRuleText(r.matchText) }));
}

/** `text` gives the transaction's normalized text, worked out at most once by the caller. */
function matches(rule: RuleSpec & { want?: string }, t: RuleTarget, text: () => string): boolean {
  if (rule.cardId !== null && rule.cardId !== t.cardId) return false;
  if (rule.minCents !== null && t.amountCents < rule.minCents) return false;
  if (rule.maxCents !== null && t.amountCents > rule.maxCents) return false;
  const want = rule.want ?? normalizeRuleText(rule.matchText);
  if (want === '') return false;
  return rule.matchType === 'exact' ? text() === want : text().includes(want);
}

/** The transaction's normalized text, worked out the first time it's asked for. */
function lazyText(t: RuleTarget): () => string {
  let text: string | undefined;
  return () => (text ??= normalizeRuleText(matchTextOf(t)));
}

export function ruleMatches(rule: RuleSpec, t: RuleTarget): boolean {
  return matches(rule, t, lazyText(t));
}

/** Which of a rule's actions can't apply now: an archived category, a deactivated person. */
export function ruleProblems(rule: RuleSpec, can: Assignable): { category: boolean; person: boolean } {
  return {
    category: rule.setCategoryId !== null && !can.categoryIds.has(rule.setCategoryId),
    person: rule.setPerson?.kind === 'user' && !can.userIds.has(rule.setPerson.userId),
  };
}

export interface RuleOutcome {
  category: { categoryId: number; ruleId: number } | null;
  /** `userId` null is Household. */
  person: { userId: number | null; ruleId: number } | null;
}

/**
 * The first matching rule for each field, in order, skipping actions that can't apply. The
 * transaction's text is normalized once, and a prepared rule's (`prepareRules`) not at all.
 */
export function evaluateRules(rules: readonly (RuleSpec | PreparedRule)[], t: RuleTarget, can: Assignable): RuleOutcome {
  const out: RuleOutcome = { category: null, person: null };
  const text = lazyText(t);
  for (const rule of rules) {
    if (out.category && out.person) break;
    const wantsCategory = !out.category && rule.setCategoryId !== null;
    const wantsPerson = !out.person && rule.setPerson !== null;
    if (!wantsCategory && !wantsPerson) continue;
    if (!matches(rule, t, text)) continue;
    const problems = ruleProblems(rule, can);
    if (wantsCategory && !problems.category) out.category = { categoryId: rule.setCategoryId!, ruleId: rule.id };
    if (wantsPerson && !problems.person) {
      const p = rule.setPerson!;
      out.person = { userId: p.kind === 'user' ? p.userId : null, ruleId: rule.id };
    }
  }
  return out;
}

export interface FieldState {
  categoryId: number;
  categorySource: FieldSource;
  /** Null is Household. */
  personUserId: number | null;
  personSource: Exclude<FieldSource, 'mapping'>;
}

export interface Categorizer {
  /** In order. `loadCategorizer` prepares them, so their text is normalized once per batch. */
  rules: readonly (RuleSpec | PreparedRule)[];
  /** Plaid PFC code (detailed or primary) to category id. */
  mapping: ReadonlyMap<string, number>;
  uncategorizedId: number;
  can: Assignable;
}

export interface CategorizeTarget extends RuleTarget {
  plaidPfcDetailed: string | null;
  plaidPfcPrimary: string | null;
}

/** The Plaid mapping's category for a transaction: detailed code first, then primary, skipping archived categories. */
export function mappedCategory(t: Pick<CategorizeTarget, 'plaidPfcDetailed' | 'plaidPfcPrimary'>, env: Pick<Categorizer, 'mapping' | 'can'>): number | null {
  for (const code of [t.plaidPfcDetailed, t.plaidPfcPrimary]) {
    if (!code) continue;
    const id = env.mapping.get(code);
    if (id !== undefined && env.can.categoryIds.has(id)) return id;
  }
  return null;
}

export type DecidedField = 'category' | 'person';

/**
 * A transaction's category and person by precedence (spec §12.9). `current` is what's stored (null
 * for a new transaction). A field of it is kept when it was set by hand, or when its value can't be
 * assigned any more (an archived category, a deactivated person), so deciding again never erases
 * history. Everything else is decided again. `reset` (Reset to automatic) names fields to decide
 * again whatever they hold.
 */
export function categorize(t: CategorizeTarget, current: FieldState | null, env: Categorizer, reset: readonly DecidedField[] = []): FieldState {
  const rules = evaluateRules(env.rules, t, env.can);
  const keepCategory =
    current !== null && !reset.includes('category') && (current.categorySource === 'manual' || !env.can.categoryIds.has(current.categoryId));
  const keepPerson =
    current !== null &&
    !reset.includes('person') &&
    (current.personSource === 'manual' || (current.personUserId !== null && !env.can.userIds.has(current.personUserId)));
  let category: Pick<FieldState, 'categoryId' | 'categorySource'>;
  if (keepCategory) category = { categoryId: current.categoryId, categorySource: current.categorySource };
  else if (rules.category) category = { categoryId: rules.category.categoryId, categorySource: 'rule' };
  else {
    const mapped = mappedCategory(t, env);
    category = mapped !== null ? { categoryId: mapped, categorySource: 'mapping' } : { categoryId: env.uncategorizedId, categorySource: 'default' };
  }
  let person: Pick<FieldState, 'personUserId' | 'personSource'>;
  if (keepPerson) person = { personUserId: current.personUserId, personSource: current.personSource };
  else if (rules.person) person = { personUserId: rules.person.userId, personSource: 'rule' };
  else person = { personUserId: null, personSource: 'default' };
  return { ...category, ...person };
}
