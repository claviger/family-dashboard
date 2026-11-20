import { describe, expect, it } from 'vitest';
import { SPEND_MESSAGES, type CardMapping } from '../../../shared/spend.js';
import { CSV_ERRORS } from '../../csv/records.js';
import { CSV_TABLE_MESSAGES } from '../../csv/table.js';
import { dateFormatsOf } from '../../csv/values.js';
import { bytes } from '../../test/bofaCsv.js';
import { DEBIT_CREDIT_SAMPLE, debitCreditCsv, signedCsv } from '../../test/cardCsv.js';
import {
  CARD_CSV_MESSAGES, guessCardMapping, isRowKey, mappingProblem, readCardFile, readCardRows, realReference, rowKey, ROW_REASONS, type CardTable,
} from './cardCsv.js';

// Synthetic files (src/server/test/cardCsv.ts). Today is 2026-11-15.
const TODAY = '2026-11-15';
const CARD = 7;
function table(text: string): CardTable {
  const file = readCardFile(bytes(text));
  if (!file.ok) throw new Error(file.message);
  return file.table;
}
const DEBIT_CREDIT: CardMapping = { date: { column: 0, format: 'dmy' }, amount: { kind: 'split', charges: 3, credits: 4 }, description: 1, reference: null, address: null };
const SIGNED: CardMapping = { date: { column: 0, format: 'ymd' }, amount: { kind: 'signed', column: 2, purchasesNegative: false }, description: 1, reference: null, address: null };
function read(text: string, m: CardMapping, opts: { cardId?: number; bofa?: boolean; fileName?: string | null } = {}) {
  const result = readCardRows(table(text), m, { cardId: opts.cardId ?? CARD, today: TODAY, fileName: opts.fileName ?? null, bofa: opts.bofa ?? false });
  if (!result.ok) throw new Error(result.message);
  return result;
}
const SAMPLE = debitCreditCsv(DEBIT_CREDIT_SAMPLE);

describe('readCardRows: amounts', () => {
  it('reads separate charges and credits as positive, whatever sign the issuer wrote, in the app sign', () => {
    const { rows } = read(SAMPLE, DEBIT_CREDIT);
    expect(rows.map((r) => [r.line, r.status, r.date, r.payee, r.amountCents, r.address])).toEqual([
      [2, 'new', '2026-10-13', 'CORNER CAFE 0042', 450, null],
      [3, 'new', '2026-10-14', 'BOOK NOOK', 102499, null],
      [4, 'new', '2026-10-15', 'CORNER CAFE 0042', 450, null],
      [5, 'new', '2026-10-15', 'CORNER CAFE 0042', 450, null],
      [6, 'new', '2026-10-16', 'ONLINE PAYMENT THANK YOU', -50000, null],
      [7, 'new', '2026-10-17', 'HARDWARE BARN #12', -1200, null],
    ]);
  });

  it('lists a row with both a charge and a credit as unreadable instead of netting them; a zero in the other column is no amount', () => {
    const file = debitCreditCsv([
      { date: '13/10/2026', description: 'BOTH', debit: '4.50', credit: '1.00' },
      { date: '13/10/2026', description: 'ZERO CREDIT', debit: '4.50', credit: '0.00' },
      { date: '13/10/2026', description: 'ZERO CHARGE', debit: '0.00', credit: '2.00' },
    ]);
    expect(mappingProblem(table(file), DEBIT_CREDIT)).toBeNull();
    expect(read(file, DEBIT_CREDIT).rows.map((r) => [r.status, r.amountCents, r.reason])).toEqual([
      ['unreadable', null, ROW_REASONS.bothAmounts],
      ['new', 450, null],
      ['new', -200, null],
    ]);
  });

  it('reads one signed column either way round', () => {
    const file = signedCsv([{ date: '2026-11-02', merchant: 'CORNER CAFE', amount: '4.50' }, { date: '2026-11-03', merchant: 'REFUND SHOP', amount: '-2.00' }]);
    expect(read(file, SIGNED).rows.map((r) => r.amountCents)).toEqual([450, -200]);
    const negative = { ...SIGNED, amount: { kind: 'signed', column: 2, purchasesNegative: true } } as const;
    expect(read(file, negative).rows.map((r) => r.amountCents)).toEqual([-450, 200]);
  });

  it("reads money as the Savings importer does, and lists a row with no amount as unreadable", () => {
    const file = signedCsv([
      { date: '2026-11-02', merchant: 'BIG SHOP', amount: '$1,234.56' },
      { date: '2026-11-02', merchant: 'RETURN', amount: '(12.00)' },
      { date: '2026-11-02', merchant: 'NOTHING', amount: '' },
    ]);
    expect(read(file, SIGNED).rows.map((r) => [r.status, r.amountCents, r.reason])).toEqual([
      ['new', 123456, null],
      ['new', -1200, null],
      ['unreadable', null, ROW_REASONS.badAmount],
    ]);
  });
});

