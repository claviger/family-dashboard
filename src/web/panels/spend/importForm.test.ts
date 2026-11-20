import { describe, expect, it } from 'vitest';
import type { CardMapping, ImportColumns } from '../../../shared/spend.js';
import { formFromPreview, mappingFromForm } from './importForm.js';

const SPLIT: CardMapping = { date: { column: 0, format: 'mdy' }, amount: { kind: 'split', charges: 3, credits: 4 }, description: 1, reference: null, address: null };
const columns = (dateFormats: ImportColumns['dateFormats'], suggested: CardMapping | null = null): ImportColumns => ({
  header: ['Transaction Date', 'Description', 'Category', 'Debit', 'Credit'], sample: [], rowCount: 6, trailingSkipped: 0, dateFormats, suggested, problem: null, hint: null,
});

describe('formFromPreview', () => {
  it('starts from the guess, with the one format its dates fit', () => {
    expect(formFromPreview({ mapping: null, columns: columns([['dmy'], [], [], [], []], SPLIT) })).toEqual({
      date: 0, format: 'dmy', kind: 'split', amount: '', purchasesNegative: false, charges: 3, credits: 4, description: 1, reference: '', address: '',
    });
  });

  it('leaves the format blank when every day is 12 or under, whatever the guess says (plan decision 8)', () => {
    expect(formFromPreview({ mapping: null, columns: columns([['mdy', 'dmy'], [], [], [], []], SPLIT) }).format).toBe('');
  });

  it("keeps the draft's own mapping's format when both fit: saved, built in, or the admin's before Change the columns", () => {
    expect(formFromPreview({ mapping: SPLIT, columns: columns([['mdy', 'dmy'], [], [], [], []]) }).format).toBe('mdy');
  });

  it('reads a signed mapping, and starts empty with nothing to go on', () => {
    const signed: CardMapping = { date: { column: 0, format: 'ymd' }, amount: { kind: 'signed', column: 2, purchasesNegative: true }, description: 1, reference: 3, address: 4 };
    expect(formFromPreview({ mapping: signed, columns: columns([['ymd'], [], [], [], []]) })).toMatchObject({ kind: 'signed', amount: 2, purchasesNegative: true, reference: 3, address: 4 });
    expect(formFromPreview({ mapping: null, columns: columns([[], [], [], [], []]) })).toEqual({
      date: '', format: '', kind: 'signed', amount: '', purchasesNegative: false, charges: '', credits: '', description: '', reference: '', address: '',
    });
  });
});

describe('mappingFromForm', () => {
  const full = formFromPreview({ mapping: SPLIT, columns: columns([['mdy'], [], [], [], []]) });

  it('asks for the date and its format, the amount, and the description first', () => {
    expect(mappingFromForm({ ...full, format: '' })).toEqual({ ok: false, problem: 'Choose the date column and how its dates are written.' });
    expect(mappingFromForm({ ...full, credits: '' })).toEqual({ ok: false, problem: 'Choose the amount column, or the charges and the payments and credits columns.' });
    expect(mappingFromForm({ ...full, kind: 'signed' })).toEqual({ ok: false, problem: 'Choose the amount column, or the charges and the payments and credits columns.' });
    expect(mappingFromForm({ ...full, description: '' })).toEqual({ ok: false, problem: 'Choose the description or payee column.' });
  });

  it('makes the mapping, with None as null', () => {
    expect(mappingFromForm(full)).toEqual({ ok: true, mapping: SPLIT });
    expect(mappingFromForm({ ...full, kind: 'signed', amount: 2, purchasesNegative: true, reference: 3 })).toEqual({
      ok: true, mapping: { ...SPLIT, amount: { kind: 'signed', column: 2, purchasesNegative: true }, reference: 3 },
    });
  });
});
