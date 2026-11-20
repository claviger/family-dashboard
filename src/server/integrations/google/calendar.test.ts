import { eq } from 'drizzle-orm';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { decryptSecret, familyRevocationAad, pendingLinkAad, singleKeyring } from '../../core/crypto.js';
import { calendarCache, calendarLinkPending, connections, pendingRevocations } from '../../db/schema.js';
import { GOOGLE_ERRORS, SCOPES, type FakeGoogleAccount } from '../../test/fakeGoogleCalendar.js';
import { addUser, linkCalendarForTest, makeTestApp, TEST_ENCRYPTION_KEY, type TestApp } from '../../test/helpers.js';
import { decryptCredentials, encryptCredentials } from '../connections.js';
import { CALENDAR_MESSAGES, GoogleCalendar, PENDING_LINK_TTL_MS, REVOCATION_ATTEMPTS } from './calendar.js';
import { pkceChallenge, type LinkTokens } from './oauth.js';

const ring = singleKeyring(TEST_ENCRYPTION_KEY);
const WINDOW = { timeMin: '2026-11-14T08:00:00.000Z', timeMax: '2026-11-23T08:00:00.000Z', timeZone: 'America/Los_Angeles' };

function setup(opts: Parameters<typeof makeTestApp>[0] = {}) {
  const t = makeTestApp(opts);
  const grant = addUser(t.db, t.clock, { email: 'alex@example.com', displayName: 'Alex', role: 'admin' });
  const jordan = addUser(t.db, t.clock, { email: 'jordan@example.com', displayName: 'Jordan', role: 'admin' });
  return { t, calendar: t.calendar, grant, jordan };
}

/** Tokens as the code exchange would return them for `account`. */
function linkTokens(t: TestApp, account: FakeGoogleAccount, scopes = ['openid', 'email', SCOPES.events, SCOPES.calendarList]): LinkTokens {
  const g = t.fakeGoogleCalendar.grant(account, scopes);
  return {
    accessToken: g.access_token, refreshToken: g.refresh_token, expiresAt: new Date(t.clock.now().getTime() + g.expires_in * 1000),
    grantedScopes: g.scope.split(' '), account: { id: account.sub, email: account.email },
  };
}

function storedCreds(t: TestApp) {
  return decryptCredentials(ring, t.calendar.connection()!) as { refreshToken: string; accessToken: string | null; expiresAt: number | null };
}

/** Collects log lines, parsed. */
function logLines() {
  const lines: Record<string, unknown>[] = [];
  return { lines, logger: pino({ level: 'debug' }, { write: (l: string) => void lines.push(JSON.parse(l) as Record<string, unknown>) }) };
}

function tokenRequests(t: TestApp) {
  return t.fakeGoogleCalendar.requests.filter((r) => r.path === '/token');
}

describe('linking', () => {
  it('waits for the admin to pick from calendars they can change, with the tokens saved encrypted for this session', async () => {
    const { t, calendar, grant } = setup();
    const family = t.fakeGoogleCalendar.createAccount({ email: 'family@example.com' });
    t.fakeGoogleCalendar.addCalendar(family, { summary: 'Family' });
    t.fakeGoogleCalendar.addCalendar(family, { summary: 'Holidays', role: 'reader' });
    t.fakeGoogleCalendar.addCalendar(family, { summary: 'Work', role: 'writerWithoutPrivateAccess' });
    const tokens = linkTokens(t, family);
    expect(await calendar.beginLink(grant, 'session-a', tokens)).toBe('ok');

    expect(calendar.pending(grant, 'session-a')).toMatchObject({ account: 'family@example.com', calendars: [{ name: 'Family', accessRole: 'owner' }] });
    expect(calendar.pending(grant, 'session-b')).toBeNull();
    const row = t.db.select().from(calendarLinkPending).get()!;
    expect(row.credentialsEnc).not.toContain(tokens.refreshToken!);
    expect(JSON.parse(decryptSecret(ring, row.credentialsEnc, pendingLinkAad(grant)))).toMatchObject({ refreshToken: tokens.refreshToken });
    // Nothing is linked until the pick.
    expect(calendar.connection()).toBeUndefined();
    t.clock.advance(PENDING_LINK_TTL_MS);
    expect(calendar.pending(grant, 'session-a')).toBeNull();
    expect(calendar.prunePending()).toBe(1);
  });

  it('refuses a link missing a calendar scope or a refresh token, or with nothing writable, and never revokes', async () => {
    const { t, calendar, grant } = setup();
    const family = t.fakeGoogleCalendar.createAccount();
    t.fakeGoogleCalendar.addCalendar(family, { summary: 'Family' });
    expect(await calendar.beginLink(grant, 's', linkTokens(t, family, ['openid', 'email', SCOPES.events]))).toBe('scopes');
    expect(await calendar.beginLink(grant, 's', { ...linkTokens(t, family), refreshToken: null })).toBe('no_refresh');
    const reader = t.fakeGoogleCalendar.createAccount();
    t.fakeGoogleCalendar.share(t.fakeGoogleCalendar.addCalendar(family, { summary: 'Shared' }), reader, 'reader');
    expect(await calendar.beginLink(grant, 's', linkTokens(t, reader))).toBe('no_calendars');
    expect(t.fakeGoogleCalendar.revocations).toEqual([]);
    expect(t.db.select().from(calendarLinkPending).all()).toEqual([]);
    // No `scope` field means what was asked was granted (RFC 6749 §5.1).
    expect(await calendar.beginLink(grant, 's', { ...linkTokens(t, family), grantedScopes: null })).toBe('ok');
  });

  it('makes the pick the family connection, encrypted for its row, and refuses a calendar that was not offered', async () => {
    const { t, calendar, grant } = setup();
    const family = t.fakeGoogleCalendar.createAccount({ email: 'family@example.com' });
    const cal = t.fakeGoogleCalendar.addCalendar(family, { summary: 'Family', timeZone: 'America/Denver' });
    const tokens = linkTokens(t, family);
    await calendar.beginLink(grant, 's', tokens);
    await expect(calendar.choose(grant, 's', 'not-offered')).rejects.toMatchObject({ code: 'validation', message: CALENDAR_MESSAGES.pickListed });
    await expect(calendar.choose(grant, 'other-session', cal.id)).rejects.toMatchObject({ code: 'not_found' });
    await calendar.choose(grant, 's', cal.id);

    expect(calendar.state()).toMatchObject({
      connected: true, status: 'ok', ownerUserId: grant,
      meta: { account: 'family@example.com', accountId: family.sub, calendarId: cal.id, calendarName: 'Family', calendarTimeZone: 'America/Denver' },
    });
    expect(storedCreds(t)).toMatchObject({ refreshToken: tokens.refreshToken });
    expect(t.db.select().from(calendarLinkPending).all()).toEqual([]);
  });

  it("lets another admin reconnect in place: same row, new owner, the old token replaced but not revoked", async () => {
    const { t, calendar, grant, jordan } = setup();
    const { account, calendar: cal } = linkCalendarForTest(t, grant);
    const before = calendar.connection()!;
    t.db.insert(calendarCache).values({ calendarId: cal.id, timeZone: 'UTC', windowStart: '2026-11-15', windowEnd: '2026-11-22', fetchedAt: t.clock.now(), fetchStartedAt: t.clock.now(), events: [] }).run();

    const fresh = linkTokens(t, account);
    await calendar.beginLink(jordan, 's2', fresh);
    await calendar.choose(jordan, 's2', cal.id);

    const after = calendar.connection()!;
    expect(after).toMatchObject({ id: before.id, ownerUserId: jordan });
    expect(storedCreds(t).refreshToken).toBe(fresh.refreshToken);
    expect(t.db.select().from(connections).all()).toHaveLength(1);
    expect(t.db.select().from(calendarCache).all()).toEqual([]);
    expect(t.fakeGoogleCalendar.revocations).toEqual([]);
    expect(t.fakeGoogleCalendar.liveRefreshTokens(account)).toBe(2);
  });
});

