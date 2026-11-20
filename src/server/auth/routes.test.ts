import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { addUser, call, cookieFor, makeTestApp } from '../test/helpers.js';

function cookiesFrom(res: Response): string[] {
  return res.headers.getSetCookie();
}

/** Turns Set-Cookie headers into a Cookie request header. */
function cookieHeader(res: Response): string {
  return cookiesFrom(res).map((c) => c.split(';')[0]).join('; ');
}

async function startFlow(t: ReturnType<typeof makeTestApp>) {
  const res = await call(t.app, 'GET', '/auth/google/start');
  expect(res.status).toBe(302);
  return { res, flowCookie: cookieHeader(res), state: t.google.lastAuth!.state };
}

describe('Google sign-in', () => {
  it('redirects to Google with PKCE params and a flow cookie', async () => {
    const t = makeTestApp();
    const { res } = await startFlow(t);
    expect(res.headers.get('location')).toMatch(/^https:\/\/accounts\.example\/authorize/);
    expect(t.google.lastAuth?.redirectUri).toBe('http://localhost:3000/auth/google/callback');
    expect(t.google.lastAuth?.codeVerifier.length).toBeGreaterThanOrEqual(43);
    expect(cookiesFrom(res).join()).toContain('__Host-oauth-flow=');
  });

  it('signs a provisioned user in and sets the session cookie', async () => {
    const t = makeTestApp();
    addUser(t.db, t.clock, { email: 'kid@example.com' });
    t.google.nextClaims = { sub: 'g-1', email: 'kid@example.com', emailVerified: true };
    const { flowCookie, state } = await startFlow(t);
    const res = await t.app.request(`/auth/google/callback?code=abc&state=${state}`, { headers: { cookie: flowCookie } });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/');
    expect(t.google.lastExchange?.callbackUrl.href).toBe(
      `http://localhost:3000/auth/google/callback?code=abc&state=${state}`,
    );
    const session = cookiesFrom(res).find((c) => c.startsWith('__Host-session='))!;
    expect(session).toMatch(/HttpOnly/);
    expect(session).toMatch(/Secure/);
    expect(session).toMatch(/SameSite=Lax/);
    const me = await call(t.app, 'GET', '/api/me', { cookie: session.split(';')[0] });
    expect(me.status).toBe(200);
  });

  it('sends unknown people to the not-set-up page without creating anything', async () => {
    const t = makeTestApp();
    t.google.nextClaims = { sub: 'g-9', email: 'stranger@example.com', emailVerified: true };
    const { flowCookie, state } = await startFlow(t);
    const res = await t.app.request(`/auth/google/callback?code=abc&state=${state}`, { headers: { cookie: flowCookie } });
    expect(res.headers.get('location')).toBe('/not-set-up?reason=not_provisioned');
    expect(cookiesFrom(res).some((c) => c.startsWith('__Host-session='))).toBe(false);
  });

  it('handles a missing flow cookie and a failed exchange', async () => {
    const t = makeTestApp();
    const noCookie = await t.app.request('/auth/google/callback?code=abc&state=x');
    expect(noCookie.headers.get('location')).toBe('/sign-in?error=expired');
    t.google.fail = true;
    const { flowCookie, state } = await startFlow(t);
    const failed = await t.app.request(`/auth/google/callback?code=abc&state=${state}`, { headers: { cookie: flowCookie } });
    expect(failed.headers.get('location')).toBe('/sign-in?error=failed');
  });

  it('redirects to the sign-in page when Google is unreachable at start', async () => {
    const t = makeTestApp();
    t.google.authUrlFail = true;
    const res = await call(t.app, 'GET', '/auth/google/start');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/sign-in?error=failed');
  });

  it("logs a failed Google call's error name only, never its message", async () => {
    const t = makeTestApp();
    const lines: string[] = [];
    const app = createApp({ ...t, logger: pino({ level: 'debug' }, { write: (line: string) => { lines.push(line); } }) });
    t.google.authUrlFail = true;
    await call(app, 'GET', '/auth/google/start');
    t.google.authUrlFail = false;
    t.google.fail = true;
    const { flowCookie, state } = await startFlow({ ...t, app });
    await app.request(`/auth/google/callback?code=abc&state=${state}`, { headers: { cookie: flowCookie } });
    const logged = lines.map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(logged.filter((l) => /^google /.test(String(l.msg)))).toEqual([
      expect.objectContaining({ msg: 'google authorization url failed', error: 'Error' }),
      expect.objectContaining({ msg: 'google sign-in failed', error: 'Error' }),
    ]);
    expect(lines.join('\n')).not.toMatch(/discovery failed|exchange failed/);
  });

  it('replaces an existing session on sign-in', async () => {
    const t = makeTestApp();
    const id = addUser(t.db, t.clock, { email: 'kid@example.com' });
    const oldCookie = cookieFor(t.db, t.clock, id);
    t.google.nextClaims = { sub: 'g-1', email: 'kid@example.com', emailVerified: true };
    const { flowCookie, state } = await startFlow(t);
    const res = await t.app.request(`/auth/google/callback?code=abc&state=${state}`, {
      headers: { cookie: `${flowCookie}; ${oldCookie}` },
    });
    expect(res.status).toBe(302);
    expect((await call(t.app, 'GET', '/api/me', { cookie: oldCookie })).status).toBe(401);
    const fresh = cookiesFrom(res).find((c) => c.startsWith('__Host-session='))!.split(';')[0];
    expect((await call(t.app, 'GET', '/api/me', { cookie: fresh })).status).toBe(200);
  });

  it('rate-limits sign-in attempts', async () => {
    const t = makeTestApp();
    for (let i = 0; i < 10; i++) expect((await call(t.app, 'GET', '/auth/google/start')).status).toBe(302);
    expect((await call(t.app, 'GET', '/auth/google/start')).status).toBe(429);
  });
});

describe('logout', () => {
  it('deletes the session and clears the cookie', async () => {
    const t = makeTestApp();
    const id = addUser(t.db, t.clock);
    const cookie = cookieFor(t.db, t.clock, id);
    const res = await call(t.app, 'POST', '/auth/logout', { cookie });
    expect(res.status).toBe(204);
    expect(cookiesFrom(res).join()).toMatch(/__Host-session=;/);
    expect((await call(t.app, 'GET', '/api/me', { cookie })).status).toBe(401);
  });
});

describe('test login', () => {
  it('is not mounted unless enabled', async () => {
    const t = makeTestApp();
    const res = await call(t.app, 'POST', '/auth/test-login', { body: { email: 'user@example.com' } });
    expect(res.status).toBe(404);
  });

  it('creates a session for an existing active user when enabled', async () => {
    const t = makeTestApp({ config: { testLogin: true } });
    addUser(t.db, t.clock);
    const res = await call(t.app, 'POST', '/auth/test-login', { body: { email: 'USER@example.com' } });
    expect(res.status).toBe(204);
    expect((await call(t.app, 'GET', '/api/me', { cookie: cookieHeader(res) })).status).toBe(200);
    const missing = await call(t.app, 'POST', '/auth/test-login', { body: { email: 'nobody@example.com' } });
    expect(missing.status).toBe(404);
  });
});
