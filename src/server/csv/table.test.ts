import { describe, expect, it } from 'vitest';
import { BANK_FILE, BROKERAGE_FILE, bytes, CASH_FILE, CASH_HEADER, CASH_SAMPLE, cashLine, fidelityFile } from '../test/importCsv.js';
import { BOFA_HEADER_LINE, reference } from '../test/bofaCsv.js';
import { CSV_ERRORS } from './records.js';
import { CSV_ROW_REASONS, CSV_TABLE_MAX_PREAMBLE, CSV_TABLE_MAX_ROWS, CSV_TABLE_MESSAGES, decodeCsv, findCsvTable } from './table.js';

// Synthetic files (src/server/test/importCsv.ts).
const NL = String.fromCharCode(10);
function table(text: string) {
  const found = findCsvTable(text);
  if (!found.ok) throw new Error(found.message);
  return found.table;
}

describe('decodeCsv', () => {
  it('takes strict UTF-8 without a byte order mark, and refuses anything else', () => {
    expect(decodeCsv(bytes('\uFEFFDate,Amount\n'))).toBe('Date,Amount\n');
    expect(decodeCsv(new Uint8Array([0xff, 0xfe, 0x00]))).toBeNull();
    expect(decodeCsv(bytes('Date\u0000,Amount'))).toBeNull();
  });
});

