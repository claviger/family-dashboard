import { describe, expect, it } from 'vitest';
import type { MeResponse } from '../shared/api.js';
import { addUser, call, cookieFor, makeTestApp } from './test/helpers.js';

describe('app core', () => {
  it('reports health', async () => {
    const t = makeTestApp();
    const res = await call(t.app, 'GET', '/healthz');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('returns 401 from /api/me without a session', async () => {
    const t = makeTestApp();
    const res = await call(t.app, 'GET', '/api/me');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: 'unauthenticated', message: 'Sign in to continue.' } });
  });

  it('returns the user, ordered panels, and family settings from /api/me', async () => {
    const t = makeTestApp();
    const id = addUser(t.db, t.clock, { panels: ['spend', 'calendar'] });
    const res = await call(t.app, 'GET', '/api/me', { cookie: cookieFor(t.db, t.clock, id) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      user: { id, email: 'user@example.com', displayName: 'User', color: '#378ADD', role: 'member' },
      panels: ['calendar', 'spend'],
      family: { name: 'Our family', timeZone: 'UTC' },
      features: { todoist: false, plaid: false },
    });
    const withTodoist = makeTestApp({ todoist: true });
    const other = addUser(withTodoist.db, withTodoist.clock);
    const me = await call(withTodoist.app, 'GET', '/api/me', { cookie: cookieFor(withTodoist.db, withTodoist.clock, other) });
    expect(((await me.json()) as MeResponse).features).toEqual({ todoist: true, plaid: false });
    // Synthetic Plaid keys: the test app never calls Plaid here.
    const withPlaid = makeTestApp({
      config: { plaid: { clientId: 'plaid-id', secret: 'plaid-secret', env: 'sandbox', apiBaseUrl: 'https://sandbox.plaid.com', linkScriptUrl: 'https://cdn.plaid.com/link/v2/stable/link-initialize.js' } },
    });
    const third = addUser(withPlaid.db, withPlaid.clock);
    const plaidMe = await call(withPlaid.app, 'GET', '/api/me', { cookie: cookieFor(withPlaid.db, withPlaid.clock, third) });
    expect(((await plaidMe.json()) as MeResponse).features).toEqual({ todoist: false, plaid: true });
  });

  it('blocks mutations without the CSRF header or with a foreign Origin', async () => {
    const t = makeTestApp();
    const id = addUser(t.db, t.clock);
    const cookie = cookieFor(t.db, t.clock, id);
    const noHeader = await call(t.app, 'POST', '/auth/logout', { cookie, csrf: false });
    expect(noHeader.status).toBe(403);
    const foreign = await t.app.request('/auth/logout', {
      method: 'POST',
      headers: { cookie, 'x-requested-with': 'dashboard', origin: 'https://evil.example' },
    });
    expect(foreign.status).toBe(403);
  });

  it('returns a JSON 404 for unknown API paths and plain 404 elsewhere', async () => {
    const t = makeTestApp();
    const id = addUser(t.db, t.clock);
    const res = await call(t.app, 'GET', '/api/nope', { cookie: cookieFor(t.db, t.clock, id) });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: { code: 'not_found', message: 'Not found.' } });
    const other = await call(t.app, 'GET', '/nope');
    expect(other.status).toBe(404);
    expect(await other.text()).toBe('Not found');
  });

  it('sets security headers', async () => {
    const t = makeTestApp();
    const res = await call(t.app, 'GET', '/healthz');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
  });
});
