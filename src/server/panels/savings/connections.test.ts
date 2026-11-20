import { eq } from 'drizzle-orm';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { PLAID_MESSAGES } from '../../../shared/plaid.js';
import { SAVINGS_MESSAGES, SavingsSettingsViewSchema } from '../../../shared/savings.js';
import { plaidItems, savingsAccounts, savingsBalances } from '../../db/schema.js';
import { FAKE_PLAID_ERRORS, type FakeAccountInput } from '../../test/fakePlaid.js';
import { addUser, makeTestApp, type TestApp } from '../../test/helpers.js';
import { BROKERAGE_ACCOUNT, CASH_ACCOUNT, linkSavingsForTest } from '../../test/savingsFixtures.js';
import { INVESTMENTS_NO_ANSWER } from './sync.js';
import {
  loadSavingsAccounts, pickSavingsAccounts, refreshSavingsConnection, removeSavingsConnection, savingsSettingsView, updateSavingsAccount,
  type SavingsSettingsDeps,
} from './connections.js';

// Synthetic. The clock is 2026-11-15 12:00 UTC.
function setup(opts: { budgetMs?: number; logger?: pino.Logger } = {}) {
  const t = makeTestApp({ plaid: true, plaidRequestBudgetMs: opts.budgetMs, logger: opts.logger });
  const admin = addUser(t.db, t.clock, { email: 'alex@example.com', role: 'admin' });
  const deps: SavingsSettingsDeps = { ...t, plaid: t.plaid!, bank: t.bank!, savings: t.savings! };
  return { t, admin, deps };
}
type Setup = ReturnType<typeof setup>;

/** Connects Fidelity-like accounts through Plaid's link calls and the fake's Link, as the Link page does: an Item waiting for the pick. */
async function connect(s: Setup, accounts: FakeAccountInput[] = [{ ...CASH_ACCOUNT, current: 1000 }, { ...BROKERAGE_ACCOUNT, current: 5000 }]) {
  const { linkToken } = await s.t.plaid!.createLinkToken(s.admin, 'session-a', { purpose: 'savings' });
  const { publicToken, metadata } = s.t.fakePlaid.completeLink(linkToken, { institution: { institution_id: 'ins_fake_savings', name: 'Example Brokerage' }, accounts });
  const { itemId } = await s.t.plaid!.exchange(s.admin, 'session-a', publicToken, metadata);
  const ids = s.t.plaid!.item(itemId)!.accounts!.map((a) => a.accountId);
  return { itemId, ids, fakeItemId: s.t.plaid!.item(itemId)!.plaidItemId };
}

const view = (s: Setup) => SavingsSettingsViewSchema.parse(savingsSettingsView(s.deps));
const shownRows = (t: TestApp) => t.db.select().from(savingsAccounts).all().map((a) => [a.nickname, a.kind, a.hiddenAt === null, a.removedAt === null]);

