import { describe, expect, it } from 'vitest';
import { POSSIBLE_DUPLICATE, type CardMapping, type ImportColumns, type PreviewRow, type SpendTransaction } from '../../../shared/spend.js';
import {
  cardName, changeLine, cycleLabel, cycleOption, excludedNote, instantDate, longDate, movedLine, otherCurrencyLine, pendingAmount, periodNames, personName,
  mappingLines, prefilledNote, previewNote, resettableFields, rowLabels, shortDate, skippedNote, sourceNote, totalWords, updatedLine,
} from './format.js';

describe('dates and cycles', () => {
  it('formats family-local dates without shifting them', () => {
    expect(shortDate('2026-11-02')).toBe('Nov 2');
    expect(longDate('2026-01-01')).toBe('Jan 1, 2026');
  });

  it('labels a cycle, across a year, and a calendar month', () => {
    expect(cycleLabel({ start: '2026-10-16', end: '2026-11-15' }, 'cycles')).toBe('Oct 16 to Nov 15, 2026');
    expect(cycleLabel({ start: '2026-12-16', end: '2027-01-15' }, 'cycles')).toBe('Dec 16, 2026 to Jan 15, 2027');
    expect(cycleLabel({ start: '2026-11-01', end: '2026-11-30' }, 'calendar_month')).toBe('November 2026');
    expect(cycleOption({ start: '2026-11-16', end: '2026-12-15', current: true, closingSource: 'inferred' }, 'cycles')).toBe('Nov 16 to Dec 15, 2026 (current)');
  });
});

describe('instantDate', () => {
  it("dates an instant on the family's calendar", () => {
    expect(instantDate('2026-11-16T06:30:00Z', 'America/Los_Angeles')).toBe('Nov 15, 2026');
    expect(instantDate('2026-11-16T06:30:00Z', 'UTC')).toBe('Nov 16, 2026');
  });
});

describe('totalWords', () => {
  it('says spent, or in credits for a negative total, never a negative amount spent', () => {
    expect(totalWords(12_345, true)).toEqual({ amount: '$123.45', words: 'spent so far' });
    expect(totalWords(0, false)).toEqual({ amount: '$0.00', words: 'spent' });
    expect(totalWords(-2_500, true)).toEqual({ amount: '$25.00', words: 'in credits so far' });
    expect(totalWords(-2_500, false, 'EUR')).toEqual({ amount: '€25.00', words: 'in credits' });
  });
});

describe('rowLabels', () => {
  const cat = { id: 1, name: 'C', kind: 'normal' as const, archived: false };
  const t = (id: number, patch: Partial<SpendTransaction>): SpendTransaction => ({
    id, cardId: 1, source: 'csv', date: '2026-11-01', merchant: 'FASTRAK', rawName: 'FASTRAK', amountCents: 275, currency: 'USD', pending: false,
    category: cat, categorySource: 'default', person: null, personSource: 'default', note: null, twinIds: [], ...patch,
  });

  it('names each row by merchant, date, and amount, and numbers rows that would share a name', () => {
    const labels = rowLabels([t(1, {}), t(2, { amountCents: 300 }), t(3, {}), t(4, { date: '2026-11-02' })]);
    expect([...labels.values()]).toEqual([
      'FASTRAK, Nov 1, 2026, $2.75, 1 of 2',
      'FASTRAK, Nov 1, 2026, $3.00',
      'FASTRAK, Nov 1, 2026, $2.75, 2 of 2',
      'FASTRAK, Nov 2, 2026, $2.75',
    ]);
  });
});

describe('changeLine', () => {
  it('compares with the previous cycle or month', () => {
    expect(changeLine(15_000, 12_500, 'cycles')).toBe('Up $25.00 from last cycle ($125.00)');
    expect(changeLine(10_000, 12_500, 'calendar_month')).toBe('Down $25.00 from last month ($125.00)');
    expect(changeLine(100, 100, 'cycles')).toBe('The same as last cycle ($1.00)');
    expect(changeLine(100, null, 'cycles')).toBeNull();
  });

  it('says a negative previous total in credits', () => {
    expect(changeLine(1_000, -2_500, 'cycles')).toBe('Up $35.00 from last cycle ($25.00 in credits)');
    expect(changeLine(-2_500, -2_500, 'calendar_month')).toBe('The same as last month ($25.00 in credits)');
  });
});

describe('pendingAmount', () => {
  it('says pending credits in credits, never a negative amount', () => {
    expect(pendingAmount(1_250)).toBe('$12.50');
    expect(pendingAmount(-1_000)).toBe('$10.00 in credits');
    expect(pendingAmount(-1_000, 'EUR')).toBe('€10.00 in credits');
  });
});

