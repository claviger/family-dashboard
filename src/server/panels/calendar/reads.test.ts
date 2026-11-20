import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { CALENDAR_CACHE_MS } from '../../../shared/calendar.js';
import { calendarCache, connections, users } from '../../db/schema.js';
import { singleKeyring } from '../../core/crypto.js';
import { GoogleCalendar } from '../../integrations/google/calendar.js';
import { getInstallId, setFamilySettings } from '../../settings.js';
import { addUser, linkCalendarForTest, makeTestApp, TEST_ENCRYPTION_KEY } from '../../test/helpers.js';
import { CACHE_KEEP_MS, CalendarService } from './service.js';

/** The test clock starts at 2026-11-15T12:00Z: 04:00 on Sunday, November 15 in Los Angeles. */
function setup(opts: Parameters<typeof makeTestApp>[0] = {}) {
  const t = makeTestApp(opts);
  setFamilySettings(t.db, { name: 'Test', timeZone: 'America/Los_Angeles' });
  const admin = addUser(t.db, t.clock, { email: 'alex@example.com', displayName: 'Alex', role: 'admin', panels: ['calendar'] });
  return { t, admin, service: t.calendarEvents };
}

function listRequests(t: ReturnType<typeof makeTestApp>) {
  return t.fakeGoogleCalendar.requests.filter((r) => r.method === 'GET' && r.path.endsWith('/events'));
}

const at = (date: string, time: string) => ({ dateTime: `${date}T${time}:00-08:00` });

