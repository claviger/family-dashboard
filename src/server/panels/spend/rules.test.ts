import { describe, expect, it, vi } from 'vitest';
import {
  categorize, evaluateRules, mappedCategory, matchTextOf, normalizeRuleText, prepareRules, ruleMatches, ruleProblems, type Assignable, type CategorizeTarget,
  type Categorizer, type FieldState, type RuleSpec,
} from './rules.js';

const GROCERIES = 1;
const DINING = 2;
const SUBSCRIPTIONS = 7;
const ARCHIVED = 20;
const PAYMENTS = 15;
const UNCATEGORIZED = 16;
const KID = 5;
const GONE = 6;

const can: Assignable = { categoryIds: new Set([GROCERIES, DINING, SUBSCRIPTIONS, PAYMENTS, UNCATEGORIZED]), userIds: new Set([KID]) };

let nextId = 1;
function rule(patch: Partial<RuleSpec>): RuleSpec {
  return { id: nextId++, matchText: 'x', matchType: 'contains', cardId: null, minCents: null, maxCents: null, setCategoryId: null, setPerson: null, ...patch };
}
function txn(patch: Partial<CategorizeTarget> = {}): CategorizeTarget {
  return { cardId: 1, merchant: null, rawName: 'SAFEWAY #1234 OAKLAND', amountCents: 5_000, plaidPfcDetailed: null, plaidPfcPrimary: null, ...patch };
}

describe('matching', () => {
  it('normalizes case, whitespace, and Unicode compatibility forms', () => {
    expect(normalizeRuleText('  Netflix\t COM ')).toBe('netflix com');
    expect(normalizeRuleText('ＮＥＴＦＬＩＸ')).toBe('netflix');
    const decomposed = `Cafe${String.fromCharCode(0x301)}`;
    expect(normalizeRuleText(decomposed)).toBe(normalizeRuleText('Café'));
    expect(ruleMatches(rule({ matchText: 'café' }), txn({ rawName: `${decomposed.toUpperCase()} ROUGE` }))).toBe(true);
  });

  it('uses the merchant name, or the raw description when there is none', () => {
    expect(matchTextOf({ merchant: 'Netflix', rawName: 'NETFLIX.COM 866-579' })).toBe('Netflix');
    expect(matchTextOf({ merchant: null, rawName: 'NETFLIX.COM 866-579' })).toBe('NETFLIX.COM 866-579');
    expect(matchTextOf({ merchant: '  ', rawName: 'RAW' })).toBe('RAW');
  });

  it('matches contains and exact, ignoring case', () => {
    expect(ruleMatches(rule({ matchText: 'safeway' }), txn())).toBe(true);
    expect(ruleMatches(rule({ matchText: 'SAFEWAY  #1234' }), txn())).toBe(true);
    expect(ruleMatches(rule({ matchText: 'trader' }), txn())).toBe(false);
    expect(ruleMatches(rule({ matchText: 'safeway', matchType: 'exact' }), txn())).toBe(false);
    expect(ruleMatches(rule({ matchText: 'safeway #1234 oakland', matchType: 'exact' }), txn())).toBe(true);
    // Against the merchant when there is one, not the raw description.
    expect(ruleMatches(rule({ matchText: 'oakland' }), txn({ merchant: 'Safeway' }))).toBe(false);
  });

  it('never matches empty text', () => {
    expect(ruleMatches(rule({ matchText: '   ' }), txn())).toBe(false);
  });

  it('matches only its card, when it names one', () => {
    expect(ruleMatches(rule({ matchText: 'safeway', cardId: 1 }), txn())).toBe(true);
    expect(ruleMatches(rule({ matchText: 'safeway', cardId: 2 }), txn())).toBe(false);
  });

  it('matches an inclusive amount range, either end optional, in the app sign', () => {
    const r = (minCents: number | null, maxCents: number | null) => rule({ matchText: 'safeway', minCents, maxCents });
    expect(ruleMatches(r(5_000, 5_000), txn())).toBe(true);
    expect(ruleMatches(r(5_001, null), txn())).toBe(false);
    expect(ruleMatches(r(null, 4_999), txn())).toBe(false);
    expect(ruleMatches(r(null, -1), txn({ amountCents: -50_000 }))).toBe(true);
    expect(ruleMatches(r(null, -1), txn({ amountCents: 0 }))).toBe(false);
  });
});

