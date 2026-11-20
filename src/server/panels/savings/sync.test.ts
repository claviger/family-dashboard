import { eq } from 'drizzle-orm';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { connections, plaidItems, savingsBalances, savingsFlows } from '../../db/schema.js';
import { INVESTMENTS_PAGE_SIZE } from '../../integrations/plaid/client.js';
import { FAKE_PLAID_ERRORS, type FakePlaidPath } from '../../test/fakePlaid.js';
import { addUser, makeTestApp } from '../../test/helpers.js';
import { addCsvImport, BROKERAGE_ACCOUNT, CASH_ACCOUNT, linkSavingsForTest } from '../../test/savingsFixtures.js';
import { undoSavingsImport } from './imports.js';
import { upsertFlow } from './store.js';
import { investmentsWindow, SavingsSync } from './sync.js';

// Synthetic throughout. The test app's clock is 2026-11-15 12:00 UTC and the family time zone UTC.
function logLines() {
  const lines: Record<string, unknown>[] = [];
  const raw: string[] = [];
  const logger = pino({ level: 'debug' }, { write: (l: string) => { raw.push(l); lines.push(JSON.parse(l) as Record<string, unknown>); } });
  return { lines, raw, logger };
}

function setup() {
  const log = logLines();
  const t = makeTestApp({ plaid: true, logger: log.logger });
  const admin = addUser(t.db, t.clock, { email: 'alex@example.com', role: 'admin' });
  const linked = linkSavingsForTest(t, admin, { accounts: [{ ...CASH_ACCOUNT, current: 1000 }, { ...BROKERAGE_ACCOUNT, current: 5000 }] });
  const fakeItem = t.fakePlaid.item(linked.fakeItemId);
  const [cashFake, brokerageFake] = fakeItem.accounts;
  const [cash, brokerage] = linked.accounts;
  return { t, admin, log, linked, savings: t.savings!, fakeItem, cashFake: cashFake!, brokerageFake: brokerageFake!, cash: cash!, brokerage: brokerage! };
}
type Setup = ReturnType<typeof setup>;

const balances = (s: Setup) => s.t.db.select().from(savingsBalances).all().map((b) => [b.accountId, b.date, b.currentCents, b.availableCents]);
const flows = (s: Setup) =>
  s.t.db.select().from(savingsFlows).all().map((f) => [f.accountId, f.source, f.date, f.kind, f.amountCents]).sort((a, b) => String(a[2]).localeCompare(String(b[2])));
const item = (s: Setup) => s.t.db.select().from(plaidItems).where(eq(plaidItems.id, s.linked.item.id)).get()!;
const connection = (s: Setup) => s.t.db.select().from(connections).where(eq(connections.id, s.linked.item.connectionId!)).get()!;

describe('investmentsWindow', () => {
  it('reads the last 30 days, or from 7 days before where it read through when that\'s earlier, never past 729 days', () => {
    expect(investmentsWindow('2026-11-15', null)).toEqual({ start: '2026-10-16', end: '2026-11-15' });
    expect(investmentsWindow('2026-11-15', '2026-11-14')).toEqual({ start: '2026-10-16', end: '2026-11-15' });
    expect(investmentsWindow('2026-11-15', '2026-09-01')).toEqual({ start: '2026-08-25', end: '2026-11-15' });
    expect(investmentsWindow('2026-11-15', '2020-01-01')).toEqual({ start: '2024-11-16', end: '2026-11-15' });
  });
});

