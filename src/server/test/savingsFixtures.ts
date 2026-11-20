import { singleKeyring } from '../core/crypto.js';
import type { SavingsFlowKind } from '../../shared/savings.js';
import {
  plaidItems, savingsAccounts, savingsBalances, savingsFlows, savingsImports, type PlaidItemAccount, type PlaidItemRow, type SavingsAccountRow, type SavingsImportRow,
} from '../db/schema.js';
import { insertFamilyConnection } from '../integrations/connections.js';
import { addUser, cookieFor, type TestApp } from './helpers.js';

/**
 * Savings test fixtures. Everything is synthetic: institutions, accounts, masks, and tokens.
 */

/** A user with the Savings panel (and only it), signed in. */
export function savingsUser(t: TestApp, opts: { role?: 'admin' | 'member'; email?: string; name?: string } = {}): { id: number; cookie: string } {
  const role = opts.role ?? 'admin';
  const email = opts.email ?? `${role}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const id = addUser(t.db, t.clock, { email, displayName: opts.name ?? email.split('@')[0]!, role, panels: ['savings'] });
  return { id, cookie: cookieFor(t.db, t.clock, id) };
}

/** A Savings Item row with no connection: enough for the store and the read model. */
export function addSavingsItem(t: TestApp, values: Partial<typeof plaidItems.$inferInsert> = {}): PlaidItemRow {
  const now = t.clock.now();
  return t.db.insert(plaidItems).values({ plaidItemId: 'item-savings', purpose: 'savings', institutionName: 'Example Brokerage', createdAt: now, updatedAt: now, ...values }).returning().get();
}

/** A shown account on an Item. */
export function addSavingsAccount(
  t: TestApp,
  plaidItemId: number,
  values: Partial<typeof savingsAccounts.$inferInsert> & Pick<typeof savingsAccounts.$inferInsert, 'plaidAccountId' | 'kind'>,
): SavingsAccountRow {
  const now = t.clock.now();
  return t.db.insert(savingsAccounts).values({ plaidItemId, nickname: values.kind === 'cash' ? 'Cash' : 'Brokerage', isoCurrencyCode: 'USD', createdAt: now, updatedAt: now, ...values }).returning().get();
}

/** The two accounts the Savings tests link: a cash management account and a brokerage account. */
export const CASH_ACCOUNT = { name: 'Example Cash Management', mask: '4321', type: 'depository', subtype: 'cash management' } as const;
export const BROKERAGE_ACCOUNT = { name: 'Example Individual Brokerage', mask: '8765', type: 'investment', subtype: 'brokerage' } as const;

/**
 * A Savings connection as if an admin had linked it and picked every account to show: a fake Plaid
 * Item with the two accounts (or `accounts`), the family connection with its token, the
 * `plaid_items` row (`purpose: 'savings'`, accounts loaded, picked), and a `savings_accounts` row
 * per account. Needs a test app with Plaid (`makeTestApp({ plaid: true })`).
 */
export function linkSavingsForTest(
  t: TestApp,
  ownerUserId: number,
  opts: { accounts?: readonly { name: string; mask: string; type: string; subtype: string; current?: number }[]; institutionName?: string } = {},
): { item: PlaidItemRow; fakeItemId: string; accounts: SavingsAccountRow[] } {
  const accounts = opts.accounts ?? [CASH_ACCOUNT, BROKERAGE_ACCOUNT];
  const fake = t.fakePlaid.createItem({ institution: { institution_id: 'ins_fake_savings', name: opts.institutionName ?? 'Example Brokerage' }, accounts: accounts.map((a) => ({ ...a })) });
  const now = t.clock.now();
  const list: PlaidItemAccount[] = fake.accounts.map((a) => ({
    accountId: a.account_id, name: a.name, officialName: a.official_name, mask: a.mask, type: a.type, subtype: a.subtype,
    isoCurrencyCode: a.iso_currency_code, unofficialCurrencyCode: a.unofficial_currency_code,
  }));
  const item = t.db.transaction((tx) => {
    const conn = insertFamilyConnection(tx, singleKeyring(t.config.tokenEncryptionKey), { kind: 'plaid', ownerUserId, meta: { itemId: fake.itemId, institutionName: opts.institutionName ?? 'Example Brokerage' }, now }, { accessToken: fake.accessToken });
    return tx.insert(plaidItems).values({
      connectionId: conn.id, plaidItemId: fake.itemId, institutionId: 'ins_fake_savings', institutionName: opts.institutionName ?? 'Example Brokerage', purpose: 'savings',
      accounts: list, pickedAt: now, createdAt: now, updatedAt: now,
    }).returning().get();
  });
  const rows = list.map((a) => addSavingsAccount(t, item.id, {
    plaidAccountId: a.accountId, kind: a.type === 'investment' ? 'investment' : 'cash', nickname: a.name, mask: a.mask, isoCurrencyCode: a.isoCurrencyCode,
  }));
  return { item, fakeItemId: fake.itemId, accounts: rows };
}

/** An account added by hand: no Plaid Item or account id. */
export function addHandAccount(t: TestApp, values: Partial<typeof savingsAccounts.$inferInsert> & Pick<typeof savingsAccounts.$inferInsert, 'kind'>): SavingsAccountRow {
  const now = t.clock.now();
  return t.db.insert(savingsAccounts).values({ source: 'manual', nickname: values.kind === 'cash' ? 'Hand cash' : 'Hand brokerage', createdAt: now, updatedAt: now, ...values }).returning().get();
}

/** A saved import with its rows, as commitSavingsImport stores them (no file, synthetic keys). */
export function addCsvImport(
  t: TestApp,
  accountId: number,
  userId: number,
  rows: { flows?: { date: string; kind: SavingsFlowKind; cents: number }[]; balances?: { date: string; cents: number }[]; firstDate?: string | null; lastDate?: string | null } = {},
): SavingsImportRow {
  const now = t.clock.now();
  const flows = rows.flows ?? [];
  const balances = rows.balances ?? [];
  const record = t.db.insert(savingsImports).values({
    accountId, fileName: 'statement.csv', fileSha256: '0'.repeat(64), layout: 'custom', uploadedByUserId: userId, uploadedAt: now,
    depositsAdded: flows.filter((f) => f.kind === 'deposit').length, withdrawalsAdded: flows.filter((f) => f.kind === 'withdrawal').length, balancesAdded: balances.length, skipped: 0,
    firstDate: rows.firstDate ?? null, lastDate: rows.lastDate ?? null,
  }).returning().get();
  flows.forEach((f, i) => {
    t.db.insert(savingsFlows).values({ accountId, source: 'csv', plaidId: `csv-${record.id}-${i}`, date: f.date, kind: f.kind, amountCents: f.cents, importId: record.id, createdAt: now, updatedAt: now }).run();
  });
  for (const b of balances) {
    t.db.insert(savingsBalances).values({ accountId, date: b.date, currentCents: b.cents, availableCents: null, fetchedAt: now, source: 'csv', importId: record.id }).run();
  }
  return record;
}
