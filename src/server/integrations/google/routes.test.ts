import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { CALENDAR_API_DISABLED_MESSAGE, CALENDAR_LINK_ERRORS, type CalendarLinkInfo, type CalendarWindow } from '../../../shared/calendar.js';
import { createApp } from '../../app.js';
import { singleKeyring } from '../../core/crypto.js';
import { GOOGLE_ERRORS, SCOPES, type FakeGoogleAccount } from '../../test/fakeGoogleCalendar.js';
import { setFamilySettings } from '../../settings.js';
import { addUser, call, cookieFor, linkCalendarForTest, makeTestApp, type TestApp } from '../../test/helpers.js';
import { GoogleCalendar } from './calendar.js';

function cookieHeader(res: Response): string {
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

function setup(opts: Parameters<typeof makeTestApp>[0] = {}) {
  const t = makeTestApp(opts);
  const admin = addUser(t.db, t.clock, { email: 'alex@example.com', displayName: 'Alex', role: 'admin', panels: ['calendar'] });
  const member = addUser(t.db, t.clock, { email: 'kid@example.com', displayName: 'Riley', panels: ['calendar'] });
  const family = t.fakeGoogleCalendar.createAccount({ email: 'family@example.com' });
  const cal = t.fakeGoogleCalendar.addCalendar(family, { summary: 'Family', timeZone: 'America/Los_Angeles' });
  t.fakeGoogleCalendar.addCalendar(family, { summary: 'Holidays', role: 'reader' });
  return { t, admin, member, family, cal, session: cookieFor(t.db, t.clock, admin) };
}

/** POST /connect/google-calendar/start, as the admin page sends it (with the CSRF headers). */
async function start(t: TestApp, session: string) {
  const res = await call(t.app, 'POST', '/connect/google-calendar/start', { cookie: session });
  expect(res.status).toBe(200);
  return { res, url: new URL(((await res.json()) as { url: string }).url) };
}

/** Start, Google's consent page (the fake approves at once), and the callback. Returns where the callback sent the browser. */
async function connect(t: TestApp, session: string, opts: { as?: FakeGoogleAccount; tamper?: (u: URL) => void } = {}) {
  const started = await start(t, session);
  if (opts.as) t.fakeGoogleCalendar.nextAccount = opts.as;
  const back = t.fakeGoogleCalendar.authorize(started.url.searchParams);
  opts.tamper?.(back);
  const res = await t.app.request(back.pathname + back.search, { headers: { cookie: `${session}; ${cookieHeader(started.res)}` } });
  expect(res.status).toBe(302);
  return res.headers.get('location');
}

async function linkInfo(t: TestApp, session: string): Promise<CalendarLinkInfo> {
  const res = await call(t.app, 'GET', '/api/admin/panels/calendar/link', { cookie: session });
  expect(res.status).toBe(200);
  return (await res.json()) as CalendarLinkInfo;
}

describe('connecting Google Calendar', () => {
  it('is for admins, behind the CSRF check, and asks Google for offline access to both scopes', async () => {
    const { t, member, session } = setup();
    expect((await call(t.app, 'POST', '/connect/google-calendar/start')).status).toBe(401);
    const asMember = await call(t.app, 'POST', '/connect/google-calendar/start', { cookie: cookieFor(t.db, t.clock, member) });
    expect(asMember.status).toBe(403);
    expect(((await asMember.json()) as { error: { message: string } }).error.message).toBe(CALENDAR_LINK_ERRORS.not_admin);
    expect((await call(t.app, 'POST', '/connect/google-calendar/start', { cookie: session, csrf: false })).status).toBe(403);
    const { res, url } = await start(t, session);
    expect(res.headers.get('set-cookie')).toMatch(/__Host-gcal-flow=.*HttpOnly.*Secure.*SameSite=Lax/i);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      redirect_uri: 'http://localhost:3000/connect/google-calendar/callback', access_type: 'offline', prompt: 'consent select_account', code_challenge_method: 'S256',
    });
    expect(url.searchParams.get('scope')).toContain(SCOPES.calendarList);
  });

  it('holds off revocation retries for 15 minutes after a link starts (R2-M5)', async () => {
    const { t, session, admin } = setup();
    linkCalendarForTest(t, admin);
    t.fakeGoogleCalendar.failures.push({ path: 'revoke', status: 503 });
    await t.calendar.disconnect(admin);
    await start(t, session);
    await t.calendar.retryRevocations();
    expect(t.fakeGoogleCalendar.requests.filter((r) => r.path === '/revoke')).toHaveLength(1);
    t.clock.advance(15 * 60_000);
    await t.calendar.retryRevocations();
    expect(t.fakeGoogleCalendar.requests.filter((r) => r.path === '/revoke')).toHaveLength(2);
  });

  it('saves the tokens for a pick, offers only writable calendars, and the pick links the calendar', async () => {
    const { t, admin, session, family, cal } = setup();
    expect(await connect(t, session)).toBe('/admin?calendar=choose');
    const info = await linkInfo(t, session);
    expect(info).toMatchObject({ connection: null, pending: { account: 'family@example.com', calendars: [{ id: cal.id, name: 'Family', accessRole: 'owner' }] }, keyMismatch: false });
    // Only in the session that started it: the same admin signed in elsewhere doesn't see it.
    expect((await linkInfo(t, cookieFor(t.db, t.clock, admin))).pending).toBeNull();

    expect((await call(t.app, 'POST', '/api/admin/panels/calendar/link/choose', { cookie: session, body: { calendarId: cal.id } })).status).toBe(204);
    expect(await linkInfo(t, session)).toMatchObject({
      pending: null,
      connection: { account: 'family@example.com', calendarId: cal.id, calendarName: 'Family', status: 'ok', linkedBy: 'Alex', lastError: null },
    });
    expect(t.calendar.state()).toMatchObject({ connected: true, meta: { accountId: family.sub } });
  });

  it('refuses a callback from another session, another person, or with the wrong state, and never exchanges the code', async () => {
    const { t, admin, session } = setup();
    const other = addUser(t.db, t.clock, { email: 'jordan@example.com', role: 'admin' });
    const started = await start(t, session);
    const back = t.fakeGoogleCalendar.authorize(started.url.searchParams);
    const flow = cookieHeader(started.res);
    for (const cookie of [`${cookieFor(t.db, t.clock, admin)}; ${flow}`, `${cookieFor(t.db, t.clock, other)}; ${flow}`, session]) {
      const res = await t.app.request(back.pathname + back.search, { headers: { cookie } });
      expect(res.headers.get('location')).toBe('/admin?calendar_error=expired');
    }
    const wrongState = new URL(back);
    wrongState.searchParams.set('state', 'not-it');
    const res = await t.app.request(wrongState.pathname + wrongState.search, { headers: { cookie: `${session}; ${flow}` } });
    expect(res.headers.get('location')).toBe('/admin?calendar_error=expired');
    expect(t.fakeGoogleCalendar.requests.filter((r) => r.path === '/token')).toEqual([]);
  });

  it('turns what Google says into plain error codes', async () => {
    const { t, session } = setup();
    t.fakeGoogleCalendar.denyNext = true;
    expect(await connect(t, session)).toBe('/admin?calendar_error=denied');
    t.fakeGoogleCalendar.grantOnly = ['openid', 'email', SCOPES.events];
    expect(await connect(t, session)).toBe('/admin?calendar_error=scopes');
    t.fakeGoogleCalendar.omitRefreshToken = true;
    expect(await connect(t, session)).toBe('/admin?calendar_error=no_refresh');
    expect(await connect(t, session, { as: t.fakeGoogleCalendar.createAccount() })).toBe('/admin?calendar_error=no_calendars');
    t.fakeGoogleCalendar.failures.push({ path: 'token', status: 400, body: { error: 'invalid_grant' } });
    expect(await connect(t, session)).toBe('/admin?calendar_error=failed');
    // Refusing a link never revokes: that would end the account's sign-in grant too.
    expect(t.fakeGoogleCalendar.revocations).toEqual([]);
    for (const code of ['denied', 'scopes', 'no_refresh', 'no_calendars', 'failed'] as const) expect(CALENDAR_LINK_ERRORS[code]).not.toMatch(/—/);
  });

  it("says so when the Calendar API isn't turned on for the Cloud project (C-M2)", async () => {
    const { t, session } = setup();
    t.fakeGoogleCalendar.failures.push({ path: 'calendarList', status: 403, body: GOOGLE_ERRORS.accessNotConfigured });
    expect(await connect(t, session)).toBe('/admin?calendar_error=api_disabled');
    expect(CALENDAR_LINK_ERRORS.api_disabled).toBe(`Google Calendar wasn't connected. ${CALENDAR_API_DISABLED_MESSAGE} Then connect again.`);
    expect(t.fakeGoogleCalendar.requests.filter((r) => r.path.endsWith('/calendarList'))).toHaveLength(1);
  });

  it("shows on Integrations, and on the card, when Google says the Calendar API isn't turned on, until a call works again (C-M2)", async () => {
    const { t, admin, session } = setup();
    setFamilySettings(t.db, { name: 'Test', timeZone: 'America/Los_Angeles' });
    linkCalendarForTest(t, admin);
    t.fakeGoogleCalendar.failures.push({ path: 'list', status: 403, body: GOOGLE_ERRORS.accessNotConfigured });
    const card = await call(t.app, 'GET', '/api/panels/calendar/summary', { cookie: session });
    expect(((await card.json()) as CalendarWindow).freshness.readOnly).toBe('api_disabled');
    // Not retried, not a rate limit, and not a reconnect.
    expect(t.fakeGoogleCalendar.requests.filter((r) => r.path.endsWith('/events'))).toHaveLength(1);
    expect((await linkInfo(t, session)).connection).toMatchObject({ status: 'ok', apiDisabled: true });
    t.clock.advance(1_000);
    await call(t.app, 'GET', '/api/panels/calendar/summary', { cookie: session });
    expect((await linkInfo(t, session)).connection).toMatchObject({ status: 'ok', apiDisabled: false });
  });

  it("logs a failed link's error code and kind, never the code or a token", async () => {
    const lines: string[] = [];
    const { t, session } = setup({ logger: pino({ level: 'debug' }, { write: (l: string) => void lines.push(l) }) });
    t.fakeGoogleCalendar.failures.push({ path: 'calendarList', status: 503 }, { path: 'calendarList', status: 503 }, { path: 'calendarList', status: 503 });
    const started = await start(t, session);
    const back = t.fakeGoogleCalendar.authorize(started.url.searchParams);
    const res = await t.app.request(back.pathname + back.search, { headers: { cookie: `${session}; ${cookieHeader(started.res)}` } });
    expect(res.headers.get('location')).toBe('/admin?calendar_error=failed');
    const failed = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === 'google calendar link failed')!;
    expect(failed).toMatchObject({ kind: 'server', status: 503 });
    expect(lines.join('\n')).not.toContain(back.searchParams.get('code')!);
    expect(lines.join('\n')).not.toMatch(/ya29\.|1\/\//);
  });

  it('gives the whole callback 45 seconds from its start, and past that sends the admin back with "failed" (R4-M2)', async () => {
    const { t, session } = setup();
    const deadlines: (number | undefined)[] = [];
    const real = t.calendar.completeLink.bind(t.calendar);
    t.calendar.completeLink = (userId, hash, p, opts) => {
      deadlines.push(opts?.deadline);
      return real(userId, hash, p, { deadline: Date.now() - 1 });
    };
    const before = Date.now();
    expect(await connect(t, session)).toBe('/admin?calendar_error=failed');
    expect(deadlines).toHaveLength(1);
    expect(deadlines[0]).toBeGreaterThanOrEqual(before + 45_000);
    expect(deadlines[0]).toBeLessThanOrEqual(Date.now() + 45_000);
    expect(t.fakeGoogleCalendar.requests.filter((r) => r.path === '/token')).toEqual([]);
  });

  it('refuses to start or finish while the key does not match', async () => {
    const { t, session } = setup();
    const started = await start(t, session);
    const mismatched = new GoogleCalendar({
      db: t.db, clock: t.clock, logger: t.logger, keyring: singleKeyring(Buffer.alloc(32, 1)), fetch: t.fakeGoogleCalendar.fetch, keyMismatch: true,
      google: { clientId: t.config.googleClientId, clientSecret: t.config.googleClientSecret, endpoints: t.config.googleEndpoints },
    });
    const app = createApp({ ...t, calendar: mismatched });
    const back = t.fakeGoogleCalendar.authorize(started.url.searchParams);
    const res = await app.request(back.pathname + back.search, { headers: { cookie: `${session}; ${cookieHeader(started.res)}` } });
    expect(res.headers.get('location')).toBe('/admin?calendar_error=key_mismatch');
    expect(t.fakeGoogleCalendar.requests.filter((r) => r.path === '/token')).toEqual([]);
    const refused = await call(app, 'POST', '/connect/google-calendar/start', { cookie: session });
    expect(refused.status).toBe(503);
  });

  it('sends a rate-limited callback back to the admin page', async () => {
    const { t, session } = setup();
    for (let i = 0; i < 10; i++) await call(t.app, 'POST', '/connect/google-calendar/start', { cookie: session });
    const res = await t.app.request('/connect/google-calendar/callback?state=x&code=y', { headers: { cookie: session } });
    expect(res.headers.get('location')).toBe('/admin?calendar_error=rate_limited');
  });
});