describe('reading a window', () => {
  it('says the calendar is not connected, without calling Google', async () => {
    const { t, service } = setup();
    expect(await service.summary()).toMatchObject({
      start: '2026-11-15', end: '2026-11-22', today: '2026-11-15', timeZone: 'America/Los_Angeles', events: [],
      freshness: { connected: false, calendarName: null, status: null, readOnly: null, fetchedAt: null },
    });
    expect(t.fakeGoogleCalendar.requests).toEqual([]);
  });

  it("fetches a day wider in the family zone, keeps the window's events in order, and caches them for 5 minutes", async () => {
    const { t, admin, service } = setup();
    const { calendar } = linkCalendarForTest(t, admin);
    t.fakeGoogleCalendar.addEvent(calendar, { summary: 'Soccer', start: at('2026-11-16', '17:00'), end: at('2026-11-16', '18:00') });
    t.fakeGoogleCalendar.addEvent(calendar, { summary: 'Before', start: at('2026-11-14', '17:00'), end: at('2026-11-14', '18:00') });
    t.fakeGoogleCalendar.addEvent(calendar, { summary: 'Thanksgiving trip', start: { date: '2026-11-16' }, end: { date: '2026-11-18' } });
    const first = await service.summary();
    expect(first.events.map((e) => e.title)).toEqual(['Thanksgiving trip', 'Soccer']);
    expect(first.freshness).toMatchObject({ connected: true, calendarName: 'Family', status: 'ok', readOnly: null, fetchedAt: '2026-11-15T12:00:00.000Z' });
    expect(listRequests(t)[0]!.query).toMatchObject({ timeMin: '2026-11-14T08:00:00.000Z', timeMax: '2026-11-23T08:00:00.000Z', timeZone: 'America/Los_Angeles' });

    t.clock.advance(CALENDAR_CACHE_MS - 1);
    await service.summary();
    expect(listRequests(t)).toHaveLength(1);
    t.clock.advance(1);
    expect((await service.summary()).freshness.fetchedAt).toBe('2026-11-15T12:05:00.000Z');
    expect(listRequests(t)).toHaveLength(2);
    await service.window('2026-11-15', '2026-11-22', { refresh: true });
    expect(listRequests(t)).toHaveLength(3);
  });

  it('shares one request among callers asking for the same window at once', async () => {
    const { t, admin, service } = setup();
    linkCalendarForTest(t, admin);
    await Promise.all([service.summary(), service.summary(), service.window('2026-11-15', '2026-11-22')]);
    expect(listRequests(t)).toHaveLength(1);
  });

  it("places all-day events by their date when the calendar's zone differs from the family's", async () => {
    const { t, admin, service } = setup();
    const account = t.fakeGoogleCalendar.createAccount();
    const tokyo = t.fakeGoogleCalendar.addCalendar(account, { summary: 'Family', timeZone: 'Asia/Tokyo' });
    linkCalendarForTest(t, admin, { account, calendar: tokyo });
    for (const date of ['2026-11-14', '2026-11-15', '2026-11-21', '2026-11-22']) {
      t.fakeGoogleCalendar.addEvent(tokyo, { summary: date, start: { date }, end: { date: date.replace(/\d\d$/, (d) => String(Number(d) + 1)) } });
    }
    expect((await service.summary()).events.map((e) => e.title)).toEqual(['2026-11-15', '2026-11-21']);
  });

  it('names who added and edited an event as they are named now, deactivated people included', async () => {
    const { t, admin, service } = setup();
    const { calendar } = linkCalendarForTest(t, admin);
    const kid = addUser(t.db, t.clock, { email: 'kid@example.com', displayName: 'Riley' });
    t.fakeGoogleCalendar.addEvent(calendar, { summary: 'Band', start: at('2026-11-16', '15:00'), end: at('2026-11-16', '16:00'), extendedProperties: { private: { dashboardCreatedBy: `${getInstallId(t.db)}:${kid}`, dashboardUpdatedBy: `${getInstallId(t.db)}:${admin}` } } });
    t.fakeGoogleCalendar.addEvent(calendar, { summary: 'Stranger', start: at('2026-11-16', '17:00'), end: at('2026-11-16', '18:00'), extendedProperties: { private: { dashboardCreatedBy: `${getInstallId(t.db)}:999` } } });
    await service.summary();
    t.db.update(users).set({ displayName: 'Rory', active: false }).where(eq(users.id, kid)).run();
    const { events } = await service.summary(); // from the cache
    expect(events.map((e) => [e.title, e.createdBy, e.updatedBy])).toEqual([
      ['Band', { id: kid, name: 'Rory' }, { id: admin, name: 'Alex' }],
      ['Stranger', null, null],
    ]);
  });

  it('serves the last good result read-only when Google is down, and nothing when there is none', async () => {
    const { t, admin, service } = setup();
    const { calendar } = linkCalendarForTest(t, admin);
    t.fakeGoogleCalendar.failures.push(...[1, 2, 3].map(() => ({ path: 'list' as const, status: 503 })));
    expect(await service.summary()).toMatchObject({ events: [], freshness: { readOnly: 'unreachable', fetchedAt: null } });
    t.fakeGoogleCalendar.addEvent(calendar, { summary: 'Dentist', start: at('2026-11-17', '09:00'), end: at('2026-11-17', '10:00') });
    await service.summary();
    t.clock.advance(CALENDAR_CACHE_MS);
    t.fakeGoogleCalendar.failures.push(...[1, 2, 3].map(() => ({ path: 'list' as const, status: 503 })));
    expect(await service.summary()).toMatchObject({ events: [{ title: 'Dentist' }], freshness: { readOnly: 'unreachable', fetchedAt: '2026-11-15T12:00:00.000Z' } });
  });

  it('serves the cache marked unreachable when Google refuses the read for a reason not about the connection (R3-M)', async () => {
    const { t, admin, service } = setup();
    const { calendar: cal } = linkCalendarForTest(t, admin);
    t.fakeGoogleCalendar.addEvent(cal, { summary: 'Dentist', start: at('2026-11-17', '09:00'), end: at('2026-11-17', '10:00') });
    await service.summary();
    t.fakeGoogleCalendar.failures.push({ path: 'list', status: 400, body: { error: { code: 400, errors: [{ reason: 'badRequest' }] } } });
    expect(await service.window('2026-11-15', '2026-11-22', { refresh: true })).toMatchObject({ events: [{ title: 'Dentist' }], freshness: { readOnly: 'unreachable' } });
  });

  it('serves the cache read-only, without calling Google, while the link needs reconnecting or the key is wrong', async () => {
    const { t, admin, service } = setup();
    const { calendar } = linkCalendarForTest(t, admin);
    t.fakeGoogleCalendar.addEvent(calendar, { summary: 'Dentist', start: at('2026-11-17', '09:00'), end: at('2026-11-17', '10:00') });
    await service.summary();
    t.db.update(connections).set({ status: 'needs_reconnect' }).run();
    const calls = t.fakeGoogleCalendar.requests.length;
    expect(await service.window('2026-11-15', '2026-11-22', { refresh: true })).toMatchObject({ events: [{ title: 'Dentist' }], freshness: { readOnly: 'needs_reconnect', status: 'needs_reconnect' } });

    const mismatched = setup({ keyMismatch: true });
    linkCalendarForTest(mismatched.t, mismatched.admin);
    expect(await mismatched.service.summary()).toMatchObject({ events: [], freshness: { connected: true, readOnly: 'key_mismatch' } });
    expect(mismatched.t.fakeGoogleCalendar.requests).toEqual([]);
    expect(t.fakeGoogleCalendar.requests).toHaveLength(calls);
  });

  it('keeps the last good result across a restart, and a dashboard write makes every window fetch again', async () => {
    const { t, admin, service } = setup();
    linkCalendarForTest(t, admin);
    await service.summary();
    const restarted = new CalendarService({ db: t.db, clock: t.clock, logger: t.logger, provider: t.calendar });
    await restarted.summary();
    expect(listRequests(t)).toHaveLength(1);
    restarted.invalidate();
    expect(t.db.select().from(calendarCache).get()).toMatchObject({ stale: true });
    await restarted.summary();
    expect(listRequests(t)).toHaveLength(2);
  });

  it("keeps the calendar's time zone up to date from Google's answers, and a new family zone is a new window", async () => {
    const { t, admin, service } = setup();
    const { calendar } = linkCalendarForTest(t, admin);
    calendar.timeZone = 'America/Denver';
    await service.summary();
    expect(t.calendar.state()).toMatchObject({ meta: { calendarTimeZone: 'America/Denver' } });
    setFamilySettings(t.db, { name: 'Test', timeZone: 'America/New_York' });
    expect((await service.summary()).timeZone).toBe('America/New_York');
    expect(listRequests(t)).toHaveLength(2);
    expect(t.db.select().from(calendarCache).all()).toHaveLength(2);
  });
});

