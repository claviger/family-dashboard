import { describe, expect, it } from 'vitest';
import { BANK_FILE, BROKERAGE_FILE, bytes, CASH_FILE, CASH_HEADER, CASH_SAMPLE, cashLine, fidelityFile } from '../../test/importCsv.js';
import { CSV_TABLE_MAX_PREAMBLE, CSV_TABLE_MAX_ROWS, CSV_TABLE_MESSAGES, decodeCsv, findCsvTable } from './csvTable.js';

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