describe('SavingsSync', () => {
  it('lets a new Plaid flow replace the imported flow it matches, and an Undo then leaves Plaid\'s', async () => {
    const s = setup();
    const record = addCsvImport(s.t, s.cash.id, s.admin, { flows: [{ date: '2026-11-02', kind: 'deposit', cents: 250_00 }, { date: '2026-11-02', kind: 'withdrawal', cents: 40_10 }] });
    s.t.fakePlaid.addTransaction(s.fakeItem.itemId, { account_id: s.cashFake.account_id, date: '2026-11-04', amount: -250 });
    expect(await s.savings.syncItem(s.linked.item.id, { reason: 'scheduled' })).toMatchObject({ status: 'synced', counts: { flowsAdded: 1, csvReplaced: 1 } });
    expect(flows(s)).toEqual([[s.cash.id, 'csv', '2026-11-02', 'withdrawal', 40_10], [s.cash.id, 'transactions', '2026-11-04', 'deposit', 250_00]]);
    expect(await s.savings.syncItem(s.linked.item.id, { reason: 'scheduled' })).toMatchObject({ counts: { csvReplaced: 0 } });
    undoSavingsImport(s.t, s.admin, s.cash.id, record.id);
    expect(flows(s)).toEqual([[s.cash.id, 'transactions', '2026-11-04', 'deposit', 250_00]]);
  });

  it('lets the brokerage\'s new Plaid flow replace its imported twin too', async () => {
    const s = setup();
    addCsvImport(s.t, s.brokerage.id, s.admin, { flows: [{ date: '2026-11-05', kind: 'deposit', cents: 300_00 }] });
    s.t.fakePlaid.addInvestmentTransaction(s.fakeItem.itemId, { account_id: s.brokerageFake.account_id, date: '2026-11-05', amount: -300, type: 'cash', subtype: 'contribution' });
    expect(await s.savings.syncItem(s.linked.item.id, { reason: 'scheduled' })).toMatchObject({ counts: { csvReplaced: 1 } });
    expect(flows(s)).toEqual([[s.brokerage.id, 'investments', '2026-11-05', 'deposit', 300_00]]);
  });

  it('leaves interest on the cash account out of the flows, counts it, and never logs its name', async () => {
    const s = setup();
    s.t.fakePlaid.addTransaction(s.fakeItem.itemId, {
      account_id: s.cashFake.account_id, date: '2026-11-05', amount: -1.25, name: 'SYNTHETIC SAVER',
      personal_finance_category: { primary: 'INCOME', detailed: 'INCOME_INTEREST_EARNED', confidence_level: 'VERY_HIGH', version: 'v2' },
    });
    s.t.fakePlaid.addTransaction(s.fakeItem.itemId, { account_id: s.cashFake.account_id, date: '2026-11-06', amount: -0.5, name: 'INTEREST PAID SYNTHETIC' });
    s.t.fakePlaid.addTransaction(s.fakeItem.itemId, { account_id: s.cashFake.account_id, date: '2026-11-07', amount: -100, name: 'SYNTHETIC PAYROLL' });
    expect(await s.savings.syncItem(s.linked.item.id, { reason: 'scheduled' })).toMatchObject({ counts: { interest: 2, flowsAdded: 1 } });
    expect(flows(s)).toEqual([[s.cash.id, 'transactions', '2026-11-07', 'deposit', 100_00]]);
    expect(s.log.raw.join('\n')).not.toMatch(/SYNTHETIC/);
    expect(s.log.lines.find((l) => l.msg === 'savings sync')).toMatchObject({ interest: 2, csvReplaced: 0 });
  });

  it('removes the flow of a transaction Plaid modifies into interest (plan decision 25)', async () => {
    const s = setup();
    const tx = s.t.fakePlaid.addTransaction(s.fakeItem.itemId, { account_id: s.cashFake.account_id, date: '2026-11-05', amount: -1.25, name: 'SYNTHETIC CREDIT' });
    await s.savings.syncItem(s.linked.item.id, { reason: 'scheduled' });
    expect(flows(s)).toEqual([[s.cash.id, 'transactions', '2026-11-05', 'deposit', 1_25]]);
    s.t.fakePlaid.modifyTransaction(tx.transaction_id, { name: 'INTEREST EARNED SYNTHETIC' });
    expect(await s.savings.syncItem(s.linked.item.id, { reason: 'scheduled' })).toMatchObject({ counts: { interest: 1, flowsRemoved: 1 } });
    expect(flows(s)).toEqual([]);
  });

  it('stores today\'s balances, the cash account\'s posted flows, and the brokerage\'s cash movements', async () => {
    const s = setup();
    s.t.fakePlaid.setBalance(s.fakeItem.itemId, s.cashFake.account_id, { current: 1000, available: 950.5 });
    s.t.fakePlaid.addTransaction(s.fakeItem.itemId, { account_id: s.cashFake.account_id, date: '2026-11-03', amount: -250, name: 'SYNTHETIC PAYROLL' });
    s.t.fakePlaid.addTransaction(s.fakeItem.itemId, { account_id: s.cashFake.account_id, date: '2026-11-04', amount: 40.1 });
    s.t.fakePlaid.addTransaction(s.fakeItem.itemId, { account_id: s.cashFake.account_id, date: '2026-11-14', amount: 9, pending: true });
    s.t.fakePlaid.addInvestmentTransaction(s.fakeItem.itemId, { account_id: s.brokerageFake.account_id, date: '2026-11-05', amount: -300, type: 'cash', subtype: 'contribution' });
    s.t.fakePlaid.addInvestmentTransaction(s.fakeItem.itemId, { account_id: s.brokerageFake.account_id, date: '2026-11-06', amount: -12.5, type: 'cash', subtype: 'dividend' });
    s.t.fakePlaid.addInvestmentTransaction(s.fakeItem.itemId, { account_id: s.brokerageFake.account_id, date: '2026-11-07', amount: 1000, type: 'buy', subtype: 'buy', security_id: 'sec-1' });

    const out = await s.savings.syncItem(s.linked.item.id, { reason: 'scheduled' });

    expect(out).toMatchObject({ status: 'synced', counts: { snapshots: 2, flowsAdded: 3, investments: 'synced', byType: { 'cash:contribution': 1, 'cash:dividend': 1, 'buy:buy': 1 } } });
    expect(balances(s)).toEqual([[s.cash.id, '2026-11-15', 1000_00, 950_50], [s.brokerage.id, '2026-11-15', 5000_00, null]]);
    expect(flows(s)).toEqual([
      [s.cash.id, 'transactions', '2026-11-03', 'deposit', 250_00],
      [s.cash.id, 'transactions', '2026-11-04', 'withdrawal', 40_10],
      [s.brokerage.id, 'investments', '2026-11-05', 'deposit', 300_00],
    ]);
    expect(item(s)).toMatchObject({ investmentsStatus: 'available', investmentsErrorCode: null, investmentsThrough: '2026-11-15', lastSyncAt: s.t.clock.now() });
    expect(item(s).cursor).not.toBeNull();
    expect(connection(s)).toMatchObject({ status: 'ok', lastSuccessAt: s.t.clock.now() });
    expect(s.t.fakePlaid.lastBody('/investments/transactions/get')).toMatchObject({ start_date: '2026-10-16', end_date: '2026-11-15' });
    // No names, merchants, or tokens in the log; Plaid's type:subtype counts are fine.
    const text = s.log.raw.join('\n');
    for (const secret of ['SYNTHETIC', CASH_ACCOUNT.name, BROKERAGE_ACCOUNT.name, 'access-']) expect(text).not.toContain(secret);
    expect(s.log.lines.some((l) => l.msg === 'savings sync')).toBe(true);
  });

  it('is idempotent the same day: a later fetch replaces the snapshot, flows update in place, and removals delete them', async () => {
    const s = setup();
    const posted = s.t.fakePlaid.addTransaction(s.fakeItem.itemId, { account_id: s.cashFake.account_id, date: '2026-11-03', amount: -250 });
    const gone = s.t.fakePlaid.addTransaction(s.fakeItem.itemId, { account_id: s.cashFake.account_id, date: '2026-11-04', amount: 20 });
    const cancelled = s.t.fakePlaid.addInvestmentTransaction(s.fakeItem.itemId, { account_id: s.brokerageFake.account_id, date: '2026-11-05', amount: -300 });
    // Market activity, so Plaid's answer after the cancellation isn't an empty one (which deletes nothing).
    s.t.fakePlaid.addInvestmentTransaction(s.fakeItem.itemId, { account_id: s.brokerageFake.account_id, date: '2026-11-06', amount: 10, type: 'buy', subtype: 'buy', security_id: 'sec-1' });
    await s.savings.syncItem(s.linked.item.id, { reason: 'scheduled' });
    await s.savings.syncItem(s.linked.item.id, { reason: 'scheduled' });
    expect(s.t.db.select().from(savingsFlows).all()).toHaveLength(3);

    s.t.clock.advance(2 * 3600_000);
    s.t.fakePlaid.setBalance(s.fakeItem.itemId, s.cashFake.account_id, { current: 1100 });
    s.t.fakePlaid.modifyTransaction(posted.transaction_id, { amount: -275 });
    s.t.fakePlaid.removeTransaction(gone.transaction_id);
    s.t.fakePlaid.removeInvestmentTransaction(cancelled.investment_transaction_id);
    const out = await s.savings.syncItem(s.linked.item.id, { reason: 'refresh' });
    expect(out).toMatchObject({ status: 'synced', counts: { flowsUpdated: 1, flowsRemoved: 2 } });
    expect(balances(s)).toEqual([[s.cash.id, '2026-11-15', 1100_00, null], [s.brokerage.id, '2026-11-15', 5000_00, null]]);
    expect(flows(s)).toEqual([[s.cash.id, 'transactions', '2026-11-03', 'deposit', 275_00]]);
  });

  it('keeps the connection ok when Plaid has no Investments for it, says so, and picks it up once it\'s there', async () => {
    const s = setup();
    s.t.fakePlaid.setInvestmentsSupported(s.fakeItem.itemId, false);
    const out = await s.savings.syncItem(s.linked.item.id, { reason: 'scheduled' });
    expect(out).toMatchObject({ status: 'synced', counts: { snapshots: 2, investments: 'unavailable' } });
    expect(item(s)).toMatchObject({ investmentsStatus: 'unavailable', investmentsErrorCode: 'PRODUCTS_NOT_SUPPORTED', backoffUntil: null });
    expect(connection(s)).toMatchObject({ status: 'ok', consecutiveFailures: 0 });

    s.t.fakePlaid.setInvestmentsSupported(s.fakeItem.itemId, true);
    s.t.fakePlaid.addInvestmentTransaction(s.fakeItem.itemId, { account_id: s.brokerageFake.account_id, date: '2026-11-10', amount: -10 });
    await s.savings.syncItem(s.linked.item.id, { reason: 'scheduled' });
    expect(item(s)).toMatchObject({ investmentsStatus: 'available', investmentsErrorCode: null });
    expect(flows(s)).toEqual([[s.brokerage.id, 'investments', '2026-11-10', 'deposit', 10_00]]);
  });

  it('records a passing failure of the balances or cash flows on the connection with a backoff', async () => {
    const s = setup();
    for (let i = 0; i < 3; i++) s.t.fakePlaid.failNext('/transactions/sync', FAKE_PLAID_ERRORS.INTERNAL_SERVER_ERROR);
    await expect(s.savings.syncItem(s.linked.item.id, { reason: 'scheduled' })).rejects.toMatchObject({ name: 'PlaidApiError' });
    // The balances step finished before the failure, and stays.
    expect(balances(s)).toHaveLength(2);
    expect(connection(s)).toMatchObject({ status: 'ok', consecutiveFailures: 1 });
    expect(item(s).backoffUntil).not.toBeNull();
    expect(await s.savings.syncItem(s.linked.item.id, { reason: 'scheduled' })).toEqual({ status: 'skipped', reason: 'backoff' });
    expect(await s.savings.syncItem(s.linked.item.id, { reason: 'refresh', ignoreBackoff: true })).toMatchObject({ status: 'synced' });
  });

  it('skips a Spend Item, one waiting for the pick, one that needs reconnecting, and a removed one', async () => {
    const s = setup();
    s.t.db.update(plaidItems).set({ pickedAt: null }).where(eq(plaidItems.id, s.linked.item.id)).run();
    expect(await s.savings.syncItem(s.linked.item.id, { reason: 'scheduled' })).toEqual({ status: 'skipped', reason: 'not_picked' });
    s.t.db.update(plaidItems).set({ pickedAt: s.t.clock.now() }).where(eq(plaidItems.id, s.linked.item.id)).run();
    s.t.plaid!.markNeedsReconnect(s.linked.item.id, 'ITEM_LOGIN_REQUIRED');
    expect(await s.savings.syncItem(s.linked.item.id, { reason: 'refresh', ignoreBackoff: true })).toEqual({ status: 'skipped', reason: 'needs_reconnect' });
    s.t.db.update(plaidItems).set({ purpose: 'spend' }).where(eq(plaidItems.id, s.linked.item.id)).run();
    expect(await s.savings.syncItem(s.linked.item.id, { reason: 'scheduled' })).toEqual({ status: 'skipped', reason: 'removed' });
    expect(s.t.fakePlaid.count('/accounts/get')).toBe(0);
  });

  it('notes an account the connection\'s list doesn\'t have, for Load accounts', async () => {
    const s = setup();
    s.fakeItem.accounts.push({ ...s.cashFake, account_id: 'acct-new', name: 'Another Cash', mask: '9999' });
    await s.savings.syncItem(s.linked.item.id, { reason: 'scheduled' });
    expect(item(s).newAccountsAt).toEqual(s.t.clock.now());
  });

  it('catches up from the cursor, then reads the whole history again when an account was shown late', async () => {
    const s = setup();
    s.t.fakePlaid.addTransaction(s.fakeItem.itemId, { account_id: s.cashFake.account_id, date: '2026-11-03', amount: -1 });
    await s.savings.syncItem(s.linked.item.id, { reason: 'scheduled' });
    s.t.db.update(plaidItems).set({ fullResyncAt: s.t.clock.now() }).where(eq(plaidItems.id, s.linked.item.id)).run();
    const before = s.t.fakePlaid.count('/transactions/sync');
    await s.savings.syncItem(s.linked.item.id, { reason: 'pick', ignoreBackoff: true });
    const calls = s.t.fakePlaid.requests.filter((r) => r.path === '/transactions/sync').slice(before);
    expect(calls.map((c) => typeof c.body.cursor)).toEqual(['string', 'undefined']);
    expect(item(s).fullResyncAt).toBeNull();
    expect(s.t.db.select().from(savingsFlows).all()).toHaveLength(1);
  });

  it('runs at most one background sync per Item, folding requests together', async () => {
    const s = setup();
    s.savings.syncSoon(s.linked.item.id);
    s.savings.syncSoon(s.linked.item.id);
    await s.savings.idle();
    expect(s.t.fakePlaid.count('/accounts/get')).toBe(1);
  });

  it('runs every live Savings Item for the daily job, checking one that needs reconnecting first, and skips all under a key mismatch', async () => {
    const s = setup();
    s.t.plaid!.markNeedsReconnect(s.linked.item.id, 'ITEM_LOGIN_REQUIRED');
    const checked: number[] = [];
    expect(await s.savings.syncAll({ check: async (id) => { checked.push(id); s.t.plaid!.clearReconnect(id); } })).toEqual({ total: 1, done: 1, skipped: 0, failed: 0 });
    expect(checked).toEqual([s.linked.item.id]);

    const mismatch = makeTestApp({ plaid: true, keyMismatch: true });
    linkSavingsForTest(mismatch, addUser(mismatch.db, mismatch.clock, { email: 'alex@example.com', role: 'admin' }));
    expect(await mismatch.savings!.syncAll()).toEqual({ total: 1, done: 0, skipped: 1, failed: 0 });
    expect(mismatch.fakePlaid.count('/accounts/get')).toBe(0);
  });

  it('restarts the cash account\'s run from the stored cursor after a mutation', async () => {
    const s = setup();
    s.t.fakePlaid.addTransaction(s.fakeItem.itemId, { account_id: s.cashFake.account_id, date: '2026-11-03', amount: -5 });
    s.t.fakePlaid.failMutationOnce(s.fakeItem.itemId, 0);
    const out = await s.savings.syncItem(s.linked.item.id, { reason: 'scheduled' });
    expect(out).toMatchObject({ status: 'synced', counts: { restarts: 1, flowsAdded: 1 } });
    expect(flows(s)).toEqual([[s.cash.id, 'transactions', '2026-11-03', 'deposit', 5_00]]);
    expect(item(s).cursor).not.toBeNull();
  });

  it('defers a run that can\'t start inside the request\'s deadline, with nothing written', async () => {
    const s = setup();
    expect(await s.savings.syncItem(s.linked.item.id, { reason: 'refresh', ignoreBackoff: true, deadline: Date.now() - 1 })).toEqual({ status: 'deferred' });
    expect(balances(s)).toEqual([]);
  });
});

