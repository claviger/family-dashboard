import { describe, expect, it } from 'vitest';
import { PLAID_PURPOSES } from './plaid.js';
import {
  MonthSchema, SAVINGS_MESSAGES, SAVINGS_NICKNAME_MAX, SAVINGS_STALE_AFTER_MS, SavingsAccountPatchSchema, SavingsPickInputSchema, SavingsRemoveInputSchema,
} from './savings.js';

describe('Plaid purposes', () => {
  it('are Spend and Savings, Spend first (the default)', () => {
    expect(PLAID_PURPOSES).toEqual(['spend', 'savings']);
  });
});

describe('MonthSchema', () => {
  it('takes YYYY-MM months only', () => {
    for (const ok of ['2026-11', '2026-01', '1999-12']) expect(MonthSchema.safeParse(ok).success, ok).toBe(true);
    for (const bad of ['2026-13', '2026-00', '2026-1', '26-11', '2026-11-01', ' 2026-11', '']) expect(MonthSchema.safeParse(bad).success, bad).toBe(false);
  });
});

describe('SavingsPickInputSchema', () => {
  it('takes show with a trimmed nickname, or skip, once per account', () => {
    expect(SavingsPickInputSchema.parse({ accounts: [{ accountId: 'a', action: 'show', nickname: '  Cash  ' }, { accountId: 'b', action: 'skip' }] }))
      .toEqual({ accounts: [{ accountId: 'a', action: 'show', nickname: 'Cash' }, { accountId: 'b', action: 'skip' }] });
    const message = (v: unknown) => SavingsPickInputSchema.safeParse(v).error?.issues[0]?.message;
    expect(message({ accounts: [{ accountId: 'a', action: 'show', nickname: '   ' }] })).toBe('Give each account you show a nickname.');
    expect(message({ accounts: [{ accountId: 'a', action: 'show', nickname: 'x'.repeat(SAVINGS_NICKNAME_MAX + 1) }] })).toBe(`Keep nicknames to ${SAVINGS_NICKNAME_MAX} characters.`);
    expect(message({ accounts: [{ accountId: 'a', action: 'skip' }, { accountId: 'a', action: 'skip' }] })).toBe('Each account can only be listed once.');
    expect(message({ accounts: [{ accountId: 'a', action: 'attach' }] })).toBe('Choose Show or Skip for each account.');
  });
});

describe('SavingsAccountPatchSchema', () => {
  it('takes a nickname, hidden, or both, and refuses neither', () => {
    expect(SavingsAccountPatchSchema.parse({ nickname: ' Brokerage ' })).toEqual({ nickname: 'Brokerage' });
    expect(SavingsAccountPatchSchema.parse({ hidden: true })).toEqual({ hidden: true });
    expect(SavingsAccountPatchSchema.safeParse({}).error?.issues[0]?.message).toBe('There are no changes to save.');
  });
});

describe('SavingsRemoveInputSchema', () => {
  it('needs deleteData said either way', () => {
    expect(SavingsRemoveInputSchema.parse({ deleteData: false })).toEqual({ deleteData: false });
    expect(SavingsRemoveInputSchema.safeParse({}).error?.issues[0]?.message).toBe('Say whether to delete its data.');
  });
});

describe('SAVINGS_STALE_AFTER_MS', () => {
  it('is a day plus the daily job’s two hours of slack', () => {
    expect(SAVINGS_STALE_AFTER_MS).toBe(26 * 60 * 60_000);
  });
});

describe('SAVINGS_MESSAGES', () => {
  it('names no institution: any brokerage can be linked', () => {
    // Except the warnings about Fidelity's built-in CSV formats, which are Fidelity's by name.
    const builtInFormatWarnings = new Set<string>(['importCashFormatOnInvestment', 'importBrokerageFormatOnCash']);
    for (const [key, m] of Object.entries(SAVINGS_MESSAGES)) {
      if (builtInFormatWarnings.has(key)) continue;
      // Messages take one or two arguments (mapBadDate takes a line and a format); extra ones are ignored.
      const text = typeof m === 'function' ? (m as (...args: string[]) => string)('2026-11-01', 'M/D/YYYY') : m;
      expect(text).not.toMatch(/Fidelity/);
    }
  });
});
