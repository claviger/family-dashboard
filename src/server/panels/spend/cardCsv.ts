import { createHash } from 'node:crypto';
import { CSV_DATE_FORMAT_LABELS, type CsvDateFormat } from '../../../shared/csvImport.js';
import { addDays } from '../../../shared/dates.js';
import { SPEND_MESSAGES, type CardMapping, type PreviewRow } from '../../../shared/spend.js';
import { CSV_ROW_REASONS, CSV_TABLE_MAX_ROWS, CSV_TABLE_MESSAGES, decodeCsv, findCsvTable, type CsvBadRow, type CsvTable } from '../../csv/table.js';
import { dateFormatsOf, parseDate, parseMoney } from '../../csv/values.js';
import { cardFormatFor } from './bofa.js';

/**
 * Reading a card's CSV through a column mapping (the generic import design; plan decisions 3 and
 * 7 to 15). Pure: a table and a mapping in, the preview's rows out, with every status but those that
 * need the database (`duplicate`, `already_imported`). Nothing here logs, and no message quotes a
 * cell: refusals name lines and roles.
 */

/** The longest payee or address kept; anything longer is an unreadable row. */
export const MAX_TEXT = 200;
/** The longest reference number kept (Bank of America's are 23 digits). */
export const MAX_REFERENCE = 40;
/** The earliest date taken. The latest is today plus `FUTURE_DAYS`. */
export const EARLIEST_DATE = '2000-01-01';
export const FUTURE_DAYS = 31;
/** Bank of America's temporary credit that hasn't posted (research §1.2): never stored, so a later file's posted row isn't skipped. */
export const PENDING_CREDIT_REFERENCE = 'TEMPRET';
/** A row key's prefix (plan decision 10). A real reference that starts like `k<digits>:` is refused, so the two never collide. */
export const KEY_PREFIX = 'k1:';
const KEY_LIKE = /^k\d+:/i;

export const CARD_CSV_MESSAGES = {
  onlyPending: 'This file only has pending holds, nothing to import yet.',
  noneReadable: 'None of the rows in this file could be read, so nothing can be imported. Check the columns and the file.',
  mostlyCredits: 'Most rows in this file are credits. Check the amount columns, and "Purchases are negative in this file", before importing.',
} as const;

export const ROW_REASONS = {
  pendingCredit: "A temporary credit that hasn't posted yet. Import it from a later file, once it has a posted date.",
  notPosted: 'Not posted yet: it has no date. Import it from a later file, once it has one.',
  /** `expected` defaults to Bank of America's 5 columns. The table finder writes these (CSV_ROW_REASONS). */
  values: (n: number, expected = 5) => CSV_ROW_REASONS.values(n, expected),
  badDate: (format: string) => `The date isn't a real date written as ${format}.`,
  badAmount: "The amount isn't a number like -12.34.",
  bothAmounts: 'This row has both a charge and a credit, so its amount is unclear.',
  noReference: 'This row has no reference number.',
  badReference: "This row's reference number starts like a key the importer makes, so it can't be stored.",
  noPayee: 'This row has no description or payee.',
  repeated: 'This reference number is on an earlier row of the file too.',
  tooLong: 'A value in this row is too long: the payee and address can have at most 200 characters, and the reference number 40.',
  dateOutOfRange: 'The posted date is before 2000 or more than a month from today.',
} as const;

/** A card file's table: the rows the columns are read from, and those the table finder couldn't split (plan decision 3). */
export interface CardTable extends CsvTable {
  bad: CsvBadRow[];
  /** How many non-blank lines after the last fitting row were skipped as footer: a count, never their contents. */
  trailingSkipped: number;
}

export type CardFile = { ok: true; table: CardTable } | { ok: false; message: string };

export type CardRows =
  | {
      ok: true;
      rows: PreviewRow[];
      /** The last 4 from a Bank of America file name like `April2026_1234.csv`, or null (plan decision 14). */
      fileMask: string | null;
      /** More credits than charges among the new rows: the sign setting may be the wrong way round. */
      mostlyCredits: boolean;
    }
  | { ok: false; message: string };

