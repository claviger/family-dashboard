import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { eq } from 'drizzle-orm';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { PLAID_LINK_ERRORS, PLAID_MESSAGES } from '../../../shared/plaid.js';
import { cards, plaidItems, plaidLinkPending } from '../../db/schema.js';
import { panelJobs } from '../../panels/registry.js';
import { mountStatic } from '../../static.js';
import { FAKE_PLAID_ERRORS } from '../../test/fakePlaid.js';
import { addUser, call, cookieFor, makeTestApp, TEST_BASE_URL, TEST_PLAID_CONFIG, TEST_PLAID_LINK_HTML, type TestApp } from '../../test/helpers.js';
import { linkSavingsForTest } from '../../test/savingsFixtures.js';
import { addCard } from '../../test/spendFixtures.js';
import { sessionHash } from '../google/routes.js';
import { CSP_REPORT_BODY_LIMIT, CSP_REPORTS_PER_MINUTE, LINK_LOCK_DEADLINE_MS, WEBHOOK_BODY_LIMIT } from './routes.js';

// Everything here is synthetic: the keys, institutions, accounts, and tokens.
const STRICT_CSP = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
const LINK_CSP =
  "default-src 'self' https://cdn.plaid.test; script-src 'self' https://cdn.plaid.test/link/v2/stable/link-initialize.js; " +
  "style-src 'self' 'unsafe-inline'; style-src-elem 'self' 'unsafe-inline'; style-src-attr 'unsafe-inline'; img-src 'self' data: https://cdn.plaid.test; " +
  "frame-src https://cdn.plaid.test; connect-src 'self' https://sandbox.plaid.test; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'";
/** Report-only, and narrower: no Plaid CDN on default-src, which "Verify on first real link" suggests trying. */
const LINK_CSP_REPORT_ONLY = LINK_CSP.replace("default-src 'self' https://cdn.plaid.test;", "default-src 'self';") + '; report-uri /csp-report';
const BANK = { institution_id: 'ins_fake_bank', name: 'Example Bank' };
const CARD = { name: 'Example Rewards', mask: '1111' };

function setup(opts: { plaid?: boolean; plaidLinkHtml?: string | null; logger?: pino.Logger; budgetMs?: number } = {}) {
  const t = makeTestApp({ plaid: opts.plaid ?? true, plaidLinkHtml: opts.plaidLinkHtml, logger: opts.logger, plaidRequestBudgetMs: opts.budgetMs });
  const admin = addUser(t.db, t.clock, { email: 'alex@example.com', role: 'admin' });
  const member = addUser(t.db, t.clock, { email: 'kid@example.com', role: 'member' });
  return { t, admin, member, cookie: cookieFor(t.db, t.clock, admin), memberCookie: cookieFor(t.db, t.clock, member) };
}
type Setup = ReturnType<typeof setup>;