describe('Savings settings', () => {
  it('lists a new connection waiting for the pick, with each account\'s type and whether it can be shown, and not Spend\'s banks', async () => {
    const s = setup();
    const { itemId, ids } = await connect(s, [{ ...CASH_ACCOUNT }, { ...BROKERAGE_ACCOUNT }, { name: 'Odd Card', mask: '0000', type: 'credit', subtype: 'credit card' }]);
    const v = view(s);
    expect(v.trial).toEqual({ used: 1, limit: 10 });
    expect(v).toMatchObject({ plaidConfigured: true, handAccounts: [], imports: [], profiles: [] });
    expect(v.connections).toHaveLength(1);
    expect(v.connections[0]).toMatchObject({
      id: itemId, institutionName: 'Example Brokerage', status: 'ok', needsPick: true, picked: false, accountsLoaded: true,
      investments: { status: 'unknown', code: null },
    });
    expect(v.connections[0]!.accounts.map((a) => [a.accountId, a.type, a.subtype, a.state, a.showable])).toEqual([
      [ids[0], 'depository', 'cash management', 'waiting', true],
      [ids[1], 'investment', 'brokerage', 'waiting', true],
      [ids[2], 'credit', 'credit card', 'waiting', false],
    ]);
  });

  it('shows the picked accounts under their nicknames, skips the rest, and runs the first sync in the request', async () => {
    const s = setup();
    const { itemId, ids } = await connect(s);
    const v = await pickSavingsAccounts(s.deps, s.admin, itemId, [
      { accountId: ids[0]!, action: 'show', nickname: 'Cash' }, { accountId: ids[1]!, action: 'show', nickname: 'Brokerage' },
    ]);
    expect(v.message).toBeNull();
    expect(v.connections[0]).toMatchObject({ needsPick: false, picked: true, investments: { status: 'available' } });
    expect(v.connections[0]!.accounts.map((a) => [a.state, a.nickname])).toEqual([['shown', 'Cash'], ['shown', 'Brokerage']]);
    expect(shownRows(s.t)).toEqual([['Cash', 'cash', true, true], ['Brokerage', 'investment', true, true]]);
    expect(s.t.db.select().from(savingsBalances).all().map((b) => b.currentCents)).toEqual([1000_00, 5000_00]);
  });

  it('refuses a pick that leaves an account undecided, names one not on the connection, or shows an account Savings can\'t show, and saves nothing', async () => {
    const s = setup();
    const { itemId, ids } = await connect(s, [{ ...CASH_ACCOUNT }, { name: 'Odd Card', mask: '0000', type: 'credit', subtype: 'credit card' }]);
    await expect(pickSavingsAccounts(s.deps, s.admin, itemId, [{ accountId: ids[0]!, action: 'show', nickname: 'Cash' }])).rejects.toThrow(SAVINGS_MESSAGES.decideEvery);
    await expect(pickSavingsAccounts(s.deps, s.admin, itemId, [{ accountId: 'acct-nope', action: 'skip' }])).rejects.toThrow(SAVINGS_MESSAGES.accountNotListed);
    await expect(pickSavingsAccounts(s.deps, s.admin, itemId, [
      { accountId: ids[0]!, action: 'show', nickname: 'Cash' }, { accountId: ids[1]!, action: 'show', nickname: 'Card' },
    ])).rejects.toThrow(SAVINGS_MESSAGES.notShowable);
    expect(shownRows(s.t)).toEqual([]);
    expect(s.t.plaid!.item(itemId)!.pickedAt).toBeNull();
  });

  it('refuses the pick for a Spend bank, and before the accounts are loaded', async () => {
    const s = setup();
    const { itemId } = await connect(s);
    s.t.db.update(plaidItems).set({ purpose: 'spend' }).where(eq(plaidItems.id, itemId)).run();
    await expect(pickSavingsAccounts(s.deps, s.admin, itemId, [])).rejects.toThrow(PLAID_MESSAGES.notFound);
    s.t.db.update(plaidItems).set({ purpose: 'savings', accounts: null }).where(eq(plaidItems.id, itemId)).run();
    await expect(pickSavingsAccounts(s.deps, s.admin, itemId, [])).rejects.toThrow(SAVINGS_MESSAGES.loadAccountsFirst);
  });

  it('shows a skipped account later, reading the cash history again from the start', async () => {
    const s = setup();
    const { itemId, ids } = await connect(s);
    await pickSavingsAccounts(s.deps, s.admin, itemId, [{ accountId: ids[0]!, action: 'skip' }, { accountId: ids[1]!, action: 'show', nickname: 'Brokerage' }]);
    expect(view(s).connections[0]!.accounts.map((a) => a.state)).toEqual(['skipped', 'shown']);
    const syncsBefore = s.t.fakePlaid.count('/transactions/sync');
    await pickSavingsAccounts(s.deps, s.admin, itemId, [{ accountId: ids[0]!, action: 'show', nickname: 'Cash' }]);
    const calls = s.t.fakePlaid.requests.filter((r) => r.path === '/transactions/sync').slice(syncsBefore);
    expect(calls.map((c) => typeof c.body.cursor)).toEqual(['string', 'undefined']);
    expect(s.t.plaid!.item(itemId)!.fullResyncAt).toBeNull();
    expect(view(s).connections[0]!.accounts.map((a) => a.state)).toEqual(['shown', 'shown']);
  });

  it('says why the brokerage has no deposits and withdrawals: Investments refused, with the fix, or a passing failure', () => {
    const s = setup();
    const linked = linkSavingsForTest(s.t, s.admin);
    const investments = () => view(s).connections[0]!.investments;
    const set = (values: Partial<typeof plaidItems.$inferInsert>) => s.t.db.update(plaidItems).set(values).where(eq(plaidItems.id, linked.item.id)).run();
    expect(investments()).toEqual({ status: 'unknown', code: null, message: null });
    set({ investmentsStatus: 'unavailable', investmentsErrorCode: 'INVALID_PRODUCT' });
    expect(investments()).toEqual({ status: 'unavailable', code: 'INVALID_PRODUCT', message: SAVINGS_MESSAGES.investmentsNotEnabled });
    set({ investmentsErrorCode: 'ADDITIONAL_CONSENT_REQUIRED' });
    expect(investments().message).toBe(SAVINGS_MESSAGES.investmentsNotShared);
    // A passing failure: the status stays what it was, and the code says it failed this time.
    set({ investmentsStatus: 'available', investmentsErrorCode: 'PRODUCT_NOT_READY' });
    expect(investments()).toEqual({ status: 'available', code: 'PRODUCT_NOT_READY', message: SAVINGS_MESSAGES.investmentsRetry });
    set({ investmentsStatus: null, investmentsErrorCode: INVESTMENTS_NO_ANSWER });
    expect(investments()).toEqual({ status: 'unknown', code: INVESTMENTS_NO_ANSWER, message: SAVINGS_MESSAGES.investmentsRetry });
    set({ investmentsStatus: 'available', investmentsErrorCode: null });
    expect(investments().message).toBeNull();
  });

  it('refuses the pick under the lock while a sync holds it', async () => {
    const s = setup({ budgetMs: 1500 });
    const { itemId, ids } = await connect(s);
    let release!: () => void;
    const held = s.t.plaid!.underLock(itemId, () => new Promise<void>((r) => { release = r; }));
    await expect(pickSavingsAccounts(s.deps, s.admin, itemId, [{ accountId: ids[0]!, action: 'skip' }, { accountId: ids[1]!, action: 'skip' }])).rejects.toThrow();
    release();
    await held;
    expect(s.t.plaid!.item(itemId)!.pickedAt).toBeNull();
  });

  it('renames and hides an account, and shows it again', async () => {
    const s = setup();
    const linked = linkSavingsForTest(s.t, s.admin);
    const id = linked.accounts[0]!.id;
    expect(updateSavingsAccount(s.deps, id, { nickname: 'Everyday cash' }).connections[0]!.accounts[0]).toMatchObject({ nickname: 'Everyday cash', state: 'shown' });
    expect(updateSavingsAccount(s.deps, id, { hidden: true }).connections[0]!.accounts[0]!.state).toBe('hidden');
    expect(updateSavingsAccount(s.deps, id, { hidden: false }).connections[0]!.accounts[0]!.state).toBe('shown');
    expect(() => updateSavingsAccount(s.deps, 999, { hidden: true })).toThrow(SAVINGS_MESSAGES.accountNotFound);
  });

  it('refreshes a connection, says Reconnect when it needs it, and defers past the budget', async () => {
    const s = setup();
    const linked = linkSavingsForTest(s.t, s.admin);
    expect((await refreshSavingsConnection(s.deps, s.admin, linked.item.id)).message).toBeNull();
    expect(s.t.db.select().from(savingsBalances).all()).toHaveLength(2);
    s.t.plaid!.markNeedsReconnect(linked.item.id, 'ITEM_LOGIN_REQUIRED');
    await expect(refreshSavingsConnection(s.deps, s.admin, linked.item.id)).rejects.toThrow(SAVINGS_MESSAGES.reconnect);
  });

  it('sends a Savings connection that needs signing in again to Savings settings, never Spend settings', async () => {
    const s = setup();
    const linked = linkSavingsForTest(s.t, s.admin);
    s.t.fakePlaid.failNext('/item/get', FAKE_PLAID_ERRORS.ITEM_LOGIN_REQUIRED);
    await expect(loadSavingsAccounts(s.deps, s.admin, linked.item.id)).rejects.toThrow(SAVINGS_MESSAGES.reconnect);
    // Now marked: refused before asking Plaid, with the same words.
    await expect(loadSavingsAccounts(s.deps, s.admin, linked.item.id)).rejects.toThrow(SAVINGS_MESSAGES.reconnect);
    expect(SAVINGS_MESSAGES.reconnect).toContain('Savings settings');
    expect(SAVINGS_MESSAGES.reconnect).not.toContain('Spend');
  });

  it("records a login that shares no accounts in words that fit a Savings connection", async () => {
    const s = setup();
    const linked = linkSavingsForTest(s.t, s.admin);
    s.t.fakePlaid.failNext('/accounts/get', { status: 400, error_type: 'ITEM_ERROR', error_code: 'NO_ACCOUNTS' });
    await expect(refreshSavingsConnection(s.deps, s.admin, linked.item.id)).rejects.toThrow(SAVINGS_MESSAGES.reconnect);
    const conn = view(s).connections[0]!;
    expect(conn.status).toBe('needs_reconnect');
    expect(conn.lastError).toBe("The bank isn't sharing any accounts. Reconnect and pick them.");
  });

  it('logs when the sync after the pick is skipped, and still saves the pick', async () => {
    const lines: Record<string, unknown>[] = [];
    const s = setup({ logger: pino({ level: 'info' }, { write: (line: string) => void lines.push(JSON.parse(line) as Record<string, unknown>) }) });
    const { itemId, ids } = await connect(s);
    s.t.plaid!.markNeedsReconnect(itemId, 'ITEM_LOGIN_REQUIRED');
    const v = await pickSavingsAccounts(s.deps, s.admin, itemId, [{ accountId: ids[0]!, action: 'show', nickname: 'Cash' }, { accountId: ids[1]!, action: 'skip' }]);
    expect(v.connections[0]!.picked).toBe(true);
    expect(lines.filter((l) => l.msg === 'savings first sync after the pick skipped').map((l) => [l.itemId, l.reason])).toEqual([[itemId, 'needs_reconnect']]);
  });

  it('says the pick saved and syncs in the background when the first sync runs out of time', async () => {
    const s = setup({ budgetMs: 1500 });
    const { itemId, ids } = await connect(s);
    s.t.fakePlaid.delayNext('/accounts/get', 3000);
    const v = await pickSavingsAccounts(s.deps, s.admin, itemId, [{ accountId: ids[0]!, action: 'show', nickname: 'Cash' }, { accountId: ids[1]!, action: 'skip' }]);
    expect(v.message).toBe(SAVINGS_MESSAGES.pickDeferred);
    expect(v.connections[0]!.picked).toBe(true);
    await s.t.savings!.idle();
    expect(s.t.db.select().from(savingsBalances).all()).toHaveLength(1);
  });

  it('loads the accounts again, a new one waiting for the pick', async () => {
    const s = setup();
    const linked = linkSavingsForTest(s.t, s.admin);
    const fake = s.t.fakePlaid.item(linked.fakeItemId);
    fake.accounts.push({ ...fake.accounts[0]!, account_id: 'acct-new', name: 'New Cash', mask: '1212' });
    const v = await loadSavingsAccounts(s.deps, s.admin, linked.item.id);
    expect(v.connections[0]!.accounts.map((a) => a.state)).toEqual(['shown', 'shown', 'waiting']);
    expect(v.connections[0]!.needsPick).toBe(true);
  });

  it('removes a connection keeping its data, or with it, and says when Plaid didn\'t confirm', async () => {
    const s = setup();
    const kept = linkSavingsForTest(s.t, s.admin, { institutionName: 'Kept Brokerage' });
    s.t.fakePlaid.failNext('/item/remove', FAKE_PLAID_ERRORS.INTERNAL_SERVER_ERROR);
    const v = await removeSavingsConnection(s.deps, s.admin, kept.item.id, { deleteData: false });
    expect(v.message).toBe("Plaid didn't confirm it removed its access yet. The dashboard will keep trying every hour.");
    expect(v.connections).toEqual([]);
    expect(v.removed).toEqual([expect.objectContaining({ institutionName: 'Kept Brokerage', reason: 'removed', revocation: 'waiting', accounts: kept.accounts.map((a) => ({ id: a.id, nickname: a.nickname })) })]);

    const gone = linkSavingsForTest(s.t, s.admin, { institutionName: 'Gone Brokerage', accounts: [{ name: 'Gone Cash', mask: '3434', type: 'depository', subtype: 'checking' }] });
    const after = await removeSavingsConnection(s.deps, s.admin, gone.item.id, { deleteData: true });
    expect(after.removed.find((r) => r.id === gone.item.id)).toMatchObject({ reason: 'removed_with_transactions', revocation: 'confirmed', accounts: [] });
  });

  it('shows only removals Plaid never confirmed for Savings connections, and Spend shows only its own', async () => {
    const s = setup();
    const linked = linkSavingsForTest(s.t, s.admin);
    // One for the removal itself, then one for each of the 12 hourly retries.
    for (let i = 0; i < 13; i++) s.t.fakePlaid.failNext('/item/remove', FAKE_PLAID_ERRORS.INTERNAL_SERVER_ERROR);
    await removeSavingsConnection(s.deps, s.admin, linked.item.id, { deleteData: false });
    for (let i = 0; i < 12; i++) await s.t.plaid!.retryRevocations();
    expect(view(s).notices).toHaveLength(1);
    expect(s.t.plaid!.revocationNotices('spend')).toEqual([]);
  });
});
