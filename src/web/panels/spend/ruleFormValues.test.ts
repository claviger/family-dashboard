import { describe, expect, it } from 'vitest';
import { formatCents } from '../../../shared/money.js';
import { RULE_TEXT_MAX, type Rule, type SpendTransaction } from '../../../shared/spend.js';
import { describeMatch, EMPTY_RULE, ruleFormFromRule, ruleFormFromTransaction, toRuleInput } from './ruleFormValues.js';

const dining = { id: 2, name: 'Dining', kind: 'normal' as const, archived: false };
const kid = { id: 7, displayName: 'Kid', color: '#000', active: true };

describe('toRuleInput', () => {
  const valid = { ...EMPTY_RULE, matchText: ' netflix ', categoryId: '2' };

  it('turns the form into a RuleInput, with dollars as cents', () => {
    expect(toRuleInput({ ...valid, cardId: '3', min: '$10', max: '20.50', person: '7', applyToPast: true })).toEqual({
      ok: true,
      input: { matchText: 'netflix', matchType: 'contains', cardId: 3, minCents: 1000, maxCents: 2050, setCategoryId: 2, setPerson: 7, applyToPast: true, placeFirst: false },
    });
    expect(toRuleInput({ ...valid, person: 'household', max: '-0.01' }, true)).toMatchObject({
      ok: true,
      input: { minCents: null, maxCents: -1, setPerson: 'household', placeFirst: true, cardId: null },
    });
  });

  it('says what to fix, and where', () => {
    expect(toRuleInput({ ...valid, matchText: '  ' })).toEqual({ ok: false, error: 'Enter the text to match.', field: 'matchText' });
    expect(toRuleInput({ ...valid, min: 'ten' })).toMatchObject({ ok: false, field: 'min' });
    expect(toRuleInput({ ...valid, max: '1.234' })).toMatchObject({ ok: false, field: 'max' });
    expect(toRuleInput({ ...valid, min: '20', max: '10' })).toEqual({ ok: false, error: "The smallest amount can't be more than the largest.", field: 'min' });
    expect(toRuleInput({ ...valid, categoryId: '' })).toEqual({ ok: false, error: 'Pick a category, a person, or both.', field: 'action' });
  });

  it('says when the text is too long, as the server does', () => {
    expect(toRuleInput({ ...valid, matchText: ` ${'x'.repeat(RULE_TEXT_MAX)} ` })).toMatchObject({ ok: true });
    expect(toRuleInput({ ...valid, matchText: 'x'.repeat(RULE_TEXT_MAX + 1) })).toEqual({
      ok: false,
      error: `Keep the text to ${RULE_TEXT_MAX} characters or fewer.`,
      field: 'matchText',
    });
  });

  it('tells a badly written amount from one over the $10,000,000 limit', () => {
    expect(toRuleInput({ ...valid, min: '10000000' })).toMatchObject({ ok: true, input: { minCents: 1_000_000_000 } });
    expect(toRuleInput({ ...valid, min: '-10000000' })).toMatchObject({ ok: true, input: { minCents: -1_000_000_000 } });
    expect(toRuleInput({ ...valid, min: '10000000.01' })).toEqual({ ok: false, error: 'Enter an amount of at most $10,000,000.', field: 'min' });
    expect(toRuleInput({ ...valid, max: '-$99,999,999,999' })).toEqual({ ok: false, error: 'Enter an amount of at most $10,000,000.', field: 'max' });
    expect(toRuleInput({ ...valid, max: '12345678901234567890' })).toEqual({ ok: false, error: 'Enter an amount of at most $10,000,000.', field: 'max' });
    expect(toRuleInput({ ...valid, min: '1e9' })).toEqual({ ok: false, error: 'Enter the smallest amount as dollars, like 10.00.', field: 'min' });
    expect(toRuleInput({ ...valid, max: '1,0000' })).toEqual({ ok: false, error: 'Enter the largest amount as dollars, like 50.00.', field: 'max' });
  });
});

