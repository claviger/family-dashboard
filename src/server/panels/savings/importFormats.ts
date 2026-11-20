import type { SavingsGroupChoice, SavingsImportFormat, SavingsMapping } from '../../../shared/savings.js';

/**
 * Built-in formats (the CSV import spec, "Built-in formats"): a mapping and group rules, recognized
 * by exact column names. Data, not code: a new bank's format is one more entry. `rules` names
 * group labels; every other label gets `otherwise`, so a built-in format decides every group (plan
 * decision 13). An admin can still change any of it before importing.
 */

export interface BuiltInFormat {
  id: Exclude<SavingsImportFormat, 'custom'>;
  name: string;
  header: readonly string[];
  mapping: SavingsMapping;
  rules: Readonly<Record<string, SavingsGroupChoice>>;
  otherwise: SavingsGroupChoice;
}

export const BUILT_IN_FORMATS: readonly BuiltInFormat[] = [
  {
    id: 'fidelity_cash',
    name: 'Fidelity cash management',
    header: ['Run Date', 'Action', 'Symbol', 'Description', 'Type', 'Price ($)', 'Quantity', 'Commission ($)', 'Fees ($)', 'Accrued Interest ($)', 'Amount ($)', 'Cash Balance ($)', 'Settlement Date'],
    mapping: { date: { column: 0, format: 'mdy' }, amount: { kind: 'signed', column: 10, inIsNegative: false }, balance: { column: 11, isValue: true }, description: 1 },
    rules: { 'INTEREST EARNED': 'not_counted' },
    otherwise: 'by_sign',
  },
  {
    id: 'fidelity_brokerage',
    name: 'Fidelity brokerage',
    header: [
      'Run Date', 'Action', 'Symbol', 'Description', 'Type', 'Exchange Quantity', 'Exchange Currency', 'Currency', 'Price', 'Quantity', 'Exchange Rate',
      'Commission', 'Fees', 'Accrued Interest', 'Amount', 'Cash Balance', 'Settlement Date',
    ],
    // Its Cash Balance is uninvested cash, not the account's value, so it's ignored.
    mapping: { date: { column: 0, format: 'mdy' }, amount: { kind: 'signed', column: 14, inIsNegative: false }, balance: { column: 15, isValue: false }, description: 1 },
    rules: {
      'TRANSFERRED FROM': 'by_sign', 'DIRECT DEPOSIT': 'by_sign', 'CHECK RECEIVED': 'by_sign', 'ELECTRONIC FUNDS': 'by_sign', 'TRANSFERRED TO': 'by_sign', 'DIRECT DEBIT': 'by_sign',
    },
    otherwise: 'not_counted',
  },
];

/** The built-in format whose header is exactly this one (after trimming), or null. */
export function builtInFormatFor(header: readonly string[]): BuiltInFormat | null {
  return BUILT_IN_FORMATS.find((f) => f.header.length === header.length && f.header.every((h, i) => h === header[i]!.trim())) ?? null;
}

/** The built-in format by id. */
export function builtInFormat(id: SavingsImportFormat): BuiltInFormat | null {
  return BUILT_IN_FORMATS.find((f) => f.id === id) ?? null;
}
