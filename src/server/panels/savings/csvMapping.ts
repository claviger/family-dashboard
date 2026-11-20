import { addDays, isLocalDate } from '../../../shared/dates.js';
import { parseCents } from '../../../shared/money.js';
import {
  SAVINGS_DATE_FORMAT_LABELS, SAVINGS_DATE_FORMATS, SAVINGS_MESSAGES, type SavingsAccountKind, type SavingsDateFormat, type SavingsMapping,
} from '../../../shared/savings.js';
import type { CsvTable } from './csvTable.js';

/**
 * Reading a table's values through a column mapping (the CSV import spec, "Mapping columns"; plan
 * decisions 6 to 9). Pure. A refusal names the line and the role, never a cell.
 */

/** A money cell (plan decision 6): null when empty, 'bad' when it isn't money. */
export function parseMoney(text: string): number | null | 'bad' {
  let t = text.trim().replace(/−/g, '-');
  if (t === '') return null;
  // At most one negative marker: parentheses or a minus, never both or two minus signs ("(-5)" and "--5" are bad, not 5.00).
  let negatives = 0;
  if (/^\(.*\)$/.test(t)) {
    negatives++;
    t = t.slice(1, -1).trim();
  }
  const sign = () => {
    if (t.startsWith('-')) {
      negatives++;
      t = t.slice(1).trim();
    } else if (t.startsWith('+')) t = t.slice(1).trim();
  };
  sign();
  t = t.replace(/^[$€£¥]\s*/, '').replace(/\s*[$€£¥]$/, '');
  sign();
  if (negatives > 1) return 'bad';
  const cents = parseCents(t);
  if (cents === null || cents < 0) return 'bad';
  return negatives === 1 && cents !== 0 ? -cents : cents;
}

const DATE_PATTERNS: Record<SavingsDateFormat, RegExp> = {
  ymd: /^(\d{4})-(\d{1,2})-(\d{1,2})$/,
  mdy: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
  dmy: /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/,
};

/** A date cell in `format`, as YYYY-MM-DD, or null when it isn't a real day written that way. */
export function parseDate(text: string, format: SavingsDateFormat): string | null {
  const m = DATE_PATTERNS[format].exec(text.trim());
  if (!m) return null;
  const [y, mo, d] = format === 'ymd' ? [m[1]!, m[2]!, m[3]!] : format === 'mdy' ? [m[3]!, m[1]!, m[2]!] : [m[3]!, m[2]!, m[1]!];
  const iso = `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
  return isLocalDate(iso) ? iso : null;
}

/** The formats every non-empty value fits; none for a column with no values. Both `mdy` and `dmy`: ambiguous, the admin chooses (plan decision 8). */
export function dateFormatsOf(values: readonly string[]): SavingsDateFormat[] {
  const present = values.map((v) => v.trim()).filter((v) => v !== '');
  if (present.length === 0) return [];
  return SAVINGS_DATE_FORMATS.filter((f) => present.every((v) => parseDate(v, f) !== null));
}

/** One row as the mapping reads it. `cents`: money in positive, null with no amount. `description`: white space collapsed, '' with none. */
export interface ReadRow {
  line: number;
  date: string;
  cents: number | null;
  balanceCents: number | null;
  description: string;
}

export type MappedRows = { ok: true; rows: ReadRow[] } | { ok: false; message: string };

const EARLIEST_DATE = '2000-01-01';

export function readMapped(table: CsvTable, m: SavingsMapping, today: string): MappedRows {
  const columns = [
    m.date.column,
    ...(m.amount.kind === 'signed' ? [m.amount.column] : [m.amount.debit, m.amount.credit]),
    ...(m.balance ? [m.balance.column] : []),
    ...(m.description !== null ? [m.description] : []),
  ];
  if (columns.some((c) => c >= table.header.length)) return { ok: false, message: SAVINGS_MESSAGES.mapColumnMissing };
  if (new Set(columns).size !== columns.length) return { ok: false, message: SAVINGS_MESSAGES.mapSameColumn };
  const latest = addDays(today, 1);
  const rows: ReadRow[] = [];
  for (const r of table.rows) {
    const date = parseDate(r.cells[m.date.column]!, m.date.format);
    if (date === null || date < EARLIEST_DATE || date > latest) return { ok: false, message: SAVINGS_MESSAGES.mapBadDate(r.line, SAVINGS_DATE_FORMAT_LABELS[m.date.format]) };
    let cents: number | null;
    if (m.amount.kind === 'signed') {
      const v = parseMoney(r.cells[m.amount.column]!);
      if (v === 'bad') return { ok: false, message: SAVINGS_MESSAGES.mapBadAmount(r.line) };
      cents = v === null ? null : m.amount.inIsNegative && v !== 0 ? -v : v;
    } else {
      const debit = parseMoney(r.cells[m.amount.debit]!);
      const credit = parseMoney(r.cells[m.amount.credit]!);
      if (debit === 'bad' || credit === 'bad') return { ok: false, message: SAVINGS_MESSAGES.mapBadAmount(r.line) };
      // Both read as positive, whatever sign the bank wrote (plan decision 7).
      cents = debit === null && credit === null ? null : Math.abs(credit ?? 0) - Math.abs(debit ?? 0);
    }
    const balance = m.balance ? parseMoney(r.cells[m.balance.column]!) : null;
    rows.push({
      line: r.line,
      date,
      cents,
      // A balance cell that isn't a number (Fidelity's `Processing`) is no balance.
      balanceCents: typeof balance === 'number' ? balance : null,
      description: m.description === null ? '' : r.cells[m.description]!.replace(/\s+/g, ' ').trim(),
    });
  }
  return { ok: true, rows };
}

/** A starting point for an unknown file's mapping (plan decision 9); null without a date and an amount column. */
export function guessMapping(table: CsvTable, kind: SavingsAccountKind): SavingsMapping | null {
  const names = table.header.map((h) => h.toLowerCase());
  const find = (re: RegExp, except: number[] = []) => {
    const i = names.findIndex((n, c) => re.test(n) && !except.includes(c));
    return i < 0 ? null : i;
  };
  const formats = table.header.map((_, c) => dateFormatsOf(table.rows.map((r) => r.cells[c]!)));
  const named = find(/date/);
  const date = named !== null && formats[named]!.length > 0 ? named : formats.findIndex((f) => f.length > 0);
  if (date < 0) return null;
  const debit = find(/debit|withdrawal|money out|paid out/, [date]);
  const credit = find(/credit|deposit|money in|paid in/, [date, ...(debit === null ? [] : [debit])]);
  const amountColumn = find(/amount/, [date]);
  const amount: SavingsMapping['amount'] | null =
    debit !== null && credit !== null ? { kind: 'split', debit, credit }
    : amountColumn !== null ? { kind: 'signed', column: amountColumn, inIsNegative: false }
    : null;
  if (!amount) return null;
  const used = [date, ...(amount.kind === 'split' ? [amount.debit, amount.credit] : [amount.column])];
  const balance = find(/balance/, used);
  const description = find(/description|action|memo|payee|details|narrative|name/, [...used, ...(balance === null ? [] : [balance])]);
  return {
    // With both M/D and D/M possible this picks M/D, and the draft still asks the admin (plan decision 8).
    date: { column: date, format: formats[date]![0]! },
    amount,
    balance: balance === null ? null : { column: balance, isValue: kind === 'cash' },
    description,
  };
}
