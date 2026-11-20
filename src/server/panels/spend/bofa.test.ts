import { describe, expect, it } from 'vitest';
import { CSV_ERRORS } from '../../csv/records.js';
import { CSV_TABLE_MAX_ROWS, CSV_TABLE_MESSAGES } from '../../csv/table.js';
import { bofaCsv, bytes, reference } from '../../test/bofaCsv.js';
import { BOFA_FORMAT, BOFA_HEADER, cardFormatFor, looksLikeBofaChecking } from './bofa.js';
import { CARD_CSV_MESSAGES, readCardFile, readCardRows, ROW_REASONS } from './cardCsv.js';

const TODAY = '2026-11-15';
/** Bank of America's built-in format through the generic path (the generic import design): the shared table finder, then the mapping layer. */
const readThroughBuiltIn = (data: Uint8Array, fileName: string | null) => {
  const file = readCardFile(data);
  if (!file.ok) return file;
  return readCardRows(file.table, BOFA_FORMAT.mapping, { cardId: 1, today: TODAY, fileName, bofa: cardFormatFor(file.table.header) !== null });
};

const coffee = { date: '11/02/2026', reference: reference(1, 1), payee: 'BLUE BOTTLE COFFEE', address: 'OAKLAND CA', amount: '-12.74' };
const groceries = { date: '11/03/2026', reference: reference(1, 2), payee: 'SAFEWAY #1234', address: 'OAKLAND CA', amount: '-1,234.56' };
const payment = { date: '11/05/2026', reference: reference(1, 3), payee: 'PAYMENT - THANK YOU', address: '', amount: '500.00' };

function read(text: string, fileName: string | null = 'currentTransaction_1234.csv') {
  return readThroughBuiltIn(bytes(text), fileName);
}

function ok(text: string, fileName?: string | null) {
  const result = read(text, fileName);
  if (!result.ok) throw new Error(result.message);
  return result;
}