describe('evaluateRules', () => {
  it('takes the first matching rule for each field, separately', () => {
    const personOnly = rule({ matchText: 'safeway', setPerson: { kind: 'user', userId: KID } });
    const both = rule({ matchText: 'safeway', setCategoryId: GROCERIES, setPerson: { kind: 'household' } });
    const later = rule({ matchText: 'safe', setCategoryId: DINING });
    expect(evaluateRules([personOnly, both, later], txn(), can)).toEqual({
      category: { categoryId: GROCERIES, ruleId: both.id },
      person: { userId: KID, ruleId: personOnly.id },
    });
    expect(evaluateRules([later, both], txn(), can)).toEqual({
      category: { categoryId: DINING, ruleId: later.id },
      person: { userId: null, ruleId: both.id },
    });
  });

  it("skips a rule that doesn't match", () => {
    const r = rule({ matchText: 'netflix', setCategoryId: SUBSCRIPTIONS });
    expect(evaluateRules([r], txn(), can)).toEqual({ category: null, person: null });
  });

  it('skips only the action naming an archived category or a deactivated person, and flags it', () => {
    const archived = rule({ matchText: 'safeway', setCategoryId: ARCHIVED, setPerson: { kind: 'user', userId: KID } });
    const gone = rule({ matchText: 'safeway', setCategoryId: GROCERIES, setPerson: { kind: 'user', userId: GONE } });
    const fallback = rule({ matchText: 'safeway', setPerson: { kind: 'household' } });
    expect(ruleProblems(archived, can)).toEqual({ category: true, person: false });
    expect(ruleProblems(gone, can)).toEqual({ category: false, person: true });
    expect(evaluateRules([archived, gone, fallback], txn(), can)).toEqual({
      category: { categoryId: GROCERIES, ruleId: gone.id },
      person: { userId: KID, ruleId: archived.id },
    });
    expect(evaluateRules([gone, fallback], txn(), can).person).toEqual({ userId: null, ruleId: fallback.id });
  });

  it("normalizes the transaction's text once, and a prepared rule's text never", () => {
    const prepared = prepareRules(Array.from({ length: 100 }, (_, n) => rule({ matchText: `Ｎｅｔｆｌｉｘ ${n}`, matchType: 'exact', setCategoryId: SUBSCRIPTIONS })));
    expect(prepared[3]!.want).toBe('netflix 3');
    const spy = vi.spyOn(String.prototype, 'normalize');
    try {
      expect(evaluateRules(prepared, txn({ rawName: 'NETFLIX  99' }), can).category).toEqual({ categoryId: SUBSCRIPTIONS, ruleId: prepared[99]!.id });
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('a household action sets Household on purpose', () => {
    expect(evaluateRules([rule({ matchText: 'safeway', setPerson: { kind: 'household' } })], txn(), can).person?.userId).toBeNull();
  });
});

describe('mappedCategory', () => {
  const env = { mapping: new Map([['FOOD_AND_DRINK', DINING], ['FOOD_AND_DRINK_GROCERIES', GROCERIES], ['ENTERTAINMENT', ARCHIVED]]), can };

  it('looks up the detailed code first, then the primary', () => {
    expect(mappedCategory({ plaidPfcDetailed: 'FOOD_AND_DRINK_GROCERIES', plaidPfcPrimary: 'FOOD_AND_DRINK' }, env)).toBe(GROCERIES);
    expect(mappedCategory({ plaidPfcDetailed: 'FOOD_AND_DRINK_COFFEE', plaidPfcPrimary: 'FOOD_AND_DRINK' }, env)).toBe(DINING);
    expect(mappedCategory({ plaidPfcDetailed: null, plaidPfcPrimary: null }, env)).toBeNull();
    expect(mappedCategory({ plaidPfcDetailed: 'X', plaidPfcPrimary: 'Y' }, env)).toBeNull();
  });

  it('skips a mapping to an archived category', () => {
    expect(mappedCategory({ plaidPfcDetailed: 'ENTERTAINMENT_TV_AND_MOVIES', plaidPfcPrimary: 'ENTERTAINMENT' }, env)).toBeNull();
  });
});

describe('categorize: precedence', () => {
  const env: Categorizer = {
    rules: [rule({ matchText: 'netflix', setCategoryId: SUBSCRIPTIONS }), rule({ matchText: 'payment', maxCents: -1, setCategoryId: PAYMENTS })],
    mapping: new Map([['FOOD_AND_DRINK', DINING], ['ENTERTAINMENT', ARCHIVED]]),
    uncategorizedId: UNCATEGORIZED,
    can,
  };
  const auto: FieldState = { categoryId: UNCATEGORIZED, categorySource: 'default', personUserId: null, personSource: 'default' };

  it('category: rule, then mapping, then Uncategorized; person: Household', () => {
    expect(categorize(txn({ rawName: 'NETFLIX.COM', plaidPfcPrimary: 'FOOD_AND_DRINK' }), null, env)).toEqual({
      categoryId: SUBSCRIPTIONS, categorySource: 'rule', personUserId: null, personSource: 'default',
    });
    expect(categorize(txn({ plaidPfcPrimary: 'FOOD_AND_DRINK' }), null, env)).toMatchObject({ categoryId: DINING, categorySource: 'mapping' });
    expect(categorize(txn({ plaidPfcPrimary: 'ENTERTAINMENT' }), null, env)).toMatchObject({ categoryId: UNCATEGORIZED, categorySource: 'default' });
    expect(categorize(txn(), null, env)).toEqual(auto);
  });

  it('keeps manual fields, each on its own, and decides the others again', () => {
    const manualCategory: FieldState = { categoryId: GROCERIES, categorySource: 'manual', personUserId: null, personSource: 'default' };
    const personRule = { ...env, rules: [rule({ matchText: 'netflix', setCategoryId: SUBSCRIPTIONS, setPerson: { kind: 'user', userId: KID } })] };
    expect(categorize(txn({ rawName: 'NETFLIX' }), manualCategory, personRule)).toEqual({
      categoryId: GROCERIES, categorySource: 'manual', personUserId: KID, personSource: 'rule',
    });
    const manualHousehold: FieldState = { categoryId: UNCATEGORIZED, categorySource: 'default', personUserId: null, personSource: 'manual' };
    expect(categorize(txn({ rawName: 'NETFLIX' }), manualHousehold, personRule)).toEqual({
      categoryId: SUBSCRIPTIONS, categorySource: 'rule', personUserId: null, personSource: 'manual',
    });
  });

  it('keeps a manual category even when it has since been archived', () => {
    const manual: FieldState = { categoryId: ARCHIVED, categorySource: 'manual', personUserId: GONE, personSource: 'manual' };
    expect(categorize(txn({ rawName: 'NETFLIX' }), manual, env)).toEqual(manual);
  });

  it("never erases history: a value set by a rule or the mapping that can't be assigned now is kept", () => {
    const byRule: FieldState = { categoryId: ARCHIVED, categorySource: 'rule', personUserId: GONE, personSource: 'rule' };
    expect(categorize(txn({ rawName: 'NETFLIX' }), byRule, env)).toEqual(byRule);
    const byMapping: FieldState = { categoryId: ARCHIVED, categorySource: 'mapping', personUserId: null, personSource: 'default' };
    expect(categorize(txn({ plaidPfcPrimary: 'FOOD_AND_DRINK' }), byMapping, env)).toEqual(byMapping);
  });

  it('decides a field again, whatever it holds, when it is reset (Reset to automatic)', () => {
    const manual: FieldState = { categoryId: GROCERIES, categorySource: 'manual', personUserId: KID, personSource: 'manual' };
    expect(categorize(txn({ rawName: 'NETFLIX' }), manual, env, ['category'])).toEqual({
      categoryId: SUBSCRIPTIONS, categorySource: 'rule', personUserId: KID, personSource: 'manual',
    });
    expect(categorize(txn({ rawName: 'NETFLIX' }), manual, env, ['person'])).toMatchObject({ personUserId: null, personSource: 'default' });
    const stale: FieldState = { categoryId: ARCHIVED, categorySource: 'rule', personUserId: GONE, personSource: 'rule' };
    expect(categorize(txn({ rawName: 'NETFLIX' }), stale, env, ['category', 'person'])).toEqual({
      categoryId: SUBSCRIPTIONS, categorySource: 'rule', personUserId: null, personSource: 'default',
    });
  });

  it('replaces a rule result when the rule no longer matches', () => {
    const byRule: FieldState = { categoryId: SUBSCRIPTIONS, categorySource: 'rule', personUserId: KID, personSource: 'rule' };
    expect(categorize(txn(), byRule, env)).toEqual(auto);
  });

  it('puts a card payment in Payments and transfers, but not a purchase with PAYMENT in its name', () => {
    expect(categorize(txn({ rawName: 'PAYMENT - THANK YOU', amountCents: -50_000 }), null, env).categoryId).toBe(PAYMENTS);
    expect(categorize(txn({ rawName: 'SQ *PAYMENT PROCESSOR', amountCents: 1_000 }), null, env).categoryId).toBe(UNCATEGORIZED);
  });
});
