import { describe, expect, it, vi } from 'vitest';
import type { SystemInfo } from '../../../shared/api.js';
import { CALENDAR_CONFLICT_MESSAGE, type CalendarEventDetail, type CalendarWindow } from '../../../shared/calendar.js';
import { runJob } from '../../core/jobs.js';
import { recentJobErrors } from '../../core/jobs.js';
import { connections } from '../../db/schema.js';
import { setFamilySettings } from '../../settings.js';
import { GOOGLE_ERRORS } from '../../test/fakeGoogleCalendar.js';
import { addUser, call, cookieFor, linkCalendarForTest, makeTestApp } from '../../test/helpers.js';
import { CALENDAR_MESSAGES, REVOCATION_ATTEMPTS } from '../../integrations/google/calendar.js';
import { panelJobs } from '../registry.js';
import { newEventId } from './edits.js';

function setup() {
  const t = makeTestApp();
  setFamilySettings(t.db, { name: 'Test', timeZone: 'America/Los_Angeles' });
  const admin = addUser(t.db, t.clock, { email: 'alex@example.com', displayName: 'Alex', role: 'admin', panels: ['calendar'] });
  const kid = addUser(t.db, t.clock, { email: 'kid@example.com', displayName: 'Riley', panels: ['calendar'] });
  const outsider = addUser(t.db, t.clock, { email: 'guest@example.com', displayName: 'Guest', panels: ['todo'] });
  return { t, admin, kid, outsider, kidCookie: cookieFor(t.db, t.clock, kid) };
}

const event = { title: 'Dentist', allDay: false, startDate: '2026-11-20', endDate: '2026-11-20', startTime: '09:00', endTime: '10:00', location: null, description: null };
/** The form for a new event, with the id the browser picks when it opens (R3-M: the id is required). */
const newEvent = () => ({ ...event, id: newEventId() });

describe('a create Google may or may not have (C-M4)', () => {
  async function createWith(failures: ReturnType<typeof makeTestApp>['fakeGoogleCalendar']['failures']) {
    const { t, admin, kidCookie } = setup();
    linkCalendarForTest(t, admin);
    t.fakeGoogleCalendar.failures.push(...failures);
    const res = await call(t.app, 'POST', '/api/panels/calendar/events', { cookie: kidCookie, body: newEvent() });
    return { status: res.status, code: ((await res.json()) as { error: { code: string } }).error.code };
  }

  it('says the outcome is unknown when the insert was sent and no good answer came back', async () => {
    expect(await createWith([1, 2, 3].map(() => ({ path: 'insert' as const, status: 503 })))).toEqual({ status: 503, code: 'outcome_unknown' });
  });

  it('says Google is unavailable when it refused the insert outright, or it was never sent', async () => {
    expect(await createWith([1, 2, 3].map(() => ({ path: 'insert' as const, status: 429, body: GOOGLE_ERRORS.tooManyRequests }))))
      .toEqual({ status: 503, code: 'integration_unavailable' });
    expect(await createWith([{ path: 'insert', status: 403, body: GOOGLE_ERRORS.accessNotConfigured }])).toEqual({ status: 503, code: 'integration_unavailable' });
    expect(await createWith([{ path: 'insert', status: 401, body: GOOGLE_ERRORS.authError }, { path: 'token', status: 400, body: GOOGLE_ERRORS.invalidGrant }]))
      .toEqual({ status: 503, code: 'integration_unavailable' });
  });

  it("says the outcome is unknown when the insert landed but reading it back didn't work", async () => {
    const { t, admin, kidCookie } = setup();
    linkCalendarForTest(t, admin);
    // The insert lands but its answer is lost; the retry finds the id taken, and reading it back fails.
    t.fakeGoogleCalendar.loseNextResponse = 'insert';
    t.fakeGoogleCalendar.failures.push(...[1, 2, 3].map(() => ({ path: 'get' as const, status: 503 })));
    const res = await call(t.app, 'POST', '/api/panels/calendar/events', { cookie: kidCookie, body: newEvent() });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('outcome_unknown');
  });
});