describe('picks that went stale, and links to another account', () => {
  it('refuses a Change calendar pick while the link it came from needs reconnecting (R2-M4)', async () => {
    const { t, calendar, grant } = setup();
    const { calendar: cal } = linkCalendarForTest(t, grant);
    await calendar.beginChange(grant, 's');
    t.db.update(connections).set({ status: 'needs_reconnect' }).run();
    await expect(calendar.choose(grant, 's', cal.id)).rejects.toMatchObject({ code: 'conflict', message: 'Reconnect Google Calendar first.' });
    expect(calendar.state()).toMatchObject({ status: 'needs_reconnect' });
  });

  it('refuses a Change calendar pick once the link it came from is disconnected or replaced', async () => {
    const { t, calendar, grant, jordan } = setup();
    const { account, calendar: cal } = linkCalendarForTest(t, grant);
    expect(await calendar.beginChange(grant, 's')).toBe('ok');
    // Disconnecting deletes every pick in progress.
    await calendar.disconnect(jordan);
    expect(t.db.select().from(calendarLinkPending).all()).toEqual([]);
    await expect(calendar.choose(grant, 's', cal.id)).rejects.toMatchObject({ code: 'not_found' });
    expect(calendar.connection()).toBeUndefined();

    // A pick made, then the link replaced by a new consent before it was used.
    linkCalendarForTest(t, grant, { account, calendar: cal });
    await calendar.beginChange(grant, 's');
    await calendar.beginLink(jordan, 's2', linkTokens(t, account));
    await calendar.choose(jordan, 's2', cal.id);
    await expect(calendar.choose(grant, 's', cal.id)).rejects.toMatchObject({ code: 'not_found', message: CALENDAR_MESSAGES.pickExpired });
    expect(t.db.select().from(calendarLinkPending).all()).toEqual([]);
  });

  it("queues the old account's token for revocation when a different Google account is linked, and keeps the same account's", async () => {
    const { t, calendar, grant, jordan } = setup();
    const { account: old, calendar: cal } = linkCalendarForTest(t, grant);
    const oldToken = storedCreds(t).refreshToken;
    await calendar.beginLink(jordan, 's', linkTokens(t, old));
    await calendar.choose(jordan, 's', cal.id);
    expect(t.db.select().from(pendingRevocations).all()).toEqual([]);

    const other = t.fakeGoogleCalendar.createAccount({ email: 'other@example.com' });
    t.fakeGoogleCalendar.share(cal, other, 'owner');
    const sameAccountToken = storedCreds(t).refreshToken;
    await calendar.beginLink(grant, 's', linkTokens(t, other));
    await calendar.choose(grant, 's', cal.id);
    const row = t.db.select().from(pendingRevocations).get()!;
    expect(row).toMatchObject({ accountId: old.sub, ownerUserId: grant });
    expect(JSON.parse(decryptSecret(ring, row.credentialsEnc, familyRevocationAad('google_calendar', row.id)))).toEqual({ refreshToken: sameAccountToken });
    expect(oldToken).not.toBe(sameAccountToken);
    expect(await calendar.retryRevocations()).toEqual({ total: 1, failed: 0, gaveUp: 0 });
    expect(t.fakeGoogleCalendar.revocations).toEqual([{ sub: old.sub, kind: 'refresh' }]);
    await expect(calendar.listEvents(WINDOW)).resolves.toBeDefined();
  });

  it("holds a waiting revocation while a pick for that account is in progress, and the link's code exchange runs under the lock", async () => {
    const { t, grant, jordan } = setup();
    const { account, calendar: cal } = linkCalendarForTest(t, grant);
    t.fakeGoogleCalendar.failures.push({ path: 'revoke', status: 503 });
    await t.calendar.disconnect(grant);
    // Google's token endpoint answers only when the test says so.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const gated: typeof fetch = async (input, init) => {
      if (new URL(input instanceof Request ? input.url : String(input)).pathname === '/token') await gate;
      return t.fakeGoogleCalendar.fetch(input, init);
    };
    const calendar = new GoogleCalendar({
      db: t.db, clock: t.clock, logger: t.logger, keyring: ring, fetch: gated, clientOptions: { sleep: async () => {} },
      google: { clientId: t.config.googleClientId, clientSecret: t.config.googleClientSecret, endpoints: t.config.googleEndpoints },
    });
    const url = new URL(calendar.oauth.authorizationUrl({ state: 'st', nonce: 'no', codeChallenge: pkceChallenge('v'.repeat(43)), redirectUri: 'http://localhost:3000/connect/google-calendar/callback' }));
    const back = t.fakeGoogleCalendar.authorize(url.searchParams);
    const linking = calendar.completeLink(jordan, 's', { callbackUrl: back, state: 'st', nonce: 'no', codeVerifier: 'v'.repeat(43), redirectUri: 'http://localhost:3000/connect/google-calendar/callback' });
    const retry = calendar.retryRevocations();
    await new Promise((r) => setTimeout(r, 20));
    expect(t.fakeGoogleCalendar.revocations).toEqual([]);
    release();
    expect(await linking).toBe('ok');
    expect(await retry).toEqual({ total: 1, failed: 0, gaveUp: 0 });
    expect(t.fakeGoogleCalendar.revocations).toEqual([]);
    expect(t.db.select().from(pendingRevocations).all()).toHaveLength(1);
    await calendar.choose(jordan, 's', cal.id);
    expect(t.db.select().from(pendingRevocations).all()).toEqual([]);
    expect(calendar.state()).toMatchObject({ meta: { accountId: account.sub } });
  });

  it("gives up at the callback's deadline, whether waiting for the lock, exchanging the code, or listing calendars (R4-M2)", async () => {
    const { t, jordan } = setup();
    const family = t.fakeGoogleCalendar.createAccount({ email: 'family@example.com' });
    t.fakeGoogleCalendar.addCalendar(family, { summary: 'Family' });
    t.fakeGoogleCalendar.nextAccount = family;
    // The test says which of Google's endpoints answers only when released (or never).
    let hold: string | null = null;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const gated: typeof fetch = async (input, init) => {
      if (new URL(input instanceof Request ? input.url : String(input)).pathname === hold) {
        await Promise.race([gate, new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))]);
      }
      return t.fakeGoogleCalendar.fetch(input, init);
    };
    const calendar = new GoogleCalendar({
      db: t.db, clock: t.clock, logger: t.logger, keyring: ring, fetch: gated, clientOptions: { sleep: async () => {} },
      google: { clientId: t.config.googleClientId, clientSecret: t.config.googleClientSecret, endpoints: t.config.googleEndpoints },
    });
    const redirectUri = 'http://localhost:3000/connect/google-calendar/callback';
    const link = (deadline?: number) => {
      const url = new URL(calendar.oauth.authorizationUrl({ state: 'st', nonce: 'no', codeChallenge: pkceChallenge('v'.repeat(43)), redirectUri }));
      const back = t.fakeGoogleCalendar.authorize(url.searchParams);
      return calendar.completeLink(jordan, 's', { callbackUrl: back, state: 'st', nonce: 'no', codeVerifier: 'v'.repeat(43), redirectUri }, deadline === undefined ? {} : { deadline });
    };
    const fast = async (p: Promise<unknown>) => {
      const started = Date.now();
      await expect(p).rejects.toBeDefined();
      expect(Date.now() - started).toBeLessThan(2_000);
    };
    // The code exchange doesn't answer in time.
    hold = '/token';
    await fast(link(Date.now() + 50));
    // Listing the calendars doesn't answer in time.
    hold = '/calendar/v3/users/me/calendarList';
    await fast(link(Date.now() + 50));
    // Waiting for the lock, while another link (with no deadline) holds it in a code exchange that doesn't answer.
    hold = '/token';
    const holder = link();
    await new Promise((r) => setTimeout(r, 10));
    await fast(link(Date.now() + 50));
    expect(t.db.select().from(calendarLinkPending).all()).toEqual([]);
    hold = null;
    release();
    expect(await holder).toBe('ok');
    // With time left, it works.
    expect(await link(Date.now() + 45_000)).toBe('ok');
  });
});

