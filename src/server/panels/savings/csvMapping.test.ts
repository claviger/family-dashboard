import { describe, expect, it } from 'vitest';
import { SAVINGS_MESSAGES, type SavingsMapping } from '../../../shared/savings.js';
import { BANK_FILE, BROKERAGE_FILE, CASH_FILE, FIDELITY_RULE_ACTIONS } from '../../test/importCsv.js';
import { guessMapping, readMapped } from './csvMapping.js';
import { dateFormatsOf, parseDate, parseMoney } from '../../csv/values.js';
import { groupLabel } from './csvRows.js';
import { findCsvTable, type CsvTable } from '../../csv/table.js';
import { BUILT_IN_FORMATS, builtInFormatFor } from './importFormats.js';

// Synthetic files (src/server/test/importCsv.ts). Today is 2026-11-15.
const TODAY = '2026-11-15';
function table(text: string): CsvTable {
  const found = findCsvTable(text);
  if (!found.ok) throw new Error(found.message);
  return found.table;
}
const tiny = (rows: string[][], header = ['Date', 'Description', 'Amount']): CsvTable => ({ header, rows: rows.map((cells, i) => ({ line: i + 2, cells })) });

describe('parseMoney', () => {
  it('reads signs, currency signs, separators, and parentheses; empty is none', () => {
    expect(['1,234.56', '"1234.56"'.slice(1, -1), '$1,234.56', '+1234.56', ' $ 1234.56 '].map(parseMoney)).toEqual([1234_56, 1234_56, 1234_56, 1234_56, 1234_56]);
    expect(['-12.34', '(12.34)', '-$12.34', '$-12.34', '−12.34', '€12.34'].map(parseMoney)).toEqual([-12_34, -12_34, -12_34, -12_34, -12_34, 12_34]);
    expect(parseMoney('')).toBeNull();
    expect(parseMoney('0')).toBe(0);
    expect(['abc', '1.234,56', '12.345', 'Processing', '1 2'].map(parseMoney)).toEqual(['bad', 'bad', 'bad', 'bad', 'bad']);
  });

  it('takes at most one negative marker', () => {
    for (const t of ['(-5)', '--5', '(-$5)', '-(5)', '-$-5', '(\u22125)', '\u2212\u22125', '-\u22125', '(5']) expect(parseMoney(t), t).toBe('bad');
    expect(['(5)', '($5)', '-$5', '$-5', '\u22125'].map(parseMoney)).toEqual([-5_00, -5_00, -5_00, -5_00, -5_00]);
  });
});

describe('dates', () => {
  it('reads each format, padded or not, and only real days', () => {
    expect(parseDate('2026-11-05', 'ymd')).toBe('2026-11-05');
    expect(parseDate('2026-1-5', 'ymd')).toBe('2026-01-05');
    expect(parseDate('11/5/2026', 'mdy')).toBe('2026-11-05');
    expect(parseDate('5/11/2026', 'dmy')).toBe('2026-11-05');
    expect(parseDate('13/10/2026', 'mdy')).toBeNull();
    expect(parseDate('02/30/2026', 'mdy')).toBeNull();
    expect(parseDate('11/5/26', 'mdy')).toBeNull();
  });

  it('takes a leap day only in a leap year', () => {
    expect(parseDate('2/29/2028', 'mdy')).toBe('2028-02-29');
    expect(parseDate('29/2/2028', 'dmy')).toBe('2028-02-29');
    expect(parseDate('2028-02-29', 'ymd')).toBe('2028-02-29');
    expect(parseDate('2/29/2027', 'mdy')).toBeNull();
  });

  it('lists the formats every value of a column fits, both for an ambiguous one', () => {
    expect(dateFormatsOf(['13/10/2026', '02/11/2026'])).toEqual(['dmy']);
    expect(dateFormatsOf(['11/12/2026', '10/28/2026'])).toEqual(['mdy']);
    expect(dateFormatsOf(['01/02/2026', '03/04/2026', ''])).toEqual(['mdy', 'dmy']);
    expect(dateFormatsOf(['2026-11-01'])).toEqual(['ymd']);
    expect(dateFormatsOf(['DIRECT DEPOSIT'])).toEqual([]);
    expect(dateFormatsOf(['', ''])).toEqual([]);
  });
});

