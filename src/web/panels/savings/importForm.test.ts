import { describe, expect, it } from 'vitest';
import type { SavingsImportDraft, SavingsMapping } from '../../../shared/savings.js';
import { formFromDraft, groupChoicesFrom, mappingFromForm, stepAfterUpdate } from './importForm.js';

// Synthetic drafts: only the fields the form reads.
const signed: SavingsMapping = { date: { column: 0, format: 'mdy' }, amount: { kind: 'signed', column: 2, inIsNegative: false }, balance: { column: 3, isValue: true }, description: 1 };
function draft(over: Partial<SavingsImportDraft>): Pick<SavingsImportDraft, 'mapping' | 'suggested' | 'dateFormats'> {
  return { mapping: null, suggested: null, dateFormats: [['mdy'], [], [], []], ...over };
}

describe('the columns form', () => {
  it("starts from the server's suggestion when it fits one date format", () => {
    expect(formFromDraft(draft({ suggested: signed }), 'cash')).toEqual({
      date: 0, format: 'mdy', kind: 'signed', amount: 2, inIsNegative: false, debit: '', credit: '', balance: 3, isValue: true, description: 1,
    });
  });

  it('starts the date format blank when the column fits both M/D and D/M, whatever was suggested', () => {
    const both: Pick<SavingsImportDraft, 'dateFormats'> = { dateFormats: [['mdy', 'dmy'], [], [], []] };
    expect(formFromDraft(draft({ ...both, suggested: signed }), 'cash').format).toBe('');
    expect(formFromDraft(draft({ ...both, suggested: { ...signed, date: { column: 0, format: 'dmy' } } }), 'cash').format).toBe('');
  });

  it('keeps a mapping the server already set (saved, built-in, or chosen before Back), even on an ambiguous column', () => {
    expect(formFromDraft(draft({ dateFormats: [['mdy', 'dmy'], [], [], []], mapping: { ...signed, date: { column: 0, format: 'dmy' } } }), 'cash').format).toBe('dmy');
  });

  it("starts blank with no suggestion, a column that isn't a date, and an investment balance that isn't the account's value", () => {
    expect(formFromDraft(draft({}), 'investment')).toEqual({
      date: '', format: '', kind: 'signed', amount: '', inIsNegative: false, debit: '', credit: '', balance: '', isValue: false, description: '',
    });
    expect(formFromDraft(draft({ dateFormats: [[], [], [], []], suggested: signed }), 'cash').format).toBe('');
    const split: SavingsMapping = { ...signed, amount: { kind: 'split', debit: 2, credit: 3 }, balance: null };
    expect(formFromDraft(draft({ suggested: split }), 'investment')).toMatchObject({ kind: 'split', debit: 2, credit: 3, amount: '', balance: '', isValue: false });
  });

  it('makes a mapping, or says what to choose first', () => {
    const form = formFromDraft(draft({ suggested: signed }), 'cash');
    expect(mappingFromForm(form, 'cash')).toEqual({ ok: true, mapping: signed });
    expect(mappingFromForm({ ...form, format: '' }, 'cash')).toEqual({ ok: false, problem: 'Choose the date column and how its dates are written.' });
    expect(mappingFromForm({ ...form, amount: '' }, 'cash')).toEqual({ ok: false, problem: 'Choose the amount column, or the debit and credit columns.' });
    expect(mappingFromForm({ ...form, kind: 'split', debit: 2, credit: '' }, 'cash')).toEqual({ ok: false, problem: 'Choose the amount column, or the debit and credit columns.' });
    expect(mappingFromForm({ ...form, kind: 'split', debit: 2, credit: 4, balance: '', description: '' }, 'cash'))
      .toEqual({ ok: true, mapping: { date: signed.date, amount: { kind: 'split', debit: 2, credit: 4 }, balance: null, description: null } });
    // A cash account's balance is always its value; an investment's only when ticked.
    expect(mappingFromForm({ ...form, isValue: false }, 'cash')).toMatchObject({ mapping: { balance: { column: 3, isValue: true } } });
    expect(mappingFromForm({ ...form, isValue: false }, 'investment')).toMatchObject({ mapping: { balance: { column: 3, isValue: false } } });
  });
});

describe('the steps', () => {
  const groups = [{ label: 'A', count: 1, choice: null, suggested: 'by_sign' as const }];
  it('shows the groups after any columns change, and the results only once the choices are sent', () => {
    expect(stepAfterUpdate({ mapping: signed, groups, results: null }, false)).toBe('groups');
    expect(stepAfterUpdate({ mapping: signed, groups, results: {} as never }, false)).toBe('groups');
    expect(stepAfterUpdate({ mapping: signed, groups, results: {} as never }, true)).toBe('results');
    expect(stepAfterUpdate({ mapping: signed, groups, results: null }, true)).toBe('groups');
  });

  it('preselects a decided group with its choice and a new one with the suggestion', () => {
    expect(groupChoicesFrom([...groups, { label: '', count: 2, choice: 'not_counted', suggested: 'deposit' }])).toEqual({ A: 'by_sign', '': 'not_counted' });
  });
});
