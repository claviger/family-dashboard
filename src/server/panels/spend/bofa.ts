import { addDays, isLocalDate } from '../../../shared/dates.js';
import { parseCents } from '../../../shared/money.js';
import type { PreviewRow } from '../../../shared/spend.js';
import { csvRecords, type CsvRecord } from './csv.js';

/**
 * Reads a Bank of America credit-card activity CSV (spec §12.13, research §1 and "CSV importer:
 * detection and safe failure"). Pure: bytes in, rows or a refusal out. Nothing here logs, and no
 * message quotes a row, so a file's contents never reach a log.
 *
 * Everything about the format is community-sourced (research §1); "Verify with a real export" in
 * the phase 6a plan lists what to check against a real file.
 */

export const BOFA_HEADER = ['Posted Date', 'Reference Number', 'Payee', 'Address', 'Amount'] as const;

/** BofA's checking and savings export starts with one of these lines (research §1.3). */
const CHECKING_HEADERS = [
  ['Description', '', 'Summary Amt.'],
  ['Date', 'Description', 'Amount', 'Running Bal.'],
];

/** A temporary credit that hasn't posted has this in Reference Number and an empty date (research §1.2). */
export const PENDING_CREDIT_REFERENCE = 'TEMPRET';

export const BOFA_MESSAGES = {
  notText: "This file isn't a text CSV. Download it again from Bank of America using Microsoft Excel Format.",
  empty: 'This file is empty.',
  checking: 'This is a Bank of America checking or savings export. Only credit-card activity can be imported.',
  notBofa: "This isn't a Bank of America credit-card activity CSV. Its first line should be: Posted Date, Reference Number, Payee, Address, Amount.",
  noRows: 'This file has no transactions in it.',
  tooManyRows: 'This file has more than 20,000 rows. Download a shorter period, and import it in parts.',
  onlyPending: 'This file only has pending holds, nothing to import yet.',
  noneReadable: "None of the rows in this file could be read, so nothing can be imported. Check that it's a Bank of America credit-card activity CSV.",
  mostlyCredits:
    'Most rows in this file are credits. Bank of America lists purchases as negative amounts, so check the amounts below before importing.',
} as const;

/** Shown for a file whose first line names `Posted Date` but isn't the header the importer knows. Only header cells are quoted, never row data. */
export function differentColumnsMessage(found: string[]): string {
  const shown = found.slice(0, 10).map((c) => (c.length > 40 ? `${c.slice(0, 40)}…` : c));
  return `This looks like a Bank of America file, but its columns are different from what the importer knows. Expected: ${BOFA_HEADER.join(', ')}. Found: ${shown.join(', ')}.`;
}

export const ROW_REASONS = {
  pendingCredit: "A temporary credit that hasn't posted yet. Import it from a later file, once it has a posted date.",
  values: (n: number) => `This row has ${n} ${n === 1 ? 'value' : 'values'} instead of 5.`,
  noDate: 'This row has no posted date.',
  badDate: "The posted date isn't a real date written as MM/DD/YYYY.",
  badAmount: "The amount isn't a number like -12.34.",
  noReference: 'This row has no reference number.',
  noPayee: 'This row has no payee.',
  repeated: 'This reference number is on an earlier row of the file too.',
  tooLong: 'A value in this row is too long: the payee and address can have at most 200 characters, and the reference number 40.',
  dateOutOfRange: 'The posted date is before 2000 or more than a month from today.',
} as const;

/** A row as read from the file: every status but `duplicate` and `already_imported`, which need the database. */
export type BofaRow = PreviewRow;

export type BofaFile =
  | {
      ok: true;
      rows: BofaRow[];
      /** The last 4 from a file name like `April2026_1234.csv` or `currentTransaction_1234.csv` (community-observed), or null. */
      fileMask: string | null;
      /** More credits than charges after the sign flip: BofA may have changed its sign convention (research step 6). */
      mostlyCredits: boolean;
    }
  | { ok: false; message: string };

function blank(fields: string[]): boolean {
  return fields.every((f) => f.trim() === '');
}

function sameCells(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** MM/DD/YYYY to YYYY-MM-DD, or null when it isn't a real date. */
function toLocalDate(text: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text);
  if (!m) return null;
  const iso = `${m[3]}-${m[1]}-${m[2]}`;
  return isLocalDate(iso) ? iso : null;
}

function row(line: number, patch: Partial<BofaRow> & Pick<BofaRow, 'status'>): BofaRow {
  return { line, date: null, reference: null, payee: null, address: null, amountCents: null, reason: null, duplicateOf: null, ...patch };
}

/** The most data rows one file may have: a year of a busy card is a few thousand. */
export const MAX_ROWS = 20_000;
/** The longest payee or address kept; anything longer is an unreadable row. */
export const MAX_TEXT = 200;
/** The longest reference number kept (BofA's are 23 digits). */
export const MAX_REFERENCE = 40;
/** The earliest posted date taken. The latest is today plus `FUTURE_DAYS`. */
export const EARLIEST_DATE = '2000-01-01';
export const FUTURE_DAYS = 31;

