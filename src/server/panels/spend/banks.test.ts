import { eq } from 'drizzle-orm';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { BANK_MESSAGES, PLAID_MESSAGES, type BanksView } from '../../../shared/plaid.js';
import { BANK_STALE_AFTER_MS, SPEND_MESSAGES, type Card, type ImportPreview, type ImportResult, type SpendOverview, type SpendSummary } from '../../../shared/spend.js';
import type { ConnectionSummary } from '../../../shared/integrations.js';
import { cards, categories, connections, csvImports, pendingRevocations, plaidItems, transactions } from '../../db/schema.js';
import { FAKE_PLAID_ERRORS, type FakeAccountInput } from '../../test/fakePlaid.js';
import { bofaCsv, bytes, reference } from '../../test/bofaCsv.js';
import { addUser, call, cookieFor, makeTestApp, TEST_BASE_URL, type TestApp } from '../../test/helpers.js';
import { linkSavingsForTest } from '../../test/savingsFixtures.js';
import { addCard, addCsvImport, addTransaction, spendUser } from '../../test/spendFixtures.js';
import { BANK_REQUEST_DEADLINE_MS, newCardName } from './banks.js';

// Everything here is synthetic: the institution, accounts, masks, merchants, and tokens.
// The test app's clock is 2026-11-15 12:00 UTC.
const P = '/api/panels/spend';
const BANK = { institution_id: 'ins_fake_bank', name: 'Example Bank' };
const REWARDS: FakeAccountInput = { name: 'Example Rewards', mask: '1111' };
const CASH: FakeAccountInput = { name: 'Example Cash Back', mask: '2222' };
const TRAVEL: FakeAccountInput = { name: 'Example Travel', mask: '3333' };

async function json<T>(res: Response, status = 200): Promise<T> {
  expect(res.status, await res.clone().text()).toBe(status);
  return (await res.json()) as T;
}

function setup(opts: { plaid?: boolean; keyMismatch?: boolean; logger?: pino.Logger; budgetMs?: number } = {}) {
  const t = makeTestApp({ plaid: opts.plaid ?? true, keyMismatch: opts.keyMismatch, logger: opts.logger, plaidRequestBudgetMs: opts.budgetMs });
  const admin = spendUser(t, { role: 'admin', email: 'alex@example.com', name: 'Alex' });
  return { t, admin };
}
type Setup = ReturnType<typeof setup>;

/** Connects a bank through the Link calls and the fake's Link, as the Link page does. Returns its local id and the fake's accounts. */
async function connect(s: Setup, accounts: FakeAccountInput[] = [REWARDS, CASH, TRAVEL]) {
  const res = await call(s.t.app, 'POST', '/connect/plaid/link-token', { cookie: s.admin.cookie, body: {} });
  const { linkToken } = await json<{ linkToken: string }>(res);
  const { publicToken, metadata } = s.t.fakePlaid.completeLink(linkToken, { institution: BANK, accounts });
  const { next } = await json<{ next: string }>(await call(s.t.app, 'POST', '/connect/plaid/exchange', { cookie: s.admin.cookie, body: { publicToken, metadata } }));
  const bankId = Number(new URL(next, 'http://x').searchParams.get('bank'));
  const fakeItem = s.t.fakePlaid.item(s.t.plaid!.item(bankId)!.plaidItemId);
  const ids = fakeItem.accounts.map((a) => a.account_id);
  return { bankId, fakeItem, ids };
}

const view = async (s: Setup) => json<BanksView>(await call(s.t.app, 'GET', `${P}/banks`, { cookie: s.admin.cookie }));
const pick = (s: Setup, bankId: number, accounts: unknown[]) => call(s.t.app, 'POST', `${P}/banks/${bankId}/accounts`, { cookie: s.admin.cookie, body: { accounts } });
const refresh = (s: Setup, bankId: number) => call(s.t.app, 'POST', `${P}/banks/${bankId}/refresh`, { cookie: s.admin.cookie });
const loadAccounts = (s: Setup, bankId: number) => call(s.t.app, 'POST', `${P}/banks/${bankId}/load-accounts`, { cookie: s.admin.cookie });
const remove = (s: Setup, bankId: number, deleteTransactions = false) =>
  call(s.t.app, 'POST', `${P}/banks/${bankId}/remove`, { cookie: s.admin.cookie, body: { deleteTransactions } });

function itemRow(t: TestApp, id: number) {
  return t.db.select().from(plaidItems).where(eq(plaidItems.id, id)).get()!;
}
function card(t: TestApp, id: number) {
  return t.db.select().from(cards).where(eq(cards.id, id)).get()!;
}
function rowsOn(t: TestApp, cardId: number) {
  return t.db.select().from(transactions).where(eq(transactions.cardId, cardId)).all();
}

describe('Spend settings: banks without Plaid', () => {
  it('are a 404 when Plaid is not configured', async () => {
    const s = setup({ plaid: false });
    expect(await json(await call(s.t.app, 'GET', `${P}/banks`, { cookie: s.admin.cookie }), 404)).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
    expect((await pick(s, 1, [])).status).toBe(404);
    expect((await refresh(s, 1)).status).toBe(404);
    expect((await remove(s, 1)).status).toBe(404);
    expect((await loadAccounts(s, 1)).status).toBe(404);
  });
});

describe('Spend settings: banks under a key mismatch', () => {
  it('refuses the pick and loading accounts with the plain key message, and says so in the view', async () => {
    const s = setup({ keyMismatch: true });
    expect((await view(s)).keyMismatch).toBe(true);
    const refused = { error: { code: 'integration_unavailable', message: PLAID_MESSAGES.keyMismatch } };
    expect(await json(await pick(s, 1, []), 503)).toEqual(refused);
    expect(await json(await loadAccounts(s, 1), 503)).toEqual(refused);
    expect(await json(await remove(s, 1), 503)).toEqual(refused);
    expect(s.t.fakePlaid.requests).toEqual([]);
  });
});

