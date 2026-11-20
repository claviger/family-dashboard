import { describe, expect, it } from 'vitest';
import type { SavingsMapping } from '../../../shared/savings.js';
import { BANK_FILE, BROKERAGE_FILE, CASH_FILE } from '../../test/importCsv.js';
import { readMapped, type ReadRow } from './csvMapping.js';
import {
  choicesFor, csvFlowKeys, dayEndBalances, defaultChoice, fileOrder, groupLabel, groupsOf, importableBalances, plaidTwins, readRows,
} from './csvRows.js';
import { findCsvTable } from './csvTable.js';
import { BUILT_IN_FORMATS } from './importFormats.js';

// Synthetic files (src/server/test/importCsv.ts). Today is 2026-11-15.
function rowsOf(text: string, mapping: SavingsMapping): ReadRow[] {
  const found = findCsvTable(text);
  if (!found.ok) throw new Error(found.message);
  const read = readMapped(found.table, mapping, '2026-11-15');
  if (!read.ok) throw new Error(read.message);
  return read.rows;
}
const [FIDELITY_CASH, FIDELITY_BROKERAGE] = BUILT_IN_FORMATS as [(typeof BUILT_IN_FORMATS)[number], (typeof BUILT_IN_FORMATS)[number]];
const BANK: SavingsMapping = { date: { column: 0, format: 'dmy' }, amount: { kind: 'split', debit: 2, credit: 3 }, balance: { column: 4, isValue: true }, description: 1 };

describe('groupLabel', () => {
  it('is the first two words, uppercased, with digits and punctuation dropped', () => {
    expect(groupLabel('DIRECT DEPOSIT EXAMPLE CORPPAYROLL (Cash)')).toBe('DIRECT DEPOSIT');
    expect(groupLabel('Check Paid # 1001 (Cash)')).toBe('CHECK PAID');
    expect(groupLabel('TRANSFERRED FROM VS X00-000000-1 (Cash)')).toBe('TRANSFERRED FROM');
    expect(groupLabel('ELECTRONIC FUNDS TRANSFER RECEIVED')).toBe('ELECTRONIC FUNDS');
    expect(groupLabel('Zelle® to Example')).toBe('ZELLE TO');
    expect(groupLabel('')).toBe('');
    expect(groupLabel('12345 / 678')).toBe('');
  });

  it('is at most 100 characters, so a saved choice always fits', () => {
    const long = `${'A'.repeat(60)} ${'B'.repeat(63)}`;
    expect(long).toHaveLength(124);
    expect(groupLabel(`${long} more words`)).toBe(long.slice(0, 100));
  });
});

describe('defaultChoice', () => {
  it('on a cash account: by sign, except a group whose label has INTEREST', () => {
    expect(defaultChoice('cash', 'CARD PURCHASE')).toBe('by_sign');
    expect(defaultChoice('cash', 'INTEREST PAID')).toBe('not_counted');
    expect(defaultChoice('cash', 'CREDIT INTEREST')).toBe('not_counted');
    expect(defaultChoice('cash', '')).toBe('by_sign');
  });

  it('on an investment account: not counted, except a group that looks like money moving', () => {
    for (const label of ['TRANSFERRED FROM', 'DIRECT DEPOSIT', 'ATM WITHDRAWAL', 'CHECK RECEIVED', 'ACH CREDIT', 'EFT IN', 'IRA CONTRIBUTION', 'DISTRIBUTION PAID']) {
      expect(defaultChoice('investment', label), label).toBe('by_sign');
    }
    for (const label of ['YOU SOLD', 'DIVIDEND RECEIVED', 'LEFT OVER', 'EACH SHARE', '']) expect(defaultChoice('investment', label), label).toBe('not_counted');
  });
});