/** At most `MAX_TEXT` characters of a field, for showing it on an unreadable row. */
function shownText(text: string): string | null {
  if (text === '') return null;
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

/**
 * `today` is the family's date: a posted date after today plus `FUTURE_DAYS`, or before
 * `EARLIEST_DATE`, makes the row unreadable. The file is read one record at a time, and reading
 * stops past `MAX_ROWS`, so a huge file costs no more than that.
 */
export function readBofaCsv(bytes: Uint8Array, fileName: string | null, today: string): BofaFile {
  let text: string;
  try {
    // Strict UTF-8; TextDecoder drops one leading byte order mark itself.
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, message: BOFA_MESSAGES.notText };
  }
  if (text.startsWith('\uFEFF')) text = text.slice(1);
  if (text.includes('\u0000')) return { ok: false, message: BOFA_MESSAGES.notText };

  // One record per line: a BofA row never holds a line break, and this keeps stray quotes linear.
  const records = csvRecords(text, { multiline: false });
  // Not a for-of: leaving one early would close the generator before the rows are read.
  let headerRecord: CsvRecord | undefined;
  for (let next = records.next(); !next.done; next = records.next()) {
    if (next.value.error !== undefined || !blank(next.value.fields)) {
      headerRecord = next.value;
      break;
    }
  }
  if (!headerRecord) return { ok: false, message: BOFA_MESSAGES.empty };

  // Only the first non-blank line can be the header: scanning further is how the wrong file gets in.
  const header = headerRecord.fields?.map((c) => c.trim()) ?? [];
  if (!sameCells(header, BOFA_HEADER)) {
    if (CHECKING_HEADERS.some((h) => sameCells(header, h))) return { ok: false, message: BOFA_MESSAGES.checking };
    if (header.includes('Posted Date')) return { ok: false, message: differentColumnsMessage(header) };
    return { ok: false, message: BOFA_MESSAGES.notBofa };
  }

  const rows: BofaRow[] = [];
  const seen = new Set<string>();
  const latest = addDays(today, FUTURE_DAYS);
  for (const record of records) {
    if (record.error === undefined && blank(record.fields)) continue;
    if (rows.length >= MAX_ROWS) return { ok: false, message: BOFA_MESSAGES.tooManyRows };
    if (record.error !== undefined) {
      rows.push(row(record.line, { status: 'unreadable', reason: record.error }));
      continue;
    }
    if (record.fields.length !== 5) {
      rows.push(row(record.line, { status: 'unreadable', reason: ROW_REASONS.values(record.fields.length) }));
      continue;
    }
    const [rawDate, rawRef, rawPayee, rawAddress, rawAmount] = record.fields.map((f) => f.trim()) as [string, string, string, string, string];
    const payee = rawPayee.replace(/\s+/g, ' ');
    const address = rawAddress.replace(/\s+/g, ' ') || null;
    const shown = { payee: shownText(payee), address: address === null ? null : shownText(address) };
    if (payee.length > MAX_TEXT || (address?.length ?? 0) > MAX_TEXT || rawRef.length > MAX_REFERENCE) {
      rows.push(row(record.line, { status: 'unreadable', ...shown, reason: ROW_REASONS.tooLong }));
      continue;
    }

    if (rawRef === PENDING_CREDIT_REFERENCE) {
      // Never stored: a later file would then skip the real, posted row.
      rows.push(row(record.line, { status: 'pending_credit', ...shown, amountCents: flip(parseCents(rawAmount)), reason: ROW_REASONS.pendingCredit }));
      continue;
    }
    if (rawDate === '') {
      rows.push(row(record.line, { status: 'unreadable', ...shown, reason: ROW_REASONS.noDate }));
      continue;
    }
    const date = toLocalDate(rawDate);
    if (!date) {
      rows.push(row(record.line, { status: 'unreadable', ...shown, reason: ROW_REASONS.badDate }));
      continue;
    }
    if (date < EARLIEST_DATE || date > latest) {
      rows.push(row(record.line, { status: 'unreadable', date, ...shown, reason: ROW_REASONS.dateOutOfRange }));
      continue;
    }
    const amount = parseCents(rawAmount);
    if (amount === null) {
      rows.push(row(record.line, { status: 'unreadable', date, ...shown, reason: ROW_REASONS.badAmount }));
      continue;
    }
    if (rawRef === '') {
      rows.push(row(record.line, { status: 'unreadable', date, ...shown, amountCents: flip(amount), reason: ROW_REASONS.noReference }));
      continue;
    }
    if (payee === '') {
      rows.push(row(record.line, { status: 'unreadable', date, reference: rawRef, address, amountCents: flip(amount), reason: ROW_REASONS.noPayee }));
      continue;
    }
    const repeated = seen.has(rawRef);
    seen.add(rawRef);
    rows.push(
      row(record.line, {
        status: repeated ? 'repeated' : 'new',
        date,
        reference: rawRef,
        ...shown,
        amountCents: flip(amount),
        reason: repeated ? ROW_REASONS.repeated : null,
      }),
    );
  }

  if (rows.length === 0) return { ok: false, message: BOFA_MESSAGES.noRows };
  const readable = rows.filter((r) => r.status === 'new');
  if (readable.length === 0) {
    return { ok: false, message: rows.every((r) => r.status === 'pending_credit') ? BOFA_MESSAGES.onlyPending : BOFA_MESSAGES.noneReadable };
  }
  const credits = readable.filter((r) => r.amountCents! < 0).length;
  const mask = fileName ? /_(\d{4})\.csv$/i.exec(fileName)?.[1] ?? null : null;
  return { ok: true, rows, fileMask: mask, mostlyCredits: credits * 2 > readable.length };
}

/** BofA writes purchases as negative; the app's convention is positive for money spent. */
function flip(cents: number | null): number | null {
  return cents === null || cents === 0 ? cents : -cents;
}