describe('Spend settings: banks', () => {
  it('are for admins with the Spend panel, behind the CSRF check', async () => {
    const s = setup();
    const { bankId } = await connect(s);
    const member = spendUser(s.t, { role: 'member' });
    const noPanel = cookieFor(s.t.db, s.t.clock, addUser(s.t.db, s.t.clock, { email: 'a2@example.com', role: 'admin', panels: ['todo'] }));
    for (const [method, path] of [
      ['GET', '/banks'], ['POST', `/banks/${bankId}/accounts`], ['POST', `/banks/${bankId}/refresh`], ['POST', `/banks/${bankId}/remove`], ['POST', `/banks/${bankId}/load-accounts`],
    ] as const) {
      const body = method === 'GET' ? undefined : {};
      expect((await call(s.t.app, method, `${P}${path}`, { body })).status).toBe(401);
      expect((await call(s.t.app, method, `${P}${path}`, { cookie: member.cookie, body })).status).toBe(403);
      expect((await call(s.t.app, method, `${P}${path}`, { cookie: noPanel, body })).status).toBe(403);
    }
    expect((await call(s.t.app, 'POST', `${P}/banks/${bankId}/remove`, { cookie: s.admin.cookie, body: { deleteTransactions: false }, csrf: false })).status).toBe(403);
    expect(itemRow(s.t, bankId).removedAt).toBeNull();
  });

  it('lists a new bank waiting for the pick, with the Trial count, suggestions by last 4, and the cards it could go on', async () => {
    const s = setup();
    const costco = addCard(s.t, { nickname: 'Costco Visa', mask: '1111' });
    const archived = addCard(s.t, { nickname: 'Old Visa', mask: '2222', archivedAt: s.t.clock.now() });
    const twin1 = addCard(s.t, { nickname: 'Twin A', mask: '3333' });
    const twin2 = addCard(s.t, { nickname: 'Twin B', mask: '3333' });
    const { bankId, ids, fakeItem } = await connect(s);
    s.t.fakePlaid.setConsentExpiration(fakeItem.itemId, '2027-11-15T12:00:00Z');
    const v = await view(s);
    expect(v).toMatchObject({ configured: true, keyMismatch: false, serverNow: '2026-11-15T12:00:00.000Z', trial: { used: 1, limit: 10 }, removed: [], notices: [], message: null });
    // Archived cards can't take an account.
    expect(v.attachableCards.map((c) => c.id)).toEqual([costco.id, twin1.id, twin2.id]);
    expect(v.attachableCards.map((c) => c.id)).not.toContain(archived.id);
    expect(v.banks).toEqual([
      {
        id: bankId, institutionName: 'Example Bank', status: 'ok', lastError: null, fix: null, lastSuccessAt: '2026-11-15T12:00:00.000Z', lastSyncAt: null,
        needsPick: true,
        picked: false,
        accountsLoaded: true,
        accounts: [
          { accountId: ids[0], name: 'Example Rewards', officialName: null, mask: '1111', subtype: 'credit card', state: 'waiting', card: null, suggestedCardId: costco.id },
          // Only an archived card has 2222, and two cards have 3333: no suggestion.
          { accountId: ids[1], name: 'Example Cash Back', officialName: null, mask: '2222', subtype: 'credit card', state: 'waiting', card: null, suggestedCardId: null },
          { accountId: ids[2], name: 'Example Travel', officialName: null, mask: '3333', subtype: 'credit card', state: 'waiting', card: null, suggestedCardId: null },
        ],
        missingCards: [], consentExpiresAt: null, disconnectAt: null, newAccountsAt: null,
      },
    ]);
    // Nothing is synced before the pick (departure 2).
    expect(s.t.fakePlaid.count('/transactions/sync')).toBe(0);
  });

  it('saves the pick (attach, create, skip) and runs the first sync in the request, replacing the CSV rows it matches', async () => {
    const s = setup();
    const costco = addCard(s.t, { nickname: 'Costco Visa', mask: '1111', usualClosingDay: 15, isoCurrencyCode: 'USD' });
    const csv = addTransaction(s.t, costco.id, { rawName: 'SYNTHETIC COFFEE', amountCents: 1_274, date: '2026-11-10', csvReference: '24692166310100000000001' });
    const { bankId, ids, fakeItem } = await connect(s);
    s.t.fakePlaid.addTransaction(fakeItem.itemId, { account_id: ids[0]!, amount: 12.74, name: 'SYNTHETIC COFFEE', date: '2026-11-10' });
    s.t.fakePlaid.addTransaction(fakeItem.itemId, { account_id: ids[1]!, amount: 40, name: 'SYNTHETIC BOOKS', date: '2026-11-11' });
    s.t.fakePlaid.addTransaction(fakeItem.itemId, { account_id: ids[2]!, amount: 99, name: 'SYNTHETIC SKIPPED', date: '2026-11-12' });
    s.t.clock.advance(60_000);

    const v = await json<BanksView>(await pick(s, bankId, [
      { accountId: ids[0], action: 'attach', cardId: costco.id },
      { accountId: ids[1], action: 'create' },
      { accountId: ids[2], action: 'skip' },
    ]));
    const bank = v.banks[0]!;
    expect(bank).toMatchObject({ needsPick: false, status: 'ok', lastError: null, lastSyncAt: s.t.clock.now().toISOString(), lastSuccessAt: s.t.clock.now().toISOString() });
    expect(bank.accounts.map((a) => [a.state, a.card?.nickname ?? null])).toEqual([['attached', 'Costco Visa'], ['attached', 'Example Cash Back'], ['skipped', null]]);
    expect(itemRow(s.t, bankId)).toMatchObject({ pickedAt: s.t.clock.now(), cursor: expect.any(String) });
    expect(s.t.fakePlaid.count('/transactions/sync')).toBe(1);

    // The existing card keeps its name and settings and takes the account.
    expect(card(s.t, costco.id)).toMatchObject({
      nickname: 'Costco Visa', mask: '1111', included: true, usualClosingDay: 15, plaidItemId: bankId, plaidAccountId: ids[0], plaidName: 'Example Rewards',
      plaidType: 'credit', plaidSubtype: 'credit card', isoCurrencyCode: 'USD', removedAt: null,
    });
    // The new card is excluded until the admin includes it, and named from Plaid.
    const created = s.t.db.select().from(cards).where(eq(cards.plaidAccountId, ids[1]!)).get()!;
    expect(created).toMatchObject({ nickname: 'Example Cash Back', mask: '2222', included: false, usualClosingDay: null, plaidItemId: bankId });
    expect(v.attachableCards).toEqual([]);

    // The Plaid row replaced the CSV one; the skipped account's transaction was dropped.
    const onCostco = rowsOn(s.t, costco.id);
    const plaidRow = onCostco.find((r) => r.source === 'plaid')!;
    expect(plaidRow).toMatchObject({ amountCents: 1_274, deletedAt: null });
    expect(onCostco.find((r) => r.id === csv.id)).toMatchObject({ replacedById: plaidRow.id, deletedAt: s.t.clock.now() });
    expect(rowsOn(s.t, created.id).map((r) => r.rawName)).toEqual(['SYNTHETIC BOOKS']);
    expect(s.t.db.select().from(transactions).all().some((r) => r.rawName === 'SYNTHETIC SKIPPED')).toBe(false);
  });

  it('refuses a pick that leaves an account undecided, or names one it can not take, and saves nothing', async () => {
    const s = setup();
    const costco = addCard(s.t, { nickname: 'Costco Visa', mask: '1111' });
    const archived = addCard(s.t, { nickname: 'Old', mask: null, archivedAt: s.t.clock.now() });
    const other = await connect(s, [{ name: 'Other Bank Card', mask: '9999' }]);
    // Another bank is still linked on this card.
    await json(await pick(s, other.bankId, [{ accountId: other.ids[0], action: 'attach', cardId: costco.id }]));
    const { bankId, ids } = await connect(s, [REWARDS, CASH]);
    const free = addCard(s.t, { nickname: 'Free', mask: null });
    const before = s.t.db.select().from(cards).all();

    const cases: [unknown[], number, string][] = [
      [[{ accountId: ids[0], action: 'skip' }], 400, BANK_MESSAGES.decideEvery],
      [[{ accountId: ids[0], action: 'skip' }, { accountId: 'acct-not-here', action: 'skip' }, { accountId: ids[1], action: 'skip' }], 404, BANK_MESSAGES.accountNotListed],
      [[{ accountId: ids[0], action: 'attach', cardId: archived.id }, { accountId: ids[1], action: 'skip' }], 400, SPEND_MESSAGES.cardArchived],
      [[{ accountId: ids[0], action: 'attach', cardId: 999 }, { accountId: ids[1], action: 'skip' }], 400, SPEND_MESSAGES.cardNotFound],
      [[{ accountId: ids[0], action: 'attach', cardId: costco.id }, { accountId: ids[1], action: 'skip' }], 409, BANK_MESSAGES.cardTaken],
      [[{ accountId: ids[0], action: 'attach', cardId: free.id }, { accountId: ids[1], action: 'attach', cardId: free.id }], 400, BANK_MESSAGES.cardTwice],
      [[{ accountId: ids[0], action: 'skip' }, { accountId: ids[0], action: 'create' }, { accountId: ids[1], action: 'skip' }], 400, 'Each account can only be listed once.'],
      [[{ accountId: ids[0], action: 'attach' }, { accountId: ids[1], action: 'skip' }], 400, 'Pick a card from the list.'],
      [[{ accountId: ids[0], action: 'keep' }, { accountId: ids[1], action: 'skip' }], 400, 'Choose a card, a new card, or Skip for each account.'],
    ];
    for (const [accounts, status, message] of cases) {
      expect(await json(await pick(s, bankId, accounts), status), JSON.stringify(accounts)).toEqual({ error: { code: expect.any(String), message } });
    }
    expect(s.t.db.select().from(cards).all()).toEqual(before);
    expect(itemRow(s.t, bankId)).toMatchObject({ pickedAt: null });
    expect((await pick(s, 999, [])).status).toBe(404);
    expect((await call(s.t.app, 'POST', `${P}/banks/abc/accounts`, { cookie: s.admin.cookie, body: { accounts: [] } })).status).toBe(404);
  });

  it("saves the pick under the bank's lock, so it never lands in the middle of a sync run", async () => {
    const s = setup();
    const { bankId, ids } = await connect(s, [REWARDS]);
    let release: (() => void) | undefined;
    // Stands in for a sync run holding the lock.
    const held = s.t.plaid!.underLock(bankId, () => new Promise<void>((resolve) => { release = resolve; }));
    const saving = pick(s, bankId, [{ accountId: ids[0], action: 'create' }]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(itemRow(s.t, bankId).pickedAt).toBeNull();
    release!();
    await held;
    await json(await saving);
    expect(itemRow(s.t, bankId).pickedAt).toEqual(s.t.clock.now());
  });

  it("keeps the pick when the first sync fails, and shows the failure on the bank", async () => {
    const s = setup();
    const { bankId, ids, fakeItem } = await connect(s, [REWARDS]);
    s.t.clock.advance(60_000);
    // A transient failure: one call and both retries.
    for (let i = 0; i < 3; i++) s.t.fakePlaid.failNext('/transactions/sync', FAKE_PLAID_ERRORS.INTERNAL_SERVER_ERROR);
    let v = await json<BanksView>(await pick(s, bankId, [{ accountId: ids[0], action: 'create' }]));
    // Still ok (it takes 3 in a row for error), but the failure came after the last success, so it's shown.
    expect(v.banks[0]).toMatchObject({ needsPick: false, status: 'ok', lastError: "Couldn't reach Plaid or the bank.", fix: null, lastSyncAt: null });
    expect(itemRow(s.t, bankId).pickedAt).toEqual(s.t.clock.now());

    // A login problem: Reconnect.
    s.t.fakePlaid.breakItem(fakeItem.itemId);
    s.t.clock.advance(60_000);
    expect((await refresh(s, bankId)).status).toBe(503);
    v = await view(s);
    expect(v.banks[0]).toMatchObject({ status: 'needs_reconnect', lastError: 'The bank needs you to sign in again.', fix: 'reconnect' });
    expect(await json(await refresh(s, bankId), 503)).toEqual({ error: { code: 'integration_unavailable', message: PLAID_MESSAGES.reconnect } });

    // An Item Plaid no longer has: only Remove fixes it.
    s.t.db.update(connections).set({ lastError: PLAID_MESSAGES.gone }).where(eq(connections.id, itemRow(s.t, bankId).connectionId!)).run();
    expect((await view(s)).banks[0]).toMatchObject({ fix: 'remove', lastError: PLAID_MESSAGES.gone });
    expect(await json(await refresh(s, bankId), 503)).toEqual({ error: { code: 'integration_unavailable', message: PLAID_MESSAGES.gone } });
  });

  it('offers Reconnect and Remove when access was revoked at the bank (USER_PERMISSION_REVOKED)', async () => {
    const s = setup();
    const { bankId, ids, fakeItem } = await connect(s, [REWARDS]);
    await json(await pick(s, bankId, [{ accountId: ids[0], action: 'create' }]));
    expect(s.t.bank!.handleWebhook({ webhook_type: 'ITEM', webhook_code: 'USER_PERMISSION_REVOKED', item_id: fakeItem.itemId, environment: 'sandbox' }))
      .toBe('needs_reconnect');
    expect((await view(s)).banks[0]).toMatchObject({ status: 'needs_reconnect', fix: 'reconnect_or_remove' });
    // A plain login problem later is Reconnect only.
    s.t.plaid!.setLastWebhookCode(bankId, 'ITEM:ERROR');
    expect((await view(s)).banks[0]).toMatchObject({ fix: 'reconnect' });
  });

  it('hides an old failure once a success came after it', async () => {
    const s = setup();
    const { bankId, ids } = await connect(s, [REWARDS]);
    s.t.clock.advance(60_000);
    for (let i = 0; i < 3; i++) s.t.fakePlaid.failNext('/transactions/sync', FAKE_PLAID_ERRORS.INTERNAL_SERVER_ERROR);
    await json(await pick(s, bankId, [{ accountId: ids[0], action: 'create' }]));
    s.t.clock.advance(60_000);
    const v = await json<BanksView>(await refresh(s, bankId));
    expect(v.banks[0]).toMatchObject({ status: 'ok', lastError: null, lastSyncAt: s.t.clock.now().toISOString() });
    // The message is still stored (spec §8 keeps it); it just isn't shown.
    expect(s.t.db.select().from(connections).get()!.lastError).toBe("Couldn't reach Plaid or the bank.");
  });

  it('attaches a skipped account later: the sync catches up, then brings its whole history', async () => {
    const s = setup();
    const { bankId, ids, fakeItem } = await connect(s, [REWARDS, CASH]);
    s.t.fakePlaid.addTransaction(fakeItem.itemId, { account_id: ids[0]!, amount: 10, name: 'SYNTHETIC ONE', date: '2026-11-01' });
    s.t.fakePlaid.addTransaction(fakeItem.itemId, { account_id: ids[1]!, amount: 20, name: 'SYNTHETIC TWO', date: '2026-11-02' });
    await json(await pick(s, bankId, [{ accountId: ids[0], action: 'create' }, { accountId: ids[1], action: 'skip' }]));
    expect(s.t.db.select().from(transactions).all().map((r) => r.rawName)).toEqual(['SYNTHETIC ONE']);
    const pickedAt = itemRow(s.t, bankId).pickedAt;
    // Picked once, so it can be refreshed, even while an account waits (G4-M4).
    expect((await view(s)).banks[0]).toMatchObject({ picked: true });

    // An attached account can't be picked again; an empty pick changes nothing and syncs nothing.
    expect(await json(await pick(s, bankId, [{ accountId: ids[0], action: 'skip' }]), 409)).toEqual({ error: { code: 'conflict', message: BANK_MESSAGES.accountAttached } });
    await json(await pick(s, bankId, []));
    expect(s.t.fakePlaid.count('/transactions/sync')).toBe(1);

    s.t.clock.advance(60_000);
    const v = await json<BanksView>(await pick(s, bankId, [{ accountId: ids[1], action: 'create' }]));
    expect(v.banks[0]!.accounts.map((a) => a.state)).toEqual(['attached', 'attached']);
    expect(v.banks[0]).toMatchObject({ picked: true, needsPick: false });
    // The pick time stays the first one's.
    expect(itemRow(s.t, bankId).pickedAt).toEqual(pickedAt);
    const syncs = s.t.fakePlaid.requests.filter((r) => r.path === '/transactions/sync');
    // Brought current from the stored cursor first (review C-S-I1), then the whole history.
    expect(syncs).toHaveLength(3);
    expect(syncs[1]!.body.cursor).toEqual(expect.any(String));
    expect(syncs[2]!.body).not.toHaveProperty('cursor');
    // A full resync: the first account's row is upserted, not doubled.
    expect(s.t.db.select().from(transactions).all().map((r) => r.rawName).sort()).toEqual(['SYNTHETIC ONE', 'SYNTHETIC TWO']);
    expect(itemRow(s.t, bankId)).toMatchObject({ fullResyncAt: null, cursor: expect.any(String) });
  });

  describe('a full resync after attaching an account (review C-S-I1)', () => {
    /**
     * The reviewer's scenario: a bank synced with one account attached and one skipped, then, at
     * Plaid, a $50 posted row removed, a $30 pending row removed, and a $36 posted row added that
     * names no pending version. None of it synced yet when the admin attaches the skipped account.
     */
    async function queuedChanges(s: Setup) {
      const { bankId, ids, fakeItem } = await connect(s, [REWARDS, CASH]);
      const fake = s.t.fakePlaid;
      const posted50 = fake.addTransaction(fakeItem.itemId, { account_id: ids[0]!, amount: 50, name: 'SYNTHETIC GROCER', date: '2026-11-05' });
      const pending30 = fake.addTransaction(fakeItem.itemId, { account_id: ids[0]!, amount: 30, name: 'SYNTHETIC DINER', date: '2026-11-12', pending: true });
      fake.addTransaction(fakeItem.itemId, { account_id: ids[1]!, amount: 20, name: 'SYNTHETIC SKIPPED CARD', date: '2026-11-02' });
      await json(await pick(s, bankId, [{ accountId: ids[0], action: 'create' }, { accountId: ids[1], action: 'skip' }]));
      const cardA = s.t.db.select().from(cards).where(eq(cards.plaidAccountId, ids[0]!)).get()!;
      expect(rowsOn(s.t, cardA.id).map((r) => r.amountCents).sort()).toEqual([3_000, 5_000]);
      const cursor = itemRow(s.t, bankId).cursor;
      expect(cursor).toEqual(expect.any(String));

      fake.removeTransaction(posted50.transaction_id);
      fake.removeTransaction(pending30.transaction_id);
      fake.addTransaction(fakeItem.itemId, { account_id: ids[0]!, amount: 36, name: 'SYNTHETIC DINER', date: '2026-11-13' });
      s.t.clock.advance(60_000);
      return { bankId, ids, fakeItem, cardA, cursor };
    }

    const live = (s: Setup, cardId: number) => rowsOn(s.t, cardId).filter((r) => r.deletedAt === null);

    it('applies what Plaid queued since the stored cursor before the full resync, so only the $36 row is live', async () => {
      const s = setup();
      const { bankId, ids, cardA, cursor } = await queuedChanges(s);
      const before = s.t.fakePlaid.count('/transactions/sync');
      await json(await pick(s, bankId, [{ accountId: ids[1], action: 'create' }]));

      expect(live(s, cardA.id).map((r) => [r.amountCents, r.pending])).toEqual([[3_600, false]]);
      // The removed rows are soft-deleted, kept 7 days for carry-over, not lost.
      expect(rowsOn(s.t, cardA.id).filter((r) => r.removedAt !== null).map((r) => r.amountCents).sort()).toEqual([3_000, 5_000]);
      const cardB = s.t.db.select().from(cards).where(eq(cards.plaidAccountId, ids[1]!)).get()!;
      expect(live(s, cardB.id).map((r) => r.rawName)).toEqual(['SYNTHETIC SKIPPED CARD']);
      const syncs = s.t.fakePlaid.requests.filter((r) => r.path === '/transactions/sync').slice(before);
      expect(syncs.map((r) => r.body.cursor ?? null)).toEqual([cursor, null]);
      expect(itemRow(s.t, bankId)).toMatchObject({ fullResyncAt: null, cursor: expect.any(String) });
    });

    it("resets nothing when the catch-up pass fails: the cursor stays, the marker stays, and the next sync does both", async () => {
      const s = setup();
      const { bankId, ids, cardA, cursor } = await queuedChanges(s);
      const before = s.t.fakePlaid.count('/transactions/sync');
      // A transient failure: one call and both retries.
      for (let i = 0; i < 3; i++) s.t.fakePlaid.failNext('/transactions/sync', FAKE_PLAID_ERRORS.INTERNAL_SERVER_ERROR);
      await json(await pick(s, bankId, [{ accountId: ids[1], action: 'create' }]));

      // The pick is saved; no pass ran, and no request went out without a cursor.
      expect(itemRow(s.t, bankId)).toMatchObject({ cursor, fullResyncAt: s.t.clock.now() });
      const failed = s.t.fakePlaid.requests.filter((r) => r.path === '/transactions/sync').slice(before);
      expect(failed.every((r) => r.body.cursor === cursor)).toBe(true);
      expect(live(s, cardA.id).map((r) => r.amountCents).sort()).toEqual([3_000, 5_000]);

      s.t.clock.advance(60_000);
      await json(await refresh(s, bankId));
      expect(live(s, cardA.id).map((r) => [r.amountCents, r.pending])).toEqual([[3_600, false]]);
      expect(itemRow(s.t, bankId)).toMatchObject({ fullResyncAt: null });
      const after = s.t.fakePlaid.requests.filter((r) => r.path === '/transactions/sync').slice(before + failed.length);
      expect(after.map((r) => r.body.cursor ?? null)).toEqual([cursor, null]);
    });

    it("soft-deletes a live pending row the full resync doesn't return, and leaves a posted one alone", async () => {
      const s = setup();
      const { bankId, ids, fakeItem } = await connect(s, [REWARDS, CASH]);
      s.t.fakePlaid.addTransaction(fakeItem.itemId, { account_id: ids[0]!, amount: 12, name: 'SYNTHETIC KEPT', date: '2026-11-10', pending: true });
      await json(await pick(s, bankId, [{ accountId: ids[0], action: 'create' }, { accountId: ids[1], action: 'skip' }]));
      const cardA = s.t.db.select().from(cards).where(eq(cards.plaidAccountId, ids[0]!)).get()!;
      // Rows Plaid no longer has, with no removal queued for them (one lost before this fix, say).
      const base = { source: 'plaid' as const, plaidAccountId: ids[0]!, date: '2026-11-09' };
      const strayPending = addTransaction(s.t, cardA.id, { ...base, plaidTransactionId: 'tx-stray-pending', pending: true, rawName: 'SYNTHETIC STRAY', amountCents: 900 });
      const strayPosted = addTransaction(s.t, cardA.id, { ...base, plaidTransactionId: 'tx-stray-posted', rawName: 'SYNTHETIC STRAY', amountCents: 800 });
      s.t.clock.advance(60_000);
      await json(await pick(s, bankId, [{ accountId: ids[1], action: 'create' }]));

      const byId = new Map(rowsOn(s.t, cardA.id).map((r) => [r.id, r]));
      expect(byId.get(strayPending.id)).toMatchObject({ removedAt: s.t.clock.now(), deletedAt: s.t.clock.now() });
      // A posted row missing from a full pass is left alone: deleting it wrongly would be worse.
      expect(byId.get(strayPosted.id)).toMatchObject({ removedAt: null, deletedAt: null });
      expect(live(s, cardA.id).map((r) => r.rawName).sort()).toEqual(['SYNTHETIC KEPT', 'SYNTHETIC STRAY']);
    });
  });

  it('after a reconnect, keeps skipped accounts skipped, waits for new ones, and lists cards the bank stopped sharing', async () => {
    const s = setup();
    const { bankId, ids } = await connect(s, [REWARDS, CASH]);
    await json(await pick(s, bankId, [{ accountId: ids[0], action: 'create' }, { accountId: ids[1], action: 'skip' }]));
    const rewardsCard = s.t.db.select().from(cards).where(eq(cards.plaidAccountId, ids[0]!)).get()!;

    // Update mode with Account Select: the admin shares the skipped card and a new one, not the attached one.
    const res = await call(s.t.app, 'POST', '/connect/plaid/link-token', { cookie: s.admin.cookie, body: { itemId: bankId, addAccounts: true } });
    const { linkToken } = await json<{ linkToken: string }>(res);
    s.t.fakePlaid.completeLink(linkToken, { accounts: [{ ...CASH, account_id: ids[1] }, TRAVEL] });
    await json(await call(s.t.app, 'POST', '/connect/plaid/updated', { cookie: s.admin.cookie, body: {} }));
    await s.t.bank!.idle();

    const bank = (await view(s)).banks[0]!;
    expect(bank.needsPick).toBe(true);
    expect(bank.accounts.map((a) => [a.name, a.state])).toEqual([['Example Cash Back', 'skipped'], ['Example Travel', 'waiting']]);
    expect(bank.missingCards).toEqual([{ id: rewardsCard.id, nickname: rewardsCard.nickname, mask: '1111', archived: false }]);
    // Only the new account must be decided.
    const travel = bank.accounts[1]!.accountId;
    const after = await json<BanksView>(await pick(s, bankId, [{ accountId: travel, action: 'skip' }]));
    expect(after.banks[0]!.needsPick).toBe(false);
  });

  it("repairs an account id the bank changed: the new id goes on the bank's own missing card, suggested by its last 4, without doubling the history", async () => {
    const s = setup();
    const costco = addCard(s.t, { nickname: 'Costco Visa', mask: '1111' });
    const lookalike = addCard(s.t, { nickname: 'Another 1111', mask: '1111' });
    const file = s.t.db.insert(csvImports)
      .values({ cardId: costco.id, fileSha256: 'synthetic', uploadedByUserId: s.admin.id, uploadedAt: s.t.clock.now(), rowCount: 1, importedCount: 1, skippedCount: 0 })
      .returning().get();
    const csv = addTransaction(s.t, costco.id, { rawName: 'SYNTHETIC COFFEE', amountCents: 1_274, date: '2026-11-10', csvReference: '24692166310100000000003', csvImportId: file.id });
    const { bankId, ids, fakeItem } = await connect(s, [REWARDS]);
    const purchase = { amount: 12.74, name: 'SYNTHETIC COFFEE', date: '2026-11-10' };
    s.t.fakePlaid.addTransaction(fakeItem.itemId, { account_id: ids[0]!, ...purchase });
    await json(await pick(s, bankId, [{ accountId: ids[0], action: 'attach', cardId: costco.id }]));
    const oldRow = rowsOn(s.t, costco.id).find((r) => r.source === 'plaid')!;
    expect(rowsOn(s.t, costco.id).find((r) => r.id === csv.id)).toMatchObject({ replacedById: oldRow.id });

    // Reconnected, the bank lists the same card under a new account id, and re-sends its history under it.
    const { linkToken } = await json<{ linkToken: string }>(await call(s.t.app, 'POST', '/connect/plaid/link-token', { cookie: s.admin.cookie, body: { itemId: bankId } }));
    s.t.fakePlaid.completeLink(linkToken, { accounts: [REWARDS] });
    await json(await call(s.t.app, 'POST', '/connect/plaid/updated', { cookie: s.admin.cookie, body: {} }));
    const newId = s.t.fakePlaid.item(fakeItem.itemId).accounts[0]!.account_id;
    expect(newId).not.toBe(ids[0]);
    s.t.fakePlaid.addTransaction(fakeItem.itemId, { account_id: newId, ...purchase });

    const bank = (await view(s)).banks[0]!;
    expect(bank.missingCards.map((c) => c.id)).toEqual([costco.id]);
    // The bank's own missing card wins over another attachable card with the same last 4.
    expect(bank.accounts).toEqual([expect.objectContaining({ accountId: newId, state: 'waiting', suggestedCardId: costco.id })]);
    expect((await view(s)).attachableCards.map((c) => c.id)).toEqual([lookalike.id]);

    const v = await json<BanksView>(await pick(s, bankId, [{ accountId: newId, action: 'attach', cardId: costco.id }]));
    expect(v.banks[0]).toMatchObject({ needsPick: false, missingCards: [] });
    // The old id stays on the Item's list, no longer listed, and is never offered.
    expect(itemRow(s.t, bankId).accounts!.map((a) => [a.accountId, a.listed ?? true])).toEqual([[newId, true], [ids[0], false]]);
    expect(v.banks[0]!.accounts.map((a) => a.accountId)).toEqual([newId]);
    expect(await json(await pick(s, bankId, [{ accountId: ids[0], action: 'create' }]), 404)).toEqual({ error: { code: 'not_found', message: BANK_MESSAGES.accountNotListed } });
    expect(card(s.t, costco.id)).toMatchObject({ plaidItemId: bankId, plaidAccountId: newId, removedAt: null });
    // The resync's row replaced the old id's row: one purchase, once.
    const live = rowsOn(s.t, costco.id).filter((r) => r.deletedAt === null);
    expect(live).toEqual([expect.objectContaining({ plaidAccountId: newId, rawName: 'SYNTHETIC COFFEE' })]);
    expect(rowsOn(s.t, costco.id).find((r) => r.id === oldRow.id)).toMatchObject({ replacedById: live[0]!.id });
    // Another bank's missing card can't take it, and a card on a linked account still can't.
    const other = await connect(s, [CASH]);
    expect(await json(await pick(s, other.bankId, [{ accountId: other.ids[0], action: 'attach', cardId: costco.id }]), 409))
      .toEqual({ error: { code: 'conflict', message: BANK_MESSAGES.cardTaken } });

    // Removed with its transactions: the rows under both ids go, and only the CSV row they replaced comes back.
    await json(await remove(s, bankId, true));
    expect(rowsOn(s.t, costco.id).map((r) => [r.id, r.source, r.deletedAt])).toEqual([[csv.id, 'csv', null]]);
  });

  it("drops the old id's pending rows when its card is repaired, so a posted row with another amount doesn't sit beside one", async () => {
    const s = setup();
    const costco = addCard(s.t, { nickname: 'Costco Visa', mask: '1111' });
    const { bankId, ids, fakeItem } = await connect(s, [REWARDS]);
    s.t.fakePlaid.addTransaction(fakeItem.itemId, { account_id: ids[0]!, amount: 20, name: 'SYNTHETIC DINER', date: '2026-11-12', pending: true });
    await json(await pick(s, bankId, [{ accountId: ids[0], action: 'attach', cardId: costco.id }]));
    const pendingRow = rowsOn(s.t, costco.id).find((r) => r.pending)!;
    expect(pendingRow).toMatchObject({ plaidAccountId: ids[0], deletedAt: null });

    // Reconnected under a new account id; the purchase has posted there with the tip added.
    const { linkToken } = await json<{ linkToken: string }>(await call(s.t.app, 'POST', '/connect/plaid/link-token', { cookie: s.admin.cookie, body: { itemId: bankId } }));
    s.t.fakePlaid.completeLink(linkToken, { accounts: [REWARDS] });
    await json(await call(s.t.app, 'POST', '/connect/plaid/updated', { cookie: s.admin.cookie, body: {} }));
    const newId = s.t.fakePlaid.item(fakeItem.itemId).accounts[0]!.account_id;
    s.t.fakePlaid.addTransaction(fakeItem.itemId, { account_id: newId, amount: 24, name: 'SYNTHETIC DINER', date: '2026-11-13' });
    await json(await pick(s, bankId, [{ accountId: newId, action: 'attach', cardId: costco.id }]));

    expect(rowsOn(s.t, costco.id).find((r) => r.id === pendingRow.id)).toMatchObject({ deletedAt: s.t.clock.now(), removedAt: s.t.clock.now() });
    expect(rowsOn(s.t, costco.id).filter((r) => r.deletedAt === null)).toEqual([expect.objectContaining({ plaidAccountId: newId, amountCents: 2_400, pending: false })]);
  });

  it("refuses an account id a removed bank's card still holds, saving nothing and logging it, rather than taking it from that card", async () => {
    const lines: Record<string, unknown>[] = [];
    const s = setup({ logger: pino({ level: 'info' }, { write: (l: string) => { lines.push(JSON.parse(l) as Record<string, unknown>); } }) });
    const costco = addCard(s.t, { nickname: 'Costco Visa', mask: '1111' });
    const travel = addCard(s.t, { nickname: 'Travel Visa', mask: '1111' });
    const first = await connect(s, [{ ...REWARDS, account_id: 'acct-reused-synthetic' }]);
    await json(await pick(s, first.bankId, [{ accountId: first.ids[0], action: 'attach', cardId: costco.id }]));
    await json(await remove(s, first.bankId, false));

    // UNVERIFIED that Plaid ever reuses an account id across Items; if it does, the pick says so.
    const again = await connect(s, [{ ...REWARDS, account_id: 'acct-reused-synthetic' }]);
    for (const choice of [{ action: 'attach', cardId: travel.id }, { action: 'create' }]) {
      expect(await json(await pick(s, again.bankId, [{ accountId: 'acct-reused-synthetic', ...choice }]), 409))
        .toEqual({ error: { code: 'conflict', message: BANK_MESSAGES.accountIdInUse } });
    }
    expect(card(s.t, costco.id)).toMatchObject({ plaidAccountId: 'acct-reused-synthetic', plaidItemId: first.bankId });
    expect(card(s.t, travel.id).plaidAccountId).toBeNull();
    expect(itemRow(s.t, again.bankId).pickedAt).toBeNull();
    expect(lines.filter((l) => l.msg === 'plaid account id already on another card; pick refused')).toEqual([
      expect.objectContaining({ itemId: again.bankId, cardId: costco.id }), expect.objectContaining({ itemId: again.bankId, cardId: costco.id }),
    ]);
    // The card that holds it can take it back.
    await json(await pick(s, again.bankId, [{ accountId: 'acct-reused-synthetic', action: 'attach', cardId: costco.id }]));
    expect(card(s.t, costco.id)).toMatchObject({ plaidAccountId: 'acct-reused-synthetic', plaidItemId: again.bankId, removedAt: null });
  });

  it("loads the accounts of a bank whose list couldn't be fetched, and refuses the pick until then", async () => {
    const s = setup();
    // A passing failure of /accounts/get after the exchange (one call and both retries): the bank is kept without accounts.
    for (let i = 0; i < 3; i++) s.t.fakePlaid.failNext('/accounts/get', FAKE_PLAID_ERRORS.INTERNAL_SERVER_ERROR);
    const { bankId, ids } = await connect(s, [REWARDS]);
    let bank = (await view(s)).banks[0]!;
    expect(bank).toMatchObject({ accountsLoaded: false, accounts: [], needsPick: true });
    expect(await json(await pick(s, bankId, []), 409)).toEqual({ error: { code: 'conflict', message: BANK_MESSAGES.loadAccountsFirst } });
    expect(itemRow(s.t, bankId).pickedAt).toBeNull();

    // A failure loading them is a plain message.
    for (let i = 0; i < 3; i++) s.t.fakePlaid.failNext('/accounts/get', FAKE_PLAID_ERRORS.INTERNAL_SERVER_ERROR);
    expect(await json(await loadAccounts(s, bankId), 503)).toEqual({ error: { code: 'integration_unavailable', message: PLAID_MESSAGES.unreachable } });

    const v = await json<BanksView>(await loadAccounts(s, bankId));
    bank = v.banks[0]!;
    expect(bank).toMatchObject({ accountsLoaded: true, needsPick: true, status: 'ok' });
    expect(bank.accounts).toEqual([expect.objectContaining({ accountId: ids[0], state: 'waiting' })]);
    expect(v.message).toBeNull();
    await json(await pick(s, bankId, [{ accountId: ids[0], action: 'create' }]));
    expect(itemRow(s.t, bankId).pickedAt).toEqual(s.t.clock.now());
    expect((await loadAccounts(s, 999)).status).toBe(404);
  });

  it('loads accounts when a sync saw an account the list lacks, which clears the notice once one is new', async () => {
    const s = setup();
    const { bankId, ids, fakeItem } = await connect(s, [REWARDS]);
    await json(await pick(s, bankId, [{ accountId: ids[0], action: 'create' }]));
    // The login now shares a second card, and its transactions come before the list is reloaded.
    const accounts = s.t.fakePlaid.item(fakeItem.itemId).accounts;
    const extra = { ...accounts[0]!, account_id: 'acct-synthetic-extra', name: 'Example Cash Back', mask: '2222' };
    accounts.push(extra);
    s.t.fakePlaid.addTransaction(fakeItem.itemId, { account_id: extra.account_id, amount: 8, name: 'SYNTHETIC NEW CARD', date: '2026-11-12' });
    await json(await refresh(s, bankId));
    expect((await view(s)).banks[0]).toMatchObject({ newAccountsAt: s.t.clock.now().toISOString(), needsPick: false });

    const v = await json<BanksView>(await loadAccounts(s, bankId));
    expect(v.banks[0]).toMatchObject({ newAccountsAt: null, needsPick: true });
    expect(v.banks[0]!.accounts.map((a) => [a.accountId, a.state])).toEqual([[ids[0], 'attached'], [extra.account_id, 'waiting']]);
    await json(await pick(s, bankId, [{ accountId: extra.account_id, action: 'create' }]));
    expect(s.t.db.select().from(transactions).all().map((r) => r.rawName).sort()).toEqual(['SYNTHETIC NEW CARD']);
  });

  it('limits Load accounts to 10 a minute per admin', async () => {
    const s = setup();
    const { bankId } = await connect(s, [REWARDS]);
    for (let i = 0; i < 10; i++) expect((await loadAccounts(s, bankId)).status).toBe(200);
    expect((await loadAccounts(s, bankId)).status).toBe(429);
    // Refresh has its own budget.
    expect((await refresh(s, bankId)).status).toBe(409);
  });

  it('refreshes now, ignoring the backoff, and refuses before the pick', async () => {
    const s = setup();
    const { bankId, ids, fakeItem } = await connect(s, [REWARDS]);
    expect(await json(await refresh(s, bankId), 409)).toEqual({ error: { code: 'conflict', message: BANK_MESSAGES.pickFirst } });
    await json(await pick(s, bankId, [{ accountId: ids[0], action: 'create' }]));
    s.t.db.update(plaidItems).set({ backoffUntil: new Date(s.t.clock.now().getTime() + 60 * 60_000) }).where(eq(plaidItems.id, bankId)).run();
    s.t.fakePlaid.addTransaction(fakeItem.itemId, { account_id: ids[0]!, amount: 5, name: 'SYNTHETIC LATER', date: '2026-11-14' });
    // A scheduled run would skip it.
    expect(await s.t.bank!.syncItem(bankId, { reason: 'scheduled' })).toEqual({ status: 'skipped', reason: 'backoff' });
    await json<BanksView>(await refresh(s, bankId));
    expect(s.t.db.select().from(transactions).all().map((r) => r.rawName)).toEqual(['SYNTHETIC LATER']);
    expect(itemRow(s.t, bankId).backoffUntil).toBeNull();
    expect((await refresh(s, 999)).status).toBe(404);
  });

  it('turns a Plaid failure on Refresh into a plain message', async () => {
    const s = setup();
    const { bankId, ids } = await connect(s, [REWARDS]);
    await json(await pick(s, bankId, [{ accountId: ids[0], action: 'create' }]));
    s.t.fakePlaid.failNext('/transactions/sync', FAKE_PLAID_ERRORS.INSTITUTION_DOWN);
    s.t.fakePlaid.failNext('/transactions/sync', FAKE_PLAID_ERRORS.INSTITUTION_DOWN);
    s.t.fakePlaid.failNext('/transactions/sync', FAKE_PLAID_ERRORS.INSTITUTION_DOWN);
    expect(await json(await refresh(s, bankId), 503)).toEqual({ error: { code: 'integration_unavailable', message: PLAID_MESSAGES.institution } });
  });

  it('saves the pick and leaves its sync to the background past the request deadline, which the lock wait shares', async () => {
    const s = setup();
    const { bankId, ids } = await connect(s, [REWARDS]);
    const underLock = vi.spyOn(s.t.plaid!, 'underLock');
    const syncItem = vi.spyOn(s.t.bank!, 'syncItem').mockResolvedValue({ status: 'deferred' });
    const syncSoon = vi.spyOn(s.t.bank!, 'syncSoon').mockImplementation(() => {});
    const before = Date.now();
    const v = await json<BanksView>(await pick(s, bankId, [{ accountId: ids[0], action: 'create' }]));
    expect(v.message).toBe('Saved. Syncing in the background.');
    expect(BANK_MESSAGES.pickDeferred).toBe(v.message);
    expect(itemRow(s.t, bankId).pickedAt).toEqual(s.t.clock.now());
    expect(syncSoon).toHaveBeenCalledWith(bankId);
    const deadline = syncItem.mock.calls[0]![1].deadline!;
    expect(underLock.mock.calls[0]![2]).toEqual({ deadline });
    expect(BANK_REQUEST_DEADLINE_MS).toBe(40_000);
    expect(deadline).toBeGreaterThanOrEqual(before + BANK_REQUEST_DEADLINE_MS);
    expect(deadline).toBeLessThanOrEqual(Date.now() + BANK_REQUEST_DEADLINE_MS);
    // GET never carries it.
    expect((await view(s)).message).toBeNull();
  });

  it('says Refresh goes on in the background past the request deadline', async () => {
    const s = setup();
    const { bankId, ids } = await connect(s, [REWARDS]);
    await json(await pick(s, bankId, [{ accountId: ids[0], action: 'create' }]));
    const syncItem = vi.spyOn(s.t.bank!, 'syncItem').mockResolvedValue({ status: 'deferred' });
    const syncSoon = vi.spyOn(s.t.bank!, 'syncSoon').mockImplementation(() => {});
    const before = Date.now();
    expect((await json<BanksView>(await refresh(s, bankId))).message).toBe(BANK_MESSAGES.refreshDeferred);
    expect(BANK_MESSAGES.refreshDeferred).toBe('Syncing in the background.');
    expect(syncSoon).toHaveBeenCalledWith(bankId);
    expect(syncItem.mock.calls[0]![1]).toMatchObject({ reason: 'refresh', ignoreBackoff: true });
    expect(syncItem.mock.calls[0]![1].deadline).toBeGreaterThanOrEqual(before + BANK_REQUEST_DEADLINE_MS);
    syncItem.mockRestore();
    // A Refresh that finishes in the request says nothing more.
    expect((await json<BanksView>(await refresh(s, bankId))).message).toBeNull();
  });

  describe('a request budget that really runs out (Plaid answering late)', () => {
    /** Short enough to overrun quickly, long enough for a call to start (it needs a second left). */
    const BUDGET_MS = 1_500;
    const connection = (s: Setup, bankId: number) => s.t.db.select().from(connections).where(eq(connections.id, itemRow(s.t, bankId).connectionId!)).get()!;
    async function picked(s: Setup) {
      const { bankId, ids, fakeItem } = await connect(s, [REWARDS]);
      await json(await pick(s, bankId, [{ accountId: ids[0], action: 'create' }]));
      return { bankId, ids, fakeItem };
    }

    it('Refresh: a sync page Plaid is slow to answer is cut off at the budget, nothing applied, the cursor kept, nothing recorded', async () => {
      const s = setup({ budgetMs: BUDGET_MS });
      const { bankId, ids, fakeItem } = await picked(s);
      s.t.fakePlaid.addTransaction(fakeItem.itemId, { account_id: ids[0]!, amount: 12, name: 'SYNTHETIC LATE PAGE', date: '2026-11-10' });
      const cursor = itemRow(s.t, bankId).cursor;
      const before = connection(s, bankId);
      // The background run is held back, to see what the request itself left.
      const syncSoon = vi.spyOn(s.t.bank!, 'syncSoon').mockImplementation(() => {});
      s.t.fakePlaid.hangNext('/transactions/sync');
      const started = Date.now();
      const v = await json<BanksView>(await refresh(s, bankId));
      expect(Date.now() - started).toBeLessThan(BUDGET_MS + 1_000);
      expect(v.message).toBe(BANK_MESSAGES.refreshDeferred);
      expect(syncSoon).toHaveBeenCalledWith(bankId);
      expect(s.t.db.select().from(transactions).all()).toEqual([]);
      expect(itemRow(s.t, bankId).cursor).toBe(cursor);
      expect(connection(s, bankId)).toEqual(before);
      // The next run, from the same cursor, gets it.
      expect(await s.t.bank!.syncItem(bankId, { reason: 'scheduled' })).toMatchObject({ status: 'synced', counts: { added: 1 } });
      expect(s.t.db.select().from(transactions).all().map((r) => r.rawName)).toEqual(['SYNTHETIC LATE PAGE']);
    });

    it("the pick: the lock wait shares the budget, and a sync page with too little left isn't asked for", async () => {
      const s = setup({ budgetMs: BUDGET_MS });
      const { bankId, ids } = await connect(s, [REWARDS]);
      // A sync holds the bank for most of the budget.
      const held = s.t.plaid!.underLock(bankId, () => new Promise<void>((resolve) => setTimeout(resolve, BUDGET_MS - 700)));
      const syncSoon = vi.spyOn(s.t.bank!, 'syncSoon').mockImplementation(() => {});
      const v = await json<BanksView>(await pick(s, bankId, [{ accountId: ids[0], action: 'create' }]));
      await held;
      expect(v.message).toBe(BANK_MESSAGES.pickDeferred);
      expect(syncSoon).toHaveBeenCalledWith(bankId);
      expect(itemRow(s.t, bankId)).toMatchObject({ pickedAt: s.t.clock.now(), lastSyncAt: null, cursor: null });
      // Under a second was left once the lock was free: the page was never asked for.
      expect(s.t.fakePlaid.count('/transactions/sync')).toBe(0);
    });

    it('Remove: a revocation Plaid is slow to confirm is queued, and the bank is removed inside the budget', async () => {
      const s = setup({ budgetMs: BUDGET_MS });
      const { bankId } = await picked(s);
      s.t.fakePlaid.hangNext('/item/remove');
      const started = Date.now();
      const v = await json<BanksView>(await remove(s, bankId));
      expect(Date.now() - started).toBeLessThan(BUDGET_MS + 1_000);
      expect(itemRow(s.t, bankId).removedAt).toEqual(s.t.clock.now());
      // The answer says Plaid didn't confirm it, and that it's tried again (G4-I4).
      expect(v.message).toBe(BANK_MESSAGES.removeUnconfirmed);
      expect(BANK_MESSAGES.removeUnconfirmed).toBe("Plaid didn't confirm it removed its access yet. The dashboard will keep trying every hour.");
      expect(s.t.db.select().from(pendingRevocations).all()).toEqual([expect.objectContaining({ kind: 'plaid', gaveUpAt: null, lastError: null })]);
    });

    it("Remove: a token that couldn't be read says Plaid wasn't asked, and where to end it instead", async () => {
      const s = setup();
      const { bankId } = await picked(s);
      vi.spyOn(s.t.plaid!, 'remove').mockResolvedValue({ revoked: false, revocation: 'not_asked', deletedTransactions: 0, restoredTransactions: 0 });
      const v = await json<BanksView>(await remove(s, bankId));
      expect(v.message).toBe(BANK_MESSAGES.removeNotAsked);
      expect(BANK_MESSAGES.removeNotAsked).toBe(
        "Plaid wasn't asked to end its access, because the saved connection couldn't be read. Remove the dashboard in the bank's connected apps settings, or at my.plaid.com.",
      );
    });

    it("Load accounts: Plaid's slow answer is cut off at the budget with a plain message, and isn't recorded as a failure", async () => {
      const s = setup({ budgetMs: BUDGET_MS });
      const { bankId } = await picked(s);
      const before = connection(s, bankId);
      s.t.fakePlaid.hangNext('/accounts/get');
      const started = Date.now();
      expect(await json(await loadAccounts(s, bankId), 503)).toEqual({ error: { code: 'integration_unavailable', message: PLAID_MESSAGES.outOfTime } });
      expect(Date.now() - started).toBeLessThan(BUDGET_MS + 1_000);
      expect(connection(s, bankId)).toEqual(before);
    });
  });

  it('refuses Remove as busy when a sync holds the bank past the request deadline', async () => {
    const s = setup();
    const { bankId } = await connect(s, [REWARDS]);
    let release!: () => void;
    const held = s.t.plaid!.underLock(bankId, () => new Promise<void>((resolve) => { release = resolve; }));
    const real = s.t.plaid!.remove.bind(s.t.plaid!);
    const passed: (number | undefined)[] = [];
    // The route's deadline is checked, then shortened so the test doesn't wait 40 s.
    vi.spyOn(s.t.plaid!, 'remove').mockImplementation((userId, itemId, opts) => {
      passed.push(opts.deadline);
      return real(userId, itemId, { ...opts, deadline: Date.now() + 20 });
    });
    const before = Date.now();
    const res = await remove(s, bankId);
    release();
    await held;
    expect(passed[0]).toBeGreaterThanOrEqual(before + BANK_REQUEST_DEADLINE_MS);
    expect(await json(res, 503)).toEqual({ error: { code: 'integration_unavailable', message: PLAID_MESSAGES.itemBusy } });
    expect(itemRow(s.t, bankId).removedAt).toBeNull();
    expect(s.t.fakePlaid.removals).toEqual([]);
  });

  it('limits Refresh to 10 a minute per admin', async () => {
    const s = setup();
    const { bankId, ids } = await connect(s, [REWARDS]);
    await json(await pick(s, bankId, [{ accountId: ids[0], action: 'create' }]));
    for (let i = 0; i < 10; i++) expect((await refresh(s, bankId)).status).toBe(200);
    expect((await refresh(s, bankId)).status).toBe(429);
    s.t.clock.advance(60_000);
    expect((await refresh(s, bankId)).status).toBe(200);
  });

  it('brings back a CSV row removed as a duplicate of a bank row that "Also delete its transactions" deletes', async () => {
    const s = setup();
    const costco = addCard(s.t, { nickname: 'Costco Visa', mask: '1111' });
    // Names the duplicate test doesn't call alike, so both stay as twins.
    const csv = addTransaction(s.t, costco.id, { date: '2026-11-03', amountCents: 3000, rawName: 'ALPHA SHOP 12', csvReference: '24692166310100000000003', csvImportId: addCsvImport(s.t, costco.id).id });
    const { bankId, ids, fakeItem } = await connect(s, [REWARDS]);
    s.t.fakePlaid.addTransaction(fakeItem.itemId, { account_id: ids[0]!, amount: 30, name: 'ZETA STORE', merchant_name: 'Zeta Store', date: '2026-11-03' });
    await json(await pick(s, bankId, [{ accountId: ids[0], action: 'attach', cardId: costco.id }]));
    expect(rowsOn(s.t, costco.id).filter((r) => r.deletedAt === null)).toHaveLength(2);
    await json(await call(s.t.app, 'POST', `${P}/transactions/${csv.id}/remove-duplicate`, { cookie: s.admin.cookie }));

    await json<BanksView>(await remove(s, bankId, true));
    expect(rowsOn(s.t, costco.id)).toEqual([expect.objectContaining({ id: csv.id, deletedAt: null, deletedReason: null, duplicateOfId: null })]);
  });

  it('removes a bank: revoked, listed as removed with its cards, the cards free for another link, CSV history kept', async () => {
    const s = setup();
    const costco = addCard(s.t, { nickname: 'Costco Visa', mask: '1111' });
    const kept = addTransaction(s.t, costco.id, { rawName: 'SYNTHETIC CSV ROW', csvReference: '24692166310100000000002' });
    const { bankId, ids, fakeItem } = await connect(s, [REWARDS]);
    s.t.fakePlaid.addTransaction(fakeItem.itemId, { account_id: ids[0]!, amount: 30, name: 'SYNTHETIC BANK ROW', date: '2026-11-03' });
    await json(await pick(s, bankId, [{ accountId: ids[0], action: 'attach', cardId: costco.id }]));
    s.t.clock.advance(60_000);

    const v = await json<BanksView>(await remove(s, bankId, true));
    expect(s.t.fakePlaid.removals).toEqual([fakeItem.itemId]);
    expect(v.banks).toEqual([]);
    // Plaid confirmed it: nothing more to say.
    expect(v.message).toBeNull();
    expect(v.removed).toEqual([
      { id: bankId, institutionName: 'Example Bank', removedAt: s.t.clock.now().toISOString(), reason: 'removed_with_transactions', revocation: 'confirmed', cards: [{ id: costco.id, nickname: 'Costco Visa', mask: '1111', archived: false }] },
    ]);
    // The Trial count still counts it (spec §12.2).
    expect(v.trial.used).toBe(1);
    expect(v.attachableCards.map((c) => c.id)).toEqual([costco.id]);
    expect(rowsOn(s.t, costco.id).map((r) => r.id)).toEqual([kept.id]);
    const listed = (await json<Card[]>(await call(s.t.app, 'GET', `${P}/cards`, { cookie: s.admin.cookie }))).find((c) => c.id === costco.id)!;
    expect(listed).toMatchObject({ plaidLinked: false, bankRemovedAt: s.t.clock.now().toISOString() });
    expect(await json(await remove(s, bankId), 404)).toEqual({ error: { code: 'not_found', message: PLAID_MESSAGES.notFound } });
    expect((await call(s.t.app, 'POST', `${P}/banks/${bankId}/remove`, { cookie: s.admin.cookie, body: {} })).status).toBe(400);

    // Linking the bank again, the account can go back on the same card, which is live again.
    const again = await connect(s, [{ ...REWARDS, name: 'Example Rewards Again' }]);
    await json(await pick(s, again.bankId, [{ accountId: again.ids[0], action: 'attach', cardId: costco.id }]));
    expect(card(s.t, costco.id)).toMatchObject({ plaidItemId: again.bankId, plaidAccountId: again.ids[0], removedAt: null });
    const cardsNow = await json<Card[]>(await call(s.t.app, 'GET', `${P}/cards`, { cookie: s.admin.cookie }));
    expect(cardsNow.find((c) => c.id === costco.id)).toMatchObject({ plaidLinked: true, bankRemovedAt: null });
    expect((await view(s)).removed[0]!.cards).toEqual([]);
  });

  it('undo, re-import, then remove with transactions: the CSV row comes back, never lost', async () => {
    const s = setup();
    const costco = addCard(s.t, { nickname: 'Costco Visa', mask: '1111' });
    const file = bofaCsv([{ date: '11/10/2026', reference: reference(9, 1), payee: 'SYNTHETIC COFFEE', address: 'OAKLAND CA', amount: '-12.74' }]);
    const importFile = async () => {
      const form = new FormData();
      form.set('cardId', String(costco.id));
      form.set('file', new File([bytes(file)], 'currentTransaction_1111.csv', { type: 'text/csv' }));
      const res = await s.t.app.request(`${P}/imports`, { method: 'POST', headers: { cookie: s.admin.cookie, 'x-requested-with': 'dashboard', origin: TEST_BASE_URL }, body: form });
      const preview = await json<ImportPreview>(res, 201);
      return { preview, commit: () => call(s.t.app, 'POST', `${P}/imports/${preview.id}/commit`, { cookie: s.admin.cookie, body: { include: preview.rows.map((r) => r.line) } }) };
    };
    const csvRow = () => rowsOn(s.t, costco.id).find((r) => r.source === 'csv');

    // 1. Imported from the file.
    expect(await json<ImportResult>(await (await importFile()).commit())).toMatchObject({ imported: 1 });
    const first = s.t.db.select().from(csvImports).get()!;
    // 2. The bank's row replaces it.
    const { bankId, ids, fakeItem } = await connect(s, [REWARDS]);
    s.t.fakePlaid.addTransaction(fakeItem.itemId, { account_id: ids[0]!, amount: 12.74, name: 'SYNTHETIC COFFEE', date: '2026-11-10' });
    await json(await pick(s, bankId, [{ accountId: ids[0], action: 'attach', cardId: costco.id }]));
    const plaidRow = rowsOn(s.t, costco.id).find((r) => r.source === 'plaid')!;
    expect(csvRow()).toMatchObject({ replacedById: plaidRow.id, csvImportId: first.id });
    // 3. The import is undone: the replaced row stays, without it.
    expect(await json(await call(s.t.app, 'DELETE', `${P}/cards/${costco.id}/imports/${first.id}`, { cookie: s.admin.cookie }))).toEqual({ removed: 0 });
    expect(csvRow()).toMatchObject({ replacedById: plaidRow.id, csvImportId: null });
    // 4. The file is imported again: the row is part of it, not "already imported", and it's adopted, not added twice.
    const again = await importFile();
    expect(again.preview.rows.map((r) => r.status)).toEqual(['new']);
    expect(await json<ImportResult>(await again.commit())).toMatchObject({ imported: 1 });
    const second = s.t.db.select().from(csvImports).all().at(-1)!;
    expect(rowsOn(s.t, costco.id).filter((r) => r.source === 'csv')).toEqual([expect.objectContaining({ csvImportId: second.id, replacedById: plaidRow.id })]);
    // 5. The bank is removed with its transactions: the CSV row comes back.
    await json(await remove(s, bankId, true));
    expect(rowsOn(s.t, costco.id).map((r) => [r.source, r.deletedAt, r.replacedById, r.csvImportId])).toEqual([['csv', null, null, second.id]]);
  });

  it("doesn't double the history when a bank removed with its transactions kept is linked again on the same card", async () => {
    const s = setup();
    const costco = addCard(s.t, { nickname: 'Costco Visa', mask: '1111' });
    const history = [
      { amount: 12.74, name: 'SYNTHETIC COFFEE', date: '2026-10-02' },
      { amount: 40, name: 'SYNTHETIC BOOKS', date: '2026-10-20' },
    ];
    const first = await connect(s, [REWARDS]);
    for (const h of history) s.t.fakePlaid.addTransaction(first.fakeItem.itemId, { account_id: first.ids[0]!, ...h });
    await json(await pick(s, first.bankId, [{ accountId: first.ids[0], action: 'attach', cardId: costco.id }]));
    const coffee = rowsOn(s.t, costco.id).find((r) => r.rawName === 'SYNTHETIC COFFEE')!;
    const groceries = s.t.db.select().from(categories).where(eq(categories.name, 'Groceries')).get()!.id;
    s.t.db.update(transactions).set({ categoryId: groceries, categorySource: 'manual', personUserId: s.admin.id, personSource: 'manual', note: 'Synthetic note' }).where(eq(transactions.id, coffee.id)).run();
    await json(await remove(s, first.bankId, false));

    // Linked again: a new Item re-sends the same history under new ids.
    const again = await connect(s, [REWARDS]);
    for (const h of history) s.t.fakePlaid.addTransaction(again.fakeItem.itemId, { account_id: again.ids[0]!, ...h });
    await json(await pick(s, again.bankId, [{ accountId: again.ids[0], action: 'attach', cardId: costco.id }]));

    const live = rowsOn(s.t, costco.id).filter((r) => r.deletedAt === null);
    expect(live.map((r) => [r.rawName, r.plaidAccountId]).sort()).toEqual([['SYNTHETIC BOOKS', again.ids[0]], ['SYNTHETIC COFFEE', again.ids[0]]]);
    const newCoffee = live.find((r) => r.rawName === 'SYNTHETIC COFFEE')!;
    expect(newCoffee).toMatchObject({ categoryId: groceries, categorySource: 'manual', personUserId: s.admin.id, personSource: 'manual', note: 'Synthetic note' });
    expect(rowsOn(s.t, costco.id).find((r) => r.id === coffee.id)).toMatchObject({ replacedById: newCoffee.id, deletedAt: s.t.clock.now() });
    // The overview shows each purchase once.
    const overview = await json<SpendOverview>(await call(s.t.app, 'GET', `${P}/overview?card=${costco.id}&cycle=2026-10-16`, { cookie: s.admin.cookie }));
    expect(overview.transactions.map((x) => x.merchant)).toEqual(['SYNTHETIC BOOKS']);
  });

  describe("a pending row's manual edits when its history comes again under new ids (review C-S-I2)", () => {
    const DINER = { amount: 20, name: 'SYNTHETIC DINER' };

    /** A pending purchase on Costco, with a category, a person and a note set by hand. */
    async function editedPending(s: Setup) {
      const costco = addCard(s.t, { nickname: 'Costco Visa', mask: '1111' });
      const first = await connect(s, [REWARDS]);
      s.t.fakePlaid.addTransaction(first.fakeItem.itemId, { account_id: first.ids[0]!, ...DINER, date: '2026-11-12', pending: true });
      await json(await pick(s, first.bankId, [{ accountId: first.ids[0], action: 'attach', cardId: costco.id }]));
      const pendingRow = rowsOn(s.t, costco.id).find((r) => r.pending)!;
      const groceries = s.t.db.select().from(categories).where(eq(categories.name, 'Groceries')).get()!.id;
      const edits = { categoryId: groceries, categorySource: 'manual' as const, personUserId: s.admin.id, personSource: 'manual' as const, note: 'Synthetic pending note' };
      s.t.db.update(transactions).set(edits).where(eq(transactions.id, pendingRow.id)).run();
      return { costco, first, pendingRow, edits };
    }

    /** The posted version arrives under an id we never had, naming a pending id we never stored. */
    const postedLater = (s: Setup, itemId: string, accountId: string) =>
      s.t.fakePlaid.addTransaction(itemId, { account_id: accountId, ...DINER, date: '2026-11-13', pending_transaction_id: 'tx-pending-never-stored' });

    function expectCarried(s: Setup, costcoId: number, pendingId: number, edits: Record<string, unknown>) {
      const live = rowsOn(s.t, costcoId).filter((r) => r.deletedAt === null);
      expect(live).toEqual([expect.objectContaining({ pending: false, amountCents: 2_000, ...edits })]);
      expect(rowsOn(s.t, costcoId).find((r) => r.id === pendingId)).toMatchObject({ replacedById: live[0]!.id });
    }

    it('after the account-id repair', async () => {
      const s = setup();
      const { costco, first, pendingRow, edits } = await editedPending(s);
      const { linkToken } = await json<{ linkToken: string }>(await call(s.t.app, 'POST', '/connect/plaid/link-token', { cookie: s.admin.cookie, body: { itemId: first.bankId } }));
      s.t.fakePlaid.completeLink(linkToken, { accounts: [REWARDS] });
      await json(await call(s.t.app, 'POST', '/connect/plaid/updated', { cookie: s.admin.cookie, body: {} }));
      const newId = s.t.fakePlaid.item(first.fakeItem.itemId).accounts[0]!.account_id;
      postedLater(s, first.fakeItem.itemId, newId);
      await json(await pick(s, first.bankId, [{ accountId: newId, action: 'attach', cardId: costco.id }]));
      expectCarried(s, costco.id, pendingRow.id, edits);
    });

    it('after Remove (keeping the transactions), then linking the bank again', async () => {
      const s = setup();
      const { costco, first, pendingRow, edits } = await editedPending(s);
      await json(await remove(s, first.bankId, false));
      const again = await connect(s, [REWARDS]);
      postedLater(s, again.fakeItem.itemId, again.ids[0]!);
      await json(await pick(s, again.bankId, [{ accountId: again.ids[0], action: 'attach', cardId: costco.id }]));
      expectCarried(s, costco.id, pendingRow.id, edits);
    });

    it('after a key reset, then linking the bank again', async () => {
      const s = setup();
      const { costco, pendingRow, edits } = await editedPending(s);
      // The real reset, as if TOKEN_ENCRYPTION_KEY had failed its check at start.
      (s.t.plaid as unknown as { keyMismatchNow: boolean }).keyMismatchNow = true;
      expect(await s.t.plaid!.forgetForNewKey()).toEqual({ forgotten: 1 });
      s.t.plaid!.clearKeyMismatch();
      const again = await connect(s, [REWARDS]);
      postedLater(s, again.fakeItem.itemId, again.ids[0]!);
      await json(await pick(s, again.bankId, [{ accountId: again.ids[0], action: 'attach', cardId: costco.id }]));
      expectCarried(s, costco.id, pendingRow.id, edits);
    });
  });

  it('keeps the bank rows when the box is not ticked, and lists removals Plaid never confirmed', async () => {
    const s = setup();
    const { bankId, ids, fakeItem } = await connect(s, [REWARDS]);
    s.t.fakePlaid.addTransaction(fakeItem.itemId, { account_id: ids[0]!, amount: 30, name: 'SYNTHETIC BANK ROW', date: '2026-11-03' });
    await json(await pick(s, bankId, [{ accountId: ids[0], action: 'create' }]));
    s.t.fakePlaid.failNext('/item/remove', FAKE_PLAID_ERRORS.INTERNAL_SERVER_ERROR);
    const removed = await json<BanksView>(await remove(s, bankId, false));
    expect(s.t.db.select().from(transactions).all().map((r) => r.rawName)).toEqual(['SYNTHETIC BANK ROW']);
    // Waiting for the hourly retries: the removed bank says so (review C-W-I2).
    expect(removed.removed.map((r) => [r.id, r.revocation])).toEqual([[bankId, 'waiting']]);
    s.t.db.update(pendingRevocations).set({ gaveUpAt: s.t.clock.now(), credentialsEnc: '' }).run();
    const v = await view(s);
    expect(v.notices).toEqual([{ id: expect.any(Number), message: expect.stringContaining('Example Bank') }]);
    // Given up on: Plaid won't be asked again, and the notice says where to end it.
    expect(v.removed.map((r) => r.revocation)).toEqual(['not_asked']);
  });

  it('names a new card from Plaid, within the nickname limit and without the last 4 (the card shows its mask)', () => {
    expect(newCardName({ name: 'Example  Rewards ', officialName: null })).toBe('Example Rewards');
    expect(newCardName({ name: 'X'.repeat(60), officialName: null })).toBe('X'.repeat(40));
    expect(newCardName({ name: '', officialName: 'Example Official' })).toBe('Example Official');
    expect(newCardName({ name: ' ', officialName: null })).toBe('Bank card');
  });
});

describe('the home card and drill-down: a linked card\'s freshness', () => {
  it("says when the bank last synced, goes stale after 12 hours, and follows the connection's status", async () => {
    const s = setup();
    const costco = addCard(s.t, { nickname: 'Costco Visa', mask: '1111' });
    const csvOnly = addCard(s.t, { nickname: 'Zed CSV only', mask: null });
    const { bankId, ids, fakeItem } = await connect(s, [REWARDS]);
    s.t.clock.advance(60_000);
    await json(await pick(s, bankId, [{ accountId: ids[0], action: 'attach', cardId: costco.id }]));
    const synced = s.t.clock.now().toISOString();
    const summary = async () => json<SpendSummary>(await call(s.t.app, 'GET', `${P}/summary`, { cookie: s.admin.cookie }));
    const overview = async () => json<SpendOverview>(await call(s.t.app, 'GET', `${P}/overview?card=${costco.id}`, { cookie: s.admin.cookie }));

    const fresh = { itemId: bankId, institutionName: 'Example Bank', status: 'ok', lastSyncAt: synced, stale: false };
    expect((await summary()).cards.map((c) => [c.nickname, c.updatedAt, c.bank])).toEqual([
      ['Costco Visa', synced, fresh],
      ['Zed CSV only', null, null],
    ]);
    expect(await overview()).toMatchObject({ updatedAt: synced, bank: fresh });

    // A success that brought no transactions (a reconnect, say) doesn't count as an update.
    s.t.db.update(connections).set({ lastSuccessAt: new Date(s.t.clock.now().getTime() + 60 * 60_000) }).where(eq(connections.id, itemRow(s.t, bankId).connectionId!)).run();
    expect((await summary()).cards[0]).toMatchObject({ updatedAt: synced, bank: fresh });

    s.t.clock.advance(BANK_STALE_AFTER_MS);
    expect((await summary()).cards[0]!.bank!.stale).toBe(false);
    s.t.clock.advance(1);
    expect((await summary()).cards[0]!.bank!.stale).toBe(true);

    // A later CSV import counts as an update.
    const imported = s.t.clock.now();
    s.t.db.insert(csvImports).values({ cardId: costco.id, fileSha256: 'x', uploadedByUserId: s.admin.id, uploadedAt: imported, rowCount: 0, importedCount: 0, skippedCount: 0 }).run();
    expect((await summary()).cards[0]).toMatchObject({ updatedAt: imported.toISOString(), bank: { stale: false } });

    s.t.fakePlaid.breakItem(fakeItem.itemId);
    await refresh(s, bankId);
    expect((await summary()).cards[0]!.bank).toMatchObject({ status: 'needs_reconnect', itemId: bankId });
    expect(csvOnly.id).toBeGreaterThan(0);

    // Removed: no bank any more, and "Updated" is the last import.
    await json(await remove(s, bankId));
    expect((await summary()).cards[0]).toMatchObject({ updatedAt: imported.toISOString(), bank: null });
    expect(await overview()).toMatchObject({ bank: null });
  });
});

describe('Admin Integrations: a bank connection', () => {
  it('names the bank as the account in the connections list', async () => {
    const s = setup();
    const { bankId, ids } = await connect(s, [REWARDS]);
    const list = async () => json<ConnectionSummary[]>(await call(s.t.app, 'GET', '/api/admin/connections', { cookie: s.admin.cookie }));
    // Waiting for its pick, so Integrations doesn't call it working (review C-M9).
    expect(await list()).toEqual([expect.objectContaining({ kind: 'plaid', scope: 'family', account: 'Example Bank', status: 'ok', ownerName: 'Alex', waitingForCards: true })]);
    await json(await pick(s, bankId, [{ accountId: ids[0], action: 'create' }]));
    expect(await list()).toEqual([expect.objectContaining({ kind: 'plaid', waitingForCards: false })]);
  });
});

describe('Spend settings: banks leave Savings connections alone', () => {
  it("doesn't list a Savings connection, and its bank routes are a 404 that asks Plaid nothing", async () => {
    const s = setup();
    const savings = linkSavingsForTest(s.t, s.admin.id);
    expect((await view(s)).banks).toEqual([]);
    const notFound = { error: { code: 'not_found', message: PLAID_MESSAGES.notFound } };
    const before = s.t.fakePlaid.requests.length;
    expect(await json(await pick(s, savings.item.id, []), 404)).toEqual(notFound);
    expect(await json(await refresh(s, savings.item.id), 404)).toEqual(notFound);
    expect(await json(await loadAccounts(s, savings.item.id), 404)).toEqual(notFound);
    expect(await json(await remove(s, savings.item.id), 404)).toEqual(notFound);
    expect(s.t.fakePlaid.requests.length).toBe(before);
    expect(itemRow(s.t, savings.item.id).removedAt).toBeNull();
  });
});