describe('a relink that invalidates the old refresh token (relinkInvalidatesOldRefresh, R2-M16)', () => {
  it('leaves the link needing a reconnect when the admin cancels the pick', async () => {
    const { t, grant, jordan } = setup();
    const { account } = linkCalendarForTest(t, grant);
    t.fakeGoogleCalendar.relinkInvalidatesOldRefresh = true;
    t.fakeGoogleCalendar.nextAccount = account;
    const redirectUri = 'http://localhost:3000/connect/google-calendar/callback';
    const url = new URL(t.calendar.oauth.authorizationUrl({ state: 'st', nonce: 'no', codeChallenge: pkceChallenge('v'.repeat(43)), redirectUri }));
    const back = t.fakeGoogleCalendar.authorize(url.searchParams);
    expect(await t.calendar.completeLink(jordan, 's', { callbackUrl: back, state: 'st', nonce: 'no', codeVerifier: 'v'.repeat(43), redirectUri })).toBe('ok');
    t.calendar.cancelPending(jordan, 's');
    // The stored link's refresh token no longer works: the next refresh is refused.
    t.clock.advance(56 * 60_000);
    t.fakeGoogleCalendar.expireAccessTokens();
    await expect(t.calendar.listEvents(WINDOW)).rejects.toMatchObject({ message: CALENDAR_MESSAGES.reconnect });
    expect(t.calendar.state()).toMatchObject({ status: 'needs_reconnect' });
  });
});

