import { centsToInput, isAmountInput, parseCentsInput } from '../../../shared/money.js';
import { AMOUNT_LIMIT_MESSAGE, RULE_TEXT_MAX, type MatchType, type Rule, type RuleInput, type SpendTransaction } from '../../../shared/spend.js';

/**
 * The rule form's values (spec §12.8) and their checks, before anything is sent. Pure. Selects
 * hold ids as strings; '' is "any card", "no category", or "leave the person alone".
 */
export interface RuleFormValues {
  matchText: string;
  matchType: MatchType;
  cardId: string;
  /** Dollars as typed; '' for no limit. */
  min: string;
  max: string;
  categoryId: string;
  /** '', 'household', or a user id. */
  person: string;
  applyToPast: boolean;
}

export type RuleField = 'matchText' | 'min' | 'max' | 'action';

export const EMPTY_RULE: RuleFormValues = { matchText: '', matchType: 'contains', cardId: '', min: '', max: '', categoryId: '', person: '', applyToPast: false };

export function ruleFormFromRule(rule: Rule): RuleFormValues {
  return {
    matchText: rule.matchText,
    matchType: rule.matchType,
    cardId: rule.card ? String(rule.card.id) : '',
    min: rule.minCents === null ? '' : centsToInput(rule.minCents),
    max: rule.maxCents === null ? '' : centsToInput(rule.maxCents),
    categoryId: rule.setCategory ? String(rule.setCategory.id) : '',
    person: rule.setPerson === null ? '' : rule.setPerson.kind === 'household' ? 'household' : String(rule.setPerson.person.id),
    applyToPast: false,
  };
}

/**
 * "Add rule" (spec §12.8): text containing the merchant name, and the category
 * and person the row shows. It's applied to past transactions unless unticked.
 *
 * `draft` is the row's unsaved picks (picker values: '' for Household). A category or person
 * picked but not saved yet is what the person means, so it fills in over the saved one.
 *
 * Household fills in only when it was picked or set on purpose (by hand or by a rule). Household
 * that's only the default leaves the person unset, so the rule doesn't start setting Household on
 * every transaction it matches. An archived category or a deactivated person is left out, since a
 * rule can't set them.
 */
export function ruleFormFromTransaction(t: SpendTransaction, draft: { category?: string; person?: string } = {}): RuleFormValues {
  return {
    ...EMPTY_RULE,
    matchText: cutText(t.merchant, RULE_TEXT_MAX),
    categoryId: draft.category ?? (t.category.archived ? '' : String(t.category.id)),
    person: draft.person !== undefined ? (draft.person === '' ? 'household' : draft.person) : savedPerson(t),
    applyToPast: true,
  };
}

function savedPerson(t: SpendTransaction): string {
  if (t.person) return t.person.active ? String(t.person.id) : '';
  return t.personSource === 'default' ? '' : 'household';
}

/** The first `max` code units of `text`, without leaving half of a two-unit character at the end. */
function cutText(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

/** An amount field: '' is no limit. Badly written and too big are told apart. */
function amountFrom(text: string, badFormat: string): { ok: true; cents: number | null } | { ok: false; error: string } {
  if (text.trim() === '') return { ok: true, cents: null };
  const cents = parseCentsInput(text);
  if (cents !== null) return { ok: true, cents };
  return { ok: false, error: isAmountInput(text) ? `${AMOUNT_LIMIT_MESSAGE}.` : badFormat };
}

export type RuleFormResult = { ok: true; input: RuleInput } | { ok: false; error: string; field: RuleField };

export function toRuleInput(v: RuleFormValues, placeFirst = false): RuleFormResult {
  const text = v.matchText.trim();
  if (text === '') return { ok: false, error: 'Enter the text to match.', field: 'matchText' };
  if (text.length > RULE_TEXT_MAX) return { ok: false, error: `Keep the text to ${RULE_TEXT_MAX} characters or fewer.`, field: 'matchText' };
  const minResult = amountFrom(v.min, 'Enter the smallest amount as dollars, like 10.00.');
  if (!minResult.ok) return { ...minResult, field: 'min' };
  const maxResult = amountFrom(v.max, 'Enter the largest amount as dollars, like 50.00.');
  if (!maxResult.ok) return { ...maxResult, field: 'max' };
  const min = minResult.cents;
  const max = maxResult.cents;
  if (min !== null && max !== null && min > max) return { ok: false, error: "The smallest amount can't be more than the largest.", field: 'min' };
  if (v.categoryId === '' && v.person === '') return { ok: false, error: 'Pick a category, a person, or both.', field: 'action' };
  return {
    ok: true,
    input: {
      matchText: text,
      matchType: v.matchType,
      cardId: v.cardId === '' ? null : Number(v.cardId),
      minCents: min,
      maxCents: max,
      setCategoryId: v.categoryId === '' ? null : Number(v.categoryId),
      setPerson: v.person === '' ? null : v.person === 'household' ? 'household' : Number(v.person),
      applyToPast: v.applyToPast,
      placeFirst,
    },
  };
}

/** One line describing a rule, for the list: `Text contains "netflix", on Visa, $10.00 to $20.00`. */
export function describeMatch(rule: Pick<Rule, 'matchText' | 'matchType' | 'card' | 'minCents' | 'maxCents'>, money: (c: number) => string): string {
  const parts = [`Text ${rule.matchType === 'exact' ? 'is' : 'contains'} "${rule.matchText}"`];
  if (rule.card) parts.push(`on ${rule.card.nickname}`);
  if (rule.minCents !== null && rule.maxCents !== null) parts.push(`${money(rule.minCents)} to ${money(rule.maxCents)}`);
  else if (rule.minCents !== null) parts.push(`${money(rule.minCents)} or more`);
  else if (rule.maxCents !== null) parts.push(`${money(rule.maxCents)} or less`);
  return parts.join(', ');
}