describe('periodNames', () => {
  it('names the current cycle or month, and the one before', () => {
    const current = { start: '2026-11-16', end: '2026-12-15', current: true, closingSource: 'inferred' as const };
    expect(periodNames(current, 'cycles')).toEqual({
      current: 'this cycle', previous: 'last cycle', currentHeading: 'This cycle', previousHeading: 'Last cycle', empty: 'Nothing spent this cycle.',
    });
    expect(periodNames({ ...current, start: '2026-11-01', end: '2026-11-30' }, 'calendar_month')).toMatchObject({
      currentHeading: 'This month', previousHeading: 'Last month', empty: 'Nothing spent this month.',
    });
  });

  it("names a past cycle by its dates, and the one before it as the previous one", () => {
    const past = { start: '2026-09-16', end: '2026-10-15', current: false, closingSource: 'inferred' as const };
    expect(periodNames(past, 'cycles')).toEqual({
      current: 'Sep 16 to Oct 15, 2026',
      previous: 'the previous cycle',
      currentHeading: 'Sep 16 to Oct 15, 2026',
      previousHeading: 'Previous cycle',
      empty: 'Nothing spent from Sep 16 to Oct 15, 2026.',
    });
    expect(periodNames({ ...past, start: '2026-09-01', end: '2026-09-30' }, 'calendar_month')).toEqual({
      current: 'September 2026',
      previous: 'the previous month',
      currentHeading: 'September 2026',
      previousHeading: 'Previous month',
      empty: 'Nothing spent in September 2026.',
    });
  });
});

describe('movedLine', () => {
  it('says where a moved item is now', () => {
    expect(movedLine('the rule for "x"', 'up', 2, 5)).toBe('Moved the rule for "x" up. It\'s now 2 of 5.');
    expect(movedLine('Pets', 'down', 0, 12)).toBe("Moved Pets down. It's now 2 of 12.");
    expect(movedLine('Pets', 'up', 1, 12)).toBe("Moved Pets up. It's now 1 of 12.");
  });
});

describe('names and notes', () => {
  it('names Household, people, and deactivated people', () => {
    expect(personName(null)).toBe('Household');
    expect(personName({ displayName: 'Riley', active: true })).toBe('Riley');
    expect(personName({ displayName: 'Old', active: false })).toBe('Old (deactivated)');
  });

  it('says where a value came from', () => {
    expect(sourceNote('manual')).toBe('Set by hand');
    expect(sourceNote('rule')).toBe('By a rule');
    expect(sourceNote('mapping')).toBe('From the bank');
    expect(sourceNote('default')).toBe('');
  });

  it('names a card with its last 4', () => {
    expect(cardName({ nickname: 'Visa', mask: '1234' })).toBe('Visa ·1234');
    expect(cardName({ nickname: 'Amex', mask: null })).toBe('Amex');
  });

  it('says when the card was last updated, by the server clock', () => {
    const now = Date.parse('2026-11-15T12:00:00Z');
    expect(updatedLine('2026-11-12T12:00:00Z', now)).toBe('Updated 3 days ago');
    expect(updatedLine(null, now)).toBe('Nothing imported yet');
  });
});

describe('previewNote', () => {
  const base: PreviewRow = { line: 2, status: 'new', date: '2026-11-09', reference: 'R2', payee: 'PARKING GARAGE #2', address: null, amountCents: 999, reason: null, duplicateOf: null };
  const near = { id: 4, date: '2026-11-08', merchant: 'PARKING GARAGE', amountCents: 999 };

  it('says what a duplicate looks like', () => {
    expect(previewNote({ ...base, status: 'duplicate', duplicateOf: near })).toBe('Looks like one already here: Nov 8, PARKING GARAGE, $9.99');
  });

  it('warns about a row that differs from a stored one only by its reference number', () => {
    expect(previewNote({ ...base, reason: POSSIBLE_DUPLICATE, duplicateOf: near })).toBe('Possible duplicate (different reference number): Nov 8, PARKING GARAGE, $9.99');
  });

  it('has nothing to say about a plain new row', () => {
    expect(previewNote(base)).toBeNull();
  });
});

describe('excludedNote (review C-M6)', () => {
  const cat = (id: number, name: string, kind: 'normal' | 'excluded' | 'uncategorized') => ({ id, name, kind, archived: false, inUse: false });
  it("names the excluded category as it's called now", () => {
    expect(excludedNote([cat(1, 'Dining', 'normal'), cat(2, 'Payments and transfers', 'excluded')])).toBe("The Payments and transfers category isn't counted.");
    expect(excludedNote([cat(2, 'Card payments', 'excluded')])).toBe("The Card payments category isn't counted.");
  });
  it('says nothing until the categories are in', () => {
    expect(excludedNote([])).toBeNull();
  });
});