describe('the Calendar API', () => {
  it('needs a session and the Calendar panel, even for admins', async () => {
    const { t, outsider } = setup();
    const lonelyAdmin = addUser(t.db, t.clock, { email: 'a2@example.com', role: 'admin' });
    expect((await call(t.app, 'GET', '/api/panels/calendar/summary')).status).toBe(401);
    expect((await call(t.app, 'GET', '/api/panels/calendar/summary', { cookie: cookieFor(t.db, t.clock, outsider) })).status).toBe(403);
    expect((await call(t.app, 'GET', '/api/panels/calendar/summary', { cookie: cookieFor(t.db, t.clock, lonelyAdmin) })).status).toBe(403);
    expect((await call(t.app, 'POST', '/api/panels/calendar/events', { cookie: cookieFor(t.db, t.clock, outsider), body: newEvent() })).status).toBe(403);
  });

  it('lets anyone with the panel create, read, edit, and delete events (spec §9.7)', async () => {
    const { t, admin, kidCookie } = setup();
    linkCalendarForTest(t, admin);
    const created = await call(t.app, 'POST', '/api/panels/calendar/events', { cookie: kidCookie, body: newEvent() });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const summary = (await (await call(t.app, 'GET', '/api/panels/calendar/summary', { cookie: kidCookie })).json()) as CalendarWindow;
    expect(summary).toMatchObject({ start: '2026-11-15', end: '2026-11-22', today: '2026-11-15', events: [{ id, title: 'Dentist', createdBy: { name: 'Riley' } }] });

    const detail = (await (await call(t.app, 'GET', `/api/panels/calendar/events/${id}`, { cookie: kidCookie })).json()) as CalendarEventDetail;
    const patched = await call(t.app, 'PATCH', `/api/panels/calendar/events/${id}`, {
      cookie: kidCookie, body: { scope: 'this', etag: detail.event.etag, seriesEtag: null, event: { ...event, title: 'Dentist (Sam)' } },
    });
    expect(patched.status).toBe(204);
    const stale = await call(t.app, 'PATCH', `/api/panels/calendar/events/${id}`, {
      cookie: kidCookie, body: { scope: 'this', etag: detail.event.etag, seriesEtag: null, event: { ...event, title: 'Again' } },
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: { code: 'conflict', message: CALENDAR_CONFLICT_MESSAGE } });

    const fresh = (await (await call(t.app, 'GET', `/api/panels/calendar/events/${id}`, { cookie: kidCookie })).json()) as CalendarEventDetail;
    expect(fresh.event).toMatchObject({ title: 'Dentist (Sam)', updatedBy: { name: 'Riley' } });
    const deleted = await call(t.app, 'DELETE', `/api/panels/calendar/events/${id}?scope=this&etag=${encodeURIComponent(fresh.event.etag)}`, { cookie: kidCookie });
    expect(deleted.status).toBe(204);
    expect((await call(t.app, 'GET', `/api/panels/calendar/events/${id}`, { cookie: kidCookie })).status).toBe(404);
  });

  it('checks the CSRF headers, the window, and the form', async () => {
    const { t, admin, kidCookie } = setup();
    linkCalendarForTest(t, admin);
    expect((await call(t.app, 'POST', '/api/panels/calendar/events', { cookie: kidCookie, body: event, csrf: false })).status).toBe(403);
    const window = (q: string) => call(t.app, 'GET', `/api/panels/calendar/events?${q}`, { cookie: kidCookie });
    expect((await window('start=2026-11-01&end=2026-12-13')).status).toBe(200);
    for (const q of ['start=2026-11-01&end=2026-12-14', 'start=2026-11-10&end=2026-11-10', 'start=11/1/2026&end=2026-11-08', 'start=2026-11-01']) {
      expect((await window(q)).status, q).toBe(400);
    }
    const bad = await call(t.app, 'POST', '/api/panels/calendar/events', { cookie: kidCookie, body: { ...newEvent(), endTime: '08:00' } });
    expect(await bad.json()).toEqual({ error: { code: 'validation', message: 'The end has to be after the start' } });
    for (const id of ['bad%20id', '..', '.', '...']) {
      expect((await call(t.app, 'GET', `/api/panels/calendar/events/${id}`, { cookie: kidCookie })).status, id).toBe(404);
    }
    expect(t.fakeGoogleCalendar.requests.filter((r) => r.method === 'GET' && !r.path.endsWith('/events'))).toEqual([]);
  });

  it('asks only for windows from 1970 to 2100, and limits refreshes past the cache to 20 a minute per person (R4-M4)', async () => {
    const { t, admin, kidCookie } = setup();
    linkCalendarForTest(t, admin);
    const window = (q: string, cookie = kidCookie) => call(t.app, 'GET', `/api/panels/calendar/events?${q}`, { cookie });
    expect((await window('start=1970-01-01&end=1970-01-08')).status).toBe(200);
    expect((await window('start=2100-12-25&end=2101-01-01')).status).toBe(200);
    for (const q of ['start=1969-12-31&end=1970-01-07', 'start=2101-01-01&end=2101-01-08', 'start=0001-01-01&end=0001-01-08', 'start=9999-12-25&end=9999-12-31']) {
      expect((await window(q)).status, q).toBe(400);
    }
    for (let i = 0; i < 20; i++) expect((await window('start=2026-11-15&end=2026-11-22&refresh=1')).status).toBe(200);
    expect((await window('start=2026-11-15&end=2026-11-22&refresh=1')).status).toBe(429);
    // Without refresh=1, and for someone else, it still answers.
    expect((await window('start=2026-11-15&end=2026-11-22')).status).toBe(200);
    expect((await window('start=2026-11-15&end=2026-11-22&refresh=1', cookieFor(t.db, t.clock, admin))).status).toBe(200);
    t.clock.advance(60_000);
    expect((await window('start=2026-11-15&end=2026-11-22&refresh=1')).status).toBe(200);
  });

  it('limits window reads, the card included, to 120 a minute per person (C-M7)', async () => {
    const { t, admin, kidCookie } = setup();
    linkCalendarForTest(t, admin);
    const read = (path: string, cookie = kidCookie) => call(t.app, 'GET', `/api/panels/calendar/${path}`, { cookie });
    for (let i = 0; i < 60; i++) expect((await read('events?start=2026-11-15&end=2026-11-22')).status).toBe(200);
    for (let i = 0; i < 60; i++) expect((await read('summary')).status).toBe(200);
    const limited = await read('events?start=2026-11-15&end=2026-11-22');
    expect(limited.status).toBe(429);
    expect(((await limited.json()) as { error: { code: string } }).error.code).toBe('rate_limited');
    expect((await read('summary')).status).toBe(429);
    // Someone else still gets theirs, and the limit resets after a minute.
    expect((await read('summary', cookieFor(t.db, t.clock, admin))).status).toBe(200);
    t.clock.advance(60_000);
    expect((await read('summary')).status).toBe(200);
  });

  it("creates with the id the browser chose, so the same Save sent twice is one event (I1)", async () => {
    const { t, admin, kidCookie } = setup();
    const { calendar } = linkCalendarForTest(t, admin);
    const id = '0123456789abcdefghijklmnop';
    const first = await call(t.app, 'POST', '/api/panels/calendar/events', { cookie: kidCookie, body: { ...event, id } });
    const again = await call(t.app, 'POST', '/api/panels/calendar/events', { cookie: kidCookie, body: { ...event, id } });
    expect([first.status, again.status]).toEqual([201, 201]);
    expect(await again.json()).toMatchObject({ id, title: 'Dentist' });
    expect(t.fakeGoogleCalendar.storedEvents(calendar)).toHaveLength(1);
    for (const bad of [undefined, 'short', 'UPPERCASE0123456789ABCDEFG', '0123456789abcdefghijklmnow', 42]) {
      const res = await call(t.app, 'POST', '/api/panels/calendar/events', { cookie: kidCookie, body: { ...event, id: bad } });
      expect(await res.json(), String(bad)).toEqual({ error: { code: 'validation', message: 'The new event is missing its id' } });
    }
  });

  it("refuses changes plainly when the calendar isn't connected or needs reconnecting", async () => {
    const { t, admin, kidCookie } = setup();
    const notLinked = await call(t.app, 'POST', '/api/panels/calendar/events', { cookie: kidCookie, body: newEvent() });
    expect(notLinked.status).toBe(503);
    expect(await notLinked.json()).toEqual({ error: { code: 'integration_unavailable', message: CALENDAR_MESSAGES.notConnected } });
    linkCalendarForTest(t, admin);
    t.db.update(connections).set({ status: 'needs_reconnect' }).run();
    const res = await call(t.app, 'POST', '/api/panels/calendar/events', { cookie: kidCookie, body: newEvent() });
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(CALENDAR_MESSAGES.reconnect);
  });
});