describe('readThroughBuiltIn: the file', () => {
  it('reads the documented shape: trims the padding, flips the sign, writes dates as YYYY-MM-DD, keeps the 23 digits', () => {
    const { rows } = ok(bofaCsv([coffee, groceries, payment]));
    expect(rows).toEqual([
      { line: 2, status: 'new', date: '2026-11-02', reference: coffee.reference, payee: 'BLUE BOTTLE COFFEE', address: 'OAKLAND CA', amountCents: 1274, reason: null, duplicateOf: null },
      { line: 3, status: 'new', date: '2026-11-03', reference: groceries.reference, payee: 'SAFEWAY #1234', address: 'OAKLAND CA', amountCents: 123456, reason: null, duplicateOf: null },
      { line: 4, status: 'new', date: '2026-11-05', reference: payment.reference, payee: 'PAYMENT - THANK YOU', address: null, amountCents: -50000, reason: null, duplicateOf: null },
    ]);
    expect(coffee.reference).toHaveLength(23);
  });

  it('reads amounts with and without thousands separators, and without padding or quotes', () => {
    const { rows } = ok(`Posted Date,Reference Number,Payee,Address,Amount\n11/02/2026,${reference(2, 1)},SHOP,,-1234.56\n11/02/2026,${reference(2, 2)},SHOP,,"-1,234.56"\n`);
    expect(rows.map((r) => r.amountCents)).toEqual([123456, 123456]);
  });

  it.each([
    ['CRLF', '\r\n'],
    ['LF', '\n'],
    ['CR', '\r'],
  ])('accepts %s line endings', (_name, eol) => {
    expect(ok(bofaCsv([coffee, groceries], { eol })).rows.map((r) => r.status)).toEqual(['new', 'new']);
  });

  it('accepts a byte order mark, leading and trailing blank lines, and a header with padding', () => {
    const text = `\uFEFF\r\n  Posted Date , Reference Number,Payee,Address,Amount\r\n${bofaCsv([coffee]).split('\r\n')[1]}\r\n\r\n\r\n`;
    expect(ok(text).rows).toHaveLength(1);
  });

  it('collapses runs of spaces inside the payee', () => {
    expect(ok(bofaCsv([{ ...coffee, payee: 'BLUE   BOTTLE\tCOFFEE' }])).rows[0]!.payee).toBe('BLUE BOTTLE COFFEE');
  });

  it('refuses bytes that are not UTF-8, and binary files', () => {
    expect(readThroughBuiltIn(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe]), 'x.xlsx')).toEqual({ ok: false, message: CSV_TABLE_MESSAGES.notText });
    expect(read('Posted Date,Reference Number,Payee,Address,Amount\n\u0000')).toEqual({ ok: false, message: CSV_TABLE_MESSAGES.notText });
  });

  it('finds no table in an empty file, or one with only the header', () => {
    expect(read('')).toEqual({ ok: false, message: CSV_TABLE_MESSAGES.noTable });
    expect(read('\r\n  \r\n')).toEqual({ ok: false, message: CSV_TABLE_MESSAGES.noTable });
    expect(read('Posted Date,Reference Number,Payee,Address,Amount\r\n')).toEqual({ ok: false, message: CSV_TABLE_MESSAGES.noTable });
  });

  it("doesn't refuse BofA's checking and savings export by name: it has no built-in format, so it's mapped like any file, with a hint", () => {
    const summary = 'Description,,Summary Amt.\r\nBeginning balance as of 10/01/2026,,"1,000.00"\r\n\r\nDate,Description,Amount,Running Bal.\r\n';
    const found = readCardFile(bytes(summary));
    if (!found.ok) throw new Error(found.message);
    expect(found.table.header).toEqual(['Description', '', 'Summary Amt.']);
    expect(cardFormatFor(found.table.header)).toBeNull();
    expect(looksLikeBofaChecking(found.table.header)).toBe(true);
    expect(looksLikeBofaChecking(['Date', 'Description', 'Amount', 'Running Bal.'])).toBe(true);
    expect(looksLikeBofaChecking([...BOFA_HEADER])).toBe(false);
  });

  it('knows its own header exactly, after trimming, and nothing else', () => {
    const found = readCardFile(bytes('Posted Date,Reference Number,Payee,Amount\r\n11/02/2026,123,SECRET MERCHANT,-1.00\r\n'));
    expect(found.ok && cardFormatFor(found.table.header)).toBeNull();
    expect(cardFormatFor([...BOFA_HEADER])).toBe(BOFA_FORMAT);
    expect(cardFormatFor([' Posted Date ', 'Reference Number', 'Payee', 'Address', 'Amount'])).toBe(BOFA_FORMAT);
    expect(BOFA_FORMAT.mapping).toEqual({ date: { column: 0, format: 'mdy' }, amount: { kind: 'signed', column: 4, purchasesNegative: true }, description: 2, reference: 1, address: 3 });
  });

  it('finds the header below a preamble, as the shared table finder does', () => {
    expect(ok(`Bank of America credit card account\r\n${bofaCsv([coffee])}`).rows.map((r) => [r.line, r.status])).toEqual([[3, 'new']]);
  });

  it('reads every row of a file with a blank line between rows, so none is left out', () => {
    const [header, ...body] = bofaCsv([coffee, groceries, payment]).trimEnd().split('\r\n');
    const text = [header, body[0], '', body[1], '', '', body[2], ''].join('\r\n');
    expect(ok(text).rows.map((r) => [r.line, r.status, r.reference])).toEqual([[2, 'new', coffee.reference], [4, 'new', groceries.reference], [7, 'new', payment.reference]]);
  });

  it('lists a bad first row, 4 values or an unclosed quote, and imports the rest, as the old reader did', () => {
    const [header, ...body] = bofaCsv([coffee, groceries]).trimEnd().split('\r\n');
    const short = [header, `11/01/2026,${reference(8, 1)},SHOP,-1.00`, ...body, ''].join('\r\n');
    expect(ok(short).rows.map((r) => [r.line, r.status, r.reason])).toEqual([[2, 'unreadable', ROW_REASONS.values(4)], [3, 'new', null], [4, 'new', null]]);
    const unclosed = [header, `11/01/2026,${reference(8, 2)},"OPEN QUOTE,,-1.00`, ...body, ''].join('\r\n');
    expect(ok(unclosed).rows.map((r) => [r.line, r.status, r.reason])).toEqual([[2, 'unreadable', CSV_ERRORS.unclosedLine], [3, 'new', null], [4, 'new', null]]);
  });

  it('refuses a file with more than 20,000 rows, and stops reading there', () => {
    const line = (n: number) => `11/02/2026,${reference(6, n)},SHOP,,-1.00`;
    const ok20k = `Posted Date,Reference Number,Payee,Address,Amount\n${Array.from({ length: CSV_TABLE_MAX_ROWS }, (_, n) => line(n)).join('\n')}\n`;
    expect(read(ok20k)).toMatchObject({ ok: true });
    expect(read(`${ok20k}${line(CSV_TABLE_MAX_ROWS)}\n`)).toEqual({ ok: false, message: CSV_TABLE_MESSAGES.tooManyRows });
    // Empty lines and blank rows don't count.
    expect(read(`${ok20k}\n\n,,,,\n`)).toMatchObject({ ok: true });
  });

  it("refuses a file in which no row can be read", () => {
    const text = 'Posted Date,Reference Number,Payee,Address,Amount\r\n11/02/2026,1,SHOP,,twelve\r\n';
    expect(read(text)).toEqual({ ok: false, message: CARD_CSV_MESSAGES.noneReadable });
  });

  it('says so when the only rows are TEMPRET temporary credits', () => {
    const header = 'Posted Date,Reference Number,Payee,Address,Amount\r\n';
    expect(read(`${header},TEMPRET,"REFUND MERCHANT","",25.00\r\n,TEMPRET,SHOP,,1.00\r\n`)).toEqual({ ok: false, message: CARD_CSV_MESSAGES.onlyPending });
    expect(CARD_CSV_MESSAGES.onlyPending).toBe('This file only has pending holds, nothing to import yet.');
    // With any other row that can't be read, it's the general message.
    expect(read(`${header},TEMPRET,SHOP,,1.00\r\n11/02/2026,1,SHOP,,twelve\r\n`)).toEqual({ ok: false, message: CARD_CSV_MESSAGES.noneReadable });
  });
});