describe('the Integrations admin API', () => {
  it('is admin-only', async () => {
    const { t, member } = setup();
    const kid = cookieFor(t.db, t.clock, member);
    expect((await call(t.app, 'GET', '/api/admin/panels/calendar/link', { cookie: kid })).status).toBe(403);
    expect((await call(t.app, 'POST', '/api/admin/panels/calendar/disconnect', { cookie: kid })).status).toBe(403);
  });

  it('changes the calendar with the saved token, without the consent page, and cancels a pick', async () => {
    const { t, admin, session, family, cal } = setup();
    linkCalendarForTest(t, admin, { account: family, calendar: cal });
    const kids = t.fakeGoogleCalendar.addCalendar(family, { summary: 'Kids' });
    expect((await call(t.app, 'POST', '/api/admin/panels/calendar/link/change', { cookie: session })).status).toBe(204);
    expect((await linkInfo(t, session)).pending?.calendars.map((c) => c.name).sort()).toEqual(['Family', 'Kids']);
    expect((await call(t.app, 'POST', '/api/admin/panels/calendar/link/cancel', { cookie: session })).status).toBe(204);
    expect((await linkInfo(t, session)).pending).toBeNull();

    await call(t.app, 'POST', '/api/admin/panels/calendar/link/change', { cookie: session });
    expect((await call(t.app, 'POST', '/api/admin/panels/calendar/link/choose', { cookie: session, body: { calendarId: kids.id } })).status).toBe(204);
    expect((await linkInfo(t, session)).connection).toMatchObject({ calendarName: 'Kids' });
    expect(t.fakeGoogleCalendar.requests.filter((r) => r.path === '/o/oauth2/v2/auth')).toEqual([]);
    const bad = await call(t.app, 'POST', '/api/admin/panels/calendar/link/choose', { cookie: session, body: { calendarId: kids.id } });
    expect(bad.status).toBe(404);
  });

  it("cancels only this session's pick, and is limited like the other changes (R4-M3)", async () => {
    const { t, admin, session, family } = setup();
    linkCalendarForTest(t, admin, { account: family });
    const other = cookieFor(t.db, t.clock, admin);
    expect((await call(t.app, 'POST', '/api/admin/panels/calendar/link/change', { cookie: other })).status).toBe(204);
    // Another session of the same admin cancels: the pick started elsewhere stays.
    expect((await call(t.app, 'POST', '/api/admin/panels/calendar/link/cancel', { cookie: session })).status).toBe(204);
    expect((await linkInfo(t, other)).pending).not.toBeNull();
    expect((await call(t.app, 'POST', '/api/admin/panels/calendar/link/cancel', { cookie: other })).status).toBe(204);
    expect((await linkInfo(t, other)).pending).toBeNull();
    // 10 changes a minute per admin, cancels included.
    for (let i = 0; i < 7; i++) expect((await call(t.app, 'POST', '/api/admin/panels/calendar/link/cancel', { cookie: session })).status).toBe(204);
    expect((await call(t.app, 'POST', '/api/admin/panels/calendar/link/cancel', { cookie: session })).status).toBe(429);
  });

  it('disconnects, revoking the token', async () => {
    const { t, admin, session, family } = setup();
    linkCalendarForTest(t, admin, { account: family });
    const res = await call(t.app, 'POST', '/api/admin/panels/calendar/disconnect', { cookie: session });
    expect(await res.json()).toEqual({ revoked: true });
    expect(t.fakeGoogleCalendar.revocations).toEqual([{ sub: family.sub, kind: 'refresh' }]);
    expect((await linkInfo(t, session)).connection).toBeNull();
  });
});
