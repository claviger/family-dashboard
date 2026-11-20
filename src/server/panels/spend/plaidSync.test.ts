import { asc, eq } from 'drizzle-orm';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { PlaidConfig } from '../../config.js';
import { singleKeyring } from '../../core/crypto.js';
import { runJob } from '../../core/jobs.js';
import { cards, connections, jobErrors, pendingRevocations, plaidItems, plaidLinkPending, statements, transactions } from '../../db/schema.js';
import { insertFamilyConnection } from '../../integrations/connections.js';
import { PlaidApiError } from '../../integrations/plaid/client.js';
import { Plaid, REVOCATION_ATTEMPTS } from '../../integrations/plaid/plaid.js';
import { FAKE_PLAID_CLIENT_ID, FAKE_PLAID_ERRORS, FAKE_PLAID_SECRET, FakePlaid, type FakeAccountInput } from '../../test/fakePlaid.js';
import { addUser, makeTestApp, TEST_BASE_URL, TEST_ENCRYPTION_KEY } from '../../test/helpers.js';
import { addCard } from '../../test/spendFixtures.js';
import { plaidJobs } from './index.js';
import { REMOVED_KEEP_MS } from './plaidApply.js';
import { BankSync, DISCONNECT_NOTICE_MS, MAX_MUTATION_RESTARTS } from './plaidSync.js';

// Everything here is synthetic: the keys, institutions, accounts, tokens, and transactions.
// The test app's clock is 2026-11-15 12:00 UTC.
const ORIGIN = 'https://plaid.test';
const config: PlaidConfig = {
  clientId: FAKE_PLAID_CLIENT_ID, secret: FAKE_PLAID_SECRET, env: 'sandbox', apiBaseUrl: ORIGIN,
  linkScriptUrl: 'https://cdn.plaid.com/link/v2/stable/link-initialize.js',
};
const CARD_A: FakeAccountInput = { name: 'Example Rewards', mask: '1111' };
const CARD_B: FakeAccountInput = { name: 'Example Cash Back', mask: '2222' };
const SYNC_URL = `${ORIGIN}/transactions/sync`;

function logLines() {
  const lines: Record<string, unknown>[] = [];
  const raw: string[] = [];
  const logger = pino({ level: 'debug' }, { write: (l: string) => { raw.push(l); lines.push(JSON.parse(l) as Record<string, unknown>); } });
  return { lines, raw, logger };
}

/**
 * A Plaid and a BankSync on the fake. `intercept` sees each request first and can answer it
 * itself (a failure on a chosen page, say) or call something mid-run.
 */
function setup(opts: { pageSize?: number; intercept?: (url: string, n: number) => Response | undefined } = {}) {
  const t = makeTestApp();
  const admin = addUser(t.db, t.clock, { email: 'alex@example.com', role: 'admin' });
  const fake = new FakePlaid();
  fake.origin = ORIGIN;
  fake.now = () => t.clock.now().getTime();
  const log = logLines();
  let calls = 0;
  const fetchFn: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const answer = opts.intercept?.(url, ++calls);
    return answer ?? fake.fetch(input, init);
  };
  const plaid = new Plaid({
    db: t.db, clock: t.clock, logger: log.logger, keyring: singleKeyring(TEST_ENCRYPTION_KEY), fetch: fetchFn, config, baseUrl: TEST_BASE_URL,
    clientOptions: { sleep: async () => {} },
  });
  const savings = { syncSoon: vi.fn<(itemId: number) => void>() };
  const bank = new BankSync({ db: t.db, clock: t.clock, logger: log.logger, plaid, pageSize: opts.pageSize, savings });
  return { t, admin, fake, plaid, bank, log, savings };
}
type Setup = ReturnType<typeof setup>;

/** Links a bank through the fake Link and the exchange, attaches each account to a new card, and saves the pick. */
async function linkBank(s: Setup, accounts: FakeAccountInput[] = [CARD_A], opts: { pick?: boolean } = {}) {
  const { linkToken } = await s.plaid.createLinkToken(s.admin, 'session-a', {});
  const { publicToken, metadata } = s.fake.completeLink(linkToken, { institution: { institution_id: `ins_${accounts[0]!.mask}`, name: 'Example Bank' }, accounts });
  const { itemId } = await s.plaid.exchange(s.admin, 'session-a', publicToken, metadata);
  const row = s.plaid.item(itemId)!;
  const fakeItem = s.fake.item(row.plaidItemId);
  const cardIds = fakeItem.accounts.map((a, i) => addCard(s.t, { nickname: `Card ${i + 1}`, mask: a.mask, usualClosingDay: null, plaidItemId: itemId, plaidAccountId: a.account_id }).id);
  if (opts.pick !== false) s.t.db.update(plaidItems).set({ pickedAt: s.t.clock.now() }).where(eq(plaidItems.id, itemId)).run();
  return { itemId, fakeItem, accountIds: fakeItem.accounts.map((a) => a.account_id), cardIds };
}

function rows(s: Setup) {
  return s.t.db.select().from(transactions).orderBy(asc(transactions.id)).all();
}

function itemRow(s: Setup, id: number) {
  return s.t.db.select().from(plaidItems).where(eq(plaidItems.id, id)).get()!;
}

function connection(s: Setup, itemId: number) {
  return s.t.db.select().from(connections).where(eq(connections.id, itemRow(s, itemId).connectionId!)).get()!;
}

