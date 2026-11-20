import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { MAX_AMOUNT_CENTS } from '../../../shared/money.js';
import type { PlaidConfig } from '../../config.js';
import { FAKE_PLAID_CLIENT_ID, FAKE_PLAID_ERRORS, FAKE_PLAID_SECRET, FakePlaid, type FakePlaidPath } from '../../test/fakePlaid.js';
import {
  classifyPlaidError, PlaidApiError, PlaidBadResponse, PlaidClient, plaidAmountCents, PlaidPastDeadline, PlaidUnavailable, type LinkTokenCreateRequest,
} from './client.js';

// Everything here is synthetic: the keys, institutions, accounts, and transactions.
const ORIGIN = 'https://plaid.test';
const config: PlaidConfig = {
  clientId: FAKE_PLAID_CLIENT_ID, secret: FAKE_PLAID_SECRET, env: 'sandbox', apiBaseUrl: ORIGIN,
  linkScriptUrl: 'https://cdn.plaid.com/link/v2/stable/link-initialize.js',
};

const NEW_LINK: LinkTokenCreateRequest = {
  client_name: 'Family Dashboard',
  language: 'en',
  country_codes: ['US'],
  user: { client_user_id: 'synthetic-user' },
  products: ['transactions'],
  required_if_supported_products: ['liabilities'],
  transactions: { days_requested: 730 },
  account_filters: { credit: { account_subtypes: ['credit card'] } },
  webhook: 'https://dashboard.example.com/webhooks/plaid',
  redirect_uri: 'https://dashboard.example.com/connect/plaid/oauth-return',
};

function setup(opts: { config?: Partial<PlaidConfig> } = {}) {
  const fake = new FakePlaid();
  fake.origin = ORIGIN;
  const waits: number[] = [];
  const client = new PlaidClient({ ...config, ...opts.config }, fake.fetch, {
    sleep: async (ms) => {
      waits.push(ms);
    },
  });
  return { fake, client, waits };
}

/** A linked Item with one synthetic card, through the fake's Link and the real exchange. */
async function linked(t: ReturnType<typeof setup>) {
  const { linkToken } = await t.client.createLinkToken(NEW_LINK);
  const { publicToken } = t.fake.completeLink(linkToken, { accounts: [{ name: 'Example Card', mask: '1234' }] });
  const { accessToken, itemId } = await t.client.exchangePublicToken(publicToken);
  const item = t.fake.item(itemId);
  return { accessToken, itemId, item, accountId: item.accounts[0]!.account_id };
}

async function caught(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error('expected a rejection');
}