describe('groupsOf and choicesFor', () => {
  it('counts each group, most rows first, and fills built-in choices for every group', () => {
    const rows = rowsOf(CASH_FILE, FIDELITY_CASH.mapping);
    expect(groupsOf(rows)).toEqual([
      { label: 'DEBIT CARD', count: 2 }, { label: 'CHECK PAID', count: 1 }, { label: 'DIRECT DEBIT', count: 1 }, { label: 'DIRECT DEPOSIT', count: 1 },
      { label: 'INTEREST EARNED', count: 1 }, { label: 'TRANSFER OF', count: 1 }, { label: 'TRANSFERRED FROM', count: 1 }, { label: 'TRANSFERRED TO', count: 1 },
    ]);
    const choices = choicesFor(groupsOf(rows), FIDELITY_CASH);
    expect(choices['INTEREST EARNED']).toBe('not_counted');
    expect(Object.values(choices).filter((c) => c === 'by_sign')).toHaveLength(7);
  });
});

describe('fileOrder and dayEndBalances', () => {
  it('detects newest first or oldest first, and takes each day\'s newest row with a number', () => {
    const cash = rowsOf(CASH_FILE, FIDELITY_CASH.mapping);
    expect(fileOrder(cash)).toBe('newest_first');
    expect(dayEndBalances(cash, 'newest_first')).toEqual([
      { date: '2026-10-28', cents: 2400_00 }, { date: '2026-10-30', cents: 2400_00 }, { date: '2026-11-01', cents: 2353_95 }, { date: '2026-11-02', cents: 2253_95 },
      { date: '2026-11-03', cents: 2753_95 }, { date: '2026-11-05', cents: 2755_20 }, { date: '2026-11-12', cents: 4200_00 },
    ]);
    const bank = rowsOf(BANK_FILE, BANK);
    expect(fileOrder(bank)).toBe('oldest_first');
    // Oct 15's newest row is the later one in an oldest-first file.
    expect(dayEndBalances(bank, 'oldest_first')).toEqual([
      { date: '2026-10-13', cents: 1000_00 }, { date: '2026-10-15', cents: 909_80 }, { date: '2026-10-31', cents: 910_55 }, { date: '2026-11-02', cents: 3410_55 }, { date: '2026-11-05', cents: 3210_55 },
    ]);
    expect(fileOrder([])).toBe('newest_first');
  });
});

describe('csvFlowKeys', () => {
  it('is stable, differs per account, hashes the full description, and tells identical rows apart', () => {
    const flows = [
      { date: '2026-11-12', kind: 'withdrawal' as const, cents: 27_60, description: 'DEBIT CARD PURCHASE EXAMPLE GYM (Cash)' },
      { date: '2026-11-12', kind: 'withdrawal' as const, cents: 27_60, description: 'DEBIT CARD PURCHASE EXAMPLE GYM (Cash)' },
      { date: '2026-11-12', kind: 'withdrawal' as const, cents: 27_60, description: 'DEBIT CARD PURCHASE OTHER (Cash)' },
    ];
    const keys = csvFlowKeys(7, flows);
    expect(new Set(keys).size).toBe(3);
    expect(keys.every((k) => /^[0-9a-f]{64}$/.test(k))).toBe(true);
    expect(csvFlowKeys(7, flows)).toEqual(keys);
    expect(csvFlowKeys(8, flows)[0]).not.toBe(keys[0]);
    expect(csvFlowKeys(7, [flows[0]!])).toEqual([keys[0]]);
  });
});