function tokenOf(cookie: string): string {
  return cookie.slice(cookie.indexOf('=') + 1);
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

const answer = async <T>(res: Response): Promise<T> => {
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as T;
};

/** The Link page's calls for a new bank: link token, Link (the fake's), exchange. */
async function connect(s: Setup, cookie = s.cookie) {
  const res = await call(s.t.app, 'POST', '/connect/plaid/link-token', { cookie, body: {} });
  expect(res.status).toBe(200);
  const { linkToken } = (await res.json()) as { linkToken: string };
  const { publicToken, metadata } = s.t.fakePlaid.completeLink(linkToken, { institution: BANK, accounts: [CARD] });
  return { publicToken, metadata, exchange: () => call(s.t.app, 'POST', '/connect/plaid/exchange', { cookie, body: { publicToken, metadata } }) };
}

function webhook(t: TestApp, payload: unknown, opts: Parameters<TestApp['fakePlaid']['signWebhook']>[1] = {}, headers: Record<string, string> = {}) {
  const signed = t.fakePlaid.signWebhook(payload, opts);
  return t.app.request('/webhooks/plaid', { method: 'POST', headers: { ...signed.headers, ...headers }, body: signed.body });
}

/** The test app with built web assets in a temp dir, like index.ts mounts them. */
function withStatic(t: TestApp) {
  const dir = mkdtempSync(join(tmpdir(), 'fd-plaid-static-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>app</title>');
  writeFileSync(join(dir, 'plaid-link.html'), TEST_PLAID_LINK_HTML);
  mountStatic(t.app, path.relative(process.cwd(), dir).split(path.sep).join('/'));
  return t.app;
}

describe('the Link pages and the CSP', () => {
  it('serves both Link pages to an admin with the Link CSP and nothing cached', async () => {
    const s = setup();
    for (const p of ['/connect/plaid/link?item=3&accounts=1', '/connect/plaid/oauth-return?oauth_state_id=synthetic-state']) {
      const res = await call(s.t.app, 'GET', p, { cookie: s.cookie });
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(TEST_PLAID_LINK_HTML);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(res.headers.get('content-security-policy')).toBe(LINK_CSP);
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('referrer-policy')).toBe('same-origin');
      // Link's OAuth popup keeps its opener (research §3.4).
      expect(res.headers.get('cross-origin-opener-policy')).toBe('same-origin-allow-popups');
      expect(res.headers.get('content-security-policy-report-only')).toBe(LINK_CSP_REPORT_ONLY);
    }
  });

  it('opens the link page only from this site (Sec-Fetch-Site same-origin or none, or none sent); the OAuth return from anywhere', async () => {
    const s = setup();
    const open = (p: string, site?: string) => s.t.app.request(p, { headers: { cookie: s.cookie, ...(site ? { 'sec-fetch-site': site } : {}) } });
    for (const site of [undefined, 'same-origin', 'none']) expect((await open('/connect/plaid/link', site)).status, site).toBe(200);
    for (const site of ['cross-site', 'same-site']) {
      const res = await open('/connect/plaid/link?item=3', site);
      expect(res.status, site).toBe(403);
      expect(await res.text()).toBe(PLAID_MESSAGES.notFromHere);
      expect(res.headers.get('content-security-policy')).toBe(STRICT_CSP);
    }
    // The bank sends the browser back here from its own site.
    expect((await open('/connect/plaid/oauth-return?oauth_state_id=synthetic-state', 'cross-site')).status).toBe(200);
  });

  it('builds the Link CSP from the config: the exact script URL and the API origin', async () => {
    const t = makeTestApp({
      config: { plaid: { ...TEST_PLAID_CONFIG, apiBaseUrl: 'http://127.0.0.1:3103', linkScriptUrl: 'http://localhost:3103/link/v2/stable/link-initialize.js' } },
    });
    const admin = addUser(t.db, t.clock, { email: 'alex@example.com', role: 'admin' });
    const csp = (await call(t.app, 'GET', '/connect/plaid/link', { cookie: cookieFor(t.db, t.clock, admin) })).headers.get('content-security-policy')!;
    expect(csp).toContain("script-src 'self' http://localhost:3103/link/v2/stable/link-initialize.js;");
    expect(csp).toContain('frame-src http://localhost:3103;');
    expect(csp).toContain("connect-src 'self' http://127.0.0.1:3103;");
  });

  it('sends a signed-out visitor home and refuses anyone but an admin, under the strict CSP', async () => {
    const s = setup();
    const out = await call(s.t.app, 'GET', '/connect/plaid/link');
    expect(out.status).toBe(302);
    expect(out.headers.get('location')).toBe('/');
    expect(out.headers.get('content-security-policy')).toBe(STRICT_CSP);
    expect(out.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    const member = await call(s.t.app, 'GET', '/connect/plaid/oauth-return', { cookie: s.memberCookie });
    expect(member.status).toBe(403);
    expect(await member.text()).toBe('Only an admin can connect a bank.');
    expect(member.headers.get('content-security-policy')).toBe(STRICT_CSP);
  });

  it("says so when the Link page isn't built", async () => {
    const s = setup({ plaidLinkHtml: null });
    const res = await call(s.t.app, 'GET', '/connect/plaid/link', { cookie: s.cookie });
    expect(res.status).toBe(503);
    expect(res.headers.get('content-security-policy')).toBe(STRICT_CSP);
  });

  it('keeps the strict CSP on every other response: the API, errors, 404s, the webhook, and the SPA fallback', async () => {
    const s = setup();
    const app = withStatic(s.t);
    const responses = [
      await call(app, 'GET', '/healthz'),
      await call(app, 'GET', '/api/me', { cookie: s.cookie }),
      await call(app, 'GET', '/api/nope', { cookie: s.cookie }),
      await call(app, 'GET', '/connect/plaid/nope', { cookie: s.cookie }),
      await call(app, 'GET', '/connect/plaid/link/', { cookie: s.cookie }),
      await call(app, 'POST', '/connect/plaid/link', { cookie: s.cookie }),
      await call(app, 'POST', '/connect/plaid/link-token', { cookie: s.cookie, body: {} }),
      await call(app, 'POST', '/connect/plaid/resume', { cookie: s.memberCookie }),
      await call(app, 'POST', '/webhooks/plaid', { csrf: false }),
      await call(app, 'GET', '/spend?tab=settings', { cookie: s.cookie }),
      await call(app, 'GET', '/plaid-link.html', { cookie: s.cookie }),
    ];
    expect(responses.map((r) => r.status)).toEqual([200, 200, 404, 404, 404, 404, 200, 403, 401, 200, 200]);
    for (const r of responses) {
      expect(r.headers.get('content-security-policy')).toBe(STRICT_CSP);
      expect(r.headers.get('cross-origin-opener-policy')).toBe('same-origin');
    }
    // The SPA's fallback really was index.html, and the built Link file served directly gets no exception.
    expect(await responses[9]!.text()).toContain('<title>app</title>');
  });

  it("makes every Plaid route a 404 without Plaid's keys, even past the SPA fallback", async () => {
    expect((await call(makeTestApp().app, 'POST', '/csp-report', { csrf: false, body: {} })).status).toBe(404);
    const s = setup({ plaid: false });
    const app = withStatic(s.t);
    for (const [method, p] of [['GET', '/connect/plaid/link'], ['GET', '/connect/plaid/oauth-return'], ['POST', '/connect/plaid/link-token'], ['POST', '/connect/plaid/exchange']] as const) {
      const res = await call(app, method, p, { cookie: s.cookie, body: method === 'POST' ? {} : undefined });
      expect(res.status).toBe(404);
      expect(res.headers.get('content-security-policy')).toBe(STRICT_CSP);
    }
    const hook = await webhook(s.t, { webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: 'item-x', environment: 'sandbox' });
    expect(hook.status).toBe(404);
    expect(((await json(await call(app, 'GET', '/api/me', { cookie: s.cookie }))).features as { plaid: boolean }).plaid).toBe(false);
  });
});

describe('POST /csp-report', () => {
  const report = (t: TestApp, body: string, opts: { type?: string; ip?: string } = {}) =>
    t.app.request('/csp-report', {
      method: 'POST',
      headers: { 'content-type': opts.type ?? 'application/csp-report', ...(opts.ip ? { 'x-forwarded-for': opts.ip } : {}) },
      body,
    });
  const logged = (lines: string[]) => lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.msg === 'csp report');

  it("takes a browser's report without the CSRF header, and logs only the directive, the blocked URL's origin, and the page's path", async () => {
    const lines: string[] = [];
    const s = setup({ logger: pino({ level: 'info' }, { write: (line: string) => { lines.push(line); } }) });
    const body = JSON.stringify({
      'csp-report': {
        'document-uri': 'https://dashboard.example.com/connect/plaid/oauth-return?oauth_state_id=synthetic-secret-state',
        'violated-directive': 'img-src',
        'effective-directive': 'img-src',
        'original-policy': "default-src 'self'; report-uri /csp-report",
        'blocked-uri': 'https://images.bank.example/pixel.gif?session=synthetic-secret-session',
        'script-sample': 'synthetic-secret-sample',
      },
    });
    expect((await report(s.t, body)).status).toBe(204);
    // The Reporting API's shape too.
    const modern = JSON.stringify([{
      type: 'csp-violation', url: 'https://dashboard.example.com/connect/plaid/link?item=3',
      body: { documentURL: 'https://dashboard.example.com/connect/plaid/link?item=3', effectiveDirective: 'script-src-elem', blockedURL: 'inline', sample: 'synthetic-secret-sample' },
    }]);
    expect((await report(s.t, modern, { type: 'application/reports+json' })).status).toBe(204);
    expect(logged(lines).map(({ directive, blocked, page }) => ({ directive, blocked, page }))).toEqual([
      { directive: 'img-src', blocked: 'https://images.bank.example', page: '/connect/plaid/oauth-return' },
      { directive: 'script-src-elem', blocked: 'inline', page: '/connect/plaid/link' },
    ]);
    const all = lines.join('\n');
    for (const secret of ['synthetic-secret-state', 'synthetic-secret-session', 'synthetic-secret-sample', 'original-policy']) expect(all).not.toContain(secret);
  });

  it('answers junk 204 and logs nothing for it', async () => {
    const lines: string[] = [];
    const s = setup({ logger: pino({ level: 'info' }, { write: (line: string) => { lines.push(line); } }) });
    for (const body of ['not json', '{}', '[]', JSON.stringify({ 'csp-report': { 'violated-directive': 'x'.repeat(500), 'blocked-uri': 'javascript:alert(1)' } })]) {
      expect((await report(s.t, body)).status).toBe(204);
    }
    expect(logged(lines).map((l) => l.directive)).toEqual(['unknown']);
    expect(logged(lines)[0]).toMatchObject({ blocked: 'other', page: null });
  });

  it('caps the body and limits reports per address', async () => {
    const s = setup();
    expect((await report(s.t, 'x'.repeat(CSP_REPORT_BODY_LIMIT + 1))).status).toBe(413);
    const body = JSON.stringify({ 'csp-report': { 'violated-directive': 'img-src', 'blocked-uri': 'data' } });
    for (let i = 0; i < CSP_REPORTS_PER_MINUTE; i++) expect((await report(s.t, body, { ip: '203.0.113.20' })).status).toBe(204);
    expect((await report(s.t, body, { ip: '203.0.113.20' })).status).toBe(429);
    expect((await report(s.t, body, { ip: '203.0.113.21' })).status).toBe(204);
  });
});

describe('the Link calls', () => {
  it('gives an admin a link token and the script URL, bound to their session', async () => {
    const s = setup();
    const res = await call(s.t.app, 'POST', '/connect/plaid/link-token', { cookie: s.cookie, body: {} });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { linkToken: string; scriptUrl: string; mode: string };
    expect(body.scriptUrl).toBe(TEST_PLAID_CONFIG.linkScriptUrl);
    expect(body.mode).toBe('new');
    const row = s.t.db.select().from(plaidLinkPending).get()!;
    expect(row).toMatchObject({ userId: s.admin, linkToken: body.linkToken, mode: 'new', sessionHash: sessionHash(tokenOf(s.cookie)) });
    expect(((await json(await call(s.t.app, 'GET', '/api/me', { cookie: s.cookie }))).features as { plaid: boolean }).plaid).toBe(true);
  });

  it('refuses a member, a signed-out caller, and a call without the CSRF header, saying where to go', async () => {
    const s = setup();
    const member = await call(s.t.app, 'POST', '/connect/plaid/link-token', { cookie: s.memberCookie, body: {} });
    expect(member.status).toBe(403);
    expect(await member.json()).toEqual({
      error: { code: 'forbidden', message: 'Only an admin can connect a bank.', details: { next: '/spend?tab=settings&bank_error=not_admin' } },
    });
    const out = await call(s.t.app, 'POST', '/connect/plaid/exchange', { body: {} });
    expect(out.status).toBe(401);
    expect(((await json(out)).error as { details: unknown }).details).toEqual({ next: '/' });
    const forged = await call(s.t.app, 'POST', '/connect/plaid/link-token', { cookie: s.cookie, body: {}, csrf: false });
    expect(forged.status).toBe(403);
    expect(s.t.db.select().from(plaidLinkPending).all()).toHaveLength(0);
  });

  it('exchanges in the same session and sends the admin to the pick', async () => {
    const s = setup();
    const { exchange } = await connect(s);
    const res = await exchange();
    expect(res.status).toBe(200);
    const item = s.t.db.select().from(plaidItems).get()!;
    expect(await res.json()).toEqual({ next: `/spend?tab=settings&bank=${item.id}` });
    expect(item.pickedAt).toBeNull();
    // Used up: a second exchange is refused, with the expired code.
    const again = await exchange();
    expect(again.status).toBe(404);
    expect(((await json(again)).error as { details: unknown }).details).toEqual({ next: '/spend?tab=settings&bank_error=expired' });
  });

  it("refuses another session's link, a duplicate bank login, and a body that isn't Link's", async () => {
    const s = setup();
    const other = cookieFor(s.t.db, s.t.clock, s.admin);
    const first = await connect(s);
    expect((await call(s.t.app, 'POST', '/connect/plaid/exchange', { cookie: other, body: { publicToken: first.publicToken, metadata: first.metadata } })).status).toBe(404);
    expect((await call(s.t.app, 'POST', '/connect/plaid/resume', { cookie: other })).status).toBe(404);

    expect((await (await connect(s)).exchange()).status).toBe(200);
    const dup = await (await connect(s)).exchange();
    expect(dup.status).toBe(409);
    expect(await dup.json()).toEqual({
      error: {
        code: 'conflict', message: 'That bank login is already connected as Example Bank. Nothing new was connected.',
        details: { next: '/spend?tab=settings&bank_error=duplicate' },
      },
    });

    await call(s.t.app, 'POST', '/connect/plaid/link-token', { cookie: s.cookie, body: {} });
    const bad = await call(s.t.app, 'POST', '/connect/plaid/exchange', { cookie: s.cookie, body: { publicToken: 'public-x', metadata: { accounts: 'nope' } } });
    expect(bad.status).toBe(400);
    expect(s.t.fakePlaid.count('/item/public_token/exchange')).toBe(1);
  });

  it('resumes the same token on the OAuth return page', async () => {
    const s = setup();
    const { linkToken } = (await (await call(s.t.app, 'POST', '/connect/plaid/link-token', { cookie: s.cookie, body: {} })).json()) as { linkToken: string };
    const res = await call(s.t.app, 'POST', '/connect/plaid/resume', { cookie: s.cookie });
    expect(await res.json()).toEqual({ linkToken, scriptUrl: TEST_PLAID_CONFIG.linkScriptUrl, mode: 'new', purpose: 'spend' });
  });

  it('finishes update mode, syncs a picked bank in the background, and sends the admin back to it', async () => {
    const s = setup();
    expect((await (await connect(s)).exchange()).status).toBe(200);
    const item = s.t.db.select().from(plaidItems).get()!;
    const fakeItem = s.t.fakePlaid.item(item.plaidItemId);
    addCard(s.t, { plaidItemId: item.id, plaidAccountId: fakeItem.accounts[0]!.account_id });
    s.t.db.update(plaidItems).set({ pickedAt: s.t.clock.now() }).where(eq(plaidItems.id, item.id)).run();
    s.t.fakePlaid.breakItem(item.plaidItemId);
    s.t.plaid!.markNeedsReconnect(item.id, 'ITEM_LOGIN_REQUIRED');

    const token = await call(s.t.app, 'POST', '/connect/plaid/link-token', { cookie: s.cookie, body: { itemId: item.id } });
    const { linkToken, mode } = (await token.json()) as { linkToken: string; mode: string };
    expect(mode).toBe('update');
    // The OAuth return page learns the mode from the resume, so it knows to call `updated`.
    expect(await (await call(s.t.app, 'POST', '/connect/plaid/resume', { cookie: s.cookie })).json()).toMatchObject({ linkToken, mode: 'update' });
    const { metadata } = s.t.fakePlaid.completeLink(linkToken);
    const res = await call(s.t.app, 'POST', '/connect/plaid/updated', { cookie: s.cookie, body: { metadata } });
    expect(await res.json()).toEqual({ next: `/spend?tab=settings&bank=${item.id}` });
    await s.t.bank!.idle();
    expect(s.t.fakePlaid.count('/transactions/sync')).toBe(1);
    expect(s.t.db.select().from(cards).all()).toHaveLength(1);
  });

  it("waits about 40 seconds for a syncing bank's lock, then sends the admin back to settings with 'busy'", async () => {
    const s = setup();
    expect((await (await connect(s)).exchange()).status).toBe(200);
    const item = s.t.db.select().from(plaidItems).get()!;
    s.t.plaid!.markNeedsReconnect(item.id, 'ITEM_LOGIN_REQUIRED');
    const { linkToken } = (await (await call(s.t.app, 'POST', '/connect/plaid/link-token', { cookie: s.cookie, body: { itemId: item.id } })).json()) as { linkToken: string };
    const { metadata } = s.t.fakePlaid.completeLink(linkToken);

    // A sync holds the Item's lock. The route's deadline is checked, then shortened so the test doesn't wait 40 s.
    let release!: () => void;
    const held = s.t.plaid!.withItem(item.id, () => new Promise<void>((resolve) => { release = resolve; }), { allowNeedsReconnect: true, sideCall: true });
    const real = s.t.plaid!.completeUpdate.bind(s.t.plaid!);
    const passed: (number | undefined)[] = [];
    vi.spyOn(s.t.plaid!, 'completeUpdate').mockImplementation((userId, session, opts = {}) => {
      passed.push(opts.deadline);
      return real(userId, session, { deadline: Date.now() + 20 });
    });
    const before = Date.now();
    const res = await call(s.t.app, 'POST', '/connect/plaid/updated', { cookie: s.cookie, body: { metadata } });
    release();
    await held;
    expect(passed[0]).toBeGreaterThanOrEqual(before + LINK_LOCK_DEADLINE_MS);
    expect(passed[0]).toBeLessThanOrEqual(Date.now() + LINK_LOCK_DEADLINE_MS);
    expect(LINK_LOCK_DEADLINE_MS).toBe(40_000);
    expect(res.status).toBe(503);
    expect((await json(res)).error).toEqual({
      code: 'integration_unavailable', message: PLAID_LINK_ERRORS.busy, details: { next: '/spend?tab=settings&bank_error=busy' },
    });
    expect(PLAID_LINK_ERRORS.busy).toBe('That bank is busy syncing. Try again in a minute.');
    // Nothing was fixed: the bank still needs reconnecting.
    expect(s.t.plaid!.items().find((v) => v.item.id === item.id)!.connection!.status).toBe('needs_reconnect');
  });

  it("keeps a new bank when Plaid is too slow with its accounts for the exchange's budget: its accounts load later", async () => {
    const s = setup({ budgetMs: 1_500 });
    const { exchange } = await connect(s);
    s.t.fakePlaid.hangNext('/accounts/get');
    const started = Date.now();
    const res = await exchange();
    expect(Date.now() - started).toBeLessThan(2_500);
    const item = s.t.db.select().from(plaidItems).get()!;
    expect(await json(res)).toEqual({ next: `/spend?tab=settings&bank=${item.id}` });
    expect(item).toMatchObject({ accounts: null, removedAt: null, institutionName: 'Example Bank' });
    expect(s.t.fakePlaid.removals).toEqual([]);
  });

  it("answers busy when Plaid is too slow for update mode's budget, and keeps the pending link to try again", async () => {
    const s = setup({ budgetMs: 1_500 });
    expect((await (await connect(s)).exchange()).status).toBe(200);
    const item = s.t.db.select().from(plaidItems).get()!;
    s.t.plaid!.markNeedsReconnect(item.id, 'ITEM_LOGIN_REQUIRED');
    const { linkToken } = (await (await call(s.t.app, 'POST', '/connect/plaid/link-token', { cookie: s.cookie, body: { itemId: item.id } })).json()) as { linkToken: string };
    const { metadata } = s.t.fakePlaid.completeLink(linkToken);
    s.t.fakePlaid.hangNext('/item/get');
    const started = Date.now();
    const res = await call(s.t.app, 'POST', '/connect/plaid/updated', { cookie: s.cookie, body: { metadata } });
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(res.status).toBe(503);
    expect(((await json(res)).error as { details: unknown }).details).toEqual({ next: '/spend?tab=settings&bank_error=busy' });
    expect(s.t.db.select().from(plaidLinkPending).all()).toHaveLength(1);
    expect(s.t.plaid!.items().find((v) => v.item.id === item.id)!.connection!.status).toBe('needs_reconnect');
    // A minute later, the same pending link finishes it.
    const again = await call(s.t.app, 'POST', '/connect/plaid/updated', { cookie: s.cookie, body: { metadata } });
    expect(await json(again)).toEqual({ next: `/spend?tab=settings&bank=${item.id}` });
    expect(s.t.plaid!.items().find((v) => v.item.id === item.id)!.connection!.status).toBe('ok');
  });

  it('turns Link exits into the codes Spend settings shows', async () => {
    const s = setup();
    await call(s.t.app, 'POST', '/connect/plaid/link-token', { cookie: s.cookie, body: {} });
    expect(await (await call(s.t.app, 'POST', '/connect/plaid/exit', { cookie: s.cookie, body: {} })).json()).toEqual({ next: '/spend?tab=settings&bank_error=exited' });
    await call(s.t.app, 'POST', '/connect/plaid/link-token', { cookie: s.cookie, body: {} });
    expect(await (await call(s.t.app, 'POST', '/connect/plaid/exit', { cookie: s.cookie, body: { errorCode: 'TRIAL_CONNECTION_LIMIT' } })).json())
      .toEqual({ next: '/spend?tab=settings&bank_error=trial_limit' });
    // Nothing pending any more.
    expect(await (await call(s.t.app, 'POST', '/connect/plaid/exit', { cookie: s.cookie, body: { errorCode: null } })).json()).toEqual({ next: '/spend?tab=settings&bank_error=expired' });
  });

  it("passes on Plaid's refusal of a link token with its code", async () => {
    const s = setup();
    s.t.fakePlaid.failNext('/link/token/create', FAKE_PLAID_ERRORS.INSTITUTION_REGISTRATION_REQUIRED);
    const res = await call(s.t.app, 'POST', '/connect/plaid/link-token', { cookie: s.cookie, body: {} });
    expect(res.status).toBe(503);
    expect(((await json(res)).error as { details: unknown }).details).toEqual({ next: '/spend?tab=settings&bank_error=institution' });
  });

  it('limits the calls to 10 a minute per admin', async () => {
    const s = setup();
    for (let i = 0; i < 10; i++) expect((await call(s.t.app, 'POST', '/connect/plaid/exit', { cookie: s.cookie, body: {} })).status).toBe(200);
    expect((await call(s.t.app, 'POST', '/connect/plaid/link-token', { cookie: s.cookie, body: {} })).status).toBe(429);
    // Per admin: another admin isn't limited by the first one's calls.
    const other = addUser(s.t.db, s.t.clock, { email: 'second@example.com', role: 'admin' });
    expect((await call(s.t.app, 'POST', '/connect/plaid/exit', { cookie: cookieFor(s.t.db, s.t.clock, other), body: {} })).status).toBe(200);
    s.t.clock.advance(60_000);
    expect((await call(s.t.app, 'POST', '/connect/plaid/link-token', { cookie: s.cookie, body: {} })).status).toBe(200);
  });
});

describe('POST /webhooks/plaid', () => {
  async function linkedItem(s: Setup) {
    expect((await (await connect(s)).exchange()).status).toBe(200);
    return s.t.db.select().from(plaidItems).get()!;
  }

  it('answers a verified webhook 200 at once and handles it afterwards, without a CSRF header', async () => {
    const s = setup();
    const item = await linkedItem(s);
    const res = await webhook(s.t, { webhook_type: 'ITEM', webhook_code: 'NEW_ACCOUNTS_AVAILABLE', item_id: item.plaidItemId, environment: 'sandbox', error: null });
    expect(res.status).toBe(200);
    expect(s.t.db.select().from(plaidItems).get()!.newAccountsAt).toBeNull();
    await s.t.bank!.idle();
    expect(s.t.db.select().from(plaidItems).get()!.newAccountsAt).toEqual(s.t.clock.now());
  });

  it('answers a replayed webhook 200 without handling it again, and logs it; a replayed sync webhook still asks for a sync', async () => {
    const lines: string[] = [];
    const s = setup({ logger: pino({ level: 'info' }, { write: (line: string) => { lines.push(line); } }) });
    const item = await linkedItem(s);
    const handled = vi.spyOn(s.t.bank!, 'handleWebhook');
    const replays = vi.spyOn(s.t.bank!, 'handleReplayedWebhook');
    const syncSoon = vi.spyOn(s.t.bank!, 'syncSoon');
    const signed = s.t.fakePlaid.signWebhook({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: item.plaidItemId, environment: 'sandbox' });
    const send = () => s.t.app.request('/webhooks/plaid', { method: 'POST', headers: signed.headers, body: signed.body });
    expect((await send()).status).toBe(200);
    expect((await send()).status).toBe(200);
    await s.t.bank!.idle();
    expect(handled).toHaveBeenCalledTimes(1);
    expect(replays).toHaveBeenCalledTimes(1);
    // Two deliveries with the same body in the same second are one to the replay set; the second still asks for a sync.
    expect(syncSoon).toHaveBeenCalledTimes(2);
    expect(syncSoon).toHaveBeenLastCalledWith(item.id);
    const replayed = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.msg === 'plaid webhook replayed; not handled again');
    expect(replayed).toHaveLength(1);
    expect(replayed[0]).toMatchObject({ type: 'TRANSACTIONS', code: 'SYNC_UPDATES_AVAILABLE' });
    // The signature is never logged.
    expect(lines.join(' ')).not.toContain(signed.headers['Plaid-Verification']!);

    // Any other code replayed is dropped.
    const other = s.t.fakePlaid.signWebhook({ webhook_type: 'ITEM', webhook_code: 'NEW_ACCOUNTS_AVAILABLE', item_id: item.plaidItemId, environment: 'sandbox' });
    const noted = vi.spyOn(s.t.plaid!, 'noteNewAccounts');
    for (let i = 0; i < 2; i++) expect((await s.t.app.request('/webhooks/plaid', { method: 'POST', headers: other.headers, body: other.body })).status).toBe(200);
    await s.t.bank!.idle();
    expect(noted).toHaveBeenCalledTimes(1);
    expect(syncSoon).toHaveBeenCalledTimes(2);
  });

  it("answers 503 when it fails after verifying, and forgets the delivery, so Plaid's retry of the same JWT is handled", async () => {
    const s = setup();
    const item = await linkedItem(s);
    const handled = vi.spyOn(s.t.bank!, 'receiveWebhook').mockImplementationOnce(() => {
      throw new Error('synthetic failure after verifying');
    });
    const signed = s.t.fakePlaid.signWebhook({ webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: item.plaidItemId, environment: 'sandbox' });
    const send = () => s.t.app.request('/webhooks/plaid', { method: 'POST', headers: signed.headers, body: signed.body });
    expect((await send()).status).toBe(503);
    expect((await send()).status).toBe(200);
    await s.t.bank!.idle();
    expect(handled).toHaveBeenCalledTimes(2);
    // Handled once it worked: a third copy is a replay, handed on only as one.
    expect((await send()).status).toBe(200);
    expect(handled).toHaveBeenCalledTimes(3);
    expect(handled.mock.calls.map((c) => c[1]?.replay === true)).toEqual([false, false, true]);
  });

  it("gives the verifier the client's IP, for its per-IP budget of key fetches", async () => {
    const s = setup();
    const verify = vi.spyOn(s.t.plaid!.verifier, 'verify');
    await webhook(s.t, { webhook_type: 'ITEM', webhook_code: 'LOGIN_REPAIRED', item_id: 'item-x', environment: 'sandbox' }, {}, { 'x-forwarded-for': '203.0.113.9' });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0]![2]).toBe('203.0.113.9');
  });

  it('answers 200 for a verified webhook about an Item nobody here has, and handles it as unknown', async () => {
    const lines: string[] = [];
    const s = setup({ logger: pino({ level: 'info' }, { write: (line: string) => { lines.push(line); } }) });
    const res = await webhook(s.t, { webhook_type: 'TRANSACTIONS', webhook_code: 'SYNC_UPDATES_AVAILABLE', item_id: 'item-nobody-has', environment: 'sandbox' });
    expect(res.status).toBe(200);
    await s.t.bank!.idle();
    const logged = lines.map((l) => JSON.parse(l) as { msg: string; outcome?: string });
    expect(logged.filter((l) => l.msg === 'plaid webhook handled').map((l) => l.outcome)).toEqual(['unknown_item']);
    expect(logged.some((l) => l.msg === 'plaid webhook handling failed')).toBe(false);
    expect(s.t.fakePlaid.count('/transactions/sync')).toBe(0);
  });

  it('refuses a missing or bad signature, a changed body, and a stale one with 401, handling nothing', async () => {
    const s = setup();
    const item = await linkedItem(s);
    const payload = { webhook_type: 'ITEM', webhook_code: 'NEW_ACCOUNTS_AVAILABLE', item_id: item.plaidItemId, environment: 'sandbox' };
    const missing = await s.t.app.request('/webhooks/plaid', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
    expect(missing.status).toBe(401);
    expect((await webhook(s.t, payload, { alg: 'none' })).status).toBe(401);
    expect((await webhook(s.t, payload, { bodySha256: '0'.repeat(64) })).status).toBe(401);
    expect((await webhook(s.t, payload, { iat: Math.floor(s.t.clock.now().getTime() / 1000) - 301 })).status).toBe(401);
    await s.t.bank!.idle();
    expect(s.t.db.select().from(plaidItems).get()!.newAccountsAt).toBeNull();
  });

  it("answers 503 when Plaid's key can't be had, so Plaid retries", async () => {
    const s = setup();
    for (let i = 0; i < 3; i++) s.t.fakePlaid.failNext('/webhook_verification_key/get', FAKE_PLAID_ERRORS.INTERNAL_SERVER_ERROR);
    const res = await webhook(s.t, { webhook_type: 'ITEM', webhook_code: 'LOGIN_REPAIRED', item_id: 'item-x', environment: 'sandbox' });
    expect(res.status).toBe(503);
  });

  it('answers 503 for a kid Plaid does not know, so a real key Plaid has not published yet gets retries', async () => {
    const s = setup();
    const payload = { webhook_type: 'ITEM', webhook_code: 'LOGIN_REPAIRED', item_id: 'item-x', environment: 'sandbox' };
    expect((await webhook(s.t, payload, { kid: 'kid-not-published-yet' })).status).toBe(503);
    // Remembered: the second is a 503 too, without asking Plaid again.
    expect((await webhook(s.t, payload, { kid: 'kid-not-published-yet' })).status).toBe(503);
    expect(s.t.fakePlaid.count('/webhook_verification_key/get')).toBe(1);
  });

  it('refuses a body over 256 KiB before verifying it', async () => {
    const s = setup();
    const big = JSON.stringify({ webhook_type: 'ITEM', webhook_code: 'ERROR', pad: 'x'.repeat(WEBHOOK_BODY_LIMIT) });
    const res = await webhook(s.t, big, {}, { 'content-length': String(Buffer.byteLength(big)) });
    expect(res.status).toBe(413);
    expect(s.t.fakePlaid.count('/webhook_verification_key/get')).toBe(0);
  });

  it('refuses a chunked body over 256 KiB, with no Content-Length, before verifying it', async () => {
    const s = setup();
    const chunk = new TextEncoder().encode('x'.repeat(64 * 1024));
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > WEBHOOK_BODY_LIMIT) return controller.close();
        sent += chunk.length;
        controller.enqueue(chunk);
      },
    });
    const signed = s.t.fakePlaid.signWebhook({ webhook_type: 'ITEM', webhook_code: 'ERROR' });
    const res = await s.t.app.request('/webhooks/plaid', { method: 'POST', headers: signed.headers, body, duplex: 'half' } as RequestInit);
    expect(res.status).toBe(413);
    expect(s.t.fakePlaid.count('/webhook_verification_key/get')).toBe(0);
  });

  it('limits to 600 a minute per IP before reading the body', async () => {
    const s = setup();
    const from = (ip: string) => ({ 'x-forwarded-for': ip });
    for (let i = 0; i < 600; i++) {
      const res = await s.t.app.request('/webhooks/plaid', { method: 'POST', headers: from('203.0.113.7') });
      expect(res.status).toBe(401);
    }
    const big = 'x'.repeat(WEBHOOK_BODY_LIMIT + 1);
    const limited = await s.t.app.request('/webhooks/plaid', { method: 'POST', headers: { ...from('203.0.113.7'), 'content-length': String(big.length) }, body: big });
    // 429, not the 413 the body would get: the limit comes first.
    expect(limited.status).toBe(429);
    // Another IP isn't limited.
    expect((await s.t.app.request('/webhooks/plaid', { method: 'POST', headers: from('203.0.113.8') })).status).toBe(401);
  });
});