describe('SavingsSync: deleting cancelled brokerage flows', () => {
  /** A brokerage flow as an earlier sync stored it, which Plaid no longer lists. */
  function storedFlow(s: Setup, plaidId: string, date: string) {
    upsertFlow(s.t.db, { accountId: s.brokerage.id, source: 'investments', plaidId, date, kind: 'deposit', amountCents: 1_00 }, s.t.clock.now());
  }
  const ids = (s: Setup) => s.t.db.select().from(savingsFlows).all().map((f) => f.plaidId).sort();
  /** More than one page: market activity (no flows), so only the stored flows are in question. */
  function fillTwoPages(s: Setup) {
    for (let i = 0; i <= INVESTMENTS_PAGE_SIZE; i++) {
      s.t.fakePlaid.addInvestmentTransaction(s.fakeItem.itemId, { account_id: s.brokerageFake.account_id, date: '2026-11-10', amount: 1, type: 'buy', subtype: 'buy', security_id: 'sec-1' });
    }
  }
  const page2 = (path: FakePlaidPath, body: Record<string, unknown>) =>
    path === '/investments/transactions/get' && (body.options as { offset?: number } | undefined)?.offset === INVESTMENTS_PAGE_SIZE;
  const plaidJson = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('deletes one stored in the window, and never one dated before it', async () => {
    const s = setup();
    storedFlow(s, 'itx-cancelled', '2026-11-10');
    // Plaid still lists other activity in the window, so its answer isn't an empty one.
    s.t.fakePlaid.addInvestmentTransaction(s.fakeItem.itemId, { account_id: s.brokerageFake.account_id, date: '2026-11-10', amount: 1, type: 'buy', subtype: 'buy', security_id: 'sec-1' });
    storedFlow(s, 'itx-old', '2026-09-01');
    expect(await s.savings.syncItem(s.linked.item.id, { reason: 'scheduled' })).toMatchObject({ counts: { investments: 'synced', flowsRemoved: 1 } });
    expect(ids(s)).toEqual(['itx-old']);
  });

  it('deletes nothing, and logs it, when Plaid lists nothing at all in a window that has stored flows', async () => {
    const s = setup();
    storedFlow(s, 'itx-a', '2026-11-08');
    storedFlow(s, 'itx-b', '2026-11-10');
    expect(await s.savings.syncItem(s.linked.item.id, { reason: 'scheduled' })).toMatchObject({ counts: { investments: 'synced', flowsRemoved: 0 } });
    expect(ids(s)).toEqual(['itx-a', 'itx-b']);
    expect(s.log.lines.filter((l) => l.msg === 'savings investments read empty; nothing deleted').map((l) => [l.itemId, l.stored])).toEqual([[s.linked.item.id, 2]]);
  });

  it("deletes nothing when an entry couldn't be read", async () => {
    const s = setup();
    storedFlow(s, 'itx-cancelled', '2026-11-10');
    s.t.fakePlaid.addInvestmentTransaction(s.fakeItem.itemId, { account_id: s.brokerageFake.account_id, date: '2026-11-11', amount: 'x' as unknown as number });
    expect(await s.savings.syncItem(s.linked.item.id, { reason: 'scheduled' })).toMatchObject({ counts: { skippedEntries: 1, flowsRemoved: 0 } });
    expect(ids(s)).toEqual(['itx-cancelled']);
  });

  it('reads every page of the window before deleting anything', async () => {
    const s = setup();
    storedFlow(s, 'itx-cancelled', '2026-11-10');
    fillTwoPages(s);
    s.t.fakePlaid.intercept = (path, body) => (page2(path, body) ? plaidJson({ error_type: 'API_ERROR', error_code: 'INTERNAL_SERVER_ERROR' }, 500) : undefined);
    expect(await s.savings.syncItem(s.linked.item.id, { reason: 'scheduled' })).toMatchObject({ status: 'synced', counts: { investments: 'retry', flowsRemoved: 0 } });
    expect(ids(s)).toEqual(['itx-cancelled']);

    s.t.fakePlaid.intercept = null;
    expect(await s.savings.syncItem(s.linked.item.id, { reason: 'scheduled' })).toMatchObject({ counts: { investments: 'synced', flowsRemoved: 1 } });
    expect(ids(s)).toEqual([]);
    expect(s.t.fakePlaid.requests.filter((r) => page2(r.path, r.body)).length).toBeGreaterThanOrEqual(2);
  });

  it('deletes nothing, and keeps the window where it was, when a page comes back empty short of the total', async () => {
    const s = setup();
    storedFlow(s, 'itx-cancelled', '2026-11-10');
    fillTwoPages(s);
    s.t.fakePlaid.intercept = (path, body) => (page2(path, body) ? plaidJson({ investment_transactions: [], total_investment_transactions: INVESTMENTS_PAGE_SIZE + 1 }) : undefined);
    expect(await s.savings.syncItem(s.linked.item.id, { reason: 'scheduled' })).toMatchObject({ counts: { investments: 'incomplete', flowsRemoved: 0 } });
    expect(ids(s)).toEqual(['itx-cancelled']);
    expect(item(s)).toMatchObject({ investmentsStatus: 'available', investmentsThrough: null });
  });

  it('deletes nothing when the total changes between pages', async () => {
    const s = setup();
    storedFlow(s, 'itx-cancelled', '2026-11-10');
    fillTwoPages(s);
    s.t.fakePlaid.intercept = (path, body) => {
      if (page2(path, body)) {
        // A new entry lands in the window between the first page and the second.
        s.t.fakePlaid.intercept = null;
        s.t.fakePlaid.addInvestmentTransaction(s.fakeItem.itemId, { account_id: s.brokerageFake.account_id, date: '2026-11-12', amount: 1, type: 'buy', subtype: 'buy', security_id: 'sec-1' });
      }
      return undefined;
    };
    expect(await s.savings.syncItem(s.linked.item.id, { reason: 'scheduled' })).toMatchObject({ counts: { investments: 'incomplete', flowsRemoved: 0 } });
    expect(ids(s)).toEqual(['itx-cancelled']);
  });
});