describe('PlaidClient', () => {
  it('sends the credentials and Plaid-Version in headers, never in the body, to the configured host', async () => {
    const t = setup();
    const seen: { url: string; headers: Headers; body: string }[] = [];
    const client = new PlaidClient(config, async (input, init) => {
      const req = new Request(input, init);
      seen.push({ url: req.url, headers: req.headers, body: await req.clone().text() });
      return t.fake.handle(req);
    });
    await client.createLinkToken(NEW_LINK);
    const [call] = seen;
    expect(call!.url).toBe('https://plaid.test/link/token/create');
    expect(call!.headers.get('plaid-client-id')).toBe(FAKE_PLAID_CLIENT_ID);
    expect(call!.headers.get('plaid-secret')).toBe(FAKE_PLAID_SECRET);
    expect(call!.headers.get('plaid-version')).toBe('2020-09-14');
    expect(call!.headers.get('content-type')).toBe('application/json');
    expect(call!.body).not.toContain(FAKE_PLAID_SECRET);
    expect(call!.body).not.toContain(FAKE_PLAID_CLIENT_ID);
    expect(JSON.parse(call!.body)).toEqual(NEW_LINK);
  });

  it("is checked by the fake: a request without Plaid-Version or JSON, or on another host, doesn't get through", async () => {
    const t = setup();
    const send = (url: string, headers: Record<string, string>) =>
      t.fake.fetch(url, { method: 'POST', headers, body: JSON.stringify(NEW_LINK) }).then(async (r) => [r.status, r.status === 404 ? null : ((await r.json()) as { error_code: string }).error_code]);
    const auth = { 'plaid-client-id': FAKE_PLAID_CLIENT_ID, 'plaid-secret': FAKE_PLAID_SECRET };
    expect(await send(`${ORIGIN}/link/token/create`, { ...auth, 'content-type': 'application/json' })).toEqual([400, 'INVALID_HEADERS']);
    expect(await send(`${ORIGIN}/link/token/create`, { ...auth, 'plaid-version': '2020-09-14' })).toEqual([400, 'INVALID_HEADERS']);
    expect(await send(`${ORIGIN}/link/token/create`, { 'plaid-version': '2020-09-14', 'content-type': 'application/json' })).toEqual([400, 'INVALID_API_KEYS']);
    expect(await send('https://production.plaid.test/link/token/create', { ...auth, 'plaid-version': '2020-09-14', 'content-type': 'application/json' })).toEqual([404, null]);
  });

  it('is refused by Plaid with the wrong keys, and the error carries codes but no secret', async () => {
    const t = setup({ config: { secret: 'wrong-secret' } });
    const err = await caught(t.client.createLinkToken(NEW_LINK));
    expect(err).toBeInstanceOf(PlaidApiError);
    expect(err).toMatchObject({ status: 400, errorType: 'INVALID_INPUT', errorCode: 'INVALID_API_KEYS', path: '/link/token/create' });
    expect((err as PlaidApiError).requestId).toMatch(/^[0-9a-f]+$/);
    expect(String((err as Error).message)).not.toContain('wrong-secret');
    expect(String((err as Error).message)).not.toContain('Synthetic error');
  });

  it('creates link tokens for a new Item and for update mode', async () => {
    const t = setup();
    const created = await t.client.createLinkToken(NEW_LINK);
    expect(created.linkToken).toMatch(/^link-sandbox-/);
    expect(Date.parse(created.expiration)).toBeGreaterThan(Date.now() + 3 * 3600_000);
    expect(t.fake.lastBody('/link/token/create')).toEqual(NEW_LINK);

    const { accessToken } = await linked(t);
    const update = await t.client.createLinkToken({
      client_name: 'Family Dashboard', language: 'en', country_codes: ['US'], user: { client_user_id: 'synthetic-user' },
      access_token: accessToken, redirect_uri: NEW_LINK.redirect_uri, update: { account_selection_enabled: true },
      account_filters: NEW_LINK.account_filters,
    });
    expect(Date.parse(update.expiration)).toBeLessThanOrEqual(Date.now() + 30 * 60_000);
    expect(t.fake.lastBody('/link/token/create')).toMatchObject({ access_token: accessToken, update: { account_selection_enabled: true } });
  });

  it('exchanges a public token once', async () => {
    const t = setup();
    const { linkToken } = await t.client.createLinkToken(NEW_LINK);
    const { publicToken, metadata } = t.fake.completeLink(linkToken, {
      institution: { institution_id: 'ins_synthetic', name: 'Example Bank' },
      accounts: [{ name: 'Example Card', mask: '1234' }, { name: 'Other Card', mask: null }],
    });
    expect(metadata).toMatchObject({
      institution: { institution_id: 'ins_synthetic', name: 'Example Bank' },
      accounts: [{ name: 'Example Card', mask: '1234', type: 'credit', subtype: 'credit card' }, { name: 'Other Card', mask: null }],
    });
    const exchanged = await t.client.exchangePublicToken(publicToken);
    expect(exchanged.accessToken).toMatch(/^access-sandbox-/);
    expect(exchanged.itemId).toBe(t.fake.item(exchanged.itemId).itemId);
    expect(t.fake.itemsCreated).toBe(1);
    expect(await caught(t.client.exchangePublicToken(publicToken))).toMatchObject({ errorCode: 'INVALID_PUBLIC_TOKEN' });
    expect(t.fake.itemsCreated).toBe(1);
  });

  it('reads the Item, with its consent expiration', async () => {
    const t = setup();
    const { accessToken, itemId } = await linked(t);
    expect(await t.client.getItem(accessToken)).toEqual({
      item_id: itemId, institution_id: 'ins_fake_1', institution_name: 'Example Bank', consent_expiration_time: null, error: null,
    });
    t.fake.setConsentExpiration(itemId, '2027-11-21T00:00:00Z');
    expect((await t.client.getItem(accessToken)).consent_expiration_time).toBe('2027-11-21T00:00:00Z');
    // The Item's own error, which /item/get answers with a 200.
    t.fake.breakItem(itemId);
    expect((await t.client.getItem(accessToken)).error).toEqual({ error_type: 'ITEM_ERROR', error_code: 'ITEM_LOGIN_REQUIRED' });
  });

  it("lists the Item's accounts with their currency codes", async () => {
    const t = setup();
    const { accessToken, accountId } = await linked(t);
    expect(await t.client.getAccounts(accessToken)).toEqual({
      accounts: [{
        account_id: accountId, name: 'Example Card', official_name: null, mask: '1234', type: 'credit', subtype: 'credit card',
        balances: { iso_currency_code: 'USD', unofficial_currency_code: null, current: 0, available: null },
      }],
      skipped: 0,
    });
  });

  it('removes an Item, after which its token is refused', async () => {
    const t = setup();
    const { accessToken, itemId } = await linked(t);
    await t.client.removeItem(accessToken);
    expect(t.fake.removals).toEqual([itemId]);
    expect(await caught(t.client.getItem(accessToken))).toMatchObject({ errorCode: 'ITEM_NOT_FOUND' });
  });

  it('reads credit liabilities, nulls included', async () => {
    const t = setup();
    const { accessToken, itemId, accountId } = await linked(t);
    expect(await caught(t.client.getLiabilities(accessToken))).toMatchObject({ errorCode: 'NO_LIABILITY_ACCOUNTS' });
    t.fake.setLiability(itemId, accountId, { last_statement_issue_date: '2026-11-03', last_statement_balance: 412.5, next_payment_due_date: '2026-11-28' });
    expect(await t.client.getLiabilities(accessToken)).toEqual({
      credit: [{
        account_id: accountId, last_statement_issue_date: '2026-11-03', last_statement_balance: 412.5, next_payment_due_date: '2026-11-28',
        minimum_payment_amount: null,
      }],
      skipped: 0,
    });
  });

  it('fetches a webhook verification key by id', async () => {
    const t = setup();
    const key = { alg: 'ES256', crv: 'P-256', kid: 'kid-1', kty: 'EC', use: 'sig', x: 'eA', y: 'eQ', created_at: 1_790_000_000, expired_at: null };
    t.fake.addWebhookKey(key);
    expect(await t.client.getWebhookVerificationKey('kid-1')).toEqual(key);
    expect(t.fake.lastBody('/webhook_verification_key/get')).toEqual({ key_id: 'kid-1' });
    expect(await caught(t.client.getWebhookVerificationKey('kid-unknown'))).toBeInstanceOf(PlaidApiError);
  });

  it('reads a webhook key without use or created_at, which nothing depends on', async () => {
    const t = setup();
    t.fake.addWebhookKey({ alg: 'ES256', crv: 'P-256', kid: 'kid-2', kty: 'EC', x: 'eA', y: 'eQ', expired_at: null });
    expect(await t.client.getWebhookVerificationKey('kid-2')).toMatchObject({ kid: 'kid-2', alg: 'ES256', x: 'eA', y: 'eQ', expired_at: null });
  });

  it('keeps its keys out of inspect and JSON, and so do its errors', async () => {
    const secret = 'synthetic-secret-never-shown';
    const fake = new FakePlaid(FAKE_PLAID_CLIENT_ID, secret);
    fake.origin = ORIGIN;
    const client = new PlaidClient({ ...config, secret }, fake.fetch, { sleep: async () => {} });
    expect(inspect(client, { depth: 10, showHidden: true })).not.toContain(secret);
    expect(JSON.stringify(client)).not.toContain(secret);
    const errors: unknown[] = [];
    errors.push(await caught(client.getItem('access-sandbox-synthetic-token')));
    fake.dropNext('/item/remove');
    errors.push(await caught(client.removeItem('access-sandbox-synthetic-token')));
    const bad = new PlaidClient({ ...config, secret }, async () => new Response('{}', { status: 200 }), { sleep: async () => {} });
    errors.push(await caught(bad.getItem('access-sandbox-synthetic-token')));
    expect(errors.map((e) => (e as Error).name)).toEqual(['PlaidApiError', 'PlaidUnavailable', 'PlaidBadResponse']);
    for (const err of errors) {
      for (const shown of [inspect(err, { depth: 10, showHidden: true }), JSON.stringify(err), String(err)]) {
        expect(shown).not.toContain(secret);
        expect(shown).not.toContain('access-sandbox-synthetic-token');
      }
    }
  });

  describe('/transactions/sync', () => {
    it('pages through the change log with opaque cursors, 500 a page, PFC v2', async () => {
      const t = setup();
      const { accessToken, itemId, accountId } = await linked(t);
      const a = t.fake.addTransaction(itemId, { account_id: accountId, amount: 5.25, merchant_name: 'Example Coffee', name: 'EXAMPLE COFFEE 123' });
      const b = t.fake.addTransaction(itemId, { account_id: accountId, amount: -20, pending: true });
      const first = await t.client.syncTransactions(accessToken, { cursor: null });
      expect(t.fake.lastBody('/transactions/sync')).toEqual({ access_token: accessToken, count: 500, options: { personal_finance_category_version: 'v2' } });
      expect(first).toMatchObject({ modified: [], removed: [], hasMore: false, transactionsUpdateStatus: 'HISTORICAL_UPDATE_COMPLETE' });
      expect(first.added.map((x) => x.transaction_id)).toEqual([a.transaction_id, b.transaction_id]);
      expect(first.added[0]).toEqual({
        transaction_id: a.transaction_id, account_id: accountId, amount: 5.25, iso_currency_code: 'USD', unofficial_currency_code: null,
        date: '2026-11-01', authorized_date: null, pending: false, pending_transaction_id: null, merchant_name: 'Example Coffee',
        name: 'EXAMPLE COFFEE 123', original_description: null,
        personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_COFFEE', confidence_level: 'VERY_HIGH', version: 'v2' },
        merchant_entity_id: null, logo_url: null, counterparties: [],
      });

      t.fake.modifyTransaction(a.transaction_id, { amount: 6 });
      const posted = t.fake.postPending(b.transaction_id, { amount: -20 });
      const second = await t.client.syncTransactions(accessToken, { cursor: first.nextCursor, count: 1 });
      expect(t.fake.lastBody('/transactions/sync')).toMatchObject({ cursor: first.nextCursor, count: 1 });
      expect(second.modified.map((x) => [x.transaction_id, x.amount])).toEqual([[a.transaction_id, 6]]);
      expect(second.hasMore).toBe(true);
      const third = await t.client.syncTransactions(accessToken, { cursor: second.nextCursor, count: 2 });
      expect(third.removed).toEqual([{ transaction_id: b.transaction_id, account_id: accountId }]);
      expect(third.added.map((x) => [x.transaction_id, x.pending, x.pending_transaction_id])).toEqual([[posted.transaction_id, false, b.transaction_id]]);
      expect(third.hasMore).toBe(false);
      // Nothing new: the same cursor comes back empty.
      const fourth = await t.client.syncTransactions(accessToken, { cursor: third.nextCursor });
      expect(fourth).toMatchObject({ added: [], modified: [], removed: [], hasMore: false });
    });

    it('answers the entire history without a cursor: what stands now, all added, never the changes that led there', async () => {
      const t = setup();
      const { accessToken, itemId, accountId } = await linked(t);
      const a = t.fake.addTransaction(itemId, { account_id: accountId, amount: 1 });
      t.fake.modifyTransaction(a.transaction_id, { amount: 2 });
      const gone = t.fake.addTransaction(itemId, { account_id: accountId });
      t.fake.removeTransaction(gone.transaction_id);
      const pending = t.fake.addTransaction(itemId, { account_id: accountId, pending: true });
      const posted = t.fake.postPending(pending.transaction_id);
      const old = t.fake.addTransaction(itemId, { account_id: accountId });
      t.fake.churn(old.transaction_id, 'tx-synthetic-new');
      const page = await t.client.syncTransactions(accessToken, { cursor: null });
      expect(page.added.map((x) => [x.transaction_id, x.amount, x.pending_transaction_id])).toEqual([
        [a.transaction_id, 2, null], [posted.transaction_id, 12.34, pending.transaction_id], ['tx-synthetic-new', 12.34, null],
      ]);
      expect(page).toMatchObject({ modified: [], removed: [], hasMore: false });
      // From its cursor on, only what changes next.
      t.fake.modifyTransaction(a.transaction_id, { amount: 3 });
      const next = await t.client.syncTransactions(accessToken, { cursor: page.nextCursor });
      expect(next).toMatchObject({ added: [], removed: [], modified: [{ transaction_id: a.transaction_id, amount: 3 }] });
    });

    it('pages the history by count, pinned to when it started: a change made meanwhile comes after it, as a change', async () => {
      const t = setup();
      const { accessToken, itemId, accountId } = await linked(t);
      const [a, b, c] = [1, 2, 3].map((amount) => t.fake.addTransaction(itemId, { account_id: accountId, amount }));
      const first = await t.client.syncTransactions(accessToken, { cursor: null, count: 2 });
      expect(first.added.map((x) => x.transaction_id)).toEqual([a!.transaction_id, b!.transaction_id]);
      expect(first.hasMore).toBe(true);
      t.fake.modifyTransaction(a!.transaction_id, { amount: 10 });
      t.fake.removeTransaction(c!.transaction_id);
      const second = await t.client.syncTransactions(accessToken, { cursor: first.nextCursor, count: 2 });
      // The history still ends with c as it stood, and there's more: the two changes.
      expect(second.added.map((x) => [x.transaction_id, x.amount])).toEqual([[c!.transaction_id, 3]]);
      expect(second).toMatchObject({ modified: [], removed: [], hasMore: true });
      const third = await t.client.syncTransactions(accessToken, { cursor: second.nextCursor, count: 2 });
      expect(third).toMatchObject({
        added: [], modified: [{ transaction_id: a!.transaction_id, amount: 10 }], removed: [{ transaction_id: c!.transaction_id }], hasMore: false,
      });
    });

    it('folds a page of changes so each transaction appears once, with its latest state', async () => {
      const t = setup();
      const { accessToken, itemId, accountId } = await linked(t);
      const kept = t.fake.addTransaction(itemId, { account_id: accountId, amount: 1 });
      const { nextCursor } = await t.client.syncTransactions(accessToken, { cursor: null });
      t.fake.modifyTransaction(kept.transaction_id, { amount: 2 });
      t.fake.modifyTransaction(kept.transaction_id, { amount: 3 });
      const a = t.fake.addTransaction(itemId, { account_id: accountId, amount: 1 });
      t.fake.modifyTransaction(a.transaction_id, { amount: 2 });
      t.fake.removeTransaction(kept.transaction_id);
      const page = await t.client.syncTransactions(accessToken, { cursor: nextCursor });
      expect(page.added.map((x) => [x.transaction_id, x.amount])).toEqual([[a.transaction_id, 2]]);
      expect(page.modified).toEqual([]);
      expect(page.removed.map((x) => x.transaction_id)).toEqual([kept.transaction_id]);
    });

    it('logs churn as a removal and an unlinked add, in either order', async () => {
      const t = setup();
      const { accessToken, itemId, accountId } = await linked(t);
      const a = t.fake.addTransaction(itemId, { account_id: accountId });
      const { nextCursor } = await t.client.syncTransactions(accessToken, { cursor: null });
      t.fake.churn(a.transaction_id, 'tx-synthetic-churned', { name: 'RENAMED' }, { removedFirst: false });
      const page = await t.client.syncTransactions(accessToken, { cursor: nextCursor, count: 1 });
      expect(page.added.map((x) => [x.transaction_id, x.pending_transaction_id, x.name])).toEqual([['tx-synthetic-churned', null, 'RENAMED']]);
      const rest = await t.client.syncTransactions(accessToken, { cursor: page.nextCursor });
      expect(rest.removed.map((x) => x.transaction_id)).toEqual([a.transaction_id]);
    });

    it('answers "" as the cursor while data is not ready', async () => {
      const t = setup();
      const { accessToken, itemId, accountId } = await linked(t);
      t.fake.addTransaction(itemId, { account_id: accountId });
      t.fake.setReady(itemId, false);
      expect(await t.client.syncTransactions(accessToken, { cursor: null })).toMatchObject({
        added: [], nextCursor: '', hasMore: false, transactionsUpdateStatus: 'NOT_READY',
      });
      t.fake.setReady(itemId, true);
      expect((await t.client.syncTransactions(accessToken, { cursor: null })).added).toHaveLength(1);
    });

    it('fails a page once with a mutation error, and the same cursor works again', async () => {
      const t = setup();
      const { accessToken, itemId, accountId } = await linked(t);
      const one = t.fake.addTransaction(itemId, { account_id: accountId });
      const two = t.fake.addTransaction(itemId, { account_id: accountId });
      t.fake.failMutationOnce(itemId, 1);
      const first = await t.client.syncTransactions(accessToken, { cursor: null, count: 1 });
      expect(first.added.map((x) => x.transaction_id)).toEqual([one.transaction_id]);
      const err = await caught(t.client.syncTransactions(accessToken, { cursor: first.nextCursor, count: 1 }));
      expect(err).toMatchObject({ status: 400, errorType: 'TRANSACTIONS_ERROR', errorCode: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION' });
      expect(classifyPlaidError(err)).toBe('mutation');
      // A mutation isn't retried by the client: the caller restarts the whole loop.
      expect(t.fake.count('/transactions/sync')).toBe(2);
      const again = await t.client.syncTransactions(accessToken, { cursor: first.nextCursor, count: 1 });
      expect(again.added.map((x) => x.transaction_id)).toEqual([two.transaction_id]);
    });

    it('refuses a cursor from another Item', async () => {
      const t = setup();
      const one = await linked(t);
      const two = await linked(t);
      const { nextCursor } = await t.client.syncTransactions(one.accessToken, { cursor: null });
      expect(await caught(t.client.syncTransactions(two.accessToken, { cursor: nextCursor }))).toMatchObject({ errorCode: 'INVALID_FIELD' });
    });

    it('fails the whole page when an entry is not in the documented shape, so the cursor never moves past it', async () => {
      const t = setup();
      const { accessToken, itemId, accountId } = await linked(t);
      t.fake.addTransaction(itemId, { account_id: accountId });
      t.fake.addTransaction(itemId, { account_id: accountId, amount: 'twelve' as unknown as number });
      const err = await caught(t.client.syncTransactions(accessToken, { cursor: null }));
      expect(err).toBeInstanceOf(PlaidBadResponse);
      expect(err).toMatchObject({ path: '/transactions/sync' });
      // A modified or removed entry that doesn't parse fails the page too.
      const one = await linked(t);
      const tx = t.fake.addTransaction(one.itemId, { account_id: one.accountId });
      const { nextCursor } = await t.client.syncTransactions(one.accessToken, { cursor: null });
      t.fake.modifyTransaction(tx.transaction_id, { pending: 'no' as unknown as boolean });
      expect(await caught(t.client.syncTransactions(one.accessToken, { cursor: nextCursor }))).toBeInstanceOf(PlaidBadResponse);
    });

    it('reads a removed entry without account_id, and fields it does not depend on as null when they are malformed', async () => {
      const fake = new FakePlaid();
      fake.origin = ORIGIN;
      const raw = {
        transaction_id: 'tx-synthetic', account_id: 'acct-synthetic', amount: 4.1, iso_currency_code: 'USD', unofficial_currency_code: null,
        date: '2026-11-01', authorized_date: null, pending: false, pending_transaction_id: null, merchant_name: 'Example Shop', name: 'EXAMPLE SHOP',
        original_description: 7, personal_finance_category: { primary: 'FOOD' }, merchant_entity_id: {}, logo_url: 12, counterparties: 'none',
      };
      const page = { added: [raw], modified: [], removed: [{ transaction_id: 'tx-gone' }], next_cursor: 'c1', has_more: false, transactions_update_status: null };
      const client = new PlaidClient(config, async () => new Response(JSON.stringify(page), { status: 200 }), { sleep: async () => {} });
      const got = await client.syncTransactions('access-synthetic', { cursor: null });
      expect(got.removed).toEqual([{ transaction_id: 'tx-gone' }]);
      expect(got.added).toHaveLength(1);
      expect(got.added[0]).toMatchObject({
        transaction_id: 'tx-synthetic', amount: 4.1, merchant_name: 'Example Shop',
        original_description: null, personal_finance_category: null, merchant_entity_id: null, logo_url: null, counterparties: null,
      });
    });
  });

  describe('errors and retries', () => {
    const IDEMPOTENT: [FakePlaidPath, (t: ReturnType<typeof setup>, accessToken: string) => Promise<unknown>][] = [
      ['/transactions/sync', (t, token) => t.client.syncTransactions(token, { cursor: null })],
      ['/liabilities/get', (t, token) => t.client.getLiabilities(token)],
      ['/accounts/get', (t, token) => t.client.getAccounts(token)],
      ['/item/get', (t, token) => t.client.getItem(token)],
      ['/webhook_verification_key/get', (t) => t.client.getWebhookVerificationKey('kid-1')],
    ];

    it.each(IDEMPOTENT)('retries %s twice on a transient failure, after 1 and 2 seconds', async (path, call) => {
      const t = setup();
      const { accessToken, itemId, accountId } = await linked(t);
      t.fake.setLiability(itemId, accountId, {});
      t.fake.addWebhookKey({ alg: 'ES256', crv: 'P-256', kid: 'kid-1', kty: 'EC', use: 'sig', x: 'eA', y: 'eQ', created_at: 1, expired_at: null });
      t.fake.failNext(path, FAKE_PLAID_ERRORS.INTERNAL_SERVER_ERROR);
      t.fake.dropNext(path);
      await call(t, accessToken);
      expect(t.fake.count(path)).toBe(3);
      expect(t.waits).toEqual([1000, 2000]);
      // A third failure in a row is thrown.
      t.waits.length = 0;
      t.fake.failNext(path, FAKE_PLAID_ERRORS.TRANSACTIONS_SYNC_LIMIT);
      t.fake.failNext(path, FAKE_PLAID_ERRORS.INSTITUTION_DOWN);
      t.fake.failNext(path, FAKE_PLAID_ERRORS.PLANNED_MAINTENANCE);
      expect(await caught(call(t, accessToken))).toMatchObject({ errorCode: 'PLANNED_MAINTENANCE' });
      expect(t.waits).toEqual([1000, 2000]);
    });

    it.each([
      ['/link/token/create', (t: ReturnType<typeof setup>) => t.client.createLinkToken(NEW_LINK)],
      ['/item/public_token/exchange', (t: ReturnType<typeof setup>) => t.client.exchangePublicToken('public-sandbox-synthetic')],
      ['/item/remove', (t: ReturnType<typeof setup>, token: string) => t.client.removeItem(token)],
    ] as const)('never retries %s', async (path, call) => {
      const t = setup();
      const { accessToken } = await linked(t);
      const before = t.fake.count(path);
      t.fake.failNext(path, FAKE_PLAID_ERRORS.INTERNAL_SERVER_ERROR);
      expect(await caught(call(t, accessToken))).toMatchObject({ status: 500, errorCode: 'INTERNAL_SERVER_ERROR' });
      t.fake.dropNext(path);
      expect(await caught(call(t, accessToken))).toBeInstanceOf(PlaidUnavailable);
      expect(t.fake.count(path) - before).toBe(2);
      expect(t.waits).toEqual([]);
    });

    it('does not retry an Item error or the Trial limit', async () => {
      const t = setup();
      const { accessToken, itemId } = await linked(t);
      t.fake.breakItem(itemId);
      expect(await caught(t.client.getAccounts(accessToken))).toMatchObject({ errorCode: 'ITEM_LOGIN_REQUIRED' });
      t.fake.repairItem(itemId);
      t.fake.failNext('/accounts/get', FAKE_PLAID_ERRORS.TRIAL_CONNECTION_LIMIT);
      expect(await caught(t.client.getAccounts(accessToken))).toMatchObject({ status: 429, errorCode: 'TRIAL_CONNECTION_LIMIT' });
      expect(t.fake.count('/accounts/get')).toBe(2);
      expect(t.waits).toEqual([]);
    });

    it('gives up on an attempt that takes too long, as unavailable', async () => {
      const fake = new FakePlaid();
      const client = new PlaidClient(config, fake.fetch, { timeoutMs: 20, sleep: async () => {} });
      fake.hangNext('/link/token/create');
      const err = await caught(client.createLinkToken(NEW_LINK));
      expect(err).toBeInstanceOf(PlaidUnavailable);
      expect((err as PlaidUnavailable).reason).toBe('timeout');
      expect(classifyPlaidError(err)).toBe('transient');
    });

    it("never starts a call that a request's deadline leaves no time for", async () => {
      const t = setup();
      const { accessToken } = await linked(t);
      const before = t.fake.count('/accounts/get');
      const err = await caught(t.client.getAccounts(accessToken, { deadline: Date.now() + 500 }));
      expect(err).toBeInstanceOf(PlaidPastDeadline);
      expect(err).toMatchObject({ path: '/accounts/get' });
      expect(t.fake.count('/accounts/get')).toBe(before);
      expect(await caught(t.client.exchangePublicToken('public-sandbox-synthetic', { deadline: Date.now() - 1 }))).toBeInstanceOf(PlaidPastDeadline);
      expect(t.fake.count('/item/public_token/exchange')).toBe(1);
    });

    it("cuts an attempt off at the request's deadline, well before its own timeout, as past the deadline, not as Plaid's failure", async () => {
      const t = setup();
      const { accessToken } = await linked(t);
      t.fake.hangNext('/transactions/sync');
      const started = Date.now();
      const err = await caught(t.client.syncTransactions(accessToken, { cursor: null }, { deadline: started + 1_200 }));
      expect(err).toBeInstanceOf(PlaidPastDeadline);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect(t.waits).toEqual([]);
    });

    it("doesn't retry past the request's deadline: the last failure is thrown", async () => {
      const t = setup();
      const { accessToken } = await linked(t);
      const before = t.fake.count('/item/get');
      t.fake.failNext('/item/get', FAKE_PLAID_ERRORS.INTERNAL_SERVER_ERROR);
      expect(await caught(t.client.getItem(accessToken, { deadline: Date.now() + 1_800 }))).toMatchObject({ errorCode: 'INTERNAL_SERVER_ERROR' });
      expect(t.fake.count('/item/get') - before).toBe(1);
      expect(t.waits).toEqual([]);
    });

    it('keeps a webhook key fetch, retries included, inside its deadline', async () => {
      const fake = new FakePlaid();
      let now = 0;
      const waits: number[] = [];
      const client = new PlaidClient(config, fake.fetch, {
        now: () => now,
        sleep: async (ms) => {
          waits.push(ms);
          now += ms;
        },
        keyDeadlineMs: 2500,
      });
      fake.failNext('/webhook_verification_key/get', FAKE_PLAID_ERRORS.INTERNAL_SERVER_ERROR);
      fake.failNext('/webhook_verification_key/get', FAKE_PLAID_ERRORS.INTERNAL_SERVER_ERROR);
      // 1 s of waiting fits before the deadline; the 2 s wait after the second failure doesn't.
      expect(await caught(client.getWebhookVerificationKey('kid-1'))).toMatchObject({ status: 500 });
      expect(waits).toEqual([1000]);
      expect(fake.count('/webhook_verification_key/get')).toBe(2);
    });

    it('treats a 200 that is not JSON, or not the documented shape, as a bad response', async () => {
      const client = new PlaidClient(config, async () => new Response('<html>', { status: 200 }));
      expect(await caught(client.removeItem('access-sandbox-synthetic'))).toBeInstanceOf(PlaidBadResponse);
      const odd = new PlaidClient(config, async () => Response.json({ link_token: 42 }));
      const err = await caught(odd.createLinkToken(NEW_LINK));
      expect(err).toBeInstanceOf(PlaidBadResponse);
      expect(err).toMatchObject({ path: '/link/token/create' });
      expect(classifyPlaidError(err)).toBe('other');
    });

    it('reads an error that is not JSON as an error without codes', async () => {
      const client = new PlaidClient(config, async () => new Response('Bad gateway', { status: 502 }), { sleep: async () => {} });
      const err = await caught(client.getItem('access-sandbox-synthetic'));
      expect(err).toMatchObject({ status: 502, errorType: null, errorCode: null, requestId: null });
      expect(classifyPlaidError(err)).toBe('transient');
    });
  });
});

describe('classifyPlaidError', () => {
  const api = (status: number, errorType: string | null, errorCode: string | null) => new PlaidApiError('/transactions/sync', status, errorType, errorCode, null);

  it('matches the Trial limit before the rate-limit type it shares', () => {
    expect(classifyPlaidError(api(429, 'RATE_LIMIT_EXCEEDED', 'TRIAL_CONNECTION_LIMIT'))).toBe('trial_limit');
    expect(classifyPlaidError(api(429, 'RATE_LIMIT_EXCEEDED', 'TRANSACTIONS_SYNC_LIMIT'))).toBe('transient');
    expect(classifyPlaidError(api(429, 'RATE_LIMIT_EXCEEDED', 'SOMETHING_NEW'))).toBe('transient');
  });

  it('sorts Item errors into reconnect and gone', () => {
    for (const code of ['ITEM_LOGIN_REQUIRED', 'ACCESS_NOT_GRANTED', 'NO_ACCOUNTS', 'PASSWORD_RESET_REQUIRED', 'ITEM_LOCKED']) {
      expect(classifyPlaidError(api(400, 'ITEM_ERROR', code)), code).toBe('reconnect');
    }
    expect(classifyPlaidError(api(400, 'ITEM_ERROR', 'ITEM_NOT_FOUND'))).toBe('gone');
    expect(classifyPlaidError(api(400, 'INVALID_INPUT', 'INVALID_ACCESS_TOKEN'))).toBe('gone');
  });

  it('calls outages, rate limits, and Plaid errors transient', () => {
    expect(classifyPlaidError(api(400, 'ITEM_ERROR', 'PRODUCT_NOT_READY'))).toBe('transient');
    for (const code of ['INSTITUTION_DOWN', 'INSTITUTION_NOT_RESPONDING', 'INSTITUTION_NOT_AVAILABLE', 'INSTITUTION_SOMETHING_NEW']) {
      expect(classifyPlaidError(api(400, 'INSTITUTION_ERROR', code)), code).toBe('transient');
    }
    expect(classifyPlaidError(api(500, 'API_ERROR', 'INTERNAL_SERVER_ERROR'))).toBe('transient');
    expect(classifyPlaidError(api(503, null, null))).toBe('transient');
    // By code or status alone, whatever the type says.
    expect(classifyPlaidError(api(400, 'ITEM_ERROR', 'INSTITUTION_DOWN'))).toBe('transient');
    expect(classifyPlaidError(api(429, null, null))).toBe('transient');
    expect(classifyPlaidError(new PlaidUnavailable('network'))).toBe('transient');
  });

  it("calls an institution that needs registering or isn't authorized other, and one Plaid no longer supports gone, never retried", () => {
    expect(classifyPlaidError(api(400, 'INSTITUTION_ERROR', 'INSTITUTION_REGISTRATION_REQUIRED'))).toBe('other');
    expect(classifyPlaidError(api(400, 'INSTITUTION_ERROR', 'UNAUTHORIZED_INSTITUTION'))).toBe('other');
    expect(classifyPlaidError(api(400, 'INSTITUTION_ERROR', 'INSTITUTION_NO_LONGER_SUPPORTED'))).toBe('gone');
  });

  it('calls the mutation error its own class, and everything else other', () => {
    expect(classifyPlaidError(api(400, 'TRANSACTIONS_ERROR', 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION'))).toBe('mutation');
    expect(classifyPlaidError(api(400, 'TRANSACTIONS_ERROR', 'TRANSACTIONS_SYNC_ITEM_LIMIT_EXCEEDED'))).toBe('other');
    expect(classifyPlaidError(api(400, 'ITEM_ERROR', 'NO_LIABILITY_ACCOUNTS'))).toBe('other');
    expect(classifyPlaidError(api(400, 'INVALID_INPUT', 'INVALID_API_KEYS'))).toBe('other');
    expect(classifyPlaidError(new Error('boom'))).toBe('other');
    expect(classifyPlaidError('boom')).toBe('other');
  });
});

describe('plaidAmountCents', () => {
  it('reads dollars as whole cents through their decimal text, so 0.1 + 0.2 style floats never leak in', () => {
    expect(plaidAmountCents(12.34)).toEqual({ cents: 1234, rounded: false });
    expect(plaidAmountCents(-20)).toEqual({ cents: -2000, rounded: false });
    expect(plaidAmountCents(0.1 + 0.2)).toEqual({ cents: 30, rounded: true });
    expect(plaidAmountCents(1.005)).toEqual({ cents: 101, rounded: true });
    expect(plaidAmountCents(4.1)).toEqual({ cents: 410, rounded: false });
    expect(plaidAmountCents(0)).toEqual({ cents: 0, rounded: false });
  });

  it('rounds past two decimal places to the nearest cent, halves away from zero, and says so', () => {
    expect(plaidAmountCents(1.234)).toEqual({ cents: 123, rounded: true });
    expect(plaidAmountCents(1.235)).toEqual({ cents: 124, rounded: true });
    expect(plaidAmountCents(-1.235)).toEqual({ cents: -124, rounded: true });
    expect(plaidAmountCents(0.999)).toEqual({ cents: 100, rounded: true });
    expect(plaidAmountCents(-0.001)).toEqual({ cents: 0, rounded: true });
    expect(plaidAmountCents(1e-7)).toEqual({ cents: 0, rounded: true });
  });

  it('refuses amounts past MAX_AMOUNT_CENTS either way, and anything not finite', () => {
    expect(plaidAmountCents(MAX_AMOUNT_CENTS / 100)).toEqual({ cents: MAX_AMOUNT_CENTS, rounded: false });
    expect(plaidAmountCents(-MAX_AMOUNT_CENTS / 100)).toEqual({ cents: -MAX_AMOUNT_CENTS, rounded: false });
    expect(plaidAmountCents(MAX_AMOUNT_CENTS / 100 + 0.01)).toBeNull();
    expect(plaidAmountCents(1e21)).toBeNull();
    expect(plaidAmountCents(Number.NaN)).toBeNull();
    expect(plaidAmountCents(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('balances on /accounts/get', () => {
  it('reads current and available, and an account whose balance is malformed keeps null balances rather than being left out', async () => {
    const { client, fake } = setup();
    const item = fake.createItem({ accounts: [{ name: 'Cash', mask: '1111', type: 'depository', subtype: 'cash management', current: 1234.56, available: 1200 }] });
    const { accounts, skipped } = await client.getAccounts(item.accessToken);
    expect(skipped).toBe(0);
    expect(accounts[0]!.balances).toEqual({ current: 1234.56, available: 1200, iso_currency_code: 'USD', unofficial_currency_code: null });

    fake.setBalance(item.itemId, item.accounts[0]!.account_id, { current: 'lots' as unknown as number, available: null });
    const again = await client.getAccounts(item.accessToken);
    expect(again.skipped).toBe(0);
    expect(again.accounts[0]!.balances.current).toBeNull();
  });
});

describe('/investments/transactions/get', () => {
  it('sends the window, count and offset, and reads the fields Savings uses, never names', async () => {
    const { client, fake } = setup();
    const item = fake.createItem({ accounts: [{ name: 'Brokerage', mask: '2222', type: 'investment', subtype: 'brokerage' }] });
    const account = item.accounts[0]!.account_id;
    fake.addInvestmentTransaction(item.itemId, { account_id: account, date: '2026-11-03', amount: -500, type: 'cash', subtype: 'deposit', name: 'SYNTHETIC ACH IN' });
    fake.addInvestmentTransaction(item.itemId, { account_id: account, date: '2026-11-04', amount: 100, type: 'buy', subtype: 'buy', security_id: 'sec-1' });
    const page = await client.getInvestmentTransactions(item.accessToken, { startDate: '2026-10-15', endDate: '2026-11-15', count: 500, offset: 0 });
    expect(fake.lastBody('/investments/transactions/get')).toMatchObject({ start_date: '2026-10-15', end_date: '2026-11-15', options: { count: 500, offset: 0 } });
    expect(page.total).toBe(2);
    expect(page.skipped).toBe(0);
    // Reverse-chronological, as Plaid answers (research §3.1).
    expect(page.transactions.map((t) => [t.date, t.type, t.subtype, t.amount, t.security_id])).toEqual([
      ['2026-11-04', 'buy', 'buy', 100, 'sec-1'], ['2026-11-03', 'cash', 'deposit', -500, null],
    ]);
    expect(Object.keys(page.transactions[0]!)).not.toContain('name');
  });

  it("pages by offset, counts entries it can't read, and is retried like the other reads", async () => {
    const { client, fake, waits } = setup();
    const item = fake.createItem({ accounts: [{ name: 'Brokerage', mask: '2222', type: 'investment', subtype: 'brokerage' }] });
    const account = item.accounts[0]!.account_id;
    for (let d = 1; d <= 3; d++) fake.addInvestmentTransaction(item.itemId, { account_id: account, date: `2026-11-0${d}`, amount: -d });
    fake.addInvestmentTransaction(item.itemId, { account_id: account, date: '2026-11-05', amount: 'x' as unknown as number });
    const first = await client.getInvestmentTransactions(item.accessToken, { startDate: '2026-11-01', endDate: '2026-11-30', count: 2, offset: 0 });
    expect([first.total, first.transactions.length, first.skipped]).toEqual([4, 1, 1]);
    fake.failNext('/investments/transactions/get', FAKE_PLAID_ERRORS.INTERNAL_SERVER_ERROR);
    const second = await client.getInvestmentTransactions(item.accessToken, { startDate: '2026-11-01', endDate: '2026-11-30', count: 2, offset: 2 });
    expect(second.transactions.map((t) => t.date)).toEqual(['2026-11-02', '2026-11-01']);
    expect(fake.count('/investments/transactions/get')).toBe(3);
    expect(waits).toEqual([1000]);
  });

  it("passes Plaid's refusals through with their codes", async () => {
    const { client, fake } = setup();
    const item = fake.createItem({ investments: false });
    await expect(client.getInvestmentTransactions(item.accessToken, { startDate: '2026-11-01', endDate: '2026-11-15' }))
      .rejects.toMatchObject({ name: 'PlaidApiError', errorType: 'ITEM_ERROR', errorCode: 'PRODUCTS_NOT_SUPPORTED' });
  });
});