describe('wiring', () => {
  it("registers Spend's Plaid jobs once Plaid is configured", () => {
    const names = (t: TestApp) => panelJobs(t).map((j) => j.name).filter((n) => n.startsWith('spend.'));
    expect(names(makeTestApp())).toEqual(['spend.pruneImports', 'spend.pruneRemoved']);
    expect(names(makeTestApp({ plaid: true }))).toEqual(['spend.pruneImports', 'spend.pruneRemoved', 'spend.transactionsSync', 'spend.statementsSync', 'spend.plaidRevocations']);
  });
});

describe('a Savings link', () => {
  it('asks Plaid for cash and investment accounts with Transactions, and Investments where supported, and goes back to Savings settings', async () => {
    const s = setup();
    const start = await answer<{ linkToken: string; mode: string; purpose: string }>(await call(s.t.app, 'POST', '/connect/plaid/link-token', { cookie: s.cookie, body: { purpose: 'savings' } }));
    expect(start).toMatchObject({ mode: 'new', purpose: 'savings' });
    const body = s.t.fakePlaid.lastBody('/link/token/create')!;
    expect(body).toMatchObject({
      products: ['transactions'], required_if_supported_products: ['investments'],
      account_filters: { depository: { account_subtypes: ['all'] }, investment: { account_subtypes: ['all'] } },
      webhook: `${TEST_BASE_URL}/webhooks/plaid`, redirect_uri: `${TEST_BASE_URL}/connect/plaid/oauth-return`,
    });
    expect(body).not.toHaveProperty('transactions');
    expect(await answer<{ purpose: string }>(await call(s.t.app, 'POST', '/connect/plaid/resume', { cookie: s.cookie }))).toMatchObject({ purpose: 'savings' });

    const { publicToken, metadata } = s.t.fakePlaid.completeLink(start.linkToken, {
      institution: { institution_id: 'ins_fake_savings', name: 'Example Brokerage' },
      accounts: [{ name: 'Cash', mask: '1111', type: 'depository', subtype: 'cash management' }, { name: 'Brokerage', mask: '2222', type: 'investment', subtype: 'brokerage' }],
    });
    const { next } = await answer<{ next: string }>(await call(s.t.app, 'POST', '/connect/plaid/exchange', { cookie: s.cookie, body: { publicToken, metadata } }));
    const itemId = Number(new URL(next, 'http://x').searchParams.get('bank'));
    expect(next).toBe(`/savings?tab=settings&bank=${itemId}`);
    expect(s.t.plaid!.item(itemId)).toMatchObject({ purpose: 'savings', pickedAt: null });
    expect(s.t.plaid!.item(itemId)!.accounts!.map((a) => [a.type, a.subtype])).toEqual([['depository', 'cash management'], ['investment', 'brokerage']]);
  });

  it("asks again without Investments when the client hasn't got it, so linking still works", async () => {
    const s = setup();
    s.t.fakePlaid.investmentsEnabled = false;
    await answer(await call(s.t.app, 'POST', '/connect/plaid/link-token', { cookie: s.cookie, body: { purpose: 'savings' } }));
    const tries = s.t.fakePlaid.requests.filter((r) => r.path === '/link/token/create');
    expect(tries.map((r) => r.body.required_if_supported_products)).toEqual([['investments'], undefined]);
  });

  it("sends a Savings link's refusals and exits back to Savings settings, and a Spend link's to Spend settings, as before", async () => {
    const s = setup();
    await answer(await call(s.t.app, 'POST', '/connect/plaid/link-token', { cookie: s.cookie, body: { purpose: 'savings' } }));
    expect(await answer(await call(s.t.app, 'POST', '/connect/plaid/exit', { cookie: s.cookie, body: { errorCode: null } }))).toEqual({ next: '/savings?tab=settings&bank_error=exited' });
    const start = await answer<{ purpose: string }>(await call(s.t.app, 'POST', '/connect/plaid/link-token', { cookie: s.cookie, body: {} }));
    expect(start.purpose).toBe('spend');
    expect(s.t.fakePlaid.lastBody('/link/token/create')).toMatchObject({ products: ['transactions'], required_if_supported_products: ['liabilities'], account_filters: { credit: { account_subtypes: ['credit card'] } } });
    expect(await answer(await call(s.t.app, 'POST', '/connect/plaid/exit', { cookie: s.cookie, body: { errorCode: null } }))).toEqual({ next: '/spend?tab=settings&bank_error=exited' });
  });

  it('reconnects a Savings connection in update mode with its own account filter, and syncs it with Savings afterwards', async () => {
    const s = setup();
    const linked = linkSavingsForTest(s.t, s.admin);
    const start = await answer<{ linkToken: string; purpose: string; mode: string }>(
      await call(s.t.app, 'POST', '/connect/plaid/link-token', { cookie: s.cookie, body: { itemId: linked.item.id, addAccounts: true } }));
    expect(start).toMatchObject({ mode: 'update', purpose: 'savings' });
    expect(s.t.fakePlaid.lastBody('/link/token/create')).toMatchObject({ update: { account_selection_enabled: true }, account_filters: { depository: { account_subtypes: ['all'] }, investment: { account_subtypes: ['all'] } } });
    s.t.fakePlaid.completeLink(start.linkToken);
    expect(await answer(await call(s.t.app, 'POST', '/connect/plaid/updated', { cookie: s.cookie, body: {} }))).toEqual({ next: `/savings?tab=settings&bank=${linked.item.id}` });
    await s.t.savings!.idle();
    expect(s.t.fakePlaid.count('/accounts/get', linked.fakeItemId)).toBeGreaterThanOrEqual(2);
  });
});