/**
 * Decodes the bytes and finds the table, keeping rows that don't fit (plan decision 3). The lines
 * after the table's last row are listed as bad rows for a built-in format with no footer (Bank of
 * America's, whose old reader listed them), and only counted for any other file.
 */
export function readCardFile(bytes: Uint8Array): CardFile {
  const text = decodeCsv(bytes);
  if (text === null) return { ok: false, message: CSV_TABLE_MESSAGES.notText };
  const found = findCsvTable(text, { keepBadRows: true });
  if (!found.ok) return found;
  const bad = found.bad ?? [];
  const trailing = found.trailing ?? [];
  if (cardFormatFor(found.table.header)?.hasFooter === false) {
    if (found.table.rows.length + bad.length + (found.trailingSkipped ?? 0) > CSV_TABLE_MAX_ROWS) return { ok: false, message: CSV_TABLE_MESSAGES.tooManyRows };
    return { ok: true, table: { ...found.table, bad: [...bad, ...trailing], trailingSkipped: 0 } };
  }
  return { ok: true, table: { ...found.table, bad, trailingSkipped: found.trailingSkipped ?? 0 } };
}

/**
 * A row's key when its file has no reference column (plan decision 10). `description` is the payee
 * as stored (white space collapsed); `n` is its place among identical rows that day in file order.
 */
export function rowKey(cardId: number, date: string, cents: number, description: string, n: number): string {
  return `${KEY_PREFIX}${createHash('sha256').update(`spend-csv-v1\n${JSON.stringify([cardId, date, cents, description])}\n${n}`).digest('hex')}`;
}

export function isRowKey(reference: string | null | undefined): boolean {
  return reference?.startsWith(KEY_PREFIX) ?? false;
}

/** The issuer's own reference number, or null for none or a key: the duplicate test's clause is about real ones only (plan decision 11). */
export function realReference(reference: string | null | undefined): string | null {
  return !reference || isRowKey(reference) ? null : reference;
}

/**
 * The row's amount in the app's sign (positive is money spent), null with none, 'bad' when a cell
 * isn't money, 'both' when a split row has a charge and a credit (not netted: the row is
 * unreadable). A zero in one of the split columns counts as empty.
 */
function amountOf(cells: readonly string[], m: CardMapping): number | null | 'bad' | 'both' {
  if (m.amount.kind === 'signed') {
    const v = parseMoney(cells[m.amount.column]!);
    if (v === 'bad' || v === null) return v;
    return m.amount.purchasesNegative && v !== 0 ? -v : v;
  }
  const charge = parseMoney(cells[m.amount.charges]!);
  const credit = parseMoney(cells[m.amount.credits]!);
  if (charge === 'bad' || credit === 'bad') return 'bad';
  if (charge === null && credit === null) return null;
  if (charge !== null && charge !== 0 && credit !== null && credit !== 0) return 'both';
  // Both read as positive, whatever sign the issuer wrote.
  return Math.abs(charge ?? 0) - Math.abs(credit ?? 0);
}

function columnsOf(m: CardMapping): number[] {
  return [
    m.date.column,
    ...(m.amount.kind === 'signed' ? [m.amount.column] : [m.amount.charges, m.amount.credits]),
    m.description,
    ...(m.reference === null ? [] : [m.reference]),
    ...(m.address === null ? [] : [m.address]),
  ];
}

/**
 * Why `m` can't be used on this table, or null (plan decision 7): a column it names isn't there,
 * one column has two roles, or a row's date (when it has one) or amount doesn't read, by line.
 */
export function mappingProblem(table: CsvTable, m: CardMapping): string | null {
  const columns = columnsOf(m);
  if (columns.some((c) => c >= table.header.length)) return SPEND_MESSAGES.importColumnMissing;
  if (new Set(columns).size !== columns.length) return SPEND_MESSAGES.importSameColumn;
  for (const r of table.rows) {
    const date = r.cells[m.date.column]!;
    if (date !== '' && parseDate(date, m.date.format) === null) return SPEND_MESSAGES.importBadDate(r.line, CSV_DATE_FORMAT_LABELS[m.date.format]);
    if (amountOf(r.cells, m) === 'bad') return SPEND_MESSAGES.importBadAmount(r.line);
  }
  return null;
}