describe('tokens and status', () => {
  it('uses the saved access token while it is good, then refreshes once, single-flight, keeping the refresh token', async () => {
    const { t, calendar, grant } = setup();
    linkCalendarForTest(t, grant);
    const original = storedCreds(t);
    await calendar.listEvents(WINDOW);
    expect(tokenRequests(t)).toHaveLength(0);

    t.clock.advance(56 * 60_000); // within 5 minutes of the hour
    await Promise.all([calendar.listEvents(WINDOW), calendar.listEvents(WINDOW), calendar.listEvents(WINDOW)]);
    expect(tokenRequests(t)).toHaveLength(1);
    const refreshed = storedCreds(t);
    expect(refreshed.refreshToken).toBe(original.refreshToken);
    expect(refreshed.accessToken).not.toBe(original.accessToken);
    expect(calendar.state()).toMatchObject({ status: 'ok' });
  });

  it('refreshes once after a 401 and tries again', async () => {
    const { t, calendar, grant } = setup();
    linkCalendarForTest(t, grant);
    t.fakeGoogleCalendar.expireAccessTokens(); // the app still thinks its token is good
    await expect(calendar.listEvents(WINDOW)).resolves.toMatchObject({ events: [] });
    expect(tokenRequests(t)).toHaveLength(1);
  });

  it('needs reconnecting after invalid_grant or a missing scope, and then fails at once without calling Google', async () => {
    const { t, calendar, grant } = setup();
    const { account } = linkCalendarForTest(t, grant);
    t.fakeGoogleCalendar.revokeAccount(account);
    await expect(calendar.listEvents(WINDOW)).rejects.toMatchObject({ code: 'integration_unavailable', message: CALENDAR_MESSAGES.reconnect });
    expect(calendar.state()).toMatchObject({ status: 'needs_reconnect', lastError: 'Google stopped accepting the saved sign-in.' });
    const calls = t.fakeGoogleCalendar.requests.length;
    await expect(calendar.listEvents(WINDOW)).rejects.toMatchObject({ message: CALENDAR_MESSAGES.reconnect });
    expect(t.fakeGoogleCalendar.requests).toHaveLength(calls);

    const other = setup();
    linkCalendarForTest(other.t, other.grant, { scopes: ['openid', 'email', SCOPES.calendarList] });
    await expect(other.calendar.listEvents(WINDOW)).rejects.toMatchObject({ message: CALENDAR_MESSAGES.reconnect });
    expect(other.calendar.state()).toMatchObject({ status: 'needs_reconnect' });
  });

  it('sets error after 3 failures in a row, and ok again after a success', async () => {
    const { t, calendar, grant } = setup();
    linkCalendarForTest(t, grant);
    for (let i = 0; i < 3; i++) {
      // Each read is tried 3 times (two retries) before it counts as one failure.
      t.fakeGoogleCalendar.failures.push(...[1, 2, 3].map(() => ({ path: 'list' as const, status: 503 })));
      await expect(calendar.listEvents(WINDOW)).rejects.toMatchObject({ message: CALENDAR_MESSAGES.unreachable });
      expect(calendar.state()).toMatchObject({ status: i < 2 ? 'ok' : 'error' });
    }
    await calendar.listEvents(WINDOW);
    expect(calendar.state()).toMatchObject({ status: 'ok' });
    expect(t.db.select().from(connections).get()).toMatchObject({ consecutiveFailures: 0 });
  });

  it("counts a calendar that's gone or refuses access, but not an event that's gone", async () => {
    const { t, calendar, grant } = setup();
    linkCalendarForTest(t, grant);
    t.fakeGoogleCalendar.failures.push({ path: 'list', status: 404, body: GOOGLE_ERRORS.notFound });
    await expect(calendar.listEvents(WINDOW)).rejects.toMatchObject({ message: CALENDAR_MESSAGES.calendarUnavailable });
    expect(t.db.select().from(connections).get()).toMatchObject({ consecutiveFailures: 1, lastError: "The family calendar couldn't be found." });
    await expect(calendar.getEvent('missing0001')).rejects.toMatchObject({ name: 'GoogleApiError', kind: 'not_found' });
    expect(t.db.select().from(connections).get()).toMatchObject({ consecutiveFailures: 1 });
  });

  it("doesn't count an event that won't parse against the connection (R2-M12)", async () => {
    const { t, calendar, grant } = setup();
    linkCalendarForTest(t, grant);
    t.fakeGoogleCalendar.failures.push({ path: 'get', status: 200, body: { id: 'odd00001', summary: 'no etag' } });
    await expect(calendar.getEvent('odd00001')).rejects.toMatchObject({ name: 'GoogleApiError', kind: 'bad_response', reason: 'event_shape' });
    expect(t.db.select().from(connections).get()).toMatchObject({ status: 'ok', consecutiveFailures: 0, lastError: null });
  });

  it('runs a token refresh and a relink one at a time, so the refresh never overwrites the new link', async () => {
    const { t, calendar, grant, jordan } = setup();
    const { account, calendar: cal } = linkCalendarForTest(t, grant);
    t.clock.advance(56 * 60_000); // the saved access token is due for a refresh
    const next = linkTokens(t, account);
    await calendar.beginLink(jordan, 's', next);
    const read = calendar.listEvents(WINDOW); // needs a refresh
    const relink = calendar.choose(jordan, 's', cal.id);
    await Promise.all([read, relink]);
    expect(storedCreds(t).refreshToken).toBe(next.refreshToken);
    expect(calendar.state()).toMatchObject({ status: 'ok', ownerUserId: jordan });
  });

  it("doesn't let a call that started earlier mark the link ok after another call found it needs reconnecting", async () => {
    const { t, grant } = setup();
    linkCalendarForTest(t, grant);
    // While this read is out, another call records needs_reconnect.
    const racing: typeof fetch = async (input, init) => {
      const res = await t.fakeGoogleCalendar.fetch(input, init);
      t.db.update(connections).set({ status: 'needs_reconnect', lastError: 'Google stopped accepting the saved sign-in.', lastErrorAt: t.clock.now() }).run();
      return res;
    };
    const calendar = new GoogleCalendar({
      db: t.db, clock: t.clock, logger: t.logger, keyring: ring, fetch: racing, clientOptions: { sleep: async () => {} },
      google: { clientId: t.config.googleClientId, clientSecret: t.config.googleClientSecret, endpoints: t.config.googleEndpoints },
    });
    await calendar.listEvents(WINDOW);
    expect(calendar.state()).toMatchObject({ status: 'needs_reconnect' });
  });

  it("never records a call's own deadline against the connection, whether it ran out in Google, the lock wait, or the refresh (R2-M7)", async () => {
    const { t, grant } = setup();
    linkCalendarForTest(t, grant);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const gated: typeof fetch = async (input, init) => {
      if (new URL(input instanceof Request ? input.url : String(input)).pathname === '/token') {
        await Promise.race([gate, new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))]);
      }
      return t.fakeGoogleCalendar.fetch(input, init);
    };
    const calendar = new GoogleCalendar({
      db: t.db, clock: t.clock, logger: t.logger, keyring: ring, fetch: gated, clientOptions: { sleep: async () => {} },
      google: { clientId: t.config.googleClientId, clientSecret: t.config.googleClientSecret, endpoints: t.config.googleEndpoints },
    });
    const failures = () => t.db.select().from(connections).get()!.consecutiveFailures;
    // Out of time before Google answers.
    await expect(calendar.getEvent('x', { deadline: Date.now() - 1 })).rejects.toMatchObject({ message: CALENDAR_MESSAGES.unreachable });
    expect(failures()).toBe(0);
    // Out of time in the refresh: the token endpoint doesn't answer in time.
    t.clock.advance(56 * 60_000);
    const started = Date.now();
    await expect(calendar.getEvent('x', { deadline: Date.now() + 50 })).rejects.toMatchObject({ message: CALENDAR_MESSAGES.unreachable });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(failures()).toBe(0);
    // Out of time waiting for the lock, while another refresh holds it.
    const holder = calendar.listEvents(WINDOW);
    await new Promise((r) => setTimeout(r, 10));
    await expect(calendar.getEvent('x', { deadline: Date.now() + 30 })).rejects.toMatchObject({ message: CALENDAR_MESSAGES.unreachable });
    expect(failures()).toBe(0);
    release();
    await holder;
    expect(calendar.state()).toMatchObject({ status: 'ok' });
  });

  it('throws a conflict instead of carrying on when the link changed calendars during a refresh (R2-M13)', async () => {
    const { t, grant } = setup();
    const { account } = linkCalendarForTest(t, grant);
    const other = t.fakeGoogleCalendar.addCalendar(account, { summary: 'Other' });
    // The first read gets a 401; while it's out, an admin switches the link to another calendar.
    const racing: typeof fetch = async (input, init) => {
      const res = await t.fakeGoogleCalendar.fetch(input, init);
      if (res.status === 401) {
        const conn = t.calendar.connection()!;
        const g = t.fakeGoogleCalendar.grant(account);
        t.db.update(connections).set({
          meta: { ...conn.meta, calendarId: other.id, calendarName: 'Other' },
          credentialsEnc: encryptCredentials(ring, conn, { refreshToken: g.refresh_token, accessToken: g.access_token, expiresAt: t.clock.now().getTime() + 3_600_000 }),
        }).run();
      }
      return res;
    };
    const calendar = new GoogleCalendar({
      db: t.db, clock: t.clock, logger: t.logger, keyring: ring, fetch: racing, clientOptions: { sleep: async () => {} },
      google: { clientId: t.config.googleClientId, clientSecret: t.config.googleClientSecret, endpoints: t.config.googleEndpoints },
    });
    t.fakeGoogleCalendar.failures.push({ path: 'get', status: 401, body: GOOGLE_ERRORS.authError });
    await expect(calendar.getEvent('evt00001')).rejects.toMatchObject({ code: 'conflict', message: CALENDAR_MESSAGES.linkChanged });
    expect(t.fakeGoogleCalendar.requests.filter((r) => r.path.includes(encodeURIComponent(other.id)))).toEqual([]);
    expect(t.db.select().from(connections).get()).toMatchObject({ status: 'ok', consecutiveFailures: 0 });
  });

  it('treats credentials that no longer decrypt, with the right key, as needing reconnecting', async () => {
    const { t, calendar, grant } = setup();
    linkCalendarForTest(t, grant);
    t.db.update(connections).set({ credentialsEnc: 'v1.AAAAAAAAAAAAAAAA.AAAA.AAAAAAAAAAAAAAAAAAAAAA' }).run();
    await expect(calendar.listEvents(WINDOW)).rejects.toMatchObject({ message: CALENDAR_MESSAGES.reconnect });
    expect(calendar.state()).toMatchObject({ status: 'needs_reconnect' });
  });
});