describe('otherCurrencyLine (review C-M9)', () => {
  it('says how many transactions are left out for their currency', () => {
    expect(otherCurrencyLine(0)).toBeNull();
    expect(otherCurrencyLine(1)).toBe('1 transaction is in another currency and not counted.');
    expect(otherCurrencyLine(3)).toBe('3 transactions are in another currency and not counted.');
  });
});

describe('resettableFields (review C-M8)', () => {
  const active = { id: 7, displayName: 'Riley', color: '#000', active: true };
  const base: SpendTransaction = {
    id: 1, cardId: 1, source: 'csv', date: '2026-11-02', merchant: 'SHOP', rawName: 'SHOP', amountCents: 100, currency: 'USD', pending: false,
    category: { id: 3, name: 'Dining', kind: 'normal', archived: false }, categorySource: 'rule', person: active, personSource: 'rule', note: null, twinIds: [],
  };
  it('offers fields set by hand', () => {
    expect(resettableFields(base)).toEqual([]);
    expect(resettableFields({ ...base, categorySource: 'manual' })).toEqual(['category']);
    expect(resettableFields({ ...base, categorySource: 'manual', personSource: 'manual' })).toEqual(['category', 'person']);
  });
  it("offers values a rule or the bank's mapping set that can't be assigned any more", () => {
    expect(resettableFields({ ...base, category: { ...base.category, archived: true } })).toEqual(['category']);
    expect(resettableFields({ ...base, categorySource: 'mapping', category: { ...base.category, archived: true } })).toEqual(['category']);
    expect(resettableFields({ ...base, person: { ...active, active: false } })).toEqual(['person']);
    // Household can always be assigned.
    expect(resettableFields({ ...base, person: null })).toEqual([]);
  });
});

describe('the import words (the generic import design)', () => {
  const header = ['Transaction Date', 'Description', 'Category', 'Debit', 'Credit'];
  const split: CardMapping = { date: { column: 0, format: 'dmy' }, amount: { kind: 'split', charges: 3, credits: 4 }, description: 1, reference: null, address: null };
  const cols = (patch: Partial<ImportColumns> = {}): ImportColumns => ({ header, sample: [], rowCount: 1, trailingSkipped: 0, dateFormats: [], suggested: null, problem: null, hint: null, ...patch });

  it('says the saved columns one role a line', () => {
    expect(mappingLines(header, split)).toEqual([
      'Date: Transaction Date, written D/M/YYYY',
      'Amount: Debit for charges, Credit for payments and credits',
      'Description: Description',
      'Reference number: none, so each row gets a key from its date, amount, and description',
      'Address: none',
    ]);
    expect(mappingLines(['Posted Date', 'Reference Number', 'Payee', 'Address', ''], { date: { column: 0, format: 'mdy' }, amount: { kind: 'signed', column: 4, purchasesNegative: true }, description: 2, reference: 1, address: 3 })).toEqual([
      'Date: Posted Date, written M/D/YYYY',
      'Amount: Column 5, purchases negative',
      'Description: Payee',
      'Reference number: Reference Number',
      'Address: Address',
    ]);
  });

  it('says where the columns came from, and nothing when saved ones did not fit', () => {
    expect(prefilledNote({ prefilled: 'profile', format: 'custom', columns: cols() })).toBe("Read with this card's saved columns. If something looks wrong, change the columns.");
    expect(prefilledNote({ prefilled: 'builtin', format: 'bofa_credit', columns: cols() })).toBe("This is a Bank of America credit card file, so it's read the way Bank of America writes it.");
    expect(prefilledNote({ prefilled: 'guess', format: 'custom', columns: cols({ suggested: split }) })).toBe('The columns are a guess from their names. Check each one.');
    expect(prefilledNote({ prefilled: 'guess', format: 'custom', columns: cols() })).toBeNull();
    expect(prefilledNote({ prefilled: 'profile', format: 'custom', columns: cols({ suggested: split, problem: 'x' }) })).toBeNull();
    expect(prefilledNote({ prefilled: 'builtin', format: 'bofa_credit', columns: cols({ problem: 'x' }) })).toBeNull();
  });

  it('says how many lines after the table were skipped, never what they said', () => {
    expect(skippedNote(cols())).toBeNull();
    expect(skippedNote(cols({ trailingSkipped: 1 }))).toBe('1 line after the table was skipped, as a footer.');
    expect(skippedNote(cols({ trailingSkipped: 2 }))).toBe('2 lines after the table were skipped, as a footer.');
  });
});
