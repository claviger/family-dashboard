import { describe, expect, it } from 'vitest';
import { bofaCsv, bytes, reference } from '../../test/bofaCsv.js';
import { BOFA_MESSAGES, differentColumnsMessage, MAX_ROWS, readBofaCsv as readBofa, ROW_REASONS } from './bofa.js';

const TODAY = '2026-11-15';
const readBofaCsv = (bytes: Uint8Array, fileName: string | null) => readBofa(bytes, fileName, TODAY);
import { CSV_ERRORS } from './csv.js';

const coffee = { date: '11/02/2026', reference: reference(1, 1), payee: 'BLUE BOTTLE COFFEE', address: 'OAKLAND CA', amount: '-12.74' };
const groceries = { date: '11/03/2026', reference: reference(1, 2), payee: 'SAFEWAY #1234', address: 'OAKLAND CA', amount: '-1,234.56' };
const payment = { date: '11/05/2026', reference: reference(1, 3), payee: 'PAYMENT - THANK YOU', address: '', amount: '500.00' };

function read(text: string, fileName: string | null = 'currentTransaction_1234.csv') {
  return readBofaCsv(bytes(text), fileName);
}

function ok(text: string, fileName?: string | null) {
  const result = read(text, fileName);
  if (!result.ok) throw new Error(result.message);
  return result;
}

describe('readBofaCsv: the file', () => {
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
    expect(readBofaCsv(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xff, 0xfe]), 'x.xlsx')).toEqual({ ok: false, message: BOFA_MESSAGES.notText });
    expect(read('Posted Date,Reference Number,Payee,Address,Amount\n\u0000')).toEqual({ ok: false, message: BOFA_MESSAGES.notText });
  });

  it('refuses an empty file, or one with only the header', () => {
    expect(read('')).toEqual({ ok: false, message: BOFA_MESSAGES.empty });
    expect(read('\r\n  \r\n')).toEqual({ ok: false, message: BOFA_MESSAGES.empty });
    expect(read('Posted Date,Reference Number,Payee,Address,Amount\r\n')).toEqual({ ok: false, message: BOFA_MESSAGES.noRows });
  });

  it("names BofA's checking and savings export when it sees one", () => {
    const summary = 'Description,,Summary Amt.\r\nBeginning balance as of 10/01/2026,,"1,000.00"\r\n\r\nDate,Description,Amount,Running Bal.\r\n';
    expect(read(summary)).toEqual({ ok: false, message: BOFA_MESSAGES.checking });
    expect(read('Date,Description,Amount,Running Bal.\r\n10/01/2026,Beginning balance as of 10/01/2026,,"1,000.00"\r\n')).toEqual({
      ok: false,
      message: BOFA_MESSAGES.checking,
    });
  });

  it('refuses a header with Posted Date but other columns, naming what it expected and found, and only the header', () => {
    const business = 'Posted Date,Reference Number,Payee,Amount\r\n11/02/2026,123,SECRET MERCHANT,-1.00\r\n';
    const result = read(business);
    expect(result).toEqual({ ok: false, message: differentColumnsMessage(['Posted Date', 'Reference Number', 'Payee', 'Amount']) });
    expect(!result.ok && result.message).toContain('Expected: Posted Date, Reference Number, Payee, Address, Amount. Found: Posted Date, Reference Number, Payee, Amount.');
    expect(!result.ok && result.message).not.toContain('SECRET');
  });

  it('refuses any other first line, naming the header it expects, and never looks for the header further down', () => {
    expect(read('Date,Payee,Amount\r\n')).toEqual({ ok: false, message: BOFA_MESSAGES.notBofa });
    expect(BOFA_MESSAGES.notBofa).toContain('Posted Date, Reference Number, Payee, Address, Amount');
    // A preamble above the real header (one source claims this; research §1.1 discounts it) is refused.
    expect(read(`Bank of America credit card account\r\n${bofaCsv([coffee])}`)).toEqual({ ok: false, message: BOFA_MESSAGES.notBofa });
  });

  it('refuses a file with more than 20,000 rows, and stops reading there', () => {
    const line = (n: number) => `11/02/2026,${reference(6, n)},SHOP,,-1.00`;
    const ok20k = `Posted Date,Reference Number,Payee,Address,Amount\n${Array.from({ length: MAX_ROWS }, (_, n) => line(n)).join('\n')}\n`;
    expect(read(ok20k)).toMatchObject({ ok: true });
    expect(read(`${ok20k}${line(MAX_ROWS)}\n`)).toEqual({ ok: false, message: BOFA_MESSAGES.tooManyRows });
    // Empty lines and blank rows don't count.
    expect(read(`${ok20k}\n\n,,,,\n`)).toMatchObject({ ok: true });
  });

  it("refuses a file in which no row can be read", () => {
    const text = 'Posted Date,Reference Number,Payee,Address,Amount\r\n11/02/2026,1,SHOP,,twelve\r\n';
    expect(read(text)).toEqual({ ok: false, message: BOFA_MESSAGES.noneReadable });
  });

  it('says so when the only rows are TEMPRET temporary credits', () => {
    const header = 'Posted Date,Reference Number,Payee,Address,Amount\r\n';
    expect(read(`${header},TEMPRET,"REFUND MERCHANT","",25.00\r\n,TEMPRET,SHOP,,1.00\r\n`)).toEqual({ ok: false, message: BOFA_MESSAGES.onlyPending });
    expect(BOFA_MESSAGES.onlyPending).toBe('This file only has pending holds, nothing to import yet.');
    // With any other row that can't be read, it's the general message.
    expect(read(`${header},TEMPRET,SHOP,,1.00\r\n11/02/2026,1,SHOP,,twelve\r\n`)).toEqual({ ok: false, message: BOFA_MESSAGES.noneReadable });
  });
});

describe('readBofaCsv: rows it can not import', () => {
  function statuses(lines: string[]) {
    return ok(`Posted Date,Reference Number,Payee,Address,Amount\r\n${bofaCsv([coffee]).split('\r\n')[1]}\r\n${lines.join('\r\n')}\r\n`).rows.slice(1);
  }

  it("shows a TEMPRET temporary credit as one it can't import yet, and never keeps TEMPRET as a reference", () => {
    const [row] = statuses([',TEMPRET,"REFUND MERCHANT","",25.00']);
    expect(row).toMatchObject({ status: 'pending_credit', reference: null, payee: 'REFUND MERCHANT', amountCents: -2500, reason: ROW_REASONS.pendingCredit });
    expect(statuses(['11/04/2026,TEMPRET,SHOP,,1.00'])[0]!.status).toBe('pending_credit');
  });

  it('lists every other unreadable row by line number, with the reason', () => {
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
      [3, 'unreadable', ROW_REASONS.noDate],
      [4, 'unreadable', ROW_REASONS.badDate],
      [5, 'unreadable', ROW_REASONS.badDate],
      [6, 'unreadable', ROW_REASONS.badDate],
      [7, 'unreadable', ROW_REASONS.badAmount],
      [8, 'unreadable', ROW_REASONS.badAmount],
      [9, 'unreadable', ROW_REASONS.noReference],
      [10, 'unreadable', ROW_REASONS.noPayee],
      [11, 'unreadable', ROW_REASONS.values(4)],
      [12, 'unreadable', CSV_ERRORS.strayQuote],
      [13, 'unreadable', CSV_ERRORS.unclosedLine],
    ]);
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

describe('readBofaCsv: warnings', () => {
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
