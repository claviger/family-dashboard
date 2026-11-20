import { csvRecords, type CsvRecord } from './records.js';

/**
 * Finds the table in a bank's CSV export (the Savings CSV import spec and the generic card import
 * design, "Finding the table"; the Savings plan's decision 5). Pure. It skips the preamble, takes
 * as the header the first row that looks like column names and is followed by a row with the same
 * number of fields, and ends the table after the last row with the header's number of fields (and
 * no CSV error). What follows it is footer and ignored. Blank lines before it are skipped, and any
 * other line before it that doesn't fit is a bad row, so no row is silently left out. Messages name
 * line numbers only, never a line's contents, and nothing here logs.
 */

export interface CsvTable {
  /** Trimmed column names. */
  header: string[];
  /** Each row's line number and trimmed cells, as many as the header has. */
  rows: { line: number; cells: string[] }[];
}

export const CSV_TABLE_MESSAGES = {
  notText: "This file isn't a text CSV. Download it again from the bank.",
  noTable: "The importer couldn't find a table in this file: a row of column names, then rows with the same number of values.",
  badLine: (line: number) => `Line ${line} of this file couldn't be read, so nothing was imported. Download the file from the bank again.`,
  tooManyRows: 'This file has more than 20,000 rows. Download a shorter period, and import it in parts.',
  tooManyColumns: 'This file has more than 200 columns, so it can\'t be imported.',
} as const;

/** Why a row inside the table couldn't be split into the header's columns (Spend lists these rows; the generic card import plan, decision 3). */
export const CSV_ROW_REASONS = {
  values: (n: number, expected: number) => `This row has ${n} ${n === 1 ? 'value' : 'values'} instead of ${expected}.`,
} as const;

/** A row inside the table that doesn't fit, by its line and why: never its contents. */
export interface CsvBadRow {
  line: number;
  reason: string;
}

export interface CsvTableOptions {
  /**
   * Spend's importer (the generic card import plan, decision 3): a row inside the table that doesn't
   * fit (a CSV error, or another number of values) before the last row that fits comes back in
   * `bad` instead of refusing the file. Where the table ends is the same as without it: a footer
   * after the last fitting row is ignored either way, and with this option its non-blank lines come
   * back as `trailing` (by line and why) and `trailingSkipped` (how many), never their contents, so
   * the caller can list them (a format with no footer) or say how many were skipped. A header whose
   * next row doesn't fit is also taken when a later row fits it. Savings leaves it off.
   */
  keepBadRows?: boolean;
}

export type CsvTableResult =
  | { ok: true; table: CsvTable; bad?: CsvBadRow[]; trailing?: CsvBadRow[]; trailingSkipped?: number }
  | { ok: false; message: string };

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