describe('readCardRows: dates and bad rows', () => {
  it('skips a row with an empty date as not posted yet, and counts it', () => {
    const { rows } = read(debitCreditCsv([{ date: '', description: 'HOTEL HOLD', debit: '300.00' }, DEBIT_CREDIT_SAMPLE[0]!]), DEBIT_CREDIT);
    expect(rows[0]).toEqual({ line: 2, status: 'pending_credit', date: null, reference: null, payee: 'HOTEL HOLD', address: null, amountCents: 30000, reason: ROW_REASONS.notPosted, duplicateOf: null });
    expect(rows[1]!.status).toBe('new');
    const onlyPending = readCardRows(table(debitCreditCsv([{ date: '', description: 'HOTEL HOLD', debit: '300.00' }])), DEBIT_CREDIT, { cardId: CARD, today: TODAY, fileName: null, bofa: false });
    expect(onlyPending).toEqual({ ok: false, message: CARD_CSV_MESSAGES.onlyPending });
  });

  it("lists rows the table couldn't split, in line order, by their line and why", () => {
    const text = [debitCreditCsv(DEBIT_CREDIT_SAMPLE.slice(0, 1)).trimEnd(), '14/10/2026,SHOP,Home,1.00', '14/10/2026,"OPEN,Home,1.00,', debitCreditCsv(DEBIT_CREDIT_SAMPLE.slice(1, 2)).split('\r\n')[1]].join('\r\n');
    expect(read(text, DEBIT_CREDIT).rows.map((r) => [r.line, r.status, r.reason])).toEqual([
      [2, 'new', null],
      [3, 'unreadable', ROW_REASONS.values(4, 5)],
      [4, 'unreadable', CSV_ERRORS.unclosedLine],
      [5, 'new', null],
    ]);
  });

  it('reads every row of a file with a blank line between rows', () => {
    const lines = SAMPLE.trimEnd().split('\r\n');
    const text = [...lines.slice(0, 3), '', ...lines.slice(3), ''].join('\r\n');
    expect(read(text, DEBIT_CREDIT).rows.map((r) => [r.line, r.status])).toEqual([[2, 'new'], [3, 'new'], [5, 'new'], [6, 'new'], [7, 'new'], [8, 'new']]);
  });

  it('counts the lines after the table it skipped: a truncated final row is one', () => {
    const text = `${SAMPLE}17/10/2026,HARDWARE BA`;
    const t = table(text);
    expect(t.rows).toHaveLength(6);
    expect(t.bad).toEqual([]);
    expect(t.trailingSkipped).toBe(1);
    expect(table(SAMPLE).trailingSkipped).toBe(0);
  });

  it("doesn't list another issuer's lines after the table (footers are common there), only counts them", () => {
    const t = table(`${SAMPLE}Total,"1,033.99",512.00\r\n\r\nGenerated 18/10/2026\r\n`);
    expect(t.rows).toHaveLength(6);
    expect(t.bad).toEqual([]);
    expect(t.trailingSkipped).toBe(2);
  });

  it("refuses what isn't a text CSV, or has no table", () => {
    expect(readCardFile(new Uint8Array([0xff, 0xfe, 0x00]))).toEqual({ ok: false, message: CSV_TABLE_MESSAGES.notText });
    expect(readCardFile(bytes(''))).toEqual({ ok: false, message: CSV_TABLE_MESSAGES.noTable });
  });

  it('says so when no row can be read', () => {
    const none = readCardRows(table(signedCsv([{ date: '2026-11-02', merchant: '', amount: '1.00' }])), SIGNED, { cardId: CARD, today: TODAY, fileName: null, bofa: false });
    expect(none).toEqual({ ok: false, message: CARD_CSV_MESSAGES.noneReadable });
  });
});