describe('ruleFormFromRule', () => {
  it('fills the form from a saved rule', () => {
    const rule: Rule = {
      id: 1, position: 1, matchText: 'PAYMENT', matchType: 'exact', card: { id: 3, nickname: 'Visa', mask: null, archived: false }, minCents: null, maxCents: -1,
      setCategory: dining, setPerson: { kind: 'user', person: kid }, problems: [],
    };
    expect(ruleFormFromRule(rule)).toEqual({ matchText: 'PAYMENT', matchType: 'exact', cardId: '3', min: '', max: '-0.01', categoryId: '2', person: '7', applyToPast: false });
    expect(ruleFormFromRule({ ...rule, setPerson: { kind: 'household' }, card: null }).person).toBe('household');
  });
});

describe('ruleFormFromTransaction (Add rule)', () => {
  const t: SpendTransaction = {
    id: 1, cardId: 1, source: 'csv', date: '2026-11-01', merchant: 'NETFLIX.COM', rawName: 'NETFLIX.COM', amountCents: 1549, currency: 'USD', pending: false,
    category: dining, categorySource: 'manual', person: kid, personSource: 'manual', note: null, twinIds: [],
  };

  it('matches text containing the merchant, with its category and person, and applies to the past', () => {
    expect(ruleFormFromTransaction(t)).toEqual({ ...EMPTY_RULE, matchText: 'NETFLIX.COM', categoryId: '2', person: '7', applyToPast: true });
  });

  it('fills in Household only when it was set on purpose, not when it is just the default', () => {
    expect(ruleFormFromTransaction({ ...t, person: null, personSource: 'manual' }).person).toBe('household');
    expect(ruleFormFromTransaction({ ...t, person: null, personSource: 'rule' }).person).toBe('household');
    expect(ruleFormFromTransaction({ ...t, person: null, personSource: 'default' }).person).toBe('');
  });

  it("leaves out a person who's deactivated, since a rule can't set them", () => {
    expect(ruleFormFromTransaction({ ...t, person: { ...kid, active: false } }).person).toBe('');
  });

  it('cuts a long merchant to the longest text a rule can have', () => {
    const long = 'A'.repeat(RULE_TEXT_MAX + 20);
    expect(ruleFormFromTransaction({ ...t, merchant: long }).matchText).toBe('A'.repeat(RULE_TEXT_MAX));
    // Never half of a character made of two code units.
    const emoji = `${'A'.repeat(RULE_TEXT_MAX - 1)}\u{1F600}B`;
    expect(ruleFormFromTransaction({ ...t, merchant: emoji }).matchText).toBe('A'.repeat(RULE_TEXT_MAX - 1));
    expect(toRuleInput(ruleFormFromTransaction({ ...t, merchant: long }))).toMatchObject({ ok: true });
  });

  it("leaves out a category that's archived, since a rule can't set it", () => {
    expect(ruleFormFromTransaction({ ...t, category: { ...dining, archived: true } }).categoryId).toBe('');
  });

  it("fills in from the row's unsaved picks when it has them, else from what's saved", () => {
    expect(ruleFormFromTransaction(t, { category: '5' })).toMatchObject({ categoryId: '5', person: '7' });
    expect(ruleFormFromTransaction(t, { person: '9' })).toMatchObject({ categoryId: '2', person: '9' });
    expect(ruleFormFromTransaction(t, { category: '5', person: '9' })).toMatchObject({ categoryId: '5', person: '9' });
    // Household picked but not saved is a choice, even over a saved person or a default Household.
    expect(ruleFormFromTransaction(t, { person: '' }).person).toBe('household');
    expect(ruleFormFromTransaction({ ...t, person: null, personSource: 'default' }, { person: '' }).person).toBe('household');
    expect(ruleFormFromTransaction({ ...t, category: { ...dining, archived: true } }, {}).categoryId).toBe('');
  });
});

describe('describeMatch', () => {
  const base = { matchText: 'netflix', matchType: 'contains' as const, card: null, minCents: null, maxCents: null };
  it('describes the text, card, and amounts', () => {
    expect(describeMatch(base, formatCents)).toBe('Text contains "netflix"');
    expect(describeMatch({ ...base, matchType: 'exact', card: { id: 1, nickname: 'Visa', mask: null, archived: false }, minCents: 1000, maxCents: 2000 }, formatCents)).toBe(
      'Text is "netflix", on Visa, $10.00 to $20.00',
    );
    expect(describeMatch({ ...base, minCents: 1000 }, formatCents)).toBe('Text contains "netflix", $10.00 or more');
    expect(describeMatch({ ...base, maxCents: -1 }, formatCents)).toBe('Text contains "netflix", -$0.01 or less');
  });
});
