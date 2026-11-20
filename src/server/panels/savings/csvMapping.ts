import { addDays } from '../../../shared/dates.js';
import {
  SAVINGS_DATE_FORMAT_LABELS, SAVINGS_MESSAGES, type SavingsAccountKind, type SavingsMapping,
} from '../../../shared/savings.js';
import type { CsvTable } from '../../csv/table.js';
import { dateFormatsOf, parseDate, parseMoney } from '../../csv/values.js';

/**
 * Reading a table's values through a column mapping (the CSV import spec, "Mapping columns"; plan
 * decisions 6 to 9). Pure. A refusal names the line and the role, never a cell.
 */

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
