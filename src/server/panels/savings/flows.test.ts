import { describe, expect, it } from 'vitest';
import { CASH_MOVEMENTS, accountKindOf, cashAccountFlow, classifyInvestmentTransaction, isPlaidInterest, type InvestmentTransactionFacts } from './flows.js';

const inv = (fields: Partial<InvestmentTransactionFacts>): InvestmentTransactionFacts => ({
  investment_transaction_id: 'itx-1', account_id: 'acct-b', security_id: null, date: '2026-11-03', amount: -100, type: 'cash', subtype: 'deposit',
  iso_currency_code: 'USD', unofficial_currency_code: null, ...fields,
});

describe('accountKindOf', () => {
  it('makes depository accounts cash and investment accounts investment, and nothing else showable', () => {
    expect(accountKindOf('depository')).toBe('cash');
    expect(accountKindOf('investment')).toBe('investment');
    expect(accountKindOf('credit')).toBeNull();
    expect(accountKindOf('loan')).toBeNull();
  });
});

describe('classifyInvestmentTransaction', () => {
  it('counts the cash movements, by the sign of the amount (negative is money in)', () => {
    expect(CASH_MOVEMENTS).toEqual(['cash:deposit', 'cash:contribution', 'cash:withdrawal', 'transfer:transfer']);
    expect(classifyInvestmentTransaction(inv({ subtype: 'deposit', amount: -100.5 }))).toEqual({ flow: { kind: 'deposit', amountCents: 100_50 } });
    expect(classifyInvestmentTransaction(inv({ subtype: 'contribution', amount: -50 }))).toEqual({ flow: { kind: 'deposit', amountCents: 50_00 } });
    expect(classifyInvestmentTransaction(inv({ subtype: 'withdrawal', amount: 20 }))).toEqual({ flow: { kind: 'withdrawal', amountCents: 20_00 } });
    expect(classifyInvestmentTransaction(inv({ type: 'transfer', subtype: 'transfer', amount: -7 }))).toEqual({ flow: { kind: 'deposit', amountCents: 7_00 } });
    expect(classifyInvestmentTransaction(inv({ type: 'transfer', subtype: 'transfer', amount: 7 }))).toEqual({ flow: { kind: 'withdrawal', amountCents: 7_00 } });
  });

  it('flags a subtype whose sign disagrees with its name, and still goes by the sign', () => {
    expect(classifyInvestmentTransaction(inv({ subtype: 'deposit', amount: 30 }))).toEqual({ flow: { kind: 'withdrawal', amountCents: 30_00 }, signMismatch: true });
    expect(classifyInvestmentTransaction(inv({ subtype: 'withdrawal', amount: -30 }))).toEqual({ flow: { kind: 'deposit', amountCents: 30_00 }, signMismatch: true });
  });

  it('leaves out everything that is the market, a fee, a trade, pending, a share transfer, or unlabelled', () => {
    const notFlows: Partial<InvestmentTransactionFacts>[] = [
      { type: 'cash', subtype: 'dividend' }, { type: 'cash', subtype: 'qualified dividend' }, { type: 'cash', subtype: 'interest' },
      { type: 'cash', subtype: 'account fee' }, { type: 'cash', subtype: 'tax withheld' }, { type: 'cash', subtype: 'long-term capital gain' },
      { type: 'cash', subtype: 'pending credit' }, { type: 'cash', subtype: 'pending debit' },
      { type: 'buy', subtype: 'buy' }, { type: 'buy', subtype: 'contribution' }, { type: 'buy', subtype: 'dividend reinvestment' },
      { type: 'sell', subtype: 'sell' }, { type: 'sell', subtype: 'distribution' }, { type: 'fee', subtype: 'management fee' },
      { type: 'transfer', subtype: 'transfer', security_id: 'sec-1' }, { type: 'transfer', subtype: 'split' }, { type: 'cancel', subtype: null },
      { type: null, subtype: null }, { type: 'cash', subtype: null },
    ];
    for (const f of notFlows) expect(classifyInvestmentTransaction(inv(f)), JSON.stringify(f)).toEqual({ flow: null });
  });

  it('skips a zero amount, and an amount it can\'t read', () => {
    expect(classifyInvestmentTransaction(inv({ amount: 0 }))).toEqual({ flow: null });
    expect(classifyInvestmentTransaction(inv({ amount: Number.NaN }))).toEqual({ flow: null, unreadable: true });
  });
});

describe('cashAccountFlow', () => {
  it('isn\'t a flow for interest: an INCOME_INTEREST category, or a name starting INTEREST EARNED or INTEREST PAID (spec, "Interest from Plaid")', () => {
    const tx = { amount: -1.25, pending: false, iso_currency_code: 'USD', unofficial_currency_code: null };
    expect(cashAccountFlow({ ...tx, personal_finance_category: { detailed: 'INCOME_INTEREST_EARNED' } }, 'USD')).toEqual({ flow: null, interest: true });
    expect(cashAccountFlow({ ...tx, personal_finance_category: { detailed: 'income_interest_earned' } }, 'USD')).toEqual({ flow: null, interest: true });
    expect(cashAccountFlow({ ...tx, name: 'Interest Paid' }, 'USD')).toEqual({ flow: null, interest: true });
    expect(cashAccountFlow({ ...tx, name: '  interest earned FDIC' }, 'USD')).toEqual({ flow: null, interest: true });
    for (const t of [{ ...tx, name: 'INTEREST CHARGE' }, { ...tx, name: 'PAYROLL INTEREST EARNED' }, { ...tx, personal_finance_category: { detailed: 'INCOME_WAGES' } }, { ...tx, name: null }]) {
      expect(cashAccountFlow(t, 'USD'), JSON.stringify(t)).toEqual({ flow: { kind: 'deposit', amountCents: 1_25 } });
    }
    expect(isPlaidInterest({ name: 'INTEREST PAID', personal_finance_category: null })).toBe(true);
  });

  const tx = { amount: -250, pending: false, iso_currency_code: 'USD', unofficial_currency_code: null };
  it('makes money in a deposit and money out a withdrawal, posted only, in the account\'s currency', () => {
    expect(cashAccountFlow(tx, 'USD')).toEqual({ flow: { kind: 'deposit', amountCents: 250_00 } });
    expect(cashAccountFlow({ ...tx, amount: 12.34 }, 'USD')).toEqual({ flow: { kind: 'withdrawal', amountCents: 12_34 } });
    expect(cashAccountFlow({ ...tx, pending: true }, 'USD')).toEqual({ flow: null });
    expect(cashAccountFlow({ ...tx, amount: 0 }, 'USD')).toEqual({ flow: null });
    expect(cashAccountFlow({ ...tx, iso_currency_code: 'CAD' }, 'USD')).toEqual({ flow: null, otherCurrency: true });
    expect(cashAccountFlow({ ...tx, iso_currency_code: null, unofficial_currency_code: 'BTC' }, 'USD')).toEqual({ flow: null, otherCurrency: true });
    // Plaid didn't say the account's currency: the transaction's is taken as it is.
    expect(cashAccountFlow({ ...tx, iso_currency_code: 'USD' }, null)).toEqual({ flow: { kind: 'deposit', amountCents: 250_00 } });
  });
});