describe('disconnecting and revocations', () => {
  it('revokes, then deletes the link and its cached events', async () => {
    const { t, calendar, grant } = setup();
    const { account, calendar: cal } = linkCalendarForTest(t, grant);
    t.db.insert(calendarCache).values({ calendarId: cal.id, timeZone: 'UTC', windowStart: '2026-11-15', windowEnd: '2026-11-22', fetchedAt: t.clock.now(), fetchStartedAt: t.clock.now(), events: [] }).run();
    expect(await calendar.disconnect(grant)).toEqual({ wasLinked: true, revoked: true });
    expect(t.fakeGoogleCalendar.revocations).toEqual([{ sub: account.sub, kind: 'refresh' }]);
    expect(calendar.connection()).toBeUndefined();
    expect(t.db.select().from(calendarCache).all()).toEqual([]);
    expect(t.db.select().from(pendingRevocations).all()).toEqual([]);
    expect(await calendar.disconnect(grant)).toEqual({ wasLinked: false, revoked: false });
  });

  it('keeps a token Google did not confirm revoking, encrypted for its row, and retries it hourly', async () => {
    const { t, calendar, grant } = setup();
    const { account } = linkCalendarForTest(t, grant);
    const { refreshToken } = storedCreds(t);
    t.fakeGoogleCalendar.failures.push({ path: 'revoke', status: 503 });
    expect(await calendar.disconnect(grant)).toEqual({ wasLinked: true, revoked: false });
    const row = t.db.select().from(pendingRevocations).get()!;
    expect(row).toMatchObject({ kind: 'google_calendar', ownerUserId: grant, accountId: account.sub });
    expect(row.credentialsEnc).not.toContain(refreshToken);
    expect(JSON.parse(decryptSecret(ring, row.credentialsEnc, familyRevocationAad('google_calendar', row.id)))).toEqual({ refreshToken });
    expect(calendar.warnings()).toEqual([expect.stringContaining("Couldn't revoke the dashboard's Google Calendar access")]);

    expect(await calendar.retryRevocations()).toEqual({ total: 1, failed: 0, gaveUp: 0 });
    expect(t.fakeGoogleCalendar.revocations).toEqual([{ sub: account.sub, kind: 'refresh' }]);
    expect(calendar.warnings()).toEqual([]);
  });

  it('drops a waiting revocation when the same Google account is linked again, so the new link keeps working', async () => {
    const { t, calendar, grant, jordan } = setup();
    const { account, calendar: cal } = linkCalendarForTest(t, grant);
    t.fakeGoogleCalendar.failures.push({ path: 'revoke', status: 503 });
    await calendar.disconnect(grant);
    await calendar.beginLink(jordan, 's', linkTokens(t, account));
    await calendar.choose(jordan, 's', cal.id);
    expect(t.db.select().from(pendingRevocations).all()).toEqual([]);
    expect(await calendar.retryRevocations()).toEqual({ total: 0, failed: 0, gaveUp: 0 });
    expect(t.fakeGoogleCalendar.revocations).toEqual([]);
    await expect(calendar.listEvents(WINDOW)).resolves.toBeDefined();
  });

  it('keeps the token for later when revocation needs client credentials, which the dashboard does not send (R2-M16)', async () => {
    const { t, calendar, grant } = setup();
    linkCalendarForTest(t, grant);
    t.fakeGoogleCalendar.revokeNeedsClientCredentials = true;
    expect(await calendar.disconnect(grant)).toEqual({ wasLinked: true, revoked: false });
    expect(t.db.select().from(pendingRevocations).all()).toHaveLength(1);
    expect(t.fakeGoogleCalendar.revocations).toEqual([]);
  });

  it(`gives up after ${REVOCATION_ATTEMPTS} failed tries, keeps the row for a lasting warning naming the account, and lets an admin dismiss it (R2-I3)`, async () => {
    const { lines, logger } = logLines();
    const { t, calendar, grant } = setup({ logger });
    const { account } = linkCalendarForTest(t, grant);
    t.fakeGoogleCalendar.failures.push(...Array.from({ length: REVOCATION_ATTEMPTS + 1 }, () => ({ path: 'revoke' as const, status: 503 })));
    await calendar.disconnect(grant);
    expect(t.db.select().from(pendingRevocations).get()).toMatchObject({ accountId: account.sub, accountEmail: account.email, gaveUpAt: null });
    for (let i = 1; i < REVOCATION_ATTEMPTS; i++) expect(await calendar.retryRevocations()).toEqual({ total: 1, failed: 1, gaveUp: 0 });
    expect(await calendar.retryRevocations()).toEqual({ total: 1, failed: 0, gaveUp: 1 });
    const row = t.db.select().from(pendingRevocations).get()!;
    expect(row).toMatchObject({ attempts: REVOCATION_ATTEMPTS, gaveUpAt: t.clock.now(), credentialsEnc: '' });
    expect(lines.find((l) => l.msg === 'gave up revoking a disconnected google calendar token')).toMatchObject({ attempts: REVOCATION_ATTEMPTS, account: account.sub });
    // Not tried again, and the in-progress warning is replaced by one naming the account.
    expect(await calendar.retryRevocations()).toEqual({ total: 0, failed: 0, gaveUp: 0 });
    expect(calendar.warnings()).toEqual([]);
    expect(calendar.revocationNotices()).toEqual([
      { id: row.id, message: `Couldn't revoke the dashboard's Google Calendar access after it was disconnected. Remove the dashboard's access in ${account.email}'s Google account settings.` },
    ]);
    expect(calendar.dismissRevocation(row.id + 1)).toBe(false);
    expect(calendar.dismissRevocation(row.id)).toBe(true);
    expect(calendar.revocationNotices()).toEqual([]);
    expect(t.db.select().from(pendingRevocations).all()).toEqual([]);
  });

  it('only dismisses revocations it gave up on', async () => {
    const { t, calendar, grant } = setup();
    linkCalendarForTest(t, grant);
    t.fakeGoogleCalendar.failures.push({ path: 'revoke', status: 503 });
    await calendar.disconnect(grant);
    const row = t.db.select().from(pendingRevocations).get()!;
    expect(calendar.dismissRevocation(row.id)).toBe(false);
    expect(t.db.select().from(pendingRevocations).all()).toHaveLength(1);
  });

  it('takes only invalid_token and invalid_grant as already revoked; any other 4xx waits for a retry, logged with its code and status (R2-I1, R2-M15)', async () => {
    const { lines, logger } = logLines();
    const { t, calendar, grant, jordan } = setup({ logger });
    const { account } = linkCalendarForTest(t, grant);
    t.fakeGoogleCalendar.revokeInvalidRequest = true;
    expect(await calendar.disconnect(grant)).toEqual({ wasLinked: true, revoked: false });
    expect(lines.find((l) => l.msg === 'google calendar revocation failed')).toMatchObject({ code: 'invalid_request', status: 400 });
    expect(await calendar.retryRevocations()).toEqual({ total: 1, failed: 1, gaveUp: 0 });
    expect(t.db.select().from(pendingRevocations).get()).toMatchObject({ attempts: 1, lastError: 'Google answered HTTP 400 (invalid_request).' });
    t.fakeGoogleCalendar.revokeInvalidRequest = false;
    t.fakeGoogleCalendar.failures.push({ path: 'revoke', status: 503 });
    expect(await calendar.retryRevocations()).toEqual({ total: 1, failed: 1, gaveUp: 0 });
    expect(t.db.select().from(pendingRevocations).get()).toMatchObject({ attempts: 2, lastError: 'Google answered HTTP 503.' });
    // The account removed the access itself: Google says the token is invalid, which is done.
    t.fakeGoogleCalendar.revokeAccount(account);
    expect(await calendar.retryRevocations()).toEqual({ total: 1, failed: 0, gaveUp: 0 });
    expect(t.db.select().from(pendingRevocations).all()).toEqual([]);
    // invalid_grant counts as done too.
    linkCalendarForTest(t, jordan);
    t.fakeGoogleCalendar.failures.push({ path: 'revoke', status: 400, body: { error: 'invalid_grant' } });
    expect(await calendar.disconnect(jordan)).toEqual({ wasLinked: true, revoked: true });
  });

  it("gives up at once on a token that won't decrypt (R2-M15)", async () => {
    const { t, calendar, grant } = setup();
    linkCalendarForTest(t, grant);
    t.fakeGoogleCalendar.failures.push({ path: 'revoke', status: 503 });
    await calendar.disconnect(grant);
    t.db.update(pendingRevocations).set({ credentialsEnc: 'v1.AAAAAAAAAAAAAAAA.AAAA.AAAAAAAAAAAAAAAAAAAAAA' }).run();
    expect(await calendar.retryRevocations()).toEqual({ total: 1, failed: 0, gaveUp: 1 });
    expect(t.db.select().from(pendingRevocations).get()).toMatchObject({ attempts: 1, gaveUpAt: t.clock.now(), lastError: "The saved token couldn't be read." });
    expect(t.fakeGoogleCalendar.requests.filter((r) => r.path === '/revoke')).toHaveLength(1);
  });

  it('waits 15 minutes after any link starts before retrying revocations (R2-M5)', async () => {
    const { t, calendar, grant } = setup();
    linkCalendarForTest(t, grant);
    t.fakeGoogleCalendar.failures.push({ path: 'revoke', status: 503 });
    await calendar.disconnect(grant);
    calendar.noteLinkStarted();
    t.clock.advance(14 * 60_000);
    expect(await calendar.retryRevocations()).toEqual({ total: 1, failed: 0, gaveUp: 0 });
    expect(t.fakeGoogleCalendar.revocations).toEqual([]);
    expect(t.db.select().from(pendingRevocations).get()).toMatchObject({ attempts: 0 });
    t.clock.advance(60_000);
    await calendar.retryRevocations();
    expect(t.fakeGoogleCalendar.revocations).toHaveLength(1);
    expect(t.db.select().from(pendingRevocations).all()).toEqual([]);
  });

  it("doesn't retry a token for an unknown account while any calendar link or pick exists (R2-M6)", async () => {
    const { t, calendar, grant, jordan } = setup();
    linkCalendarForTest(t, grant);
    t.fakeGoogleCalendar.failures.push({ path: 'revoke', status: 503 });
    await calendar.disconnect(grant);
    t.db.update(pendingRevocations).set({ accountId: null }).run();
    const other = t.fakeGoogleCalendar.createAccount({ email: 'other@example.com' });
    t.fakeGoogleCalendar.addCalendar(other, { summary: 'Other' });
    await calendar.beginLink(jordan, 's', linkTokens(t, other));
    await calendar.retryRevocations();
    expect(t.fakeGoogleCalendar.requests.filter((r) => r.path === '/revoke')).toHaveLength(1);
    await calendar.choose(jordan, 's', [...t.fakeGoogleCalendar.calendars.values()].find((c) => c.summary === 'Other')!.id);
    await calendar.retryRevocations();
    expect(t.fakeGoogleCalendar.requests.filter((r) => r.path === '/revoke')).toHaveLength(1);
    await calendar.disconnect(jordan);
    expect(await calendar.retryRevocations()).toEqual({ total: 1, failed: 0, gaveUp: 0 });
    expect(t.db.select().from(pendingRevocations).all()).toEqual([]);
  });

  it('says a token for an unknown account is waiting while a calendar link exists, and lets an admin dismiss it (C-M5)', async () => {
    const { t, calendar, grant, jordan } = setup();
    linkCalendarForTest(t, grant);
    t.fakeGoogleCalendar.failures.push({ path: 'revoke', status: 503 });
    await calendar.disconnect(grant);
    t.db.update(pendingRevocations).set({ accountId: null }).run();
    const row = t.db.select().from(pendingRevocations).get()!;
    // No link: it's tried every hour, as any other.
    expect(calendar.warnings()).toEqual([expect.stringContaining("It's tried again every hour.")]);
    expect(calendar.revocationNotices()).toEqual([]);
    expect(calendar.dismissRevocation(row.id)).toBe(false);
    linkCalendarForTest(t, jordan);
    expect(calendar.warnings()).toEqual([]);
    expect(calendar.revocationNotices()).toEqual([{
      id: row.id,
      message: "Couldn't revoke the dashboard's Google Calendar access after it was disconnected. Waiting until the calendar link is removed, because the account isn't known. " +
        "Dismissing this forgets the old access without revoking it: you can remove it in that Google account's settings.",
    }]);
    expect(calendar.revocationNotices()[0]!.message).not.toMatch(/—/);
    expect(calendar.dismissRevocation(row.id)).toBe(true);
    expect(t.db.select().from(pendingRevocations).all()).toEqual([]);
  });

  it('remembers a link starting across a restart, so revocations still wait (C-M5)', async () => {
    const { t, calendar, grant } = setup();
    linkCalendarForTest(t, grant);
    t.fakeGoogleCalendar.failures.push({ path: 'revoke', status: 503 });
    await calendar.disconnect(grant);
    calendar.noteLinkStarted();
    t.clock.advance(5 * 60_000);
    const restarted = new GoogleCalendar({
      db: t.db, clock: t.clock, logger: t.logger, keyring: ring, fetch: t.fakeGoogleCalendar.fetch, clientOptions: { sleep: async () => {} },
      google: { clientId: t.config.googleClientId, clientSecret: t.config.googleClientSecret, endpoints: t.config.googleEndpoints },
    });
    await restarted.retryRevocations();
    expect(t.fakeGoogleCalendar.requests.filter((r) => r.path === '/revoke')).toHaveLength(1);
    t.clock.advance(10 * 60_000);
    await restarted.retryRevocations();
    expect(t.fakeGoogleCalendar.revocations).toHaveLength(1);
  });
});