describe('readThroughBuiltIn: rows it can not import', () => {
  function statuses(lines: string[]) {
    return ok(`Posted Date,Reference Number,Payee,Address,Amount\r\n${bofaCsv([coffee]).split('\r\n')[1]}\r\n${lines.join('\r\n')}\r\n`).rows.slice(1);
  }

  it("shows a TEMPRET temporary credit as one it can't import yet, and never keeps TEMPRET as a reference", () => {
    const [row] = statuses([',TEMPRET,"REFUND MERCHANT","",25.00']);
    expect(row).toMatchObject({ status: 'pending_credit', reference: null, payee: 'REFUND MERCHANT', amountCents: -2500, reason: ROW_REASONS.pendingCredit });
    expect(statuses(['11/04/2026,TEMPRET,SHOP,,1.00'])[0]!.status).toBe('pending_credit');
  });

  it('lists every other row it can not import by line number, with the reason', () => {
    const rows = statuses([
      `,${reference(3, 1)},SHOP,,-1.00`,
      `13/01/2026,${reference(3, 2)},SHOP,,-1.00`,
      `02/30/2026,${reference(3, 3)},SHOP,,-1.00`,
      `2026-11-02,${reference(3, 4)},SHOP,,-1.00`,
      `11/02/2026,${reference(3, 5)},SHOP,,$1.00`,
      `11/02/2026,${reference(3, 6)},SHOP,,-1.234`,
      `11/02/2026,,SHOP,,-1.00`,
      `11/02/2026,${reference(3, 7)},,,-1.00`,
      `11/02/2026,${reference(3, 8)},SHOP,-1.00`,
      `11/02/2026,${reference(3, 9)},SH"OP,,-1.00`,
      `11/02/2026,${reference(3, 10)},"OPEN QUOTE,,-1.00`,
    ]);
    expect(rows.map((r) => [r.line, r.status, r.reason])).toEqual([
      [3, 'pending_credit', ROW_REASONS.notPosted],
      [4, 'unreadable', ROW_REASONS.badDate('M/D/YYYY')],
      [5, 'unreadable', ROW_REASONS.badDate('M/D/YYYY')],
      [6, 'unreadable', ROW_REASONS.badDate('M/D/YYYY')],
      // The shared money parser reads a currency sign (decision 21).
      [7, 'new', null],
      [8, 'unreadable', ROW_REASONS.badAmount],
      [9, 'unreadable', ROW_REASONS.noReference],
      [10, 'unreadable', ROW_REASONS.noPayee],
      [11, 'unreadable', ROW_REASONS.values(4)],
      [12, 'unreadable', CSV_ERRORS.strayQuote],
      [13, 'unreadable', CSV_ERRORS.unclosedLine],
    ]);
  });

  it('lists the lines after the last row that fits too: its files have no footer', () => {
    expect(statuses([`11/02/2026,${reference(3, 12)},SHOP,,-1.00,EXTRA`]).map((r) => [r.line, r.status, r.reason])).toEqual([[3, 'unreadable', 'This row has 6 values instead of 5.']]);
    const file = readCardFile(bytes(`${bofaCsv([coffee])}11/03/2026,${reference(3, 13)},SHOP,-1.00\r\n`));
    expect(file.ok && [file.table.bad, file.table.trailingSkipped]).toEqual([[{ line: 3, reason: ROW_REASONS.values(4) }], 0]);
  });

  it('refuses dates before 2000 or more than 31 days after today', () => {
    const rows = statuses([
      `12/31/1999,${reference(4, 1)},SHOP,,-1.00`,
      `01/01/2000,${reference(4, 2)},SHOP,,-1.00`,
      `12/16/2026,${reference(4, 3)},SHOP,,-1.00`,
      `12/17/2026,${reference(4, 4)},SHOP,,-1.00`,
      `01/01/0001,${reference(4, 5)},SHOP,,-1.00`,
    ]);
    expect(rows.map((r) => [r.status, r.reason])).toEqual([
      ['unreadable', ROW_REASONS.dateOutOfRange],
      ['new', null],
      ['new', null],
      ['unreadable', ROW_REASONS.dateOutOfRange],
      ['unreadable', ROW_REASONS.dateOutOfRange],
    ]);
  });

  it('refuses a payee or address over 200 characters, or a reference over 40, showing only the start', () => {
    const long = 'X'.repeat(201);
    const rows = statuses([
      `11/02/2026,${reference(5, 1)},${long},,-1.00`,
      `11/02/2026,${reference(5, 2)},SHOP,${long},-1.00`,
      `11/02/2026,${'9'.repeat(41)},SHOP,,-1.00`,
      `11/02/2026,${reference(5, 3)},${'Y'.repeat(200)},,-1.00`,
    ]);
    expect(rows.map((r) => [r.status, r.reason])).toEqual([
      ['unreadable', ROW_REASONS.tooLong],
      ['unreadable', ROW_REASONS.tooLong],
      ['unreadable', ROW_REASONS.tooLong],
      ['new', null],
    ]);
    expect(rows[0]!.payee).toHaveLength(201);
    expect(rows[0]!.payee!.endsWith('…')).toBe(true);
  });

  it('flags a reference number that is on an earlier row of the same file', () => {
    const rows = statuses([`11/03/2026,${coffee.reference},OTHER SHOP,,-3.00`]);
    expect(rows[0]).toMatchObject({ status: 'repeated', reason: ROW_REASONS.repeated, amountCents: 300 });
  });
});

describe('readThroughBuiltIn: warnings', () => {
  it('takes the last 4 from file names like April2026_1234.csv and currentTransaction_5678.csv', () => {
    expect(ok(bofaCsv([coffee]), 'April2026_1234.csv').fileMask).toBe('1234');
    expect(ok(bofaCsv([coffee]), 'currentTransaction_5678.CSV').fileMask).toBe('5678');
    expect(ok(bofaCsv([coffee]), 'export.csv').fileMask).toBeNull();
    expect(ok(bofaCsv([coffee]), null).fileMask).toBeNull();
  });

  it('says when most rows are credits after the flip, which suggests the sign convention changed', () => {
    expect(ok(bofaCsv([coffee, groceries, payment])).mostlyCredits).toBe(false);
    const flipped = [coffee, groceries].map((l) => ({ ...l, amount: l.amount.replace('-', '') }));
    expect(ok(bofaCsv([...flipped, payment])).mostlyCredits).toBe(true);
  });
});