describe('findCsvTable', () => {
  it('finds Fidelity\'s table past its blank lines and stops at the disclaimer', () => {
    const t = table(CASH_FILE);
    expect(t.header).toEqual(CASH_HEADER.split(','));
    expect(t.rows).toHaveLength(9);
    // Two blank lines, then the header on line 3: the first row is line 4, its quotes gone.
    expect(t.rows[0]).toEqual({ line: 4, cells: ['11/12/2026', 'DIRECT DEPOSIT EXAMPLE CORPPAYROLL (Cash)', '', 'No Description', 'Cash', '', '0', '', '', '', '1500.00', '4200.00', ''] });
    expect(t.rows[6]!.cells[10]).toBe('-46.05');
    expect(table(BROKERAGE_FILE).rows).toHaveLength(8);
  });

  it('skips a preamble, takes CRLF, and ends at a footer right after the rows', () => {
    const t = table(BANK_FILE);
    expect(t.header).toEqual(['Date', 'Description', 'Debit', 'Credit', 'Balance']);
    expect(t.rows.map((r) => r.line)).toEqual([5, 6, 7, 8, 9, 10]);
    expect(t.rows[0]!.cells).toEqual(['13/10/2026', 'OPENING TRANSFER FROM SAVINGS', '', '1,000.00', '1,000.00']);
  });

  it('allows blank lines between the header and the first row', () => {
    expect(table(`Date,Amount\n\n2026-11-01,5.00\n2026-11-02,6.00\n`).rows.map((r) => r.line)).toEqual([3, 4]);
  });

  it('refuses a file with no table, or no rows, naming nothing from it', () => {
    expect(findCsvTable('')).toEqual({ ok: false, message: CSV_TABLE_MESSAGES.noTable });
    expect(findCsvTable('just one line of words\n')).toEqual({ ok: false, message: CSV_TABLE_MESSAGES.noTable });
    // Numbers aren't column names.
    expect(findCsvTable('2026-11-01,5.00\n2026-11-02,6.00\n')).toEqual({ ok: false, message: CSV_TABLE_MESSAGES.noTable });
    expect(findCsvTable(`\n\n${CASH_HEADER}\n\nDate downloaded 11/15/2026 06:54 pm\n`)).toEqual({ ok: false, message: CSV_TABLE_MESSAGES.noTable });
  });

  it('refuses a bad row in the middle of the table by its line number', () => {
    const lines = CASH_SAMPLE.map(cashLine);
    lines[2] = '11/12/2026,A ROW WITH TOO FEW VALUES,1.00';
    expect(findCsvTable(fidelityFile(CASH_HEADER, lines))).toEqual({ ok: false, message: CSV_TABLE_MESSAGES.badLine(6) });
    lines[2] = '11/12/2026,A "STRAY" QUOTE' + ',x'.repeat(11);
    expect(findCsvTable(fidelityFile(CASH_HEADER, lines))).toEqual({ ok: false, message: CSV_TABLE_MESSAGES.badLine(6) });
  });

  it("refuses a header whose next row is a CSV error by that row's line, not as no table", () => {
    // An unclosed quote on the first row.
    expect(findCsvTable(['Date,Description,Amount', '2026-11-01,"UNCLOSED QUOTE,5.00', '2026-11-02,B,6.00', ''].join(NL))).toEqual({ ok: false, message: CSV_TABLE_MESSAGES.badLine(2) });
    // A quoted line break (one record per line), after a blank line.
    expect(findCsvTable(['Date,Description,Amount', '', '2026-11-01,"TWO', 'LINES",5.00', ''].join(NL))).toEqual({ ok: false, message: CSV_TABLE_MESSAGES.badLine(3) });
  });

  it('looks for the header only in the first non-blank lines', () => {
    const preamble = (n: number) => Array.from({ length: n }, (_, i) => `Preamble line ${i}`);
    const rows = ['Date,Amount', '2026-11-01,5.00'];
    expect(table([...preamble(CSV_TABLE_MAX_PREAMBLE - 1), ...rows].join(NL)).header).toEqual(['Date', 'Amount']);
    expect(findCsvTable([...preamble(CSV_TABLE_MAX_PREAMBLE), ...rows].join(NL))).toEqual({ ok: false, message: CSV_TABLE_MESSAGES.noTable });
  });

  it('gives up on a large file with no table quickly: the search is bounded and linear', () => {
    // Lines that each look like column names but never have a next row with the same field count: the old search sliced the rest of the file for each.
    const lines = Array.from({ length: 200_000 }, (_, i) => (i % 2 === 0 ? 'Some words,more words' : 'a,b,c'));
    const text = lines.join(NL);
    expect(text.length).toBeLessThan(5 * 1024 * 1024);
    const started = performance.now();
    expect(findCsvTable(text)).toEqual({ ok: false, message: CSV_TABLE_MESSAGES.noTable });
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('refuses more than 20,000 rows', () => {
    const rows = Array.from({ length: CSV_TABLE_MAX_ROWS + 1 }, (_, i) => `2026-11-01,${i}.00`);
    expect(findCsvTable(['Date,Amount', ...rows].join('\n'))).toEqual({ ok: false, message: CSV_TABLE_MESSAGES.tooManyRows });
  });
});

describe('findCsvTable: blank lines inside the table', () => {
  const header = 'Date,Description,Amount';

  it('reads on past a blank line, several, or a blank row, while the rows after still fit, so no row is left out', () => {
    const text = [header, '2026-11-01,SHOP,1.00', '', '2026-11-02,SHOP,2.00', '', '', ',,', '  ,  ,  ', '2026-11-03,SHOP,3.00', ''].join(NL);
    expect(table(text).rows.map((r) => r.line)).toEqual([2, 4, 9]);
    expect(findCsvTable(text, { keepBadRows: true })).toMatchObject({ ok: true, table: { rows: [{ line: 2 }, { line: 4 }, { line: 9 }] }, bad: [] });
  });

  it('keeps every row of a Bank of America file with a blank line between rows', () => {
    const line = (n: number) => `11/0${n}/2026,${reference(9, n)},"SHOP ${n}","OAKLAND CA",-${n}.00`;
    const text = [BOFA_HEADER_LINE, line(1), line(2), '', line(3), '', '', line(4), ''].join('\r\n');
    const found = findCsvTable(text, { keepBadRows: true });
    expect(found).toMatchObject({ ok: true, bad: [] });
    expect(found.ok && found.table.rows.map((r) => [r.line, r.cells[2]])).toEqual([[2, 'SHOP 1'], [3, 'SHOP 2'], [5, 'SHOP 3'], [8, 'SHOP 4']]);
  });

  it("still ends a Fidelity file at its disclaimer after a blank line, with a blank line mid-table read past", () => {
    const lines = CASH_SAMPLE.map(cashLine);
    const text = fidelityFile(CASH_HEADER, [...lines.slice(0, 4), '', ...lines.slice(4)]);
    const t = table(text);
    expect(t.rows).toHaveLength(9);
    // Two blank lines and the header (lines 1 to 3), four rows, the blank line 8, then the rest.
    expect(t.rows.map((r) => r.line)).toEqual([4, 5, 6, 7, 9, 10, 11, 12, 13]);
    expect(findCsvTable(text, { keepBadRows: true })).toMatchObject({ ok: true, bad: [] });
  });

  it('a blank line, then a row with a CSV error, then more rows: Spend lists the bad row and keeps every later row; Savings refuses by its line', () => {
    const text = [header, '2026-11-01,SHOP,1.00', '', '2026-11-02,"OPEN,2.00', '2026-11-03,SHOP,3.00', '2026-11-04,SHOP,4.00', ''].join(NL);
    expect(findCsvTable(text)).toEqual({ ok: false, message: CSV_TABLE_MESSAGES.badLine(4) });
    expect(findCsvTable(text, { keepBadRows: true })).toMatchObject({
      ok: true, table: { rows: [{ line: 2 }, { line: 5 }, { line: 6 }] }, bad: [{ line: 4, reason: CSV_ERRORS.unclosedLine }],
    });
  });

  it('a blank line, then a footer-like line, then more rows: the line is a bad row, not the end of the table', () => {
    const text = [header, '2026-11-01,SHOP,1.00', '', 'Total,1.00', '2026-11-02,SHOP,2.00', ''].join(NL);
    expect(findCsvTable(text)).toEqual({ ok: false, message: CSV_TABLE_MESSAGES.badLine(4) });
    expect(findCsvTable(text, { keepBadRows: true })).toMatchObject({ ok: true, table: { rows: [{ line: 2 }, { line: 5 }] }, bad: [{ line: 4, reason: CSV_ROW_REASONS.values(2, 3) }] });
  });

  it('a bad row between fitting rows is still the bad line', () => {
    const text = [header, '2026-11-01,SHOP,1.00', '', '2026-11-02,SHOP,2.00', '2026-11-03,SHOP', '2026-11-04,SHOP,4.00', ''].join(NL);
    expect(findCsvTable(text)).toEqual({ ok: false, message: CSV_TABLE_MESSAGES.badLine(5) });
  });

  it('ends after the last row that fits: everything after it is footer, even lines with CSV errors', () => {
    const text = [header, '2026-11-01,SHOP,1.00', '2026-11-02,SHOP,2.00', 'Total,3.00', '"Unclosed disclaimer', 'a,b', '', 'Downloaded 11/15/2026'].join(NL);
    expect(table(text).rows.map((r) => r.line)).toEqual([2, 3]);
    expect(findCsvTable(text, { keepBadRows: true })).toMatchObject({ ok: true, table: { rows: [{ line: 2 }, { line: 3 }] }, bad: [], trailingSkipped: 4 });
  });
});

describe('findCsvTable with keepBadRows (Spend, plan decision 3)', () => {
  const header = 'Date,Description,Amount';

  it("keeps a bad row in the middle by its line and why, where Savings refuses the file", () => {
    const text = [header, '2026-11-01,SHOP,1.00', '2026-11-02,SHOP', '2026-11-03,"OPEN,1.00', '2026-11-04,SHOP,2.00'].join('\n');
    expect(findCsvTable(text)).toEqual({ ok: false, message: CSV_TABLE_MESSAGES.badLine(3) });
    expect(findCsvTable(text, { keepBadRows: true })).toEqual({
      ok: true,
      table: { header: ['Date', 'Description', 'Amount'], rows: [{ line: 2, cells: ['2026-11-01', 'SHOP', '1.00'] }, { line: 5, cells: ['2026-11-04', 'SHOP', '2.00'] }] },
      bad: [{ line: 3, reason: CSV_ROW_REASONS.values(2, 3) }, { line: 4, reason: CSV_ERRORS.unclosedLine }],
      trailing: [],
      trailingSkipped: 0,
    });
    expect(CSV_ROW_REASONS.values(2, 3)).toBe('This row has 2 values instead of 3.');
    expect(CSV_ROW_REASONS.values(1, 5)).toBe('This row has 1 value instead of 5.');
  });

  it('ignores a footer right after the last fitting row, as Savings does', () => {
    const text = ['Example Bank', header, '2026-11-01,SHOP,1.00', 'Total,1.00', '', 'Downloaded 11/15/2026'].join('\r\n');
    expect(findCsvTable(text)).toEqual({ ok: true, table: { header: ['Date', 'Description', 'Amount'], rows: [{ line: 3, cells: ['2026-11-01', 'SHOP', '1.00'] }] } });
    expect(findCsvTable(text, { keepBadRows: true })).toEqual({
      ok: true,
      table: { header: ['Date', 'Description', 'Amount'], rows: [{ line: 3, cells: ['2026-11-01', 'SHOP', '1.00'] }] },
      bad: [],
      // The footer's two lines, by line and why (never their contents): a format with no footer lists them, others count them.
      trailing: [{ line: 4, reason: CSV_ROW_REASONS.values(2, 3) }, { line: 6, reason: CSV_ROW_REASONS.values(1, 3) }],
      trailingSkipped: 2,
    });
  });

  it('takes a header whose next row does not fit when a later row does, and lists that row; Savings still refuses', () => {
    const short = [header, '2026-11-01,SHOP', '2026-11-02,SHOP,2.00', ''].join(NL);
    expect(findCsvTable(short)).toEqual({ ok: false, message: CSV_TABLE_MESSAGES.noTable });
    expect(findCsvTable(short, { keepBadRows: true })).toMatchObject({
      ok: true, table: { header: ['Date', 'Description', 'Amount'], rows: [{ line: 3 }] }, bad: [{ line: 2, reason: CSV_ROW_REASONS.values(2, 3) }],
    });
    const unclosed = [header, '', '2026-11-01,"OPEN,1.00', '2026-11-02,SHOP,2.00', ''].join(NL);
    expect(findCsvTable(unclosed)).toEqual({ ok: false, message: CSV_TABLE_MESSAGES.badLine(3) });
    expect(findCsvTable(unclosed, { keepBadRows: true })).toMatchObject({ ok: true, table: { rows: [{ line: 4 }] }, bad: [{ line: 3, reason: CSV_ERRORS.unclosedLine }] });
    // A header whose next row fits is still preferred to an earlier line of words with a later fitting line (the footer here).
    expect(findCsvTable(['Account,Example', header, '2026-11-01,SHOP,1.00', 'Total,1.00', ''].join(NL), { keepBadRows: true })).toMatchObject({
      ok: true, table: { header: ['Date', 'Description', 'Amount'], rows: [{ line: 3 }] }, bad: [], trailingSkipped: 1,
    });
    // With no row that fits anywhere, there's still no table.
    expect(findCsvTable([header, '2026-11-01,SHOP', ''].join(NL), { keepBadRows: true })).toEqual({ ok: false, message: CSV_TABLE_MESSAGES.noTable });
  });

  it('counts the lines after the last fitting row: a truncated final row is one', () => {
    const text = [header, '2026-11-01,SHOP,1.00', '2026-11-02,SHOP,2.00', '2026-11-03,SHO', ''].join(NL);
    expect(findCsvTable(text, { keepBadRows: true })).toMatchObject({ ok: true, table: { rows: [{ line: 2 }, { line: 3 }] }, bad: [], trailingSkipped: 1 });
    // Blank lines after the table aren't counted.
    expect(findCsvTable([header, '2026-11-01,SHOP,1.00', '', ',,', ''].join(NL), { keepBadRows: true })).toMatchObject({ ok: true, trailingSkipped: 0 });
    // Savings doesn't get the count.
    expect(findCsvTable(text)).not.toHaveProperty('trailingSkipped');
  });

  it('counts bad rows toward the 20,000', () => {
    const rows = Array.from({ length: CSV_TABLE_MAX_ROWS }, (_, n) => `2026-11-01,SHOP ${n},1.00`);
    // A footer after the last fitting row doesn't count; a bad row before it does, and that's one too many.
    expect(findCsvTable([header, ...rows, 'Total'].join('\n'), { keepBadRows: true })).toMatchObject({ ok: true, bad: [] });
    expect(findCsvTable([header, rows[0], 'Total', ...rows.slice(2)].join('\n'), { keepBadRows: true })).toMatchObject({ ok: true, bad: [{ line: 3 }] });
    expect(findCsvTable([header, rows[0], 'Total', ...rows.slice(1)].join('\n'), { keepBadRows: true })).toEqual({ ok: false, message: CSV_TABLE_MESSAGES.tooManyRows });
  });
});