describe('a TOKEN_ENCRYPTION_KEY that does not match', () => {
  it('refuses every call without calling Google, and can only forget the link', async () => {
    const { t, calendar, grant } = setup({ keyMismatch: true });
    linkCalendarForTest(t, grant);
    const refused = { code: 'integration_unavailable', message: CALENDAR_MESSAGES.keyMismatch };
    await expect(calendar.listEvents(WINDOW)).rejects.toMatchObject(refused);
    await expect(calendar.disconnect(grant)).rejects.toMatchObject(refused);
    await expect(calendar.choose(grant, 's', 'x')).rejects.toMatchObject(refused);
    await expect(calendar.beginLink(grant, 's', linkTokens(t, t.fakeGoogleCalendar.createAccount()))).rejects.toMatchObject(refused);
    expect(t.fakeGoogleCalendar.requests).toEqual([]);
    expect(await calendar.retryRevocations()).toEqual({ total: 0, failed: 0, gaveUp: 0 });

    expect(await calendar.forgetForNewKey()).toEqual({ disconnected: true });
    expect(calendar.connection()).toBeUndefined();
    expect(t.fakeGoogleCalendar.revocations).toEqual([]);
    await expect(setup().calendar.forgetForNewKey()).rejects.toMatchObject({ code: 'conflict' });
  });

  it('keeps the revocations it gave up on, which hold no token, when it forgets the link (C-M5)', async () => {
    const { t, calendar, grant } = setup({ keyMismatch: true });
    linkCalendarForTest(t, grant);
    const row = (values: Partial<typeof pendingRevocations.$inferInsert>) => t.db.insert(pendingRevocations)
      .values({ kind: 'google_calendar', ownerUserId: grant, accountId: 'sub-1', accountEmail: 'old@example.com', credentialsEnc: 'x', createdAt: t.clock.now(), ...values })
      .returning({ id: pendingRevocations.id }).get().id;
    const waiting = row({});
    const gaveUp = row({ credentialsEnc: '', gaveUpAt: t.clock.now(), attempts: REVOCATION_ATTEMPTS });
    await calendar.forgetForNewKey();
    expect(t.db.select({ id: pendingRevocations.id }).from(pendingRevocations).all()).toEqual([{ id: gaveUp }]);
    expect(waiting).not.toBe(gaveUp);
    expect(calendar.revocationNotices()).toEqual([{ id: gaveUp, message: expect.stringContaining("old@example.com's Google account settings") }]);
  });
});

