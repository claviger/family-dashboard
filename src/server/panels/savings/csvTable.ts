import { csvRecords, type CsvRecord } from '../spend/csv.js';

/**
 * Finds the table in a bank's CSV export (the CSV import spec, "Finding the table"; plan decision
 * 5). Pure. It skips the preamble, takes as the header the first row that looks like column names
 * and is followed by a row with the same number of fields, and ends the table at a blank line, at
 * a footer right after the rows, or at the end of the file. Messages name line numbers only, never
 * a line's contents, and nothing here logs.
 */

export interface CsvTable {
  /** Trimmed column names. */
  header: string[];
  /** Each row's line number and trimmed cells, as many as the header has. */
  rows: { line: number; cells: string[] }[];
}

export type CsvTableResult = { ok: true; table: CsvTable } | { ok: false; message: string };

export const CSV_TABLE_MESSAGES = {
  notText: "This file isn't a text CSV. Download it again from the bank.",
  noTable: "The importer couldn't find a table in this file: a row of column names, then rows with the same number of values.",
  badLine: (line: number) => `Line ${line} of this file couldn't be read, so nothing was imported. Download the file from the bank again.`,
  tooManyRows: 'This file has more than 20,000 rows. Download a shorter period, and import it in parts.',
  tooManyColumns: 'This file has more than 200 columns, so it can\'t be imported.',
} as const;

export const CSV_TABLE_MAX_ROWS = 20_000;
const CSV_TABLE_MAX_COLUMNS = 200;
/** How many non-blank lines, the header included, the header search looks at before giving up. */
export const CSV_TABLE_MAX_PREAMBLE = 200;

/** Strict UTF-8, without a byte order mark; null for anything that isn't text. */
export function decodeCsv(bytes: Uint8Array): string | null {
  let text: string;
  try {
    // TextDecoder drops one leading byte order mark itself.
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  if (text.startsWith('\uFEFF')) text = text.slice(1);
  return text.includes('\u0000') ? null : text;
}

const blank = (fields: readonly string[]) => fields.every((f) => f.trim() === '');

/** Column names: at least two cells with a letter, and no non-empty cell without one (dates and amounts have none). */
function looksLikeHeader(fields: readonly string[]): boolean {
  const filled = fields.map((f) => f.trim()).filter((f) => f !== '');
  return filled.length >= 2 && filled.every((f) => /\p{L}/u.test(f));
}

export function findCsvTable(text: string): CsvTableResult {
  // One record per line (Spend's choice): a bank row never holds a line break, and stray quotes stay linear.
  const records = [...csvRecords(text, { multiline: false })];
  const isBlank = (r: CsvRecord) => r.error === undefined && blank(r.fields);
  // The header is among the first CSV_TABLE_MAX_PREAMBLE non-blank records. Each candidate looks
  // ahead by index to the next non-blank record, so the search is linear and bounded.
  let at = -1;
  let seen = 0;
  for (let i = 0; i < records.length && at < 0; i++) {
    const r = records[i]!;
    if (isBlank(r)) continue;
    if (++seen > CSV_TABLE_MAX_PREAMBLE) break;
    if (r.error !== undefined || !looksLikeHeader(r.fields)) continue;
    let j = i + 1;
    while (j < records.length && isBlank(records[j]!)) j++;
    const next = records[j];
    if (!next) continue;
    // Column names followed by a row that can't be read: that row is the bad line, not "no table".
    if (next.error !== undefined) return { ok: false, message: CSV_TABLE_MESSAGES.badLine(next.line) };
    if (next.fields.length === r.fields.length) at = i;
  }
  if (at < 0) return { ok: false, message: CSV_TABLE_MESSAGES.noTable };
  const headerRecord = records[at]!;
  const header = headerRecord.fields!.map((c) => c.trim());
  if (header.length > CSV_TABLE_MAX_COLUMNS) return { ok: false, message: CSV_TABLE_MESSAGES.tooManyColumns };

  // The block: from the header to the first blank line after a row. csvRecords makes nothing for an
  // empty line, so a jump in line numbers is a blank line too.
  const block: CsvRecord[] = [];
  let lastLine = headerRecord.line;
  for (const r of records.slice(at + 1)) {
    const afterBlank = r.line > lastLine + 1;
    lastLine = r.line;
    if (block.length > 0 && (afterBlank || isBlank(r))) break;
    if (isBlank(r)) continue;
    block.push(r);
  }
  // A row that doesn't fit ends the table only when nothing after it in the block fits (a footer);
  // otherwise it's a bad row in the middle, and the file is refused by its line.
  const fits = (r: CsvRecord) => r.error === undefined && r.fields.length === header.length;
  const firstBad = block.findIndex((r) => !fits(r));
  if (firstBad >= 0 && block.slice(firstBad + 1).some(fits)) return { ok: false, message: CSV_TABLE_MESSAGES.badLine(block[firstBad]!.line) };
  const rows = block.slice(0, firstBad < 0 ? block.length : firstBad).map((r) => ({ line: r.line, cells: r.fields!.map((c) => c.trim()) }));
  if (rows.length === 0) return { ok: false, message: CSV_TABLE_MESSAGES.noTable };
  if (rows.length > CSV_TABLE_MAX_ROWS) return { ok: false, message: CSV_TABLE_MESSAGES.tooManyRows };
  return { ok: true, table: { header, rows } };
}