function plaidError(status: number, error_type: string, error_code: string): Response {
  return new Response(JSON.stringify({ error_type, error_code, error_message: 'synthetic', request_id: 'req-synthetic' }), { status, headers: { 'content-type': 'application/json' } });
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

function addTransactions(s: Setup, itemId: string, accountId: string, n: number) {
  return Array.from({ length: n }, (_, i) => s.fake.addTransaction(itemId, { account_id: accountId, amount: 10 + i, name: `SYNTHETIC SHOP ${i}`, date: '2026-11-10' }));
}

describe('the sync loop', () => {
  it('follows has_more page by page with count and PFC v2, then applies the run and saves its cursor', async () => {
    const s = setup({ pageSize: 2 });
    const { itemId, fakeItem, accountIds } = await linkBank(s);
    addTransactions(s, fakeItem.itemId, accountIds[0]!, 5);
    // Later than the exchange, which set lastSuccessAt: the sync's own success must move it.
    s.t.clock.advance(60_000);
    const out = await s.bank.syncItem(itemId, { reason: 'scheduled' });
    expect(out).toMatchObject({ status: 'synced', pages: 3, restarts: 0, counts: { added: 5 } });
    expect(rows(s)).toHaveLength(5);
    const bodies = s.fake.requests.filter((r) => r.path === '/transactions/sync').map((r) => r.body);
    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toEqual({ access_token: fakeItem.accessToken, count: 2, options: { personal_finance_category_version: 'v2' } });
    expect(bodies[1]!.cursor).toEqual(expect.any(String));
    const item = itemRow(s, itemId);
    expect(item.cursor).toEqual(expect.any(String));
    expect(item).toMatchObject({ transactionsStatus: 'HISTORICAL_UPDATE_COMPLETE', lastSyncAt: s.t.clock.now() });
    expect(connection(s, itemId)).toMatchObject({ status: 'ok', lastSuccessAt: s.t.clock.now() });

    // The next run starts from the saved cursor and finds nothing new.
    expect(await s.bank.syncItem(itemId, { reason: 'scheduled' })).toMatchObject({ status: 'synced', pages: 1, counts: { added: 0 } });
    expect(s.fake.lastBody('/transactions/sync')!.cursor).toBe(item.cursor);
    const line = s.log.lines.find((l) => l.msg === 'plaid sync')!;
    expect(line).toMatchObject({ itemId, reason: 'scheduled', pages: 3, restarts: 0, added: 5 });
    // Ids and counts only: no token, no merchant text.
    expect(s.log.raw.join('')).not.toContain(fakeItem.accessToken);
    expect(s.log.raw.join('')).not.toContain('SYNTHETIC SHOP');
  });

  it('stores no cursor while Plaid has no data yet, and sends none the next time', async () => {
    const s = setup();
    const { itemId, fakeItem } = await linkBank(s);
    s.fake.setReady(fakeItem.itemId, false);
    expect(await s.bank.syncItem(itemId, { reason: 'pick' })).toMatchObject({ status: 'synced', pages: 1 });
    expect(itemRow(s, itemId)).toMatchObject({ cursor: null, transactionsStatus: 'NOT_READY' });
    await s.bank.syncItem(itemId, { reason: 'scheduled' });
    expect(s.fake.lastBody('/transactions/sync')).not.toHaveProperty('cursor');
  });

  it("keeps the caught-up cursor and the full-resync marker when the full pass finds no data yet, and reconciles nothing (review C-S-I1)", async () => {
    const s = setup();
    const { itemId, fakeItem, accountIds } = await linkBank(s);
    s.fake.addTransaction(fakeItem.itemId, { account_id: accountIds[0]!, amount: 7, name: 'SYNTHETIC PENDING', date: '2026-11-10', pending: true });
    await s.bank.syncItem(itemId, { reason: 'scheduled' });
    const marked = s.t.clock.now();
    s.t.db.update(plaidItems).set({ fullResyncAt: marked }).where(eq(plaidItems.id, itemId)).run();
    s.fake.addTransaction(fakeItem.itemId, { account_id: accountIds[0]!, amount: 8, name: 'SYNTHETIC LATER', date: '2026-11-11' });
    // Plaid answers a request with no cursor with no data (`next_cursor: ""`).
    s.fake.setReady(fakeItem.itemId, false);
    const out = await s.bank.syncItem(itemId, { reason: 'scheduled' });
    expect(out).toMatchObject({ status: 'synced', pages: 2, counts: { added: 1, reconciledPending: 0 } });
    const caughtUp = itemRow(s, itemId);
    expect(caughtUp).toMatchObject({ cursor: expect.any(String), fullResyncAt: marked });
    expect(rows(s).filter((r) => r.deletedAt === null)).toHaveLength(2);
    expect(s.log.lines.filter((l) => l.msg === 'plaid sync').slice(-2).map((l) => l.pass)).toEqual(['catch_up', 'full']);

    s.fake.setReady(fakeItem.itemId, true);
    await s.bank.syncItem(itemId, { reason: 'scheduled' });
    const bodies = s.fake.requests.filter((r) => r.path === '/transactions/sync').slice(-2).map((r) => r.body.cursor ?? null);
    expect(bodies).toEqual([caughtUp.cursor, null]);
    expect(itemRow(s, itemId).fullResyncAt).toBeNull();
    expect(rows(s).filter((r) => r.deletedAt === null)).toHaveLength(2);
  });

  it('restarts from the stored cursor after a mutation, throwing the buffered pages away', async () => {
    const s = setup({ pageSize: 2 });
    const { itemId, fakeItem, accountIds } = await linkBank(s);
    addTransactions(s, fakeItem.itemId, accountIds[0]!, 1);
    await s.bank.syncItem(itemId, { reason: 'scheduled' });
    const stored = itemRow(s, itemId).cursor!;
    const before = s.fake.count('/transactions/sync');
    addTransactions(s, fakeItem.itemId, accountIds[0]!, 5);
    s.fake.failMutationOnce(fakeItem.itemId, 1); // the second page of the first attempt
    const out = await s.bank.syncItem(itemId, { reason: 'scheduled' });
    expect(out).toMatchObject({ status: 'synced', pages: 3, restarts: 1, counts: { added: 5, modified: 0, unchanged: 0 } });
    expect(rows(s)).toHaveLength(6);
    const bodies = s.fake.requests.filter((r) => r.path === '/transactions/sync').map((r) => r.body).slice(before);
    // Page 1 from the stored cursor, the failed page 2, then the whole run again from the stored cursor.
    expect(bodies.map((b) => b.cursor === stored)).toEqual([true, false, true, false, false]);
    expect(s.log.lines.some((l) => l.msg === 'plaid sync restarted after a mutation' && l.pagesDropped === 1)).toBe(true);
  });

  it('restarts when the bank changes data mid-run (strictMutation), and the restarted run gets the change too', async () => {
    let s!: Setup;
    let fakeId = '';
    let accountId = '';
    let syncs = 0;
    s = setup({
      pageSize: 2,
      intercept: (url) => {
        // While the second page is asked for, a new transaction lands at the bank.
        if (url === SYNC_URL && ++syncs === 3) s.fake.addTransaction(fakeId, { account_id: accountId, amount: 99, name: 'SYNTHETIC LATE SHOP', date: '2026-11-11' });
        return undefined;
      },
    });
    s.fake.strictMutation = true;
    const { itemId, fakeItem, accountIds } = await linkBank(s);
    fakeId = fakeItem.itemId;
    accountId = accountIds[0]!;
    addTransactions(s, fakeId, accountId, 1);
    await s.bank.syncItem(itemId, { reason: 'scheduled' });
    addTransactions(s, fakeId, accountId, 3);
    const out = await s.bank.syncItem(itemId, { reason: 'scheduled' });
    expect(out).toMatchObject({ status: 'synced', restarts: 1, counts: { added: 4 } });
    expect(rows(s)).toHaveLength(5);
    expect(rows(s).some((r) => r.amountCents === 9900)).toBe(true);
  });

  it(`gives up after ${MAX_MUTATION_RESTARTS} restarts: nothing applied, the cursor kept, the failure recorded`, async () => {
    const s = setup({ pageSize: 1 });
    const { itemId, fakeItem, accountIds } = await linkBank(s);
    addTransactions(s, fakeItem.itemId, accountIds[0]!, 1);
    await s.bank.syncItem(itemId, { reason: 'scheduled' });
    const stored = itemRow(s, itemId).cursor!;
    const before = s.fake.count('/transactions/sync');
    addTransactions(s, fakeItem.itemId, accountIds[0]!, 3);
    // Every attempt gets its first page (buffered), then fails on the second.
    for (let i = 0; i <= MAX_MUTATION_RESTARTS; i++) s.fake.failMutationOnce(fakeItem.itemId, 2 * i + 1);
    const err = await rejection(s.bank.syncItem(itemId, { reason: 'scheduled' }));
    expect(err).toBeInstanceOf(PlaidApiError);
    expect((err as PlaidApiError).errorCode).toBe('TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION');
    expect(s.fake.count('/transactions/sync') - before).toBe(2 * (MAX_MUTATION_RESTARTS + 1));
    expect(rows(s)).toHaveLength(1);
    expect(itemRow(s, itemId).cursor).toBe(stored);
    expect(itemRow(s, itemId).backoffUntil).not.toBeNull();
    expect(connection(s, itemId).consecutiveFailures).toBe(1);
  });

  it('commits the cursor only with its pages: a failure part way through applies nothing', async () => {
    let failOn = 0;
    let syncs = 0;
    const s = setup({
      pageSize: 2,
      intercept: (url) => {
        if (url !== SYNC_URL) return undefined;
        syncs++;
        return syncs === failOn ? plaidError(400, 'INVALID_REQUEST', 'INVALID_FIELD') : undefined;
      },
    });
    const { itemId, fakeItem, accountIds } = await linkBank(s);
    addTransactions(s, fakeItem.itemId, accountIds[0]!, 1);
    await s.bank.syncItem(itemId, { reason: 'scheduled' });
    const cursor = itemRow(s, itemId).cursor;
    expect(cursor).not.toBeNull();

    addTransactions(s, fakeItem.itemId, accountIds[0]!, 5);
    failOn = syncs + 2; // the second page of the next run
    expect(await rejection(s.bank.syncItem(itemId, { reason: 'scheduled' }))).toMatchObject({ errorCode: 'INVALID_FIELD' });
    expect(rows(s)).toHaveLength(1);
    expect(itemRow(s, itemId).cursor).toBe(cursor);

    // The next run starts from the same cursor and gets all of it.
    expect(await s.bank.syncItem(itemId, { reason: 'scheduled' })).toMatchObject({ status: 'synced', counts: { added: 5 } });
    expect(rows(s)).toHaveLength(6);
  });

  it("keeps the cursor before a page with an entry it can't read, and shows the error on the bank", async () => {
    const s = setup();
    const { itemId, fakeItem, accountIds } = await linkBank(s);
    addTransactions(s, fakeItem.itemId, accountIds[0]!, 1);
    await s.bank.syncItem(itemId, { reason: 'scheduled' });
    const cursor = itemRow(s, itemId).cursor;
    const [bad] = addTransactions(s, fakeItem.itemId, accountIds[0]!, 2);
    s.fake.modifyTransaction(bad!.transaction_id, { date: 20261110 as unknown as string });
    expect(await rejection(s.bank.syncItem(itemId, { reason: 'scheduled' }))).toMatchObject({ name: 'PlaidBadResponse' });
    expect(rows(s)).toHaveLength(1);
    expect(itemRow(s, itemId).cursor).toBe(cursor);
    expect(connection(s, itemId).lastError).not.toBeNull();
  });

  it('skips an Item in backoff unless asked to ignore it, and a success clears the backoff', async () => {
    const s = setup();
    const { itemId, fakeItem, accountIds } = await linkBank(s);
    for (let i = 0; i < 3; i++) s.fake.failNext('/transactions/sync', FAKE_PLAID_ERRORS.INTERNAL_SERVER_ERROR); // the client retries twice
    expect(await rejection(s.bank.syncItem(itemId, { reason: 'scheduled' }))).toBeInstanceOf(PlaidApiError);
    const until = itemRow(s, itemId).backoffUntil!;
    expect(until.getTime() - s.t.clock.now().getTime()).toBe(5 * 60_000);

    addTransactions(s, fakeItem.itemId, accountIds[0]!, 1);
    const calls = s.fake.count('/transactions/sync');
    expect(await s.bank.syncItem(itemId, { reason: 'scheduled' })).toEqual({ status: 'skipped', reason: 'backoff' });
    expect(await s.bank.syncItem(itemId, { reason: 'webhook' })).toEqual({ status: 'skipped', reason: 'backoff' });
    expect(s.fake.count('/transactions/sync')).toBe(calls);

    expect(await s.bank.syncItem(itemId, { reason: 'refresh', ignoreBackoff: true })).toMatchObject({ status: 'synced', counts: { added: 1 } });
    expect(itemRow(s, itemId).backoffUntil).toBeNull();
    expect(connection(s, itemId)).toMatchObject({ status: 'ok', consecutiveFailures: 0 });

    // Past the backoff, scheduled runs go again.
    for (let i = 0; i < 3; i++) s.fake.failNext('/transactions/sync', FAKE_PLAID_ERRORS.INSTITUTION_DOWN);
    await rejection(s.bank.syncItem(itemId, { reason: 'scheduled' }));
    s.t.clock.advance(5 * 60_000);
    expect(await s.bank.syncItem(itemId, { reason: 'scheduled' })).toMatchObject({ status: 'synced' });
  });

  it('skips an Item waiting for the pick, a removed one, and one that needs reconnecting, without asking Plaid', async () => {
    const s = setup();
    const waiting = await linkBank(s, [CARD_A], { pick: false });
    expect(await s.bank.syncItem(waiting.itemId, { reason: 'scheduled', ignoreBackoff: true })).toEqual({ status: 'skipped', reason: 'not_picked' });

    const broken = await linkBank(s, [CARD_B]);
    s.plaid.markNeedsReconnect(broken.itemId, 'ITEM_LOGIN_REQUIRED');
    expect(await s.bank.syncItem(broken.itemId, { reason: 'refresh', ignoreBackoff: true })).toEqual({ status: 'skipped', reason: 'needs_reconnect' });

    await s.plaid.remove(s.admin, broken.itemId, { deleteTransactions: false });
    expect(await s.bank.syncItem(broken.itemId, { reason: 'scheduled' })).toEqual({ status: 'skipped', reason: 'removed' });
    expect(await s.bank.syncItem(999, { reason: 'scheduled' })).toEqual({ status: 'skipped', reason: 'removed' });
    expect(s.fake.count('/transactions/sync')).toBe(0);
  });

  it('records a login error on the connection and rethrows it', async () => {
    const s = setup();
    const { itemId, fakeItem } = await linkBank(s);
    s.fake.breakItem(fakeItem.itemId);
    expect(await rejection(s.bank.syncItem(itemId, { reason: 'scheduled' }))).toMatchObject({ errorCode: 'ITEM_LOGIN_REQUIRED' });
    expect(connection(s, itemId).status).toBe('needs_reconnect');
  });
});

describe('a request deadline', () => {
  it('drops the buffered pages past the deadline: nothing applied, the cursor kept, the connection untouched, and the run deferred', async () => {
    const mocked: { restore?: () => void } = {};
    let deadline = 0;
    const s = setup({
      pageSize: 2,
      // The first page comes back after the deadline.
      intercept: (url) => {
        if (url === SYNC_URL && !mocked.restore) {
          const spy = vi.spyOn(Date, 'now').mockReturnValue(deadline + 1);
          mocked.restore = () => spy.mockRestore();
        }
        return undefined;
      },
    });
    try {
      const { itemId, fakeItem, accountIds } = await linkBank(s);
      addTransactions(s, fakeItem.itemId, accountIds[0]!, 5);
      const before = connection(s, itemId);
      deadline = Date.now() + 60_000;
      expect(await s.bank.syncItem(itemId, { reason: 'refresh', ignoreBackoff: true, deadline })).toEqual({ status: 'deferred' });
      expect(s.fake.count('/transactions/sync')).toBe(1);
      expect(rows(s)).toHaveLength(0);
      expect(itemRow(s, itemId)).toMatchObject({ cursor: null, lastSyncAt: null });
      expect(connection(s, itemId)).toEqual(before);
      expect(s.log.lines.find((l) => l.msg === 'plaid sync deferred')).toMatchObject({ itemId, reason: 'refresh', waitedForLock: false, pagesDropped: 1 });
    } finally {
      mocked.restore?.();
    }
  });

  it('is deferred when the lock stays busy past it (another run has the Item), and a run without one waits its turn', async () => {
    const s = setup();
    const { itemId, fakeItem, accountIds } = await linkBank(s);
    addTransactions(s, fakeItem.itemId, accountIds[0]!, 1);
    let release!: () => void;
    const held = s.plaid.withItem(itemId, () => new Promise<void>((resolve) => (release = resolve)), { sideCall: true });
    expect(await s.bank.syncItem(itemId, { reason: 'pick', ignoreBackoff: true, deadline: Date.now() + 20 })).toEqual({ status: 'deferred' });
    expect(s.log.lines.find((l) => l.msg === 'plaid sync deferred')).toMatchObject({ itemId, waitedForLock: true, pagesDropped: 0 });
    const waiting = s.bank.syncItem(itemId, { reason: 'scheduled' });
    release();
    await held;
    expect(await waiting).toMatchObject({ status: 'synced', counts: { added: 1 } });
    expect(s.fake.count('/transactions/sync')).toBe(1);
  });
});

describe('background runs', () => {
  it('folds requests made while a run waits for its turn into that run', async () => {
    const s = setup();
    const { itemId, fakeItem, accountIds } = await linkBank(s);
    addTransactions(s, fakeItem.itemId, accountIds[0]!, 1);
    s.bank.syncSoon(itemId);
    s.bank.syncSoon(itemId);
    s.bank.syncSoon(itemId);
    await s.bank.idle();
    expect(s.fake.count('/transactions/sync')).toBe(1);
    expect(rows(s)).toHaveLength(1);
  });

  it('runs once more when asked during a run, however many times', async () => {
    let bank: BankSync | null = null;
    let itemId = 0;
    let syncs = 0;
    const s = setup({
      intercept: (url) => {
        if (url === SYNC_URL && ++syncs === 1) {
          bank!.syncSoon(itemId);
          bank!.syncSoon(itemId);
        }
        return undefined;
      },
    });
    bank = s.bank;
    ({ itemId } = await linkBank(s));
    s.bank.syncSoon(itemId);
    await s.bank.idle();
    expect(s.fake.count('/transactions/sync')).toBe(2);
  });

  it('logs a failed background run and carries on', async () => {
    const s = setup();
    const { itemId, fakeItem } = await linkBank(s);
    s.fake.breakItem(fakeItem.itemId);
    s.bank.syncSoon(itemId);
    await s.bank.idle();
    expect(s.log.lines.some((l) => l.msg === 'plaid background run failed' && l.errorCode === 'ITEM_LOGIN_REQUIRED')).toBe(true);
  });
});

describe('statements from liabilities', () => {
  function statementsOf(s: Setup, cardId: number) {
    return s.t.db.select().from(statements).where(eq(statements.cardId, cardId)).orderBy(asc(statements.closingDate)).all();
  }
  function card(s: Setup, id: number) {
    return s.t.db.select().from(cards).where(eq(cards.id, id)).get()!;
  }

  it('adds a Plaid statement for a new date, refreshes it later, and sets the usual closing day from the latest', async () => {
    const s = setup();
    const { itemId, fakeItem, accountIds, cardIds } = await linkBank(s, [CARD_A, CARD_B]);
    s.t.db.update(cards).set({ included: false }).where(eq(cards.id, cardIds[1]!)).run(); // excluded cards get statements too
    s.fake.setLiability(fakeItem.itemId, accountIds[0]!, {
      last_statement_issue_date: '2026-11-03', last_statement_balance: 1234.56, next_payment_due_date: '2026-11-28', minimum_payment_amount: 35,
    });
    s.fake.setLiability(fakeItem.itemId, accountIds[1]!, { last_statement_issue_date: '2026-10-21' });
    const out = await s.bank.refreshLiabilities(itemId, { reason: 'scheduled' });
    expect(out).toEqual({ status: 'refreshed', counts: expect.objectContaining({ cards: 2, added: 2, updated: 0, closingDays: 2, unavailable: null }) });
    expect(statementsOf(s, cardIds[0]!)).toMatchObject([{
      closingDate: '2026-11-03', source: 'plaid', statementBalanceCents: 123_456, paymentDueDate: '2026-11-28', minimumPaymentCents: 3_500, fetchedAt: s.t.clock.now(),
    }]);
    expect(statementsOf(s, cardIds[1]!)).toMatchObject([{ closingDate: '2026-10-21', source: 'plaid', statementBalanceCents: null, paymentDueDate: null, minimumPaymentCents: null }]);
    expect(card(s, cardIds[0]!).usualClosingDay).toBe(3);
    expect(card(s, cardIds[1]!).usualClosingDay).toBe(21);

    // The same date again: refreshed, not added.
    s.t.clock.advance(60_000);
    s.fake.setLiability(fakeItem.itemId, accountIds[0]!, { last_statement_issue_date: '2026-11-03', last_statement_balance: 1200 });
    s.fake.setLiability(fakeItem.itemId, accountIds[1]!, { last_statement_issue_date: null });
    const again = await s.bank.refreshLiabilities(itemId, { reason: 'scheduled' });
    expect(again).toMatchObject({ counts: { added: 0, updated: 1, noDate: 1, closingDays: 0 } });
    expect(statementsOf(s, cardIds[0]!)).toMatchObject([{ statementBalanceCents: 120_000, minimumPaymentCents: null, fetchedAt: s.t.clock.now() }]);
    expect(s.log.lines.find((l) => l.msg === 'plaid liabilities')).toMatchObject({ itemId, added: 2 });
  });

  it("keeps an admin's manual date on or near Plaid's, and an older date doesn't move the closing day", async () => {
    const s = setup();
    const { itemId, fakeItem, accountIds, cardIds } = await linkBank(s, [CARD_A, CARD_B]);
    const now = s.t.clock.now();
    s.t.db.insert(statements).values([
      { cardId: cardIds[0]!, closingDate: '2026-11-04', source: 'manual', createdAt: now, updatedAt: now },
      { cardId: cardIds[1]!, closingDate: '2026-11-12', source: 'manual', createdAt: now, updatedAt: now },
    ]).run();
    s.t.db.update(cards).set({ usualClosingDay: 12 }).where(eq(cards.id, cardIds[1]!)).run();
    s.fake.setLiability(fakeItem.itemId, accountIds[0]!, { last_statement_issue_date: '2026-11-03' });
    // An older date on another day of the month: it must not become the usual closing day.
    s.fake.setLiability(fakeItem.itemId, accountIds[1]!, { last_statement_issue_date: '2026-10-08' });
    expect(await s.bank.refreshLiabilities(itemId, { reason: 'scheduled' })).toMatchObject({ counts: { keptManual: 1, added: 1, closingDays: 0 } });
    expect(statementsOf(s, cardIds[0]!).map((r) => [r.closingDate, r.source])).toEqual([['2026-11-04', 'manual']]);
    expect(statementsOf(s, cardIds[1]!).map((r) => [r.closingDate, r.source])).toEqual([['2026-10-08', 'plaid'], ['2026-11-12', 'manual']]);
    expect(card(s, cardIds[0]!).usualClosingDay).toBeNull();
    expect(card(s, cardIds[1]!).usualClosingDay).toBe(12);
  });

  it('keeps a manual date within 15 days, 15 included, and moves a stored Plaid date when the new one is within 15 days of it', async () => {
    const s = setup();
    const { itemId, fakeItem, accountIds, cardIds } = await linkBank(s, [CARD_A, CARD_B]);
    const now = s.t.clock.now();
    s.t.db.insert(statements).values({ cardId: cardIds[0]!, closingDate: '2026-10-20', source: 'manual', createdAt: now, updatedAt: now }).run();
    const refresh = async (a: string, b: string, more: Record<string, unknown> = {}) => {
      s.fake.setLiability(fakeItem.itemId, accountIds[0]!, { last_statement_issue_date: a });
      s.fake.setLiability(fakeItem.itemId, accountIds[1]!, { last_statement_issue_date: b, ...more });
      const out = await s.bank.refreshLiabilities(itemId, { reason: 'scheduled' });
      if (out.status !== 'refreshed') throw new Error(`skipped: ${out.reason}`);
      return out;
    };
    const dates = (cardId: number) => statementsOf(s, cardId).map((r) => [r.closingDate, r.source]);

    // 15 days from the manual 10-20: kept. On card 2, a first Plaid date.
    expect((await refresh('2026-11-04', '2026-10-03')).counts).toMatchObject({ keptManual: 1, added: 1, moved: 0 });
    expect(dates(cardIds[0]!)).toEqual([['2026-10-20', 'manual']]);
    // The bank's date for that statement moves two days: the same row, with the new fields.
    expect((await refresh('2026-11-04', '2026-10-05', { last_statement_balance: 50 })).counts).toMatchObject({ added: 0, moved: 1 });
    expect(statementsOf(s, cardIds[1]!)).toMatchObject([{ closingDate: '2026-10-05', source: 'plaid', statementBalanceCents: 5_000 }]);
    expect(card(s, cardIds[1]!).usualClosingDay).toBe(5);
    // 16 days from the manual date is the next statement, and so is a month on.
    expect((await refresh('2026-11-05', '2026-11-04')).counts).toMatchObject({ keptManual: 0, added: 2, moved: 0 });
    expect(dates(cardIds[0]!)).toEqual([['2026-10-20', 'manual'], ['2026-11-05', 'plaid']]);
    expect(dates(cardIds[1]!)).toEqual([['2026-10-05', 'plaid'], ['2026-11-04', 'plaid']]);
    // Moving the latest one earlier moves the nearest row, and the closing day follows it.
    expect((await refresh('2026-11-05', '2026-11-02')).counts).toMatchObject({ updated: 1, moved: 1 });
    expect(dates(cardIds[1]!)).toEqual([['2026-10-05', 'plaid'], ['2026-11-02', 'plaid']]);
    expect(card(s, cardIds[1]!).usualClosingDay).toBe(2);
  });

  it("treats no shared liabilities as no statements, not a broken connection, and ignores accounts without a card", async () => {
    const s = setup();
    const { itemId, fakeItem, accountIds, cardIds } = await linkBank(s, [CARD_A, CARD_B]);
    // The fake answers NO_LIABILITY_ACCOUNTS when no account has liabilities.
    expect(await s.bank.refreshLiabilities(itemId, { reason: 'scheduled' })).toMatchObject({ status: 'refreshed', counts: { unavailable: 'NO_LIABILITY_ACCOUNTS', added: 0 } });
    s.fake.failNext('/liabilities/get', FAKE_PLAID_ERRORS.ACCESS_NOT_GRANTED);
    expect(await s.bank.refreshLiabilities(itemId, { reason: 'scheduled' })).toMatchObject({ counts: { unavailable: 'ACCESS_NOT_GRANTED' } });
    expect(connection(s, itemId)).toMatchObject({ status: 'ok', consecutiveFailures: 0 });

    // A skipped account has no card: its entry is counted and dropped.
    s.t.db.update(cards).set({ plaidAccountId: null, plaidItemId: null }).where(eq(cards.id, cardIds[1]!)).run();
    s.fake.setLiability(fakeItem.itemId, accountIds[1]!, { last_statement_issue_date: '2026-11-01' });
    expect(await s.bank.refreshLiabilities(itemId, { reason: 'scheduled' })).toMatchObject({ counts: { cards: 0, unattached: 1, added: 0 } });
    expect(s.t.db.select().from(statements).all()).toHaveLength(0);
  });

  it("never touches the sync's health: a success doesn't set ok and a passing failure neither counts nor backs off", async () => {
    const s = setup();
    const { itemId, fakeItem, accountIds } = await linkBank(s);
    const conn = connection(s, itemId);
    s.t.db.update(connections).set({ status: 'error', consecutiveFailures: 3, lastError: "Couldn't reach Plaid or the bank." }).where(eq(connections.id, conn.id)).run();
    s.fake.setLiability(fakeItem.itemId, accountIds[0]!, { last_statement_issue_date: '2026-11-03' });
    s.t.clock.advance(60_000);
    expect(await s.bank.refreshLiabilities(itemId, { reason: 'scheduled' })).toMatchObject({ status: 'refreshed', counts: { added: 1 } });
    expect(connection(s, itemId)).toMatchObject({ status: 'error', consecutiveFailures: 3, lastSuccessAt: conn.lastSuccessAt });
    for (let i = 0; i < 3; i++) s.fake.failNext('/liabilities/get', FAKE_PLAID_ERRORS.INTERNAL_SERVER_ERROR);
    expect(await rejection(s.bank.refreshLiabilities(itemId, { reason: 'scheduled' }))).toMatchObject({ errorCode: 'INTERNAL_SERVER_ERROR' });
    expect(connection(s, itemId)).toMatchObject({ status: 'error', consecutiveFailures: 3 });
    expect(itemRow(s, itemId).backoffUntil).toBeNull();
  });

  it('skips an Item with no attached cards, and records a real failure', async () => {
    const s = setup();
    const { itemId, cardIds } = await linkBank(s);
    s.fake.failNext('/liabilities/get', FAKE_PLAID_ERRORS.ITEM_LOGIN_REQUIRED);
    expect(await rejection(s.bank.refreshLiabilities(itemId, { reason: 'scheduled' }))).toMatchObject({ errorCode: 'ITEM_LOGIN_REQUIRED' });
    expect(connection(s, itemId).status).toBe('needs_reconnect');
    s.t.db.update(cards).set({ plaidAccountId: null, plaidItemId: null }).where(eq(cards.id, cardIds[0]!)).run();
    s.plaid.clearReconnect(itemId);
    expect(await s.bank.refreshLiabilities(itemId, { reason: 'scheduled' })).toEqual({ status: 'skipped', reason: 'no_cards' });
  });
});

describe('rechecking Items that need reconnecting', () => {
  it('the daily statements run clears one Plaid reports fine and syncs it, and keeps one still broken or revoked', async () => {
    const s = setup();
    const fine = await linkBank(s, [CARD_A]);
    const broken = await linkBank(s, [CARD_B]);
    const revoked = await linkBank(s, [{ name: 'Example Travel', mask: '3333' }]);
    s.plaid.markNeedsReconnect(fine.itemId, 'ITEM_LOGIN_REQUIRED');
    s.plaid.markNeedsReconnect(broken.itemId, 'ITEM_LOGIN_REQUIRED');
    s.fake.breakItem(broken.fakeItem.itemId);
    s.bank.handleWebhook({ webhook_type: 'ITEM', webhook_code: 'USER_PERMISSION_REVOKED', item_id: revoked.fakeItem.itemId, environment: 'sandbox' });
    addTransactions(s, fine.fakeItem.itemId, fine.accountIds[0]!, 1);
    const seen = s.fake.requests.length;

    expect(await s.bank.refreshAllLiabilities()).toEqual({ total: 3, done: 1, skipped: 2, failed: 0 });
    await s.bank.idle();
    expect(connection(s, fine.itemId)).toMatchObject({ status: 'ok', consecutiveFailures: 0 });
    expect(rows(s)).toHaveLength(1);
    expect(connection(s, broken.itemId).status).toBe('needs_reconnect');
    expect(connection(s, revoked.itemId).status).toBe('needs_reconnect');
    expect(s.fake.requests.slice(seen).filter((r) => r.path === '/item/get').map((r) => r.body.access_token).sort())
      .toEqual([fine.fakeItem.accessToken, broken.fakeItem.accessToken, revoked.fakeItem.accessToken].sort());
    // An Item that's fine isn't asked about.
    const asked = s.fake.count('/item/get');
    await s.bank.refreshAllLiabilities();
    expect(s.fake.count('/item/get')).toBe(asked + 2);
  });

  it('keeps a revoked Item revoked after a later webhook overwrites the last webhook code', async () => {
    const s = setup();
    const revoked = await linkBank(s, [CARD_A]);
    s.bank.handleWebhook({ webhook_type: 'ITEM', webhook_code: 'USER_PERMISSION_REVOKED', item_id: revoked.fakeItem.itemId, environment: 'sandbox' });
    // Any later webhook, a transactions one say, replaces the last code the Item has.
    s.bank.handleWebhook({ webhook_type: 'TRANSACTIONS', webhook_code: 'DEFAULT_UPDATE', item_id: revoked.fakeItem.itemId, environment: 'sandbox' });
    expect(s.plaid.item(revoked.itemId)!.lastWebhookCode).toBe('TRANSACTIONS:DEFAULT_UPDATE');
    expect(await s.bank.checkItem(revoked.itemId, { reason: 'scheduled' })).toBe('unchanged');
    expect(connection(s, revoked.itemId).status).toBe('needs_reconnect');
  });

  it("doesn't ask about a bank gone at Plaid, and a failed check is only logged", async () => {
    const s = setup();
    const gone = await linkBank(s, [CARD_A]);
    const flaky = await linkBank(s, [CARD_B]);
    s.fake.failNext('/transactions/sync', FAKE_PLAID_ERRORS.ITEM_NOT_FOUND);
    await rejection(s.bank.syncItem(gone.itemId, { reason: 'scheduled' }));
    expect(connection(s, gone.itemId).status).toBe('needs_reconnect');
    s.plaid.markNeedsReconnect(flaky.itemId, 'ITEM_LOGIN_REQUIRED');
    for (let i = 0; i < 3; i++) s.fake.failNext('/item/get', FAKE_PLAID_ERRORS.INTERNAL_SERVER_ERROR);
    const asked = s.fake.count('/item/get');
    expect(await s.bank.refreshAllLiabilities()).toMatchObject({ failed: 0, skipped: 2 });
    expect(s.fake.count('/item/get')).toBe(asked + 3);
    expect(connection(s, flaky.itemId)).toMatchObject({ status: 'needs_reconnect' });
    expect(s.log.lines.find((l) => l.msg === 'plaid item check failed')).toMatchObject({ itemId: flaky.itemId, errorCode: 'INTERNAL_SERVER_ERROR' });
  });
});

describe('webhooks', () => {
  function hook(fakeItemId: string, type: string, code: string, extra: Record<string, unknown> = {}) {
    return { webhook_type: type, webhook_code: code, item_id: fakeItemId, environment: 'sandbox', ...extra };
  }

  it('syncs on SYNC_UPDATES_AVAILABLE in the background and notes the code', async () => {
    const s = setup();
    const { itemId, fakeItem, accountIds } = await linkBank(s);
    addTransactions(s, fakeItem.itemId, accountIds[0]!, 2);
    expect(s.bank.handleWebhook(hook(fakeItem.itemId, 'TRANSACTIONS', 'SYNC_UPDATES_AVAILABLE', { initial_update_complete: true, historical_update_complete: true }))).toBe('sync');
    await s.bank.idle();
    expect(rows(s)).toHaveLength(2);
    expect(itemRow(s, itemId).lastWebhookCode).toBe('TRANSACTIONS:SYNC_UPDATES_AVAILABLE');
  });

  it('acknowledges the legacy transaction codes and WEBHOOK_UPDATE_ACKNOWLEDGED without doing anything', async () => {
    const s = setup();
    const { fakeItem } = await linkBank(s);
    for (const code of ['INITIAL_UPDATE', 'HISTORICAL_UPDATE', 'DEFAULT_UPDATE', 'TRANSACTIONS_REMOVED']) {
      expect(s.bank.handleWebhook(hook(fakeItem.itemId, 'TRANSACTIONS', code))).toBe('ignored');
    }
    expect(s.bank.handleWebhook(hook(fakeItem.itemId, 'ITEM', 'WEBHOOK_UPDATE_ACKNOWLEDGED'))).toBe('ignored');
    expect(s.bank.handleWebhook(hook(fakeItem.itemId, 'ITEM', 'USER_ACCOUNT_REVOKED', { account_id: 'acct-x' }))).toBe('ignored');
    expect(s.bank.handleWebhook(hook(fakeItem.itemId, 'SOMETHING_NEW', 'SOME_CODE'))).toBe('ignored');
    await s.bank.idle();
    expect(s.fake.count('/transactions/sync')).toBe(0);
  });

  it("marks the connection for reconnecting on ITEM ERROR with a login code once /item/get confirms it, and on USER_PERMISSION_REVOKED", async () => {
    const s = setup();
    const a = await linkBank(s, [CARD_A]);
    const b = await linkBank(s, [CARD_B]);
    s.fake.breakItem(a.fakeItem.itemId);
    expect(s.bank.handleWebhook(hook(a.fakeItem.itemId, 'ITEM', 'ERROR', { error: { error_type: 'ITEM_ERROR', error_code: 'ITEM_LOGIN_REQUIRED', status: 400 } }))).toBe('check_item');
    expect(connection(s, a.itemId).status).toBe('ok');
    await s.bank.idle();
    expect(s.fake.lastBody('/item/get')).toEqual({ access_token: a.fakeItem.accessToken });
    expect(connection(s, a.itemId)).toMatchObject({ status: 'needs_reconnect', lastError: 'The bank needs you to sign in again.' });
    expect(s.log.lines.find((l) => l.msg === 'plaid item checked')).toMatchObject({ itemId: a.itemId, reason: 'webhook', outcome: 'needs_reconnect' });
    expect(s.bank.handleWebhook(hook(b.fakeItem.itemId, 'ITEM', 'USER_PERMISSION_REVOKED', { error: null }))).toBe('needs_reconnect');
    expect(connection(s, b.itemId).status).toBe('needs_reconnect');
    // Another Item error is left for the next sync to record.
    const c = await linkBank(s, [{ name: 'Example Travel', mask: '3333' }]);
    expect(s.bank.handleWebhook(hook(c.fakeItem.itemId, 'ITEM', 'ERROR', { error: { error_code: 'INSTITUTION_DOWN' } }))).toBe('ignored');
    expect(connection(s, c.itemId).status).toBe('ok');
  });

  it("doesn't believe a late ITEM ERROR when /item/get says the login works: a LOGIN_REPAIRED that came first wins", async () => {
    const s = setup();
    const { itemId, fakeItem } = await linkBank(s);
    s.plaid.markNeedsReconnect(itemId, 'ITEM_LOGIN_REQUIRED');
    expect(s.bank.handleWebhook(hook(fakeItem.itemId, 'ITEM', 'LOGIN_REPAIRED'))).toBe('repaired');
    expect(s.bank.handleWebhook(hook(fakeItem.itemId, 'ITEM', 'ERROR', { error: { error_code: 'ITEM_LOGIN_REQUIRED' } }))).toBe('check_item');
    await s.bank.idle();
    expect(connection(s, itemId)).toMatchObject({ status: 'ok', consecutiveFailures: 0 });
    expect(s.log.lines.find((l) => l.msg === 'plaid item checked')).toMatchObject({ itemId, outcome: 'unchanged' });
    // A check /item/get can't answer changes nothing and doesn't count against the connection.
    for (let i = 0; i < 3; i++) s.fake.failNext('/item/get', FAKE_PLAID_ERRORS.INTERNAL_SERVER_ERROR);
    s.bank.handleWebhook(hook(fakeItem.itemId, 'ITEM', 'ERROR', { error: { error_code: 'ITEM_LOGIN_REQUIRED' } }));
    await s.bank.idle();
    expect(connection(s, itemId)).toMatchObject({ status: 'ok', consecutiveFailures: 0 });
    expect(s.log.lines.some((l) => l.msg === 'plaid background run failed')).toBe(true);
  });

  it('clears the reconnect on LOGIN_REPAIRED and syncs', async () => {
    const s = setup();
    const { itemId, fakeItem, accountIds } = await linkBank(s);
    s.plaid.markNeedsReconnect(itemId, 'ITEM_LOGIN_REQUIRED');
    addTransactions(s, fakeItem.itemId, accountIds[0]!, 1);
    expect(s.bank.handleWebhook(hook(fakeItem.itemId, 'ITEM', 'LOGIN_REPAIRED'))).toBe('repaired');
    await s.bank.idle();
    expect(connection(s, itemId).status).toBe('ok');
    expect(rows(s)).toHaveLength(1);
  });

  it('notes new accounts, a disconnect date, and a new consent expiry', async () => {
    const s = setup();
    const { itemId, fakeItem } = await linkBank(s);
    expect(s.bank.handleWebhook(hook(fakeItem.itemId, 'ITEM', 'NEW_ACCOUNTS_AVAILABLE', { error: null }))).toBe('new_accounts');
    expect(itemRow(s, itemId).newAccountsAt).toEqual(s.t.clock.now());
    expect(s.bank.handleWebhook(hook(fakeItem.itemId, 'ITEM', 'PENDING_DISCONNECT', { reason: 'INSTITUTION_TOKEN_EXPIRATION', disconnect_time: '2026-11-22T12:00:00Z' }))).toBe('disconnect_at');
    expect(itemRow(s, itemId).disconnectAt).toBe('2026-11-22T12:00:00Z');
    expect(s.bank.handleWebhook(hook(fakeItem.itemId, 'ITEM', 'PENDING_EXPIRATION', { consent_expiration_time: '2026-11-29T00:00:00Z' }))).toBe('disconnect_at');
    expect(itemRow(s, itemId).disconnectAt).toBe('2026-11-29T00:00:00Z');
    // Without a date it can read, it's a week from now: Plaid sends it 7 days before.
    const inAWeek = new Date(s.t.clock.now().getTime() + DISCONNECT_NOTICE_MS).toISOString();
    expect(s.bank.handleWebhook(hook(fakeItem.itemId, 'ITEM', 'PENDING_DISCONNECT', { disconnect_time: 'not a date' }))).toBe('disconnect_at');
    expect(itemRow(s, itemId).disconnectAt).toBe(inAWeek);
    s.t.clock.advance(60_000);
    expect(s.bank.handleWebhook(hook(fakeItem.itemId, 'ITEM', 'PENDING_DISCONNECT', { reason: 'INSTITUTION_MIGRATION' }))).toBe('disconnect_at');
    expect(itemRow(s, itemId).disconnectAt).toBe(new Date(s.t.clock.now().getTime() + DISCONNECT_NOTICE_MS).toISOString());
    expect(s.bank.handleWebhook(hook(fakeItem.itemId, 'ITEM', 'CONSENT_UPDATED', { consent_expiration_time: '2027-11-01T00:00:00Z' }))).toBe('consent');
    expect(itemRow(s, itemId).consentExpirationTime).toBe('2027-11-01T00:00:00Z');
  });

  it('gets liabilities on LIABILITIES DEFAULT_UPDATE', async () => {
    const s = setup();
    const { fakeItem, accountIds, cardIds } = await linkBank(s);
    s.fake.setLiability(fakeItem.itemId, accountIds[0]!, { last_statement_issue_date: '2026-11-05' });
    expect(s.bank.handleWebhook(hook(fakeItem.itemId, 'LIABILITIES', 'DEFAULT_UPDATE', { account_ids_with_new_liabilities: [accountIds[0]], error: null }))).toBe('liabilities');
    await s.bank.idle();
    expect(s.t.db.select().from(statements).where(eq(statements.cardId, cardIds[0]!)).all()).toHaveLength(1);
  });

  it('ignores an unknown or removed Item, another environment, and a body without a type', async () => {
    const s = setup();
    const { itemId, fakeItem } = await linkBank(s);
    expect(s.bank.handleWebhook(hook('item-nobody-has', 'TRANSACTIONS', 'SYNC_UPDATES_AVAILABLE'))).toBe('unknown_item');
    expect(s.bank.handleWebhook({ ...hook(fakeItem.itemId, 'TRANSACTIONS', 'SYNC_UPDATES_AVAILABLE'), environment: 'production' })).toBe('other_environment');
    expect(s.bank.handleWebhook({ item_id: fakeItem.itemId })).toBe('unreadable');
    await s.plaid.remove(s.admin, itemId, { deleteTransactions: false });
    expect(s.bank.handleWebhook(hook(fakeItem.itemId, 'ITEM', 'NEW_ACCOUNTS_AVAILABLE'))).toBe('unknown_item');
    await s.bank.idle();
    expect(s.fake.count('/transactions/sync')).toBe(0);
    expect(itemRow(s, itemId).newAccountsAt).toBeNull();
    expect(s.log.lines.some((l) => l.msg === 'plaid webhook for another environment')).toBe(true);
  });

  it('a replayed webhook still asks for a sync or liabilities, folded into one already pending, and drops every other code', async () => {
    const s = setup();
    const { itemId, fakeItem, accountIds, cardIds } = await linkBank(s);
    const before = itemRow(s, itemId).lastWebhookCode;
    addTransactions(s, fakeItem.itemId, accountIds[0]!, 2);
    // The original and its replay in the same breath: one sync runs, and it gets everything.
    expect(s.bank.handleWebhook(hook(fakeItem.itemId, 'TRANSACTIONS', 'SYNC_UPDATES_AVAILABLE'))).toBe('sync');
    expect(s.bank.handleReplayedWebhook(hook(fakeItem.itemId, 'TRANSACTIONS', 'SYNC_UPDATES_AVAILABLE'))).toBe('sync');
    await s.bank.idle();
    expect(rows(s)).toHaveLength(2);
    const syncs = s.fake.count('/transactions/sync');
    expect(syncs).toBeGreaterThanOrEqual(1);
    // A replay alone, after that sync finished, runs one more (new data the first never saw).
    addTransactions(s, fakeItem.itemId, accountIds[0]!, 1);
    const lastCode = itemRow(s, itemId).lastWebhookCode;
    expect(s.bank.handleReplayedWebhook(hook(fakeItem.itemId, 'TRANSACTIONS', 'SYNC_UPDATES_AVAILABLE'))).toBe('sync');
    await s.bank.idle();
    expect(rows(s)).toHaveLength(3);
    expect(s.fake.count('/transactions/sync')).toBe(syncs + 1);
    // A replay records nothing about the webhook.
    expect(itemRow(s, itemId).lastWebhookCode).toBe(lastCode);
    expect(lastCode).not.toBe(before);
    // Liabilities too.
    s.fake.setLiability(fakeItem.itemId, accountIds[0]!, { last_statement_issue_date: '2026-11-05' });
    expect(s.bank.handleReplayedWebhook(hook(fakeItem.itemId, 'LIABILITIES', 'DEFAULT_UPDATE'))).toBe('liabilities');
    await s.bank.idle();
    expect(s.t.db.select().from(statements).where(eq(statements.cardId, cardIds[0]!)).all()).toHaveLength(1);
    // Every other code is dropped: nothing is noted, checked or synced.
    const calls = s.fake.requests.length;
    for (const [type, code] of [['ITEM', 'NEW_ACCOUNTS_AVAILABLE'], ['ITEM', 'ERROR'], ['ITEM', 'LOGIN_REPAIRED'], ['ITEM', 'USER_PERMISSION_REVOKED'], ['TRANSACTIONS', 'DEFAULT_UPDATE']] as const) {
      expect(s.bank.handleReplayedWebhook(hook(fakeItem.itemId, type, code, { error: { error_code: 'ITEM_LOGIN_REQUIRED' } }))).toBe('ignored');
    }
    await s.bank.idle();
    expect(s.fake.requests.length).toBe(calls);
    expect(itemRow(s, itemId).newAccountsAt).toBeNull();
    // An unknown Item, another environment, and a removed Item: nothing.
    expect(s.bank.handleReplayedWebhook(hook('item-nobody-has', 'TRANSACTIONS', 'SYNC_UPDATES_AVAILABLE'))).toBe('unknown_item');
    expect(s.bank.handleReplayedWebhook({ ...hook(fakeItem.itemId, 'TRANSACTIONS', 'SYNC_UPDATES_AVAILABLE'), environment: 'production' })).toBe('other_environment');
    await s.plaid.remove(s.admin, itemId, { deleteTransactions: false });
    const afterRemove = s.fake.count('/transactions/sync');
    expect(s.bank.handleReplayedWebhook(hook(fakeItem.itemId, 'TRANSACTIONS', 'SYNC_UPDATES_AVAILABLE'))).toBe('unknown_item');
    await s.bank.idle();
    expect(s.fake.count('/transactions/sync')).toBe(afterRemove);
  });

  it('receiveWebhook handles it after returning, and idle waits for that', async () => {
    const s = setup();
    const { itemId, fakeItem } = await linkBank(s);
    s.bank.receiveWebhook(hook(fakeItem.itemId, 'ITEM', 'NEW_ACCOUNTS_AVAILABLE'));
    expect(itemRow(s, itemId).newAccountsAt).toBeNull();
    await s.bank.idle();
    expect(itemRow(s, itemId).newAccountsAt).toEqual(s.t.clock.now());
  });
});

describe('the jobs', () => {
  function jobsOf(s: Setup) {
    return new Map(plaidJobs({ db: s.t.db, clock: s.t.clock, logger: s.log.logger, plaid: s.plaid, bank: s.bank }, { jitterMs: 0 }).map((j) => [j.name, j]));
  }

  it('registers only the prune without Plaid, and all four with it, on the design\'s schedules', () => {
    const t = makeTestApp();
    expect(plaidJobs({ db: t.db, clock: t.clock, logger: t.logger, plaid: null, bank: null }).map((j) => j.name)).toEqual(['spend.pruneRemoved']);
    const s = setup();
    expect([...jobsOf(s).values()].map((j) => [j.name, j.cron])).toEqual([
      ['spend.pruneRemoved', '15 4 * * *'],
      ['spend.transactionsSync', '0 */6 * * *'],
      ['spend.statementsSync', '0 6 * * *'],
      ['spend.plaidRevocations', '45 * * * *'],
    ]);
  });

  it('syncs every live Item, and a failure is a plain job error after the others ran', async () => {
    const s = setup();
    const a = await linkBank(s, [CARD_A]);
    const b = await linkBank(s, [CARD_B]);
    await linkBank(s, [{ name: 'Example Travel', mask: '3333' }], { pick: false });
    addTransactions(s, b.fakeItem.itemId, b.accountIds[0]!, 1);
    // An error that's neither a login problem nor transient, so the next run tries again.
    s.fake.breakItem(a.fakeItem.itemId, { status: 400, error_type: 'INVALID_REQUEST', error_code: 'INVALID_FIELD' });
    expect(await s.bank.syncAll()).toEqual({ total: 3, done: 1, skipped: 1, failed: 1 });
    expect(rows(s)).toHaveLength(1);

    await expect(jobsOf(s).get('spend.transactionsSync')!.run()).rejects.toThrow(
      "Couldn't sync transactions for 1 of 3 banks through Plaid. Spend settings shows each bank's status.",
    );
    s.fake.repairItem(a.fakeItem.itemId);
    await jobsOf(s).get('spend.transactionsSync')!.run();
  });

  it('skips both scheduled runs during a key mismatch, logged as skipped, instead of failing every Item (review C-S-M5)', async () => {
    const s = setup();
    await linkBank(s, [CARD_A]);
    await linkBank(s, [CARD_B]);
    // As if TOKEN_ENCRYPTION_KEY had failed its check at start.
    (s.plaid as unknown as { keyMismatchNow: boolean }).keyMismatchNow = true;
    const calls = s.fake.requests.length;
    expect(await s.bank.syncAll()).toEqual({ total: 2, done: 0, skipped: 2, failed: 0 });
    expect(await s.bank.refreshAllLiabilities()).toEqual({ total: 2, done: 0, skipped: 2, failed: 0 });
    const job = { db: s.t.db, clock: s.t.clock, logger: s.log.logger };
    await runJob(job, jobsOf(s).get('spend.transactionsSync')!);
    await runJob(job, jobsOf(s).get('spend.statementsSync')!);
    expect(s.t.db.select().from(jobErrors).all()).toEqual([]);
    expect(s.fake.requests.length).toBe(calls);
    expect(s.log.lines.filter((l) => l.msg === 'plaid scheduled run skipped').map((l) => [l.kind, l.outcome, l.reason])).toEqual([
      ['sync', 'skipped', 'key_mismatch'], ['liabilities', 'skipped', 'key_mismatch'], ['sync', 'skipped', 'key_mismatch'], ['liabilities', 'skipped', 'key_mismatch'],
    ]);
    expect(s.log.lines.some((l) => l.msg === 'plaid scheduled run failed for an item')).toBe(false);
  });

  it('stops between Items once the scheduler stops', async () => {
    const s = setup();
    await linkBank(s, [CARD_A]);
    const stopped = new AbortController();
    stopped.abort();
    expect(await s.bank.syncAll({ signal: stopped.signal })).toEqual({ total: 1, done: 0, skipped: 0, failed: 0 });
    await runJob({ db: s.t.db, clock: s.t.clock, logger: s.log.logger }, jobsOf(s).get('spend.transactionsSync')!, stopped.signal);
    expect(s.fake.count('/transactions/sync')).toBe(0);
    expect(s.t.db.select().from(jobErrors).all()).toHaveLength(0);
  });

  it('gets statements for every Item daily, with a plain error when one fails', async () => {
    const s = setup();
    const { fakeItem, accountIds } = await linkBank(s);
    s.fake.setLiability(fakeItem.itemId, accountIds[0]!, { last_statement_issue_date: '2026-11-05' });
    await jobsOf(s).get('spend.statementsSync')!.run();
    expect(s.t.db.select().from(statements).all()).toHaveLength(1);
    for (let i = 0; i < 3; i++) s.fake.failNext('/liabilities/get', FAKE_PLAID_ERRORS.INTERNAL_SERVER_ERROR);
    await expect(jobsOf(s).get('spend.statementsSync')!.run()).rejects.toThrow("Couldn't get statements for 1 of 1 bank through Plaid.");
  });

  it('prunes removed transactions past 7 days and expired link pendings', async () => {
    const s = setup();
    const { cardIds } = await linkBank(s);
    const now = s.t.clock.now();
    const old = new Date(now.getTime() - REMOVED_KEEP_MS - 1);
    const base = { cardId: cardIds[0]!, source: 'plaid' as const, date: '2026-11-01', amountCents: 100, rawName: 'X', categoryId: 1, categorySource: 'default' as const, personSource: 'default' as const, createdAt: now, updatedAt: now };
    s.t.db.insert(transactions).values([
      { ...base, plaidTransactionId: 'tx-old', removedAt: old, deletedAt: old },
      { ...base, plaidTransactionId: 'tx-recent', removedAt: now, deletedAt: now },
    ]).run();
    await s.plaid.createLinkToken(s.admin, 'session-z', {});
    s.t.clock.advance(31 * 60_000);
    await jobsOf(s).get('spend.pruneRemoved')!.run();
    expect(rows(s).map((r) => r.plaidTransactionId)).toEqual(['tx-recent']);
    expect(s.t.db.select().from(plaidLinkPending).all()).toHaveLength(0);
    expect(s.log.lines.find((l) => l.msg === 'pruned removed plaid rows')).toMatchObject({ transactions: 1, pending: 1 });
  });

  it('retries removals hourly and makes giving up a job error', async () => {
    const s = setup();
    const { itemId } = await linkBank(s);
    s.fake.failNext('/item/remove', FAKE_PLAID_ERRORS.INTERNAL_SERVER_ERROR);
    await s.plaid.remove(s.admin, itemId, { deleteTransactions: false });
    s.t.db.update(pendingRevocations).set({ attempts: REVOCATION_ATTEMPTS - 1 }).run();
    s.fake.failNext('/item/remove', FAKE_PLAID_ERRORS.INTERNAL_SERVER_ERROR);
    await expect(jobsOf(s).get('spend.plaidRevocations')!.run()).rejects.toThrow("Gave up ending the dashboard's Plaid connection for a removed bank.");
  });
});

describe("Savings Items in Spend's sync", () => {
  /** A linked Item made Savings', with its connection, as the exchange makes one for a Savings link. */
  function savingsItem(s: Setup): { id: number; plaidItemId: string } {
    const fake = s.fake.createItem({ institution: { institution_id: 'ins_fake_savings', name: 'Example Brokerage' }, accounts: [{ name: 'Cash', type: 'depository', subtype: 'cash management' }] });
    const now = s.t.clock.now();
    const item = s.t.db.transaction((tx) => {
      const conn = insertFamilyConnection(tx, singleKeyring(TEST_ENCRYPTION_KEY), { kind: 'plaid', ownerUserId: s.admin, meta: { itemId: fake.itemId }, now }, { accessToken: fake.accessToken });
      return tx.insert(plaidItems).values({ connectionId: conn.id, plaidItemId: fake.itemId, purpose: 'savings', pickedAt: now, accounts: [], createdAt: now, updatedAt: now }).returning().get();
    });
    return { id: item.id, plaidItemId: fake.itemId };
  }

  it("are never synced, read for statements, or counted by Spend's jobs", async () => {
    const s = setup();
    const savings = savingsItem(s);
    expect(await s.bank.syncAll()).toEqual({ total: 0, done: 0, skipped: 0, failed: 0 });
    expect(await s.bank.refreshAllLiabilities()).toEqual({ total: 0, done: 0, skipped: 0, failed: 0 });
    expect(await s.bank.syncItem(savings.id, { reason: 'refresh', ignoreBackoff: true })).toEqual({ status: 'skipped', reason: 'removed' });
    expect(s.fake.count('/transactions/sync')).toBe(0);
  });

  it("hand a Savings Item's new-data webhooks to Savings, and handle its ITEM codes as for any bank", async () => {
    const s = setup();
    const savings = savingsItem(s);
    for (const [type, code] of [['TRANSACTIONS', 'SYNC_UPDATES_AVAILABLE'], ['HOLDINGS', 'DEFAULT_UPDATE'], ['INVESTMENTS_TRANSACTIONS', 'DEFAULT_UPDATE']] as const) {
      expect(s.bank.handleWebhook({ webhook_type: type, webhook_code: code, item_id: savings.plaidItemId, environment: 'sandbox' })).toBe('sync');
    }
    expect(s.savings.syncSoon).toHaveBeenCalledTimes(3);
    expect(s.savings.syncSoon).toHaveBeenCalledWith(savings.id);
    expect(s.bank.handleWebhook({ webhook_type: 'LIABILITIES', webhook_code: 'DEFAULT_UPDATE', item_id: savings.plaidItemId, environment: 'sandbox' })).toBe('ignored');
    s.plaid.markNeedsReconnect(savings.id, 'ITEM_LOGIN_REQUIRED');
    expect(s.bank.handleWebhook({ webhook_type: 'ITEM', webhook_code: 'LOGIN_REPAIRED', item_id: savings.plaidItemId, environment: 'sandbox' })).toBe('repaired');
    expect(s.savings.syncSoon).toHaveBeenCalledTimes(4);
    expect(s.bank.handleReplayedWebhook({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: savings.plaidItemId, environment: 'sandbox' })).toBe('sync');
    expect(s.savings.syncSoon).toHaveBeenCalledTimes(5);
    await s.bank.idle();
    expect(s.fake.count('/transactions/sync')).toBe(0);
  });

  it('ignore HOLDINGS and INVESTMENTS_TRANSACTIONS for a Spend Item, as before', () => {
    const s = setup();
    const fake = s.fake.createItem();
    const now = s.t.clock.now();
    s.t.db.transaction((tx) => {
      const conn = insertFamilyConnection(tx, singleKeyring(TEST_ENCRYPTION_KEY), { kind: 'plaid', ownerUserId: s.admin, meta: { itemId: fake.itemId }, now }, { accessToken: fake.accessToken });
      tx.insert(plaidItems).values({ connectionId: conn.id, plaidItemId: fake.itemId, pickedAt: now, accounts: [], createdAt: now, updatedAt: now }).run();
    });
    expect(s.bank.handleWebhook({ webhook_type: 'HOLDINGS', webhook_code: 'DEFAULT_UPDATE', item_id: fake.itemId, environment: 'sandbox' })).toBe('ignored');
    expect(s.bank.handleWebhook({ webhook_type: 'INVESTMENTS_TRANSACTIONS', webhook_code: 'DEFAULT_UPDATE', item_id: fake.itemId, environment: 'sandbox' })).toBe('ignored');
    expect(s.savings.syncSoon).not.toHaveBeenCalled();
  });
});