describe('the INVALID_PRODUCT retry', () => {
  it("is only for a new Savings link: a Spend link, or a Savings reconnect, isn't asked again", async () => {
    const s = setup();
    const linkTokens = () => s.t.fakePlaid.requests.filter((r) => r.path === '/link/token/create').length;
    s.t.fakePlaid.failNext('/link/token/create', FAKE_PLAID_ERRORS.INVALID_PRODUCT);
    const spend = await call(s.t.app, 'POST', '/connect/plaid/link-token', { cookie: s.cookie, body: {} });
    expect(spend.status).not.toBe(200);
    expect(((await spend.json()) as { error: { details: { next: string } } }).error.details.next).toMatch(/^\/spend\?tab=settings&bank_error=/);
    expect(linkTokens()).toBe(1);

    const linked = linkSavingsForTest(s.t, s.admin);
    s.t.fakePlaid.failNext('/link/token/create', FAKE_PLAID_ERRORS.INVALID_PRODUCT);
    const update = await call(s.t.app, 'POST', '/connect/plaid/link-token', { cookie: s.cookie, body: { itemId: linked.item.id } });
    expect(update.status).not.toBe(200);
    expect(((await update.json()) as { error: { details: { next: string } } }).error.details.next).toMatch(/^\/savings\?tab=settings&bank_error=/);
    expect(linkTokens()).toBe(2);
  });
});