describe('fetches that overlap a write, a disconnect, or a slow Google', () => {
  /** A fetch to Google's events list that waits until the test releases it. */
  function gatedList(t: ReturnType<typeof makeTestApp>) {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetch: typeof globalThis.fetch = async (input, init) => {
      if (new URL(input instanceof Request ? input.url : String(input)).pathname.endsWith('/events')) await gate;
      return t.fakeGoogleCalendar.fetch(input, init);
    };
    return { fetch, release };
  }

  function serviceWith(t: ReturnType<typeof makeTestApp>, fetch: typeof globalThis.fetch, readWaitMs?: number) {
    const calendar = new GoogleCalendar({
      db: t.db, clock: t.clock, logger: t.logger, keyring: singleKeyring(TEST_ENCRYPTION_KEY), fetch, clientOptions: { sleep: async () => {} },
      google: { clientId: t.config.googleClientId, clientSecret: t.config.googleClientSecret, endpoints: t.config.googleEndpoints },
    });
    return { calendar, service: new CalendarService({ db: t.db, clock: t.clock, logger: t.logger, provider: calendar, readWaitMs }) };
  }

  it('saves a fetch that started before a dashboard write as stale, and a later read fetches again', async () => {
    const { t, admin } = setup();
    linkCalendarForTest(t, admin);
    const gate = gatedList(t);
    const { service } = serviceWith(t, gate.fetch);
    const refreshing = service.refreshSummary();
    await new Promise((r) => setTimeout(r, 10));
    service.invalidate(); // a dashboard write lands while the fetch is out
    gate.release();
    await refreshing;
    expect(t.db.select().from(calendarCache).get()).toMatchObject({ stale: true });
    await service.summary();
    expect(t.db.select().from(calendarCache).get()).toMatchObject({ stale: false });
    expect(listRequests(t)).toHaveLength(2);
  });

  it('fetches again before serving a read whose fetch overlapped a dashboard write (C-I1)', async () => {
    const { t, admin } = setup();
    linkCalendarForTest(t, admin);
    const gate = gatedList(t);
    const { service } = serviceWith(t, gate.fetch);
    const reading = service.summary();
    await new Promise((r) => setTimeout(r, 10));
    service.invalidate();
    gate.release();
    expect((await reading).freshness.readOnly).toBeNull();
    expect(listRequests(t)).toHaveLength(2);
    expect(t.db.select().from(calendarCache).get()).toMatchObject({ stale: false });
  });

  it("doesn't cache a fetch whose link was disconnected while it was out", async () => {
    const { t, admin } = setup();
    linkCalendarForTest(t, admin);
    const gate = gatedList(t);
    const { calendar, service } = serviceWith(t, gate.fetch);
    const reading = service.summary();
    await new Promise((r) => setTimeout(r, 10));
    await calendar.disconnect(admin);
    gate.release();
    await reading;
    expect(t.db.select().from(calendarCache).all()).toEqual([]);
  });

  it('never lets a fetch replace a newer one that finished first (R3-M)', async () => {
    const { t, admin } = setup();
    const { calendar: cal } = linkCalendarForTest(t, admin);
    const e = t.fakeGoogleCalendar.addEvent(cal, { summary: 'Old', start: at('2026-11-17', '09:00'), end: at('2026-11-17', '10:00') });
    // The older fetch has its answer, then is held on the way back.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow: typeof globalThis.fetch = async (input, init) => {
      const res = await t.fakeGoogleCalendar.fetch(input, init);
      if (new URL(input instanceof Request ? input.url : String(input)).pathname.endsWith('/events')) await gate;
      return res;
    };
    const { service: older } = serviceWith(t, slow);
    const reading = older.window('2026-11-15', '2026-11-22', { refresh: true });
    await new Promise((r) => setTimeout(r, 10));
    t.fakeGoogleCalendar.editEvent(cal, String(e.id), { summary: 'New' });
    t.clock.advance(1_000);
    await t.calendarEvents.window('2026-11-15', '2026-11-22', { refresh: true });
    release();
    await reading;
    expect(t.db.select().from(calendarCache).get()!.events.map((x) => x.title)).toEqual(['New']);
  });

  /** Window fetches that have their answer from the fake, then wait on the way back until released, in order. */
  function heldLists(t: ReturnType<typeof makeTestApp>) {
    const held: Array<() => void> = [];
    let hold = true;
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const res = await t.fakeGoogleCalendar.fetch(input, init);
      const listing = (init?.method ?? 'GET') === 'GET' && new URL(input instanceof Request ? input.url : String(input)).pathname.endsWith('/events');
      if (hold && listing) await new Promise<void>((r) => held.push(r));
      return res;
    };
    return { fetch, held, setHold: (on: boolean) => (hold = on) };
  }
  const tick = () => new Promise((r) => setTimeout(r, 20));

  it.each([
    ['the clock moving between them', 1_000],
    ['the same clock time for both', 0],
  ])('never serves what was fetched before a write as fresh: A starts, write, B starts, A lands, B lands (C-I1), %s', async (_, step) => {
    const { t, admin } = setup();
    const { calendar: cal } = linkCalendarForTest(t, admin);
    t.fakeGoogleCalendar.addEvent(cal, { summary: 'Old', start: at('2026-11-16', '09:00'), end: at('2026-11-16', '10:00') });
    const lists = heldLists(t);
    const { service } = serviceWith(t, lists.fetch, 5_000);
    const titles = (w: { events: { title: string }[] }) => w.events.map((e) => e.title);

    const a = service.window('2026-11-15', '2026-11-22', { refresh: true }); // A has its answer: Old only
    await tick();
    t.clock.advance(step);
    t.fakeGoogleCalendar.addEvent(cal, { summary: 'New', start: at('2026-11-17', '09:00'), end: at('2026-11-17', '10:00') });
    service.invalidate(); // the dashboard write that added New
    t.clock.advance(step);
    const b = service.window('2026-11-15', '2026-11-22'); // B, after the write: Old and New
    await tick();
    expect(lists.held).toHaveLength(2);
    lists.setHold(false);
    t.clock.advance(step);
    lists.held[0]!(); // A lands first
    await tick();
    lists.held[1]!(); // then B

    const bw = await b;
    expect(titles(bw)).toEqual(['Old', 'New']);
    expect(bw.freshness.readOnly).toBeNull();
    // A asked before the write, but what it fetched is older than the write: it's not served as fresh either.
    const aw = await a;
    expect(aw.freshness.readOnly === null ? titles(aw) : 'not fresh').toEqual(['Old', 'New']);
    expect(t.db.select().from(calendarCache).all().map((r) => ({ stale: r.stale, titles: r.events.map((e) => e.title) }))).toEqual([{ stale: false, titles: ['Old', 'New'] }]);
    // And the next read is served from that cache, without asking Google again.
    const before = listRequests(t).length;
    expect(titles(await service.window('2026-11-15', '2026-11-22'))).toEqual(['Old', 'New']);
    expect(listRequests(t)).toHaveLength(before);
  });

  it('keeps saving fetches after a restart, when the saved rows were fetched at a later write count (C-I1)', async () => {
    const { t, admin, service } = setup();
    const { calendar: cal } = linkCalendarForTest(t, admin);
    for (let i = 0; i < 3; i++) service.invalidate();
    await service.window('2026-11-15', '2026-11-22');
    t.fakeGoogleCalendar.addEvent(cal, { summary: 'Later', start: at('2026-11-17', '09:00'), end: at('2026-11-17', '10:00') });
    t.clock.advance(CALENDAR_CACHE_MS);
    // A new process: its own service, over the same database.
    const restarted = new CalendarService({ db: t.db, clock: t.clock, logger: t.logger, provider: t.calendar });
    expect((await restarted.window('2026-11-15', '2026-11-22')).events.map((e) => e.title)).toEqual(['Later']);
    expect(t.db.select().from(calendarCache).get()!.events.map((e) => e.title)).toEqual(['Later']);
  });

  it('serves the cache, marked unreachable, when Google is slow, and lets the fetch finish in the background', async () => {
    const { t, admin } = setup();
    const { calendar: cal } = linkCalendarForTest(t, admin);
    t.fakeGoogleCalendar.addEvent(cal, { summary: 'Dentist', start: at('2026-11-17', '09:00'), end: at('2026-11-17', '10:00') });
    await t.calendarEvents.summary();
    t.fakeGoogleCalendar.addEvent(cal, { summary: 'Piano', start: at('2026-11-18', '15:00'), end: at('2026-11-18', '16:00') });
    t.clock.advance(CALENDAR_CACHE_MS);
    const gate = gatedList(t);
    const { service } = serviceWith(t, gate.fetch, 20);
    expect(await service.summary()).toMatchObject({ events: [{ title: 'Dentist' }], freshness: { readOnly: 'unreachable' } });
    gate.release();
    await new Promise((r) => setTimeout(r, 50));
    expect(t.db.select().from(calendarCache).get()!.events.map((e) => e.title)).toEqual(['Dentist', 'Piano']);
  });
});