describe('readMapped', () => {
  const signed: SavingsMapping = { date: { column: 0, format: 'ymd' }, amount: { kind: 'signed', column: 2, inIsNegative: false }, balance: null, description: 1 };

  it('reads a signed column, flipping it for a bank that writes money in as negative', () => {
    const t = tiny([['2026-11-01', 'PAYCHECK  EXAMPLE', '-100.00'], ['2026-11-02', '', ''], ['2026-11-03', 'FEE', '0']]);
    expect(readMapped(t, signed, TODAY)).toEqual({ ok: true, rows: [
      { line: 2, date: '2026-11-01', cents: -100_00, balanceCents: null, description: 'PAYCHECK EXAMPLE' },
      { line: 3, date: '2026-11-02', cents: null, balanceCents: null, description: '' },
      { line: 4, date: '2026-11-03', cents: 0, balanceCents: null, description: 'FEE' },
    ] });
    const flipped = readMapped(t, { ...signed, amount: { kind: 'signed', column: 2, inIsNegative: true } }, TODAY);
    expect(flipped.ok && flipped.rows.map((r) => r.cents)).toEqual([100_00, null, 0]);
  });

  it('reads Debit and Credit columns as money out and in, and a balance that isn\'t a number as none', () => {
    const rows = readMapped(table(BANK_FILE), { date: { column: 0, format: 'dmy' }, amount: { kind: 'split', debit: 2, credit: 3 }, balance: { column: 4, isValue: true }, description: 1 }, TODAY);
    expect(rows.ok && rows.rows.map((r) => [r.date, r.cents, r.balanceCents])).toEqual([
      ['2026-10-13', 1000_00, 1000_00], ['2026-10-15', -45_10, 954_90], ['2026-10-15', -45_10, 909_80],
      ['2026-10-31', 75, 910_55], ['2026-11-02', 2500_00, 3410_55], ['2026-11-05', -200_00, 3210_55],
    ]);
    const processing = readMapped(table(BROKERAGE_FILE), BUILT_IN_FORMATS[1]!.mapping, TODAY);
    expect(processing.ok && processing.rows[0]!.balanceCents).toBeNull();
  });

  it('refuses a bad date or amount by its line, and a column used twice or not there', () => {
    const t = tiny([['2026-11-01', 'A', '1.00'], ['11/02/2026', 'B', '2.00'], ['2026-11-03', 'C', 'lots']]);
    expect(readMapped(t, signed, TODAY)).toEqual({ ok: false, message: SAVINGS_MESSAGES.mapBadDate(3, 'YYYY-MM-DD') });
    expect(readMapped(tiny([['2026-11-01', 'C', 'lots']]), signed, TODAY)).toEqual({ ok: false, message: SAVINGS_MESSAGES.mapBadAmount(2) });
    expect(readMapped(tiny([['2026-11-17', 'C', '1']]), signed, TODAY)).toEqual({ ok: false, message: SAVINGS_MESSAGES.mapBadDate(2, 'YYYY-MM-DD') });
    expect(readMapped(t, { ...signed, description: 2 }, TODAY)).toEqual({ ok: false, message: SAVINGS_MESSAGES.mapSameColumn });
    expect(readMapped(t, { ...signed, description: 7 }, TODAY)).toEqual({ ok: false, message: SAVINGS_MESSAGES.mapColumnMissing });
  });
});

describe('guessMapping', () => {
  it('suggests Debit and Credit, the balance, and the description for a bank file', () => {
    expect(guessMapping(table(BANK_FILE), 'cash')).toEqual({
      date: { column: 0, format: 'dmy' }, amount: { kind: 'split', debit: 2, credit: 3 }, balance: { column: 4, isValue: true }, description: 1,
    });
    expect(guessMapping(table(BANK_FILE), 'investment')?.balance).toEqual({ column: 4, isValue: false });
  });

  it('suggests a signed amount column, and nothing without a date or an amount', () => {
    expect(guessMapping(tiny([['2026-11-01', 'A', '1.00']], ['Posted', 'Memo', 'Amount']), 'cash')).toEqual({
      date: { column: 0, format: 'ymd' }, amount: { kind: 'signed', column: 2, inIsNegative: false }, balance: null, description: 1,
    });
    expect(guessMapping(tiny([['x', 'A', '1.00']]), 'cash')).toBeNull();
    expect(guessMapping(tiny([['2026-11-01', 'A', '1.00']], ['Date', 'Memo', 'Value']), 'cash')).toBeNull();
  });
});

describe('the built-in formats', () => {
  it('recognize Fidelity\'s two headers exactly, and read their files', () => {
    expect(builtInFormatFor(table(CASH_FILE).header)?.id).toBe('fidelity_cash');
    expect(builtInFormatFor(table(BROKERAGE_FILE).header)?.id).toBe('fidelity_brokerage');
    expect(builtInFormatFor(table(BANK_FILE).header)).toBeNull();
    expect(builtInFormatFor([...table(CASH_FILE).header.slice(0, -1), 'Settled'])).toBeNull();
    for (const [file, format] of [[CASH_FILE, BUILT_IN_FORMATS[0]!], [BROKERAGE_FILE, BUILT_IN_FORMATS[1]!]] as const) {
      expect(readMapped(table(file), format.mapping, TODAY).ok, format.id).toBe(true);
    }
  });

  it("name in their rules exactly the labels groupLabel makes of Fidelity's wordings", () => {
    for (const format of BUILT_IN_FORMATS) {
      const labels = FIDELITY_RULE_ACTIONS[format.id].map(groupLabel);
      expect(new Set(labels), format.id).toEqual(new Set(Object.keys(format.rules)));
      expect(labels.every((l) => format.rules[l] !== undefined), format.id).toBe(true);
    }
  });
});