describe('readRows', () => {
  it('turns the Fidelity cash file into flows and day-end balances, with no description text', () => {
    const rows = rowsOf(CASH_FILE, FIDELITY_CASH.mapping);
    const plan = readRows(1, 'cash', rows, FIDELITY_CASH.mapping, choicesFor(groupsOf(rows), FIDELITY_CASH));
    expect(plan.flows.map((f) => [f.date, f.kind, f.cents])).toEqual([
      ['2026-11-12', 'deposit', 1500_00], ['2026-11-12', 'withdrawal', 27_60], ['2026-11-12', 'withdrawal', 27_60], ['2026-11-03', 'deposit', 500_00],
      ['2026-11-02', 'withdrawal', 100_00], ['2026-11-01', 'withdrawal', 46_05], ['2026-10-28', 'withdrawal', 400_00],
    ]);
    expect(plan.balances).toHaveLength(7);
    expect(JSON.stringify(plan)).not.toMatch(/EXAMPLE|Check Paid|VS X00/);
  });

  it('turns the brokerage file into its transfers only, and ignores a balance that isn\'t the account\'s value', () => {
    const rows = rowsOf(BROKERAGE_FILE, FIDELITY_BROKERAGE.mapping);
    const plan = readRows(2, 'investment', rows, FIDELITY_BROKERAGE.mapping, choicesFor(groupsOf(rows), FIDELITY_BROKERAGE));
    expect(plan.flows.map((f) => [f.date, f.kind, f.cents])).toEqual([['2026-11-10', 'withdrawal', 250_00], ['2026-11-03', 'deposit', 600_00]]);
    expect(plan.balances).toEqual([]);
    const value = { ...FIDELITY_BROKERAGE.mapping, balance: { column: 15, isValue: true } };
    expect(readRows(2, 'investment', rows, value, choicesFor(groupsOf(rows), FIDELITY_BROKERAGE)).balances.length).toBeGreaterThan(0);
  });

  it('follows each group\'s choice: Deposit and Withdrawal by size, By sign, Not counted, never a zero', () => {
    const row = (description: string, cents: number | null) => ({ line: 2, date: '2026-11-01', cents, balanceCents: null, description });
    const rows = [row('PAY IN', -5_00), row('PAY OUT', 5_00), row('SIGNED ONE', -7_00), row('SKIP ME', 9_00), row('SIGNED ONE', 0), row('', null)];
    const m: SavingsMapping = { date: { column: 0, format: 'ymd' }, amount: { kind: 'signed', column: 1, inIsNegative: false }, balance: null, description: 2 };
    const plan = readRows(3, 'cash', rows, m, { 'PAY IN': 'deposit', 'PAY OUT': 'withdrawal', 'SIGNED ONE': 'by_sign', 'SKIP ME': 'not_counted', '': 'by_sign' });
    expect(plan.flows.map((f) => [f.kind, f.cents])).toEqual([['deposit', 5_00], ['withdrawal', 5_00], ['withdrawal', 7_00]]);
  });
});

describe('plaidTwins', () => {
  const csv = (date: string, cents = 50_00, kind: 'deposit' | 'withdrawal' = 'deposit') => ({ date, kind, cents });
  const plaid = (id: number, date: string, cents = 50_00, kind: 'deposit' | 'withdrawal' = 'deposit') => ({ id, date, kind, cents });

  it('covers a CSV flow with a Plaid flow of the same kind and amount within 3 days, one to one, nearest first', () => {
    expect(plaidTwins([csv('2026-11-01')], [plaid(1, '2026-11-04')])).toEqual(new Set([0]));
    expect(plaidTwins([csv('2026-11-01')], [plaid(1, '2026-11-05')])).toEqual(new Set());
    expect(plaidTwins([csv('2026-11-01')], [plaid(1, '2026-11-01', 50_01)])).toEqual(new Set());
    expect(plaidTwins([csv('2026-11-01')], [plaid(1, '2026-11-01', 50_00, 'withdrawal')])).toEqual(new Set());
    expect(plaidTwins([csv('2026-11-01'), csv('2026-11-01')], [plaid(1, '2026-11-02')]).size).toBe(1);
    expect(plaidTwins([csv('2026-11-01'), csv('2026-11-04')], [plaid(1, '2026-11-04')])).toEqual(new Set([1]));
  });
});

describe('importableBalances', () => {
  const b = (date: string) => ({ date, cents: 1_00 });
  it('adds only days before the first Plaid balance that have no balance yet', () => {
    const balances = [b('2026-10-28'), b('2026-10-30'), b('2026-11-01'), b('2026-11-03')];
    expect(importableBalances(balances, [])).toEqual({ add: balances, skipped: 0 });
    expect(importableBalances(balances, [{ date: '2026-11-01', source: 'plaid' }, { date: '2026-10-30', source: 'manual' }])).toEqual({ add: [b('2026-10-28')], skipped: 3 });
    expect(importableBalances(balances, [{ date: '2026-10-28', source: 'csv' }])).toEqual({ add: balances.slice(1), skipped: 1 });
  });
});
