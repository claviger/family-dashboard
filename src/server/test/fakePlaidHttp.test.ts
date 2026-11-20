import { createHash, createPublicKey, verify, type webcrypto } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { runInNewContext } from 'node:vm';
import { serve, type ServerType } from '@hono/node-server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifyPlaidError, PlaidApiError, PlaidClient, PlaidUnavailable } from '../integrations/plaid/client.js';
import { FAKE_PLAID_ERRORS, FakePlaid } from './fakePlaid.js';
import { FAKE_LINK_SCRIPT_PATH, FakePlaidHttp } from './fakePlaidHttp.js';

// Everything here is synthetic: the keys, institutions, accounts, tokens and transactions.
const API = 'http://127.0.0.1:3103';
const CDN = 'http://localhost:3103';
const REDIRECT = 'http://localhost:3100/connect/plaid/oauth-return';

function setup() {
  const fake = new FakePlaid();
  const http = new FakePlaidHttp(fake, { apiOrigin: API, scriptOrigin: CDN, webhookUrl: 'http://127.0.0.1:3100/webhooks/plaid' });
  const req = (method: string, url: string, body?: unknown) =>
    http.handle(new Request(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }));
  const control = async <T = Record<string, unknown>>(path: string, body?: unknown) => {
    const res = await req(body === undefined ? 'GET' : 'POST', `${API}/__fake/${path}`, body);
    return { status: res.status, body: (await res.json()) as T };
  };
  /** The app's call to Plaid, as PlaidClient makes it. */
  const plaid = async (path: string, body: Record<string, unknown>) => {
    const res = await http.handle(new Request(`${API}${path}`, {
      method: 'POST',
      headers: { 'PLAID-CLIENT-ID': fake.clientId, 'PLAID-SECRET': fake.secret, 'Plaid-Version': '2020-09-14', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }));
    return (await res.json()) as Record<string, unknown>;
  };
  /** A new Item's link token, or with `access_token` an update-mode one (which has no products). */
  const linkToken = async (extra: Record<string, unknown> = {}) =>
    (await plaid('/link/token/create', {
      client_name: 'Family Dashboard', language: 'en', country_codes: ['US'], user: { client_user_id: 'u-1' }, redirect_uri: REDIRECT,
      ...('access_token' in extra ? {} : { products: ['transactions'] }), ...extra,
    })).link_token as string;
  return { fake, http, req, control, plaid, linkToken };
}
type Setup = ReturnType<typeof setup>;

interface LinkOutcome {
  kind: 'success' | 'exit' | 'redirect';
  args: unknown[];
  errors: string[];
}

