import type { SavingsAccountKind, SavingsFlowKind } from '../../../shared/savings.js';
import { plaidAmountCents } from '../../integrations/plaid/client.js';

/**
 * What counts as money in or out of a Savings account (the Savings spec, "Data"; plan decisions 4
 * to 6; docs/research/plaid-savings.md §3.5). Pure. Direction is always from the sign of Plaid's
 * `amount`: negative is money in (a deposit), positive is money out (a withdrawal), for both
 * `/transactions/sync` and `/investments/transactions/get` (research §3.3). Amounts become
 * positive cents.
 */

/** The investment transaction `type:subtype` pairs that are cash moving in or out (decision 6). `transfer:transfer` only without a security. */
export const CASH_MOVEMENTS = ['cash:deposit', 'cash:contribution', 'cash:withdrawal', 'transfer:transfer'] as const;
const CASH_MOVEMENT_SET: ReadonlySet<string> = new Set(CASH_MOVEMENTS);
/** Subtypes whose name says a direction, for the sign check. */
const INWARD = new Set(['deposit', 'contribution']);
const OUTWARD = new Set(['withdrawal']);

/** A shown account's kind, from Plaid's account `type`; null for a type Savings doesn't show. */
export function accountKindOf(type: string): SavingsAccountKind | null {
  if (type === 'depository') return 'cash';
  if (type === 'investment') return 'investment';
  return null;
}

/** The fields of an investment transaction the classification reads (the Plaid client parses exactly these). */
export interface InvestmentTransactionFacts {
  investment_transaction_id: string;
  account_id: string;
  security_id: string | null;
  date: string;
  amount: number;
  type: string | null;
  subtype: string | null;
  iso_currency_code: string | null;
  unofficial_currency_code: string | null;
}

export interface FlowValue {
  kind: SavingsFlowKind;
  amountCents: number;
}

/**
 * `flow` null: not a flow (or zero). `signMismatch`: a cash movement whose sign disagrees with its
 * subtype's name, still classified by the sign and counted in the log. `unreadable`: the amount
 * isn't a number the client can turn into cents.
 */
export type Classified = { flow: FlowValue | null; signMismatch?: true; unreadable?: true };

function byAmount(amount: number): { flow: FlowValue | null; unreadable?: true } {
  const cents = plaidAmountCents(amount);
  if (cents === null) return { flow: null, unreadable: true };
  if (cents.cents === 0) return { flow: null };
  return { flow: { kind: cents.cents < 0 ? 'deposit' : 'withdrawal', amountCents: Math.abs(cents.cents) } };
}

/** A brokerage account's investment transaction: a flow, or not (decision 6). */
export function classifyInvestmentTransaction(t: InvestmentTransactionFacts): Classified {
  if (t.type === null || t.subtype === null) return { flow: null };
  const pair = `${t.type}:${t.subtype}`;
  if (!CASH_MOVEMENT_SET.has(pair)) return { flow: null };
  if (pair === 'transfer:transfer' && t.security_id !== null) return { flow: null };
  const result = byAmount(t.amount);
  if (result.flow === null) return result;
  const mismatch = (INWARD.has(t.subtype) && result.flow.kind !== 'deposit') || (OUTWARD.has(t.subtype) && result.flow.kind !== 'withdrawal');
  return mismatch ? { ...result, signMismatch: true } : result;
}

/** The fields of a `/transactions/sync` entry the cash account's flows read. `name` and the category are read for interest only, never stored. */
export interface CashTransactionFacts {
  amount: number;
  pending: boolean;
  iso_currency_code: string | null;
  unofficial_currency_code: string | null;
  name?: string | null;
  personal_finance_category?: { detailed: string } | null;
}

/**
 * Interest on a cash account (the CSV import spec, "Interest from Plaid"): Plaid's docs don't confirm
 * the category (research plaid-savings §10), so a transaction is interest when its detailed category
 * starts with INCOME_INTEREST, or its name starts with INTEREST EARNED or INTEREST PAID, ignoring case.
 */
export function isPlaidInterest(t: Pick<CashTransactionFacts, 'name' | 'personal_finance_category'>): boolean {
  if (t.personal_finance_category?.detailed.toUpperCase().startsWith('INCOME_INTEREST')) return true;
  return /^INTEREST (EARNED|PAID)\b/i.test(t.name?.trim() ?? '');
}

/**
 * A cash account's transaction (decision 5): posted only, in the account's currency (`currency`,
 * null when Plaid didn't say it), zero skipped. `otherCurrency` is counted in the log.
 */
export function cashAccountFlow(t: CashTransactionFacts, currency: string | null): { flow: FlowValue | null; otherCurrency?: true; unreadable?: true; interest?: true } {
  if (t.pending) return { flow: null };
  if (t.unofficial_currency_code !== null || (currency !== null && t.iso_currency_code !== null && t.iso_currency_code !== currency)) {
    return { flow: null, otherCurrency: true };
  }
  // Interest lands in Other change, the same as an imported CSV's.
  if (isPlaidInterest(t)) return { flow: null, interest: true };
  return byAmount(t.amount);
}