describe('SavingsSync: a passing Investments failure', () => {
  it('keeps the balances and cash flows, leaves the connection alone, says so on the Item, and reads again next time', async () => {
    const s = setup();
    s.t.fakePlaid.addTransaction(s.fakeItem.itemId, { account_id: s.cashFake.account_id, date: '2026-11-03', amount: -5 });
    s.t.fakePlaid.addInvestmentTransaction(s.fakeItem.itemId, { account_id: s.brokerageFake.account_id, date: '2026-11-10', amount: -10 });
    for (let i = 0; i < 3; i++) s.t.fakePlaid.failNext('/investments/transactions/get', FAKE_PLAID_ERRORS.PRODUCT_NOT_READY);
    expect(await s.savings.syncItem(s.linked.item.id, { reason: 'pick', ignoreBackoff: true })).toMatchObject({ status: 'synced', counts: { snapshots: 2, investments: 'retry' } });
    expect(balances(s)).toHaveLength(2);
    expect(flows(s)).toEqual([[s.cash.id, 'transactions', '2026-11-03', 'deposit', 5_00]]);
    expect(connection(s)).toMatchObject({ status: 'ok', consecutiveFailures: 0, lastError: null });
    expect(item(s)).toMatchObject({ backoffUntil: null, investmentsStatus: null, investmentsErrorCode: 'PRODUCT_NOT_READY', investmentsThrough: null });

    expect(await s.savings.syncItem(s.linked.item.id, { reason: 'scheduled' })).toMatchObject({ counts: { investments: 'synced' } });
    expect(item(s)).toMatchObject({ investmentsStatus: 'available', investmentsErrorCode: null, investmentsThrough: '2026-11-15' });
    expect(flows(s)).toHaveLength(2);
  });

  it("keeps an unavailable Item's code through a passing failure", async () => {
    const s = setup();
    s.t.fakePlaid.setInvestmentsSupported(s.fakeItem.itemId, false);
    await s.savings.syncItem(s.linked.item.id, { reason: 'scheduled' });
    s.t.fakePlaid.dropNext('/investments/transactions/get');
    s.t.fakePlaid.dropNext('/investments/transactions/get');
    s.t.fakePlaid.dropNext('/investments/transactions/get');
    expect(await s.savings.syncItem(s.linked.item.id, { reason: 'scheduled' })).toMatchObject({ counts: { investments: 'retry' } });
    expect(item(s)).toMatchObject({ investmentsStatus: 'unavailable', investmentsErrorCode: 'PRODUCTS_NOT_SUPPORTED' });
    expect(connection(s)).toMatchObject({ status: 'ok', consecutiveFailures: 0 });
  });

  it('still fails the run for an Investments error that is the connection\'s, not a passing one', async () => {
    const s = setup();
    s.t.fakePlaid.failNext('/investments/transactions/get', FAKE_PLAID_ERRORS.ITEM_LOGIN_REQUIRED);
    await expect(s.savings.syncItem(s.linked.item.id, { reason: 'scheduled' })).rejects.toMatchObject({ errorCode: 'ITEM_LOGIN_REQUIRED' });
    expect(connection(s).status).toBe('needs_reconnect');
  });
});