describe('row keys (the generic import design, "Re-importing without a reference number")', () => {
  it('gives each row without a reference column a k1: key from the card, date, cents, and description', () => {
    const { rows } = read(SAMPLE, DEBIT_CREDIT);
    expect(rows[0]!.reference).toBe(rowKey(CARD, '2026-10-13', 450, 'CORNER CAFE 0042', 0));
    expect(rows[0]!.reference).toMatch(/^k1:[0-9a-f]{64}$/);
    expect(rows.every((r) => isRowKey(r.reference))).toBe(true);
    expect(realReference(rows[0]!.reference)).toBeNull();
    expect(realReference('24692160000000100000001')).toBe('24692160000000100000001');
    expect(realReference(null)).toBeNull();
  });

  it('keeps two identical rows on one day apart, by their place that day in file order', () => {
    const { rows } = read(SAMPLE, DEBIT_CREDIT);
    expect(rows[2]!.reference).toBe(rowKey(CARD, '2026-10-15', 450, 'CORNER CAFE 0042', 0));
    expect(rows[3]!.reference).toBe(rowKey(CARD, '2026-10-15', 450, 'CORNER CAFE 0042', 1));
    expect(new Set(rows.map((r) => r.reference)).size).toBe(rows.length);
  });

  it('gives the same rows the same keys in an overlapping file, and white space in a description makes no difference', () => {
    const first = read(debitCreditCsv(DEBIT_CREDIT_SAMPLE.slice(0, 4)), DEBIT_CREDIT).rows;
    const later = read(debitCreditCsv([{ ...DEBIT_CREDIT_SAMPLE[2]!, description: 'CORNER   CAFE 0042' }, ...DEBIT_CREDIT_SAMPLE.slice(3)]), DEBIT_CREDIT).rows;
    expect(later.slice(0, 2).map((r) => r.reference)).toEqual(first.slice(2, 4).map((r) => r.reference));
  });

  it('makes different keys on another card', () => {
    expect(read(SAMPLE, DEBIT_CREDIT, { cardId: 8 }).rows[0]!.reference).not.toBe(read(SAMPLE, DEBIT_CREDIT).rows[0]!.reference);
  });

  it("with a reference column, needs one on every row, flags one repeated, and refuses one that looks like a key", () => {
    const text = 'Date,Merchant,Amount,Ref\n2026-11-02,SHOP,1.00,R1\n2026-11-02,SHOP,1.00,R1\n2026-11-02,SHOP,1.00,\n2026-11-02,SHOP,1.00,k1:abc\n';
    const rows = read(text, { ...SIGNED, reference: 3 }).rows;
    expect(rows.map((r) => [r.status, r.reference, r.reason])).toEqual([
      ['new', 'R1', null],
      ['repeated', 'R1', ROW_REASONS.repeated],
      ['unreadable', null, ROW_REASONS.noReference],
      ['unreadable', null, ROW_REASONS.badReference],
    ]);
  });
});

describe('mappingProblem (plan decision 7)', () => {
  it('names a column that is not in the file, or one with two roles', () => {
    const t = table(SAMPLE);
    expect(mappingProblem(t, { ...DEBIT_CREDIT, address: 9 })).toBe(SPEND_MESSAGES.importColumnMissing);
    expect(mappingProblem(t, { ...DEBIT_CREDIT, description: 3 })).toBe(SPEND_MESSAGES.importSameColumn);
  });

  it("names the first line whose date or amount the mapping can't read, and passes empty dates", () => {
    const t = table(SAMPLE);
    expect(mappingProblem(t, DEBIT_CREDIT)).toBeNull();
    expect(mappingProblem(t, { ...DEBIT_CREDIT, date: { column: 0, format: 'mdy' } })).toBe(SPEND_MESSAGES.importBadDate(2, 'M/D/YYYY'));
    expect(mappingProblem(table(debitCreditCsv([...DEBIT_CREDIT_SAMPLE.slice(0, 1), { date: '14/10/2026', description: 'SHOP', debit: '1.234,56' }])), DEBIT_CREDIT)).toBe(SPEND_MESSAGES.importBadAmount(3));
    expect(mappingProblem(table(debitCreditCsv([{ date: '', description: 'HOLD', debit: '1.00' }, DEBIT_CREDIT_SAMPLE[0]!])), DEBIT_CREDIT)).toBeNull();
  });
});

describe('guessCardMapping (plan decision 15)', () => {
  it("guesses a Debit and Credit file's columns, with the one date format its values fit", () => {
    expect(guessCardMapping(table(SAMPLE))).toEqual(DEBIT_CREDIT);
  });

  it('prefers a posted date, and guesses the sign from the amounts', () => {
    const text = 'Transaction Date,Post Date,Description,Amount,Reference,City\n2026-11-01,2026-11-02,SHOP,-4.50,A1,OAKLAND\n2026-11-02,2026-11-03,PAYMENT,100.00,A2,\n2026-11-03,2026-11-04,SHOP,-1.00,A3,BERKELEY\n';
    expect(guessCardMapping(table(text))).toEqual({
      date: { column: 1, format: 'ymd' }, amount: { kind: 'signed', column: 3, purchasesNegative: true }, description: 2, reference: 4, address: 5,
    });
    expect(guessCardMapping(table(signedCsv([{ date: '2026-11-02', merchant: 'SHOP', amount: '4.50' }, { date: '2026-11-03', merchant: 'SHOP', amount: '3.00' }])))).toMatchObject({
      amount: { kind: 'signed', column: 2, purchasesNegative: false }, description: 1,
    });
  });

  it("when every day is 12 or under, both formats fit: the guess's format is only a start, which the columns form leaves blank (Task 9)", () => {
    const t = table(debitCreditCsv([{ date: '01/10/2026', description: 'SHOP', debit: '1.00' }, { date: '02/10/2026', description: 'SHOP', debit: '2.00' }]));
    expect(dateFormatsOf(t.rows.map((r) => r.cells[0]!))).toEqual(['mdy', 'dmy']);
    expect(guessCardMapping(t)?.date).toEqual({ column: 0, format: 'mdy' });
  });

  it('suggests nothing without a date or an amount column', () => {
    expect(guessCardMapping(table('Name,Note\nSHOP,hello\nSHOP,again\n'))).toBeNull();
    expect(guessCardMapping(table('Date,Note\n2026-11-01,hello\n2026-11-02,again\n'))).toBeNull();
  });
});