describe('refreshSummary', () => {
  it('fetches the summary window even when it is fresh, and prunes windows nobody looked at for a week', async () => {
    const { t, admin, service } = setup();
    linkCalendarForTest(t, admin);
    await service.window('2026-10-01', '2026-10-08');
    t.clock.advance(CACHE_KEEP_MS + 1);
    await service.summary();
    expect(await service.refreshSummary()).toBe('fetched');
    expect(listRequests(t)).toHaveLength(3);
    expect(t.db.select().from(calendarCache).all().map((r) => r.windowStart)).toEqual(['2026-11-22']);
  });

  it("doesn't prune while the link isn't ok, so the last good results stay (R3-M)", async () => {
    const { t, admin, service } = setup();
    linkCalendarForTest(t, admin);
    await service.window('2026-10-01', '2026-10-08');
    t.clock.advance(CACHE_KEEP_MS + 1);
    for (const status of ['needs_reconnect', 'error'] as const) {
      t.db.update(connections).set({ status }).run();
      t.fakeGoogleCalendar.failures.push(...[1, 2, 3].map(() => ({ path: 'list' as const, status: 503 })));
      await service.refreshSummary().catch(() => {});
      expect(t.db.select().from(calendarCache).all().map((r) => r.windowStart), status).toEqual(['2026-10-01']);
    }
  });

  it('skips quietly with nothing to fetch, and throws when Google is down', async () => {
    const { t, admin, service } = setup();
    expect(await service.refreshSummary()).toBe('skipped');
    linkCalendarForTest(t, admin);
    t.fakeGoogleCalendar.failures.push(...[1, 2, 3].map(() => ({ path: 'list' as const, status: 503 })));
    await expect(service.refreshSummary()).rejects.toMatchObject({ code: 'integration_unavailable' });
    t.db.update(connections).set({ status: 'needs_reconnect' }).run();
    expect(await service.refreshSummary()).toBe('skipped');
  });
});