export function findCsvTable(text: string, opts: CsvTableOptions = {}): CsvTableResult {
  // One record per line (Spend's choice): a bank row never holds a line break, and stray quotes stay
  // linear. The records are read in two passes and never all kept (the final review's M2): the first
  // finds the header and where the table ends, and refuses a file over the limits as soon as it's
  // sure to be; the second keeps only the table's rows and the lines after it, both bounded.
  const read = () => csvRecords(text, { multiline: false });
  const isBlank = (r: CsvRecord) => r.error === undefined && blank(r.fields);
  const keep = opts.keepBadRows === true;

  // Pass 1. The header is among the first CSV_TABLE_MAX_PREAMBLE non-blank records: a row of column
  // names whose next non-blank record has as many fields.
  let at = -1;
  let header: string[] = [];
  let seen = 0;
  let searching = true;
  let candidate: { i: number; fields: string[] } | null = null;
  // Spend's fallback below: the lines of column names in the preamble.
  const candidates: { i: number; fields: string[] }[] = [];
  // The last record (by index) with each field count and no CSV error: blank ones too, as the end
  // of the table has always counted them, and without them, for the fallback.
  const lastAny = new Map<number, number>();
  const lastFilled = new Map<number, number>();
  // Once the header is known: the table's rows so far, the misfits confirmed inside it (a fitting
  // record came after them), and those not yet confirmed.
  let rowCount = 0;
  let badCount = 0;
  let pending = 0;
  let pendingLine = 0;
  const tableRecord = (r: CsvRecord): CsvTableResult | null => {
    if (r.error === undefined && r.fields.length === header.length) {
      if (pending > 0) {
        if (!keep) return { ok: false, message: CSV_TABLE_MESSAGES.badLine(pendingLine) };
        badCount += pending;
        pending = 0;
      }
      if (!blank(r.fields)) rowCount++;
      if (rowCount + badCount > CSV_TABLE_MAX_ROWS) return { ok: false, message: CSV_TABLE_MESSAGES.tooManyRows };
    } else if (!isBlank(r)) {
      if (pending === 0) pendingLine = r.line;
      pending++;
    }
    return null;
  };
  let i = -1;
  for (const r of read()) {
    i++;
    if (r.error === undefined) {
      lastAny.set(r.fields.length, i);
      if (!blank(r.fields)) lastFilled.set(r.fields.length, i);
    }
    if (at >= 0) {
      const refused = tableRecord(r);
      if (refused) return refused;
      continue;
    }
    if (!searching || isBlank(r)) continue;
    if (candidate) {
      if (r.error !== undefined) {
        // Column names followed by a row that can't be read: for Savings that row is the bad line, not
        // "no table". Spend lists it, if a later row fits these column names (below).
        if (!keep) return { ok: false, message: CSV_TABLE_MESSAGES.badLine(r.line) };
      } else if (r.fields.length === candidate.fields.length) {
        at = candidate.i;
        header = candidate.fields.map((c) => c.trim());
        if (header.length > CSV_TABLE_MAX_COLUMNS) return { ok: false, message: CSV_TABLE_MESSAGES.tooManyColumns };
        const refused = tableRecord(r);
        if (refused) return refused;
        continue;
      }
    }
    if (++seen > CSV_TABLE_MAX_PREAMBLE) {
      searching = false;
      candidate = null;
      continue;
    }
    candidate = r.error === undefined && looksLikeHeader(r.fields) ? { i, fields: r.fields } : null;
    if (candidate && keep) candidates.push(candidate);
  }
  if (at < 0 && keep) {
    // Spend (the Batch A review): the header's first row may be one that doesn't fit, a short or
    // unclosed row. Take the first line of column names that some later row fits; the rows between
    // become bad rows.
    const found = candidates.find((c) => (lastFilled.get(c.fields.length) ?? -1) > c.i);
    if (found) {
      at = found.i;
      header = found.fields.map((c) => c.trim());
      if (header.length > CSV_TABLE_MAX_COLUMNS) return { ok: false, message: CSV_TABLE_MESSAGES.tooManyColumns };
    }
  }
  if (at < 0) return { ok: false, message: CSV_TABLE_MESSAGES.noTable };

  // The table ends after the last row that fits. Everything after it is footer and ignored. Between
  // the header and that row, blank lines are skipped and any other line that doesn't fit is a bad
  // row: kept by line and why for Spend, or the file is refused by its line for Savings.
  const last = lastAny.get(header.length) ?? at;
  const fits = (r: CsvRecord) => r.error === undefined && r.fields.length === header.length;
  // Pass 2: the rows, at most the limit, and the lines after the table, as many as could be listed.
  const rows: CsvTable['rows'] = [];
  const bad: CsvBadRow[] = [];
  const trailing: CsvBadRow[] = [];
  let trailingSkipped = 0;
  i = -1;
  for (const r of read()) {
    i++;
    if (i <= at || isBlank(r)) continue;
    if (i > last) {
      if (!keep) break;
      // Listed for a format that has no footer (Bank of America's), counted for any other.
      trailingSkipped++;
      if (trailing.length <= CSV_TABLE_MAX_ROWS) trailing.push({ line: r.line, reason: r.error ?? CSV_ROW_REASONS.values(r.fields!.length, header.length) });
      continue;
    }
    if (fits(r)) rows.push({ line: r.line, cells: r.fields!.map((c) => c.trim()) });
    else if (!keep) return { ok: false, message: CSV_TABLE_MESSAGES.badLine(r.line) };
    else bad.push({ line: r.line, reason: r.error ?? CSV_ROW_REASONS.values(r.fields!.length, header.length) });
    if (rows.length + bad.length > CSV_TABLE_MAX_ROWS) return { ok: false, message: CSV_TABLE_MESSAGES.tooManyRows };
  }
  if (rows.length === 0) return { ok: false, message: CSV_TABLE_MESSAGES.noTable };
  if (!keep) return { ok: true, table: { header, rows } };
  return { ok: true, table: { header, rows }, bad, trailing, trailingSkipped };
}