/** At most `MAX_TEXT` characters of a field, for showing it on an unreadable row. */
function shownText(text: string): string | null {
  if (text === '') return null;
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…` : text;
}

function row(line: number, patch: Partial<PreviewRow> & Pick<PreviewRow, 'status'>): PreviewRow {
  return { line, date: null, reference: null, payee: null, address: null, amountCents: null, reason: null, duplicateOf: null, ...patch };
}

/**
 * The preview's rows, read through `m` (the order of checks is Bank of America's reader's, so its
 * rows come out as they did). `bofa`: the header is exactly Bank of America's, so `TEMPRET` rows
 * are held back and the file name's last 4 is read (plan decision 14). `today` is the family's date.
 */
export function readCardRows(table: CardTable, m: CardMapping, opts: { cardId: number; today: string; fileName: string | null; bofa: boolean }): CardRows {
  const rows: PreviewRow[] = table.bad.map((b) => row(b.line, { status: 'unreadable', reason: b.reason }));
  const seen = new Set<string>();
  const sameDay = new Map<string, number>();
  const latest = addDays(opts.today, FUTURE_DAYS);
  const label = CSV_DATE_FORMAT_LABELS[m.date.format];
  for (const r of table.rows) {
    const cell = (c: number | null) => (c === null ? '' : r.cells[c]!);
    const rawDate = cell(m.date.column);
    const rawRef = cell(m.reference);
    const payee = cell(m.description).replace(/\s+/g, ' ');
    const address = cell(m.address).replace(/\s+/g, ' ') || null;
    const shown = { payee: shownText(payee), address: address === null ? null : shownText(address) };
    const amount = amountOf(r.cells, m);
    const cents = typeof amount === 'number' ? amount : null;
    if (payee.length > MAX_TEXT || (address?.length ?? 0) > MAX_TEXT || rawRef.length > MAX_REFERENCE) {
      rows.push(row(r.line, { status: 'unreadable', ...shown, reason: ROW_REASONS.tooLong }));
      continue;
    }
    if (opts.bofa && rawRef === PENDING_CREDIT_REFERENCE) {
      // Never stored: a later file would then skip the real, posted row.
      rows.push(row(r.line, { status: 'pending_credit', ...shown, amountCents: cents, reason: ROW_REASONS.pendingCredit }));
      continue;
    }
    if (rawDate === '') {
      // The generic import design: skipped and counted, never imported.
      rows.push(row(r.line, { status: 'pending_credit', ...shown, amountCents: cents, reason: ROW_REASONS.notPosted }));
      continue;
    }
    const date = parseDate(rawDate, m.date.format);
    if (!date) {
      rows.push(row(r.line, { status: 'unreadable', ...shown, reason: ROW_REASONS.badDate(label) }));
      continue;
    }
    if (date < EARLIEST_DATE || date > latest) {
      rows.push(row(r.line, { status: 'unreadable', date, ...shown, reason: ROW_REASONS.dateOutOfRange }));
      continue;
    }
    if (cents === null) {
      rows.push(row(r.line, { status: 'unreadable', date, ...shown, reason: amount === 'both' ? ROW_REASONS.bothAmounts : ROW_REASONS.badAmount }));
      continue;
    }
    if (m.reference !== null && rawRef === '') {
      rows.push(row(r.line, { status: 'unreadable', date, ...shown, amountCents: cents, reason: ROW_REASONS.noReference }));
      continue;
    }
    if (m.reference !== null && KEY_LIKE.test(rawRef)) {
      rows.push(row(r.line, { status: 'unreadable', date, ...shown, amountCents: cents, reason: ROW_REASONS.badReference }));
      continue;
    }
    if (payee === '') {
      rows.push(row(r.line, { status: 'unreadable', date, reference: rawRef || null, address, amountCents: cents, reason: ROW_REASONS.noPayee }));
      continue;
    }
    if (m.reference === null) {
      const same = JSON.stringify([date, cents, payee]);
      const n = sameDay.get(same) ?? 0;
      sameDay.set(same, n + 1);
      rows.push(row(r.line, { status: 'new', date, reference: rowKey(opts.cardId, date, cents, payee, n), ...shown, amountCents: cents }));
      continue;
    }
    const repeated = seen.has(rawRef);
    seen.add(rawRef);
    rows.push(row(r.line, { status: repeated ? 'repeated' : 'new', date, reference: rawRef, ...shown, amountCents: cents, reason: repeated ? ROW_REASONS.repeated : null }));
  }
  rows.sort((a, b) => a.line - b.line);

  const readable = rows.filter((r) => r.status === 'new');
  if (readable.length === 0) {
    return { ok: false, message: rows.every((r) => r.status === 'pending_credit') ? CARD_CSV_MESSAGES.onlyPending : CARD_CSV_MESSAGES.noneReadable };
  }
  const credits = readable.filter((r) => r.amountCents! < 0).length;
  const fileMask = opts.bofa && opts.fileName ? /_(\d{4})\.csv$/i.exec(opts.fileName)?.[1] ?? null : null;
  return { ok: true, rows, fileMask, mostlyCredits: credits * 2 > readable.length };
}

/** Each column's date formats (none: not a date column), from every row. */
export function columnDateFormats(table: CsvTable): CsvDateFormat[][] {
  return table.header.map((_, c) => dateFormatsOf(table.rows.map((r) => r.cells[c]!)));
}

/** Most of a column's non-zero amounts are negative: how a card file writes purchases, usually. */
function mostlyNegative(table: CsvTable, column: number): boolean {
  const values = table.rows.map((r) => parseMoney(r.cells[column]!)).filter((v): v is number => typeof v === 'number' && v !== 0);
  return values.filter((v) => v < 0).length * 2 > values.length;
}

/** A starting point for an unknown card file's mapping (plan decision 15), which the admin confirms; null without a date, an amount, or a description column. */
export function guessCardMapping(table: CsvTable, dateFormats?: readonly (readonly CsvDateFormat[])[]): CardMapping | null {
  const names = table.header.map((h) => h.toLowerCase());
  const pick = (re: RegExp, except: readonly number[]) => {
    const i = names.findIndex((n, c) => re.test(n) && !except.includes(c));
    return i < 0 ? null : i;
  };
  const formats = dateFormats ?? columnDateFormats(table);
  const isDate = (c: number) => formats[c]!.length > 0;
  // A posted date first: billing cycles go by it (spec §12.4).
  const posted = names.findIndex((n, c) => /post/.test(n) && /date/.test(n) && isDate(c));
  const named = names.findIndex((n, c) => /date/.test(n) && isDate(c));
  const date = posted >= 0 ? posted : named >= 0 ? named : formats.findIndex((f) => f.length > 0);
  if (date < 0) return null;
  const charges = pick(/debit|charge|purchase|withdrawal|money out/, [date]);
  const credits = pick(/credit|payment|refund|money in/, [date, ...(charges === null ? [] : [charges])]);
  const amountColumn = pick(/amount/, [date]);
  const amount: CardMapping['amount'] | null =
    charges !== null && credits !== null ? { kind: 'split', charges, credits }
    : amountColumn !== null ? { kind: 'signed', column: amountColumn, purchasesNegative: mostlyNegative(table, amountColumn) }
    : null;
  if (!amount) return null;
  const used = [date, ...(amount.kind === 'split' ? [amount.charges, amount.credits] : [amount.column])];
  const reference = pick(/reference|^ref\b|transaction id/, used);
  const notYet = [...used, ...(reference === null ? [] : [reference])];
  const textColumn = table.header.findIndex((_, c) => !notYet.includes(c) && table.rows.some((r) => /\p{L}/u.test(r.cells[c]!)));
  const description = pick(/description|payee|merchant|details|narrative|memo|name/, notYet) ?? (textColumn >= 0 ? textColumn : null);
  if (description === null) return null;
  const address = pick(/address|location|city/, [...notYet, description]);
  // With both M/D and D/M possible this picks M/D; the columns form leaves it blank then (plan decision 8).
  return { date: { column: date, format: formats[date]![0]! }, amount, description, reference, address };
}
