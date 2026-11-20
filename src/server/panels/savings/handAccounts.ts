import { eq } from 'drizzle-orm';
import { isAmountInput, parseCentsInputUpTo } from '../../../shared/money.js';
import { SAVINGS_MAX_BALANCE_CENTS, SAVINGS_MESSAGES, type SavingsHandAccountInput, type SavingsSetBalanceInput } from '../../../shared/savings.js';
import { localDate } from '../../core/clock.js';
import { AppError } from '../../core/errors.js';
import { savingsAccounts, type SavingsAccountRow } from '../../db/schema.js';
import { getFamilySettings } from '../../settings.js';
import type { SavingsImportDeps } from './imports.js';
import { putManualBalance } from './store.js';

/**
 * Hand-added accounts and Set balance (the CSV import spec, "Accounts"; plan decisions 21 and 26).
 * Admins only (the routes check), local writes, no Plaid. Logs carry ids and the kind.
 */

const EARLIEST_BALANCE_DATE = '2000-01-01';

function liveAccount(deps: SavingsImportDeps, accountId: number): SavingsAccountRow {
  const row = deps.db.select().from(savingsAccounts).where(eq(savingsAccounts.id, accountId)).get();
  if (!row || row.removedAt !== null) throw new AppError('not_found', SAVINGS_MESSAGES.accountNotFound);
  return row;
}

export function addHandAccount(deps: SavingsImportDeps, userId: number, input: SavingsHandAccountInput): SavingsAccountRow {
  const now = deps.clock.now();
  const row = deps.db.insert(savingsAccounts)
    .values({ source: 'manual', nickname: input.nickname, kind: input.kind, isoCurrencyCode: 'USD', createdAt: now, updatedAt: now })
    .returning().get();
  deps.logger.info({ userId, accountId: row.id, kind: row.kind }, 'savings account added by hand');
  return row;
}

/** Set balance: any account that isn't removed, for today or a day since 2000, unless Plaid has that day. */
export function setSavingsBalance(deps: SavingsImportDeps, userId: number, accountId: number, input: SavingsSetBalanceInput): void {
  const account = liveAccount(deps, accountId);
  if (!isAmountInput(input.amount)) throw new AppError('validation', SAVINGS_MESSAGES.balanceAmount);
  // Negative is fine: an overdrawn account.
  const cents = parseCentsInputUpTo(input.amount, SAVINGS_MAX_BALANCE_CENTS);
  if (cents === null) throw new AppError('validation', SAVINGS_MESSAGES.balanceTooBig);
  const today = localDate(deps.clock.now(), getFamilySettings(deps.db).timeZone);
  const date = input.date ?? today;
  if (date > today) throw new AppError('validation', SAVINGS_MESSAGES.balanceFuture);
  if (date < EARLIEST_BALANCE_DATE) throw new AppError('validation', SAVINGS_MESSAGES.balanceTooOld);
  if (putManualBalance(deps.db, account.id, date, cents, deps.clock.now()) === 'plaid') throw new AppError('conflict', SAVINGS_MESSAGES.balanceFromPlaid);
  deps.logger.info({ userId, accountId: account.id }, 'savings balance set by hand');
}

/** Remove a hand-added account: marked removed (kept for past months), or deleted with its balances, flows, imports, settings, and draft. */
export function removeHandAccount(deps: SavingsImportDeps, userId: number, accountId: number, opts: { deleteData: boolean }): void {
  const account = liveAccount(deps, accountId);
  if (account.source !== 'manual') throw new AppError('validation', SAVINGS_MESSAGES.linkedRemove);
  const now = deps.clock.now();
  if (opts.deleteData) deps.db.delete(savingsAccounts).where(eq(savingsAccounts.id, account.id)).run();
  else deps.db.update(savingsAccounts).set({ removedAt: now, updatedAt: now }).where(eq(savingsAccounts.id, account.id)).run();
  deps.logger.info({ userId, accountId: account.id, deleteData: opts.deleteData }, 'savings hand-added account removed');
}