describe('the Calendar jobs', () => {
  it('refresh the summary window every 5 minutes, after up to 75 seconds of jitter', async () => {
    const { t, admin } = setup();
    linkCalendarForTest(t, admin);
    const job = panelJobs(t).find((j) => j.name === 'calendar.refreshSummary')!;
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    await runJob(t, job);
    random.mockRestore();
    expect(t.fakeGoogleCalendar.requests.filter((r) => r.path.endsWith('/events'))).toHaveLength(1);
    // Stopping the app ends the wait, and the run, early.
    const stopped = new AbortController();
    stopped.abort();
    await runJob(t, job, stopped.signal);
    expect(t.fakeGoogleCalendar.requests.filter((r) => r.path.endsWith('/events'))).toHaveLength(1);
  });

  it('record a failed refresh, and a revocation given up on, for the System page', async () => {
    const { t, admin } = setup();
    linkCalendarForTest(t, admin);
    const job = (name: string) => panelJobs(t).find((j) => j.name === name)!;
    vi.spyOn(Math, 'random').mockReturnValue(0);
    t.fakeGoogleCalendar.failures.push(...[1, 2, 3].map(() => ({ path: 'list' as const, status: 503 })));
    await runJob(t, job('calendar.refreshSummary'));
    vi.restoreAllMocks();
    expect(recentJobErrors(t.db, 10)).toMatchObject([{ job: 'calendar.refreshSummary', message: CALENDAR_MESSAGES.unreachable }]);

    t.fakeGoogleCalendar.failures.push(...Array.from({ length: REVOCATION_ATTEMPTS + 1 }, () => ({ path: 'revoke' as const, status: 503 })));
    await t.calendar.disconnect(admin);
    for (let i = 0; i < REVOCATION_ATTEMPTS; i++) await runJob(t, job('calendar.revocations'));
    expect(recentJobErrors(t.db, 10).find((e) => e.job === 'calendar.revocations')?.message).toMatch(/^Gave up revoking the dashboard's Google Calendar access/);
  });

  it('shows a revocation given up on as a lasting System warning that an admin can dismiss (R2-I3)', async () => {
    const { t, admin, kidCookie } = setup();
    const { account } = linkCalendarForTest(t, admin);
    t.fakeGoogleCalendar.failures.push(...Array.from({ length: REVOCATION_ATTEMPTS + 1 }, () => ({ path: 'revoke' as const, status: 503 })));
    await t.calendar.disconnect(admin);
    for (let i = 0; i < REVOCATION_ATTEMPTS; i++) await t.calendar.retryRevocations();
    const adminCookie = cookieFor(t.db, t.clock, admin);
    const system = (await (await call(t.app, 'GET', '/api/admin/system', { cookie: adminCookie })).json()) as SystemInfo;
    expect(system.warnings).toEqual([]);
    expect(system.revocationNotices).toEqual([{ id: expect.any(Number), message: expect.stringContaining(`Remove the dashboard's access in ${account.email}'s Google account settings.`) }]);
    const id = system.revocationNotices[0]!.id;
    const path = `/api/admin/panels/calendar/revocations/${id}/dismiss`;
    expect((await call(t.app, 'POST', path, { cookie: kidCookie })).status).toBe(403);
    expect((await call(t.app, 'POST', path, { cookie: adminCookie, csrf: false })).status).toBe(403);
    expect((await call(t.app, 'POST', '/api/admin/panels/calendar/revocations/x/dismiss', { cookie: adminCookie })).status).toBe(404);
    expect((await call(t.app, 'POST', path, { cookie: adminCookie })).status).toBe(204);
    expect((await call(t.app, 'POST', path, { cookie: adminCookie })).status).toBe(404);
    const after = (await (await call(t.app, 'GET', '/api/admin/system', { cookie: adminCookie })).json()) as SystemInfo;
    expect(after.revocationNotices).toEqual([]);
  });
});