/** Loads the served link-initialize.js in a sandbox, as the Link page would, and opens Link once. */
async function openLink(s: Setup, config: { token: string; receivedRedirectUri?: string }): Promise<LinkOutcome> {
  const script = await (await s.req('GET', `${CDN}${FAKE_LINK_SCRIPT_PATH}`)).text();
  const errors: string[] = [];
  return new Promise((resolve) => {
    const sandbox: Record<string, unknown> = {
      fetch: (input: string, init: RequestInit) => s.http.handle(new Request(input, init)),
      console: { error: (m: string) => errors.push(m) },
      location: { assign: (url: string) => resolve({ kind: 'redirect', args: [url], errors }) },
    };
    sandbox.window = sandbox;
    runInNewContext(script, sandbox);
    const Plaid = sandbox.Plaid as { create(c: unknown): { open(): void } };
    Plaid.create({
      ...config,
      onSuccess: (...args: unknown[]) => resolve({ kind: 'success', args, errors }),
      onExit: (...args: unknown[]) => resolve({ kind: 'exit', args, errors }),
    }).open();
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the fake Link', () => {
  it('is served only from the script origin, and the API only from the API origin', async () => {
    const s = setup();
    const script = await s.req('GET', `${CDN}${FAKE_LINK_SCRIPT_PATH}`);
    expect(script.status).toBe(200);
    expect(script.headers.get('content-type')).toMatch(/^text\/javascript/);
    // It calls back on the API origin, the one the Link page's connect-src allows.
    expect(await script.text()).toContain(`"${API}/__fake/link/complete"`);
    expect((await s.req('GET', `${API}${FAKE_LINK_SCRIPT_PATH}`)).status).toBe(404);
    expect((await s.req('POST', `${CDN}/link/token/create`, {})).status).toBe(404);
    expect((await s.control('health')).body).toEqual({ ok: true });
  });

  it('answers the browser cross-origin', async () => {
    const s = setup();
    const res = await s.req('OPTIONS', `${API}/__fake/link/complete`);
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-headers')).toBe('content-type');
  });

  it("succeeds by default with the fake's bank, and the public token exchanges", async () => {
    const s = setup();
    const token = await s.linkToken();
    const out = await openLink(s, { token });
    expect(out.kind).toBe('success');
    const [publicToken, metadata] = out.args as [string, { institution: unknown; accounts: { mask: string }[] }];
    expect(metadata.institution).toEqual({ institution_id: 'ins_fake_1', name: 'Example Bank' });
    expect(metadata.accounts.map((a) => a.mask)).toEqual(['1111']);
    expect(await s.plaid('/item/public_token/exchange', { public_token: publicToken })).toHaveProperty('access_token');
    expect((await s.control('link/sessions')).body).toEqual([
      { mode: 'new', itemId: expect.any(String), receivedRedirectUri: null, outcome: 'success', linkTokenRequest: expect.objectContaining({ redirect_uri: REDIRECT }) },
    ]);
  });

  it('ends the way the test queued: the accounts chosen, then an exit with an error', async () => {
    const s = setup();
    await s.control('link/next', { outcome: 'success', institution: { institution_id: 'ins_fake_bofa', name: 'Example Bank of Tests' }, accounts: [{ name: 'Travel', mask: '2222' }] });
    await s.control('link/next', { outcome: 'exit', error: { error_type: 'RATE_LIMIT_EXCEEDED', error_code: 'TRIAL_CONNECTION_LIMIT' } });
    const first = await openLink(s, { token: await s.linkToken() });
    expect((first.args[1] as { accounts: { name: string }[] }).accounts.map((a) => a.name)).toEqual(['Travel']);
    const second = await openLink(s, { token: await s.linkToken() });
    expect(second.kind).toBe('exit');
    expect(second.args[0]).toEqual({ error_type: 'RATE_LIMIT_EXCEEDED', error_code: 'TRIAL_CONNECTION_LIMIT' });
    expect(second.args[1]).toMatchObject({ institution: null, status: null });
  });

  it('goes to the bank and back: the return page must pass exactly the URL the bank sent', async () => {
    const s = setup();
    const token = await s.linkToken();
    await s.control('link/next', { outcome: 'oauth' });
    const away = await openLink(s, { token });
    expect(away.kind).toBe('redirect');
    const back = away.args[0] as string;
    expect(back).toMatch(new RegExp(`^${REDIRECT}\\?oauth_state_id=[0-9a-f-]{36}$`));

    const wrong = await openLink(s, { token, receivedRedirectUri: `${back}&extra=1` });
    expect(wrong.kind).toBe('exit');
    expect(wrong.args[0]).toMatchObject({ error_code: 'FAKE_LINK_FAILED' });
    expect(wrong.errors[0]).toMatch(/receivedRedirectUri/);

    const done = await openLink(s, { token, receivedRedirectUri: back });
    expect(done.kind).toBe('success');
    const sessions = (await s.control<{ receivedRedirectUri: string | null; outcome: string }[]>('link/sessions')).body;
    expect(sessions.map((x) => [x.outcome, x.receivedRedirectUri])).toEqual([['oauth', null], ['failed', `${back}&extra=1`], ['success', back]]);
  });

  it('refuses a receivedRedirectUri when Link never went to the bank, and a token it never issued', async () => {
    const s = setup();
    const stray = await openLink(s, { token: await s.linkToken(), receivedRedirectUri: `${REDIRECT}?oauth_state_id=x` });
    expect(stray.args[0]).toMatchObject({ error_code: 'FAKE_LINK_FAILED' });
    const unknown = await openLink(s, { token: 'link-sandbox-nope' });
    expect(unknown.kind).toBe('exit');
    expect(unknown.errors[0]).toMatch(/did not issue/);
  });

  it('reconnects in update mode with the same Item', async () => {
    const s = setup();
    const item = s.fake.createItem();
    s.fake.breakItem(item.itemId);
    const out = await openLink(s, { token: await s.linkToken({ access_token: item.accessToken }) });
    expect(out.kind).toBe('success');
    expect(s.fake.item(item.itemId).error).toBeNull();
    expect((await s.control<unknown[]>('link/sessions')).body[0]).toMatchObject({ mode: 'update', itemId: item.itemId });
  });
});

describe('the controls', () => {
  it('changes transactions at the bank, on the newest linked Item by default', async () => {
    const s = setup();
    const item = s.fake.createItem({ accounts: [{ name: 'Everyday', mask: '1111' }, { name: 'Travel', mask: '2222' }] });
    const added = await s.control('transactions/add', { mask: '2222', transaction_id: 'tx-pending', pending: true, amount: 4.5 });
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({ transaction_id: 'tx-pending', account_id: item.accounts[1]!.account_id, pending: true });
    expect((await s.control('transactions/modify', { transactionId: 'tx-pending', changes: { amount: 5 } })).body).toMatchObject({ amount: 5 });
    expect((await s.control('transactions/post', { pendingId: 'tx-pending', posted: { transaction_id: 'tx-posted' } })).body).toMatchObject({ pending_transaction_id: 'tx-pending' });
    expect((await s.control('transactions/churn', { oldId: 'tx-posted', newId: 'tx-churned' })).body).toMatchObject({ transaction_id: 'tx-churned' });
    expect((await s.control('transactions/remove', { transactionId: 'tx-churned' })).status).toBe(200);
    expect(s.fake.item(item.itemId).log.map((c) => c.kind)).toEqual(['added', 'modified', 'removed', 'added', 'removed', 'added', 'removed']);
    const view = (await s.control<{ itemsCreated: number; items: unknown[] }>('items')).body;
    expect(view.itemsCreated).toBe(1);
    expect(view.items[0]).toMatchObject({ itemId: item.itemId, transactions: [] });
  });

  it('sets statements, breaks and repairs an Item, and fails the next API call', async () => {
    const s = setup();
    const item = s.fake.createItem();
    expect((await s.control('liabilities', { fields: { last_statement_issue_date: '2026-10-28', last_statement_balance: 120.5 } })).status).toBe(200);
    expect(s.fake.item(item.itemId).liabilities.get(item.accounts[0]!.account_id)).toMatchObject({ last_statement_issue_date: '2026-10-28' });
    await s.control('items/break', {});
    expect(s.fake.item(item.itemId).error?.error_code).toBe('ITEM_LOGIN_REQUIRED');
    await s.control('items/repair', {});
    expect(s.fake.item(item.itemId).error).toBeNull();
    await s.control('items/consent', { consentExpirationTime: '2027-10-01T00:00:00Z' });
    expect(s.fake.item(item.itemId).consentExpirationTime).toBe('2027-10-01T00:00:00Z');

    await s.control('fail', { path: '/accounts/get', error: 'INSTITUTION_DOWN' });
    expect(await s.plaid('/accounts/get', { access_token: item.accessToken })).toMatchObject({ error_code: 'INSTITUTION_DOWN' });
    expect(await s.plaid('/accounts/get', { access_token: item.accessToken })).toHaveProperty('accounts');
    expect((await s.control<unknown[]>('requests?path=/accounts/get')).body).toHaveLength(2);
    // Counted per Item by its access token, which never leaves the fake.
    const other = s.fake.createItem();
    await s.plaid('/accounts/get', { access_token: other.accessToken });
    expect((await s.control('count?path=/accounts/get')).body).toEqual({ count: 3 });
    expect((await s.control(`count?path=/accounts/get&itemId=${item.itemId}`)).body).toEqual({ count: 2 });
    expect((await s.control(`count?path=/accounts/get&itemId=${other.itemId}`)).body).toEqual({ count: 1 });
    expect(JSON.stringify((await s.control(`count?path=/accounts/get&itemId=${item.itemId}`)).body)).not.toContain(item.accessToken);
    expect((await s.control('count')).status).toBe(400);
  });

  it('delays the next call to a path, then answers it as usual', async () => {
    const s = setup();
    const item = s.fake.createItem();
    expect((await s.control('delay', { path: '/accounts/get', ms: 150 })).status).toBe(200);
    const started = Date.now();
    expect(await s.plaid('/accounts/get', { access_token: item.accessToken })).toHaveProperty('accounts');
    expect(Date.now() - started).toBeGreaterThanOrEqual(140);
    // Only the next one.
    const again = Date.now();
    await s.plaid('/accounts/get', { access_token: item.accessToken });
    expect(Date.now() - again).toBeLessThan(100);
    expect((await s.control('delay', { path: '/accounts/get', ms: 'soon' })).status).toBe(400);
    expect((await s.control('delay', { path: '/accounts/get', ms: 60_001 })).status).toBe(400);
  });

  it("fails, drops or delays only the named Item's next call when given an itemId (review C-M10)", async () => {
    const s = setup();
    const mine = s.fake.createItem();
    const other = s.fake.createItem();
    await s.control('fail', { path: '/accounts/get', error: 'INSTITUTION_DOWN', itemId: mine.itemId });
    // Another Item's call goes through; the failure waits for this one's.
    expect(await s.plaid('/accounts/get', { access_token: other.accessToken })).toHaveProperty('accounts');
    expect(await s.plaid('/accounts/get', { access_token: mine.accessToken })).toMatchObject({ error_code: 'INSTITUTION_DOWN' });
    await s.control('delay', { path: '/accounts/get', ms: 300, itemId: mine.itemId });
    const quick = Date.now();
    await s.plaid('/accounts/get', { access_token: other.accessToken });
    expect(Date.now() - quick).toBeLessThan(200);
    const slow = Date.now();
    await s.plaid('/accounts/get', { access_token: mine.accessToken });
    expect(Date.now() - slow).toBeGreaterThanOrEqual(280);
    await s.control('fail', { path: '/item/get', drop: true, itemId: mine.itemId });
    expect(await s.plaid('/item/get', { access_token: other.accessToken })).toHaveProperty('item');
    await expect(s.fake.fetch(`${API}/item/get`, {
      method: 'POST',
      headers: { 'PLAID-CLIENT-ID': s.fake.clientId, 'PLAID-SECRET': s.fake.secret, 'Plaid-Version': '2020-09-14', 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: mine.accessToken }),
    })).rejects.toThrow('fetch failed');
    expect((await s.control('fail', { path: '/item/get', error: 'INSTITUTION_DOWN', itemId: 'item-nope' })).status).toBe(400);
  });

  it("reset-queues empties the queued Link results and the next calls' failures and delays, and nothing else", async () => {
    const s = setup();
    const item = s.fake.createItem();
    await s.control('link/next', { outcome: 'exit' });
    await s.control('fail', { path: '/accounts/get', error: 'INSTITUTION_DOWN' });
    await s.control('fail', { path: '/item/get', drop: true });
    await s.control('delay', { path: '/transactions/sync', ms: 5_000 });
    expect((await s.control('reset-queues', {})).body).toEqual({ cleared: { linkResults: 1, failures: 3 } });
    expect(s.http.linkResults).toEqual([]);
    expect(await s.plaid('/accounts/get', { access_token: item.accessToken })).toHaveProperty('accounts');
    expect(await s.plaid('/item/get', { access_token: item.accessToken })).toHaveProperty('item');
    const started = Date.now();
    await s.plaid('/transactions/sync', { access_token: item.accessToken });
    expect(Date.now() - started).toBeLessThan(1_000);
    // Items, sessions and the request log stay.
    expect(s.fake.items.size).toBe(1);
    expect(s.fake.requests.length).toBe(3);
  });

  it('says what was wrong with a control', async () => {
    const s = setup();
    expect(await s.control('transactions/add', {})).toEqual({ status: 400, body: { error: 'No linked bank yet.' } });
    s.fake.createItem();
    expect((await s.control('transactions/add', { mask: '9999' })).body).toEqual({ error: 'No such account on that bank.' });
    expect((await s.control('fail', { path: '/accounts/get', error: 'NOPE' })).status).toBe(400);
    expect((await s.control('link/next', { outcome: 'maybe' })).status).toBe(400);
    expect((await s.control('nope')).status).toBe(404);
  });

  it("fires a signed webhook at the Item's webhook URL, filling in its item_id", async () => {
    const s = setup();
    const item = s.fake.createItem({ webhook: 'http://localhost:3100/webhooks/plaid' });
    const sent: { url: string; headers: Headers; body: string }[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      sent.push({ url: String(input), headers: new Headers(init?.headers), body: String(init?.body) });
      return new Response(null, { status: 200 });
    });
    const res = await s.control('webhook', { payload: { webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', note: 'café' } });
    expect(res.body).toEqual({ status: 200 });
    expect(sent[0]!.url).toBe('http://localhost:3100/webhooks/plaid');
    const body = sent[0]!.body;
    expect(JSON.parse(body)).toEqual({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', note: 'café', item_id: item.itemId, environment: 'sandbox' });
    // Plaid's own layout (2-space indents), signed over exactly those bytes, by the key it serves.
    expect(body).toBe(JSON.stringify(JSON.parse(body), null, 2));
    const jwt = sent[0]!.headers.get('plaid-verification')!;
    const [header, claims, signature] = jwt.split('.') as [string, string, string];
    const { alg, kid } = JSON.parse(Buffer.from(header, 'base64url').toString()) as { alg: string; kid: string };
    expect(alg).toBe('ES256');
    const { iat, request_body_sha256 } = JSON.parse(Buffer.from(claims, 'base64url').toString()) as { iat: number; request_body_sha256: string };
    expect(Math.abs(iat - Date.now() / 1000)).toBeLessThan(5);
    expect(request_body_sha256).toBe(createHash('sha256').update(Buffer.from(body, 'utf8')).digest('hex'));
    const served = await s.plaid('/webhook_verification_key/get', { key_id: kid });
    const key = createPublicKey({ key: served.key as webcrypto.JsonWebKey, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(signature, 'base64url'))).toBe(true);
    await s.control('webhook', { url: 'http://127.0.0.1:3100/elsewhere', payload: { item_id: 'item-x', webhook_type: 'ITEM', webhook_code: 'ERROR' } });
    expect(sent[1]!.url).toBe('http://127.0.0.1:3100/elsewhere');
  });

  it('sets balances, adds investment transactions, and switches Investments for an Item and the client', async () => {
    const { control, fake } = setup();
    const item = fake.createItem({ institution: { institution_id: 'ins_s', name: 'Example Brokerage' }, accounts: [
      { name: 'Cash', mask: '1111', type: 'depository', subtype: 'cash management' }, { name: 'Brokerage', mask: '2222', type: 'investment', subtype: 'brokerage' },
    ] });
    expect(await control('balances', { itemId: item.itemId, mask: '1111', current: 1500.25, available: 1400 })).toEqual({ status: 200, body: { ok: true } });
    expect(fake.item(item.itemId).accounts[0]).toMatchObject({ current: 1500.25, available: 1400 });
    const added = await control('investments/add', { itemId: item.itemId, mask: '2222', date: '2026-11-03', amount: -250, type: 'cash', subtype: 'deposit' });
    expect(added.body).toMatchObject({ account_id: item.accounts[1]!.account_id, amount: -250 });
    expect((await control('items/investments', { itemId: item.itemId, supported: false })).body).toEqual({ ok: true });
    expect(fake.item(item.itemId).investmentsSupported).toBe(false);
    expect((await control('investments-enabled', { enabled: false })).body).toEqual({ ok: true });
    expect(fake.investmentsEnabled).toBe(false);
  });
});

describe('over HTTP', () => {
  let server: ServerType | null = null;
  afterEach(async () => {
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = null;
  });

  /** The fake on a real port, as fakePlaidServer.ts runs it, and the app's own client in front of it. */
  async function listen(opts: { secret?: string } = {}) {
    const fake = new FakePlaid();
    const http = new FakePlaidHttp(fake, { apiOrigin: 'http://127.0.0.1:0', scriptOrigin: 'http://localhost:0' });
    const port = await new Promise<number>((resolve) => {
      server = serve({ fetch: http.handle, hostname: '127.0.0.1', port: 0 }, (info: AddressInfo) => resolve(info.port));
    });
    const apiBaseUrl = `http://127.0.0.1:${port}`;
    fake.origin = apiBaseUrl;
    const client = new PlaidClient({ clientId: fake.clientId, secret: opts.secret ?? fake.secret, apiBaseUrl }, fetch, { sleep: async () => {}, timeoutMs: 500 });
    return { fake, client, apiBaseUrl };
  }

  it("carries the app's headers and body to the fake, and its answer back", async () => {
    const { fake, client } = await listen();
    const { linkToken } = await client.createLinkToken({
      client_name: 'Family Dashboard', language: 'en', country_codes: ['US'], user: { client_user_id: 'u-1' }, products: ['transactions'],
    });
    const { publicToken } = fake.completeLink(linkToken, { accounts: [{ name: 'Example Card', mask: '1234' }] });
    const { accessToken, itemId } = await client.exchangePublicToken(publicToken);
    const accountId = fake.item(itemId).accounts[0]!.account_id;
    const tx = fake.addTransaction(itemId, { account_id: accountId, amount: 5.25 });
    const page = await client.syncTransactions(accessToken, { cursor: null });
    expect(page.added.map((t) => [t.transaction_id, t.amount])).toEqual([[tx.transaction_id, 5.25]]);
    expect(fake.lastBody('/transactions/sync')).toEqual({ access_token: accessToken, count: 500, options: { personal_finance_category_version: 'v2' } });
  });

  it("refuses the wrong keys, and passes Plaid's error status and codes through", async () => {
    const wrong = await listen({ secret: 'wrong-secret' });
    expect(await wrong.client.getWebhookVerificationKey('kid-1').catch((e: unknown) => e)).toMatchObject({ status: 400, errorCode: 'INVALID_API_KEYS' });
    await new Promise<void>((resolve) => server!.close(() => resolve()));

    const { fake, client, apiBaseUrl } = await listen();
    fake.failNext('/item/public_token/exchange', FAKE_PLAID_ERRORS.TRIAL_CONNECTION_LIMIT);
    const err = await client.exchangePublicToken('public-sandbox-synthetic').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlaidApiError);
    expect(err).toMatchObject({ status: 429, errorType: 'RATE_LIMIT_EXCEEDED', errorCode: 'TRIAL_CONNECTION_LIMIT', requestId: expect.any(String) });
    expect(classifyPlaidError(err)).toBe('trial_limit');
    // The raw answer is Plaid's error shape, as the fake made it.
    fake.failNext('/item/get', FAKE_PLAID_ERRORS.INTERNAL_SERVER_ERROR);
    const res = await fetch(`${apiBaseUrl}/item/get`, {
      method: 'POST', headers: { 'PLAID-CLIENT-ID': fake.clientId, 'PLAID-SECRET': fake.secret, 'Plaid-Version': '2020-09-14', 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ error_type: 'API_ERROR', error_code: 'INTERNAL_SERVER_ERROR', display_message: null });
  });

  it('drops the connection for dropNext, and leaves a hung call unanswered, as the network would', async () => {
    const { fake, client } = await listen();
    fake.dropNext('/item/remove');
    expect(await client.removeItem('access-sandbox-synthetic').catch((e: unknown) => e)).toMatchObject({ reason: 'network' });
    fake.hangNext('/item/remove');
    const hung = await client.removeItem('access-sandbox-synthetic').catch((e: unknown) => e);
    expect(hung).toBeInstanceOf(PlaidUnavailable);
    expect(hung).toMatchObject({ reason: 'timeout' });
  });
});