it('never logs a token', async () => {
  const lines: string[] = [];
  const logger = pino({ level: 'debug' }, { write: (line: string) => void lines.push(line) });
  const { t, calendar, grant } = setup({ logger });
  const account = t.fakeGoogleCalendar.createAccount();
  const cal = t.fakeGoogleCalendar.addCalendar(account, { summary: 'Family' });
  const tokens = linkTokens(t, account);
  await calendar.beginLink(grant, 's', tokens);
  await calendar.choose(grant, 's', cal.id);
  t.clock.advance(56 * 60_000);
  await calendar.listEvents(WINDOW);
  const refreshed = storedCreds(t).accessToken!;
  t.fakeGoogleCalendar.failures.push({ path: 'revoke', status: 503 });
  await calendar.disconnect(grant);
  const all = lines.join('\n');
  expect(all).toContain('google calendar token refreshed');
  for (const secret of [tokens.accessToken, tokens.refreshToken!, refreshed]) expect(all).not.toContain(secret);
  expect(t.db.select().from(connections).where(eq(connections.kind, 'google_calendar')).all()).toEqual([]);
});

it('is constructed without network calls', () => {
  const { t } = setup();
  expect(new GoogleCalendar({ db: t.db, clock: t.clock, logger: t.logger, keyring: ring, fetch: t.fakeGoogleCalendar.fetch, google: { clientId: 'c', clientSecret: 's', endpoints: t.config.googleEndpoints } }).state()).toEqual({ connected: false, keyMismatch: false });
  expect(t.fakeGoogleCalendar.requests).toEqual([]);
});
