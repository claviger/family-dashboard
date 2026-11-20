import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { CALENDAR_CONFLICT_MESSAGE, CALENDAR_EVENT_GONE, eventIdFromBytes, type CalendarEventInput } from '../../../shared/calendar.js';
import { singleKeyring } from '../../core/crypto.js';
import { calendarCache, connections } from '../../db/schema.js';
import { addDays } from '../../../shared/dates.js';
import { CALENDAR_MESSAGES, GoogleCalendar } from '../../integrations/google/calendar.js';
import { getInstallId, setFamilySettings } from '../../settings.js';
import { GOOGLE_ERRORS } from '../../test/fakeGoogleCalendar.js';
import { addUser, linkCalendarForTest, makeTestApp, TEST_ENCRYPTION_KEY } from '../../test/helpers.js';
import { newEventId } from './edits.js';
import { CALENDAR_WRITE_MESSAGES, CalendarService, SERIES_MOVE_BLOCKED } from './service.js';

const LA = 'America/Los_Angeles';
const TOKYO = 'Asia/Tokyo';
const at = (date: string, time: string) => ({ dateTime: `${date}T${time}:00-08:00`, timeZone: LA });

function setup(opts: Parameters<typeof makeTestApp>[0] = {}) {
  const t = makeTestApp(opts);
  setFamilySettings(t.db, { name: 'Test', timeZone: LA });
  const grant = addUser(t.db, t.clock, { email: 'alex@example.com', displayName: 'Alex', role: 'admin', panels: ['calendar'] });
  const kid = addUser(t.db, t.clock, { email: 'kid@example.com', displayName: 'Riley', panels: ['calendar'] });
  const { calendar } = linkCalendarForTest(t, grant);
  /** What `dashboardCreatedBy` and `dashboardUpdatedBy` hold for a user of this install. */
  const by = (userId: number) => `${getInstallId(t.db)}:${userId}`;
  return { t, grant, kid, cal: calendar, service: t.calendarEvents, fake: t.fakeGoogleCalendar, by };
}

/** Collects log lines, parsed. */
function logLines() {
  const lines: Record<string, unknown>[] = [];
  return { lines, logger: pino({ level: 'debug' }, { write: (l: string) => void lines.push(JSON.parse(l) as Record<string, unknown>) }) };
}

/** A service whose Google calls go through `fetch`, for changes that land between two of them. */
function serviceWith(s: ReturnType<typeof setup>, fetch: typeof globalThis.fetch) {
  const { t } = s;
  const calendar = new GoogleCalendar({
    db: t.db, clock: t.clock, logger: t.logger, keyring: singleKeyring(TEST_ENCRYPTION_KEY), fetch, clientOptions: { sleep: async () => {} },
    google: { clientId: t.config.googleClientId, clientSecret: t.config.googleClientSecret, endpoints: t.config.googleEndpoints },
  });
  return new CalendarService({ db: t.db, clock: t.clock, logger: t.logger, provider: calendar });
}

/** A new event's form, with the id the browser picks when the form opens. */
function newEvent(fields: Partial<CalendarEventInput> = {}) {
  return { ...form(fields), id: newEventId() };
}

function form(fields: Partial<CalendarEventInput> = {}): CalendarEventInput {
  return { title: 'Dentist', allDay: false, startDate: '2026-11-20', endDate: '2026-11-20', startTime: '09:00', endTime: '10:00', location: null, description: null, ...fields };
}

/** The form as the person would see it for an event the panel returned. */
function formOf(e: { title: string; allDay: boolean; startDate: string; endDate: string; startTime: string | null; endTime: string | null; location: string | null; description: string | null }): CalendarEventInput {
  return { title: e.title, allDay: e.allDay, startDate: e.startDate, endDate: e.endDate, startTime: e.startTime, endTime: e.endTime, location: e.location, description: e.description };
}

function writes(t: ReturnType<typeof makeTestApp>) {
  return t.fakeGoogleCalendar.requests.filter((r) => r.method !== 'GET').map((r) => ({ method: r.method, path: r.path.replace(/^.*\/events/, ''), body: r.body, ifMatch: r.ifMatch }));
}

/** A weekly Tuesday 4pm series from November 3, 2026. */
function weekly(s: ReturnType<typeof setup>, recurrence = ['RRULE:FREQ=WEEKLY;BYDAY=TU'], fields: Record<string, unknown> = {}) {
  return s.fake.addEvent(s.cal, { id: 'swim0001', summary: 'Swim', recurrence, start: at('2026-11-03', '16:00'), end: at('2026-11-03', '17:00'), ...fields });
}

/** The first instance in a window, its detail, and an "All events" edit through it. */
async function allEvents(s: ReturnType<typeof setup>, start = '2026-11-15', end = '2026-11-22') {
  const instance = (await s.service.window(start, end, { refresh: true })).events[0]!;
  const detail = await s.service.detail(instance.id);
  const edit = (fields: Partial<CalendarEventInput>, userId = s.grant) => s.service.update(userId, instance.id, {
    scope: 'all', etag: detail.event.etag, seriesEtag: detail.series!.etag, event: { ...formOf(detail.event), repeat: detail.series!.repeat, ...fields },
  });
  return { instance, ...detail, edit };
}

describe('creating', () => {
  it("sends only the dashboard's fields, with its own id, both an offset and a zone, and who added it", async () => {
    const s = setup();
    const event = await s.service.create(s.kid, newEvent({ location: ' Main St ' }));
    const [insert] = writes(s.t);
    expect(insert).toEqual({
      method: 'POST', path: '', ifMatch: null,
      body: {
        id: expect.stringMatching(/^[a-v0-9]{26}$/), summary: 'Dentist', location: 'Main St',
        start: { dateTime: '2026-11-20T09:00:00-08:00', timeZone: LA }, end: { dateTime: '2026-11-20T10:00:00-08:00', timeZone: LA },
        extendedProperties: { private: { dashboardCreatedBy: s.by(s.kid) } },
      },
    });
    expect(event).toMatchObject({ title: 'Dentist', location: 'Main St', startTime: '09:00', createdBy: { id: s.kid, name: 'Riley' }, updatedBy: null });
  });

  it("writes an all-day event's end as Google's exclusive date", async () => {
    const s = setup();
    const event = await s.service.create(s.kid, newEvent({ title: 'Grandma visits', allDay: true, startDate: '2026-11-26', endDate: '2026-11-28', startTime: null, endTime: null }));
    expect(writes(s.t)[0]!.body).toMatchObject({ start: { date: '2026-11-26' }, end: { date: '2026-11-29' } });
    expect(event).toMatchObject({ allDay: true, startDate: '2026-11-26', endDate: '2026-11-28' });
  });

  it('writes a repeat as an RRULE, which Google expands into instances', async () => {
    const s = setup();
    await s.service.create(s.kid, newEvent({ title: 'Piano', startDate: '2026-11-16', endDate: '2026-11-16', startTime: '15:00', endTime: '15:30', repeat: { freq: 'weekly', weekdays: ['MO', 'TH'], end: { type: 'on', date: '2026-11-30' } } }));
    expect(writes(s.t)[0]!.body).toMatchObject({ recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO,TH;UNTIL=20261201T075959Z'] });
    const { events } = await s.service.window('2026-11-15', '2026-12-06');
    expect(events.map((e) => e.startDate)).toEqual(['2026-11-16', '2026-11-19', '2026-11-23', '2026-11-26', '2026-11-30']);
    expect(new Set(events.map((e) => e.seriesId)).size).toBe(1);
  });

  it('recognizes its own event when an answer was lost and the client retried the call', async () => {
    const s = setup();
    s.fake.loseNextResponse = 'insert';
    const event = await s.service.create(s.kid, newEvent());
    expect(s.fake.storedEvents(s.cal)).toHaveLength(1);
    expect(event).toMatchObject({ title: 'Dentist', createdBy: { id: s.kid } });
  });

  it("uses the id the browser chose, so a Save sent twice makes one event (I1)", async () => {
    const s = setup();
    const id = eventIdFromBytes(new Uint8Array(16).fill(7));
    const first = await s.service.create(s.kid, { ...form(), id });
    // The browser never saw the answer, and the person pressed Save again.
    const again = await s.service.create(s.kid, { ...form(), id });
    expect(first.id).toBe(id);
    expect(again).toMatchObject({ id, title: 'Dentist', createdBy: { id: s.kid } });
    expect(s.fake.storedEvents(s.cal)).toHaveLength(1);
    // An id someone else's event already has is not read back as this person's: a plain 409 (R3-M).
    await expect(s.service.create(s.grant, { ...form(), id })).rejects.toMatchObject({ code: 'conflict', message: CALENDAR_WRITE_MESSAGES.idTaken });
    s.fake.addEvent(s.cal, { id: 'made0in0google0000000000aa', summary: 'Theirs', start: at('2026-11-20', '09:00'), end: at('2026-11-20', '10:00') });
    await expect(s.service.create(s.kid, { ...form(), id: 'made0in0google0000000000aa' })).rejects.toMatchObject({ code: 'conflict', message: CALENDAR_WRITE_MESSAGES.idTaken });
    expect(s.fake.event(s.cal, 'made0in0google0000000000aa')).toMatchObject({ summary: 'Theirs' });
  });

  it('makes every window fetch again after a write was tried, even one that failed (R3-M)', async () => {
    const s = setup();
    const created = await s.service.create(s.kid, newEvent());
    const stale = async () => {
      await s.service.window('2026-11-15', '2026-11-22', { refresh: true });
      expect(s.t.db.select().from(calendarCache).get()).toMatchObject({ stale: false });
    };
    await stale();
    // A patch whose answer didn't come back may have been applied.
    s.fake.failures.push({ path: 'patch', status: 500 });
    await expect(s.service.update(s.kid, created.id, { scope: 'this', etag: created.etag, seriesEtag: null, event: { ...formOf(created), title: 'x' } })).rejects.toBeDefined();
    expect(s.t.db.select().from(calendarCache).get()).toMatchObject({ stale: true });
    await stale();
    s.fake.failures.push(...[1, 2, 3].map(() => ({ path: 'insert' as const, status: 500 })));
    await expect(s.service.create(s.kid, newEvent())).rejects.toBeDefined();
    expect(s.t.db.select().from(calendarCache).get()).toMatchObject({ stale: true });
    await stale();
    s.fake.failures.push(...[1, 2, 3].map(() => ({ path: 'delete' as const, status: 500 })));
    await expect(s.service.delete(s.kid, created.id, { scope: 'this', etag: created.etag })).rejects.toBeDefined();
    expect(s.t.db.select().from(calendarCache).get()).toMatchObject({ stale: true });
    // Refused before anything was sent: nothing to mark.
    await stale();
    await expect(s.service.update(s.kid, created.id, { scope: 'this', etag: '"old"', seriesEtag: null, event: { ...formOf(created), title: 'x' } })).rejects.toMatchObject({ code: 'conflict' });
    expect(s.t.db.select().from(calendarCache).get()).toMatchObject({ stale: false });
  });

  it('makes every window fetch again', async () => {
    const s = setup();
    await s.service.summary();
    await s.service.create(s.kid, newEvent());
    expect(s.t.db.select().from(calendarCache).get()).toMatchObject({ stale: true });
    expect((await s.service.summary()).events.map((e) => e.title)).toEqual(['Dentist']);
  });
});

describe('editing one event', () => {
  it('patches only the fields that changed, with If-Match, and keeps who added it and everything else', async () => {
    const s = setup();
    const created = await s.service.create(s.kid, newEvent({ location: 'Main St', description: 'Bring the card' }));
    s.fake.editEvent(s.cal, created.id, { attendees: [{ email: 'sam@example.com' }], reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }] } });
    const { event } = await s.service.detail(created.id);
    await s.service.update(s.grant, created.id, { scope: 'this', etag: event.etag, seriesEtag: null, event: { ...formOf(event), title: 'Dentist (Sam)', location: '' } });
    expect(writes(s.t).at(-1)).toEqual({
      method: 'PATCH', path: `/${created.id}`, ifMatch: event.etag,
      body: { summary: 'Dentist (Sam)', location: null, extendedProperties: { private: { dashboardUpdatedBy: s.by(s.grant) } } },
    });
    const after = s.fake.event(s.cal, created.id)!;
    expect(after).toMatchObject({
      summary: 'Dentist (Sam)', description: 'Bring the card', attendees: [{ email: 'sam@example.com' }], reminders: { overrides: [{ minutes: 30 }] },
      extendedProperties: { private: { dashboardCreatedBy: s.by(s.kid), dashboardUpdatedBy: s.by(s.grant) } },
    });
    expect(after.location).toBeUndefined();
    expect((await s.service.detail(created.id)).event).toMatchObject({ createdBy: { name: 'Riley' }, updatedBy: { name: 'Alex' } });
  });

  it('moves an event between timed and all-day without leaving the other kind of time behind', async () => {
    const s = setup();
    const created = await s.service.create(s.kid, newEvent());
    const { event } = await s.service.detail(created.id);
    await s.service.update(s.kid, created.id, { scope: 'this', etag: event.etag, seriesEtag: null, event: { ...formOf(event), allDay: true, startTime: null, endTime: null } });
    expect(s.fake.event(s.cal, created.id)).toMatchObject({ start: { date: '2026-11-20' }, end: { date: '2026-11-21' } });
    expect((s.fake.event(s.cal, created.id)!.start as { dateTime?: string }).dateTime).toBeUndefined();
  });

  it('sends nothing when nothing changed', async () => {
    const s = setup();
    const created = await s.service.create(s.kid, newEvent());
    const before = writes(s.t).length;
    const { event } = await s.service.detail(created.id);
    await s.service.update(s.kid, created.id, { scope: 'this', etag: event.etag, seriesEtag: null, event: formOf(event) });
    expect(writes(s.t)).toHaveLength(before);
  });

  it('checks the order of the times only when they changed (M-6)', async () => {
    const s = setup();
    // Made in Google, ending when it starts.
    const g = s.fake.addEvent(s.cal, { summary: 'Reminder', start: at('2026-11-20', '09:00'), end: at('2026-11-20', '09:00') });
    const { event } = await s.service.detail(String(g.id));
    await s.service.update(s.kid, event.id, { scope: 'this', etag: event.etag, seriesEtag: null, event: { ...formOf(event), title: 'Call the school' } });
    expect(s.fake.event(s.cal, event.id)).toMatchObject({ summary: 'Call the school' });
    const fresh = (await s.service.detail(event.id)).event;
    await expect(s.service.update(s.kid, event.id, { scope: 'this', etag: fresh.etag, seriesEtag: null, event: { ...formOf(fresh), startTime: '10:00' } }))
      .rejects.toMatchObject({ code: 'validation', message: 'The end has to be after the start' });
  });

  it("never writes back a description Google keeps as HTML", async () => {
    const s = setup();
    const g = s.fake.addEvent(s.cal, { summary: 'Recital', description: '<b>Bring</b> flowers', start: at('2026-11-20', '18:00'), end: at('2026-11-20', '19:00') });
    const { event } = await s.service.detail(String(g.id));
    expect(event).toMatchObject({ description: 'Bring flowers', descriptionIsHtml: true });
    await s.service.update(s.kid, event.id, { scope: 'this', etag: event.etag, seriesEtag: null, event: { ...formOf(event), title: 'Recital!', description: 'something else' } });
    expect(writes(s.t).at(-1)!.body).toEqual({ summary: 'Recital!', extendedProperties: { private: { dashboardUpdatedBy: s.by(s.kid) } } });
    expect(s.fake.event(s.cal, event.id)!.description).toBe('<b>Bring</b> flowers');
  });

  it('adds a repeat to an event, sending its times with their zone', async () => {
    const s = setup();
    const created = await s.service.create(s.kid, newEvent());
    const { event } = await s.service.detail(created.id);
    await s.service.update(s.kid, created.id, { scope: 'this', etag: event.etag, seriesEtag: null, event: { ...formOf(event), repeat: { freq: 'daily', weekdays: [], end: { type: 'after', count: 3 } } } });
    expect(writes(s.t).at(-1)!.body).toMatchObject({ recurrence: ['RRULE:FREQ=DAILY;COUNT=3'], start: { timeZone: LA } });
    expect((await s.service.window('2026-11-20', '2026-11-27')).events).toHaveLength(3);
  });

  it("refuses read-only events without calling Google", async () => {
    const s = setup();
    const birthday = s.fake.addEvent(s.cal, { summary: 'Sam', eventType: 'birthday', start: { date: '2026-11-20' }, end: { date: '2026-11-21' } });
    const { event } = await s.service.detail(String(birthday.id));
    await expect(s.service.update(s.kid, event.id, { scope: 'this', etag: event.etag, seriesEtag: null, event: { ...formOf(event), title: 'x' } }))
      .rejects.toMatchObject({ code: 'validation', message: CALENDAR_WRITE_MESSAGES.readOnly });
    expect(writes(s.t)).toEqual([]);
  });
});

describe('conflicts (spec §9.6)', () => {
  it('catches an event that changed since the form was loaded, before writing', async () => {
    const { lines, logger } = logLines();
    const s = setup({ logger });
    const created = await s.service.create(s.kid, newEvent());
    const { event } = await s.service.detail(created.id);
    s.fake.editEvent(s.cal, created.id, { summary: 'Changed in Google' });
    const before = writes(s.t).length;
    await expect(s.service.update(s.kid, created.id, { scope: 'this', etag: event.etag, seriesEtag: null, event: { ...formOf(event), title: 'Mine' } }))
      .rejects.toMatchObject({ code: 'conflict', message: CALENDAR_CONFLICT_MESSAGE });
    await expect(s.service.delete(s.kid, created.id, { scope: 'this', etag: event.etag })).rejects.toMatchObject({ code: 'conflict' });
    expect(writes(s.t)).toHaveLength(before);
    expect(lines.filter((l) => l.msg === 'calendar edit conflict')).toMatchObject([{ caughtBy: 'precheck' }, { caughtBy: 'precheck' }]);
  });

  it("treats Google's 412 as the same conflict when the event really changed after the precheck", async () => {
    const { lines, logger } = logLines();
    const s = setup({ logger });
    const created = await s.service.create(s.kid, newEvent());
    const { event } = await s.service.detail(created.id);
    // Someone changes it in Google between the dashboard's read and its patch.
    const racing = serviceWith(s, async (input, init) => {
      if (init?.method === 'PATCH') s.fake.editEvent(s.cal, created.id, { summary: 'Changed in Google' });
      return s.fake.fetch(input, init);
    });
    await expect(racing.update(s.kid, created.id, { scope: 'this', etag: event.etag, seriesEtag: null, event: { ...formOf(event), title: 'Mine' } }))
      .rejects.toMatchObject({ code: 'conflict' });
    expect(lines.filter((l) => l.msg === 'calendar edit conflict')).toMatchObject([{ caughtBy: 'google' }]);
    expect(s.fake.event(s.cal, created.id)!.summary).toBe('Changed in Google');
  });

  it("still catches a conflict when Google ignores If-Match", async () => {
    const s = setup();
    const created = await s.service.create(s.kid, newEvent());
    const { event } = await s.service.detail(created.id);
    s.fake.ignoreIfMatch = true;
    s.fake.editEvent(s.cal, created.id, { summary: 'Changed in Google' });
    await expect(s.service.update(s.kid, created.id, { scope: 'this', etag: event.etag, seriesEtag: null, event: { ...formOf(event), title: 'Mine' } }))
      .rejects.toMatchObject({ code: 'conflict' });
    expect(s.fake.event(s.cal, created.id)!.summary).toBe('Changed in Google');
  });

  it("never sends without If-Match for a single event, a series, or a delete: a 412 there is a conflict, even when the etag didn't change (R3-I5)", async () => {
    const { lines, logger } = logLines();
    const s = setup({ logger });
    const created = await s.service.create(s.kid, newEvent());
    const { event } = await s.service.detail(created.id);
    s.fake.failures.push({ path: 'patch', status: 412, body: GOOGLE_ERRORS.conditionNotMet });
    await expect(s.service.update(s.kid, created.id, { scope: 'this', etag: event.etag, seriesEtag: null, event: { ...formOf(event), title: 'Mine' } }))
      .rejects.toMatchObject({ code: 'conflict' });
    s.fake.failures.push({ path: 'delete', status: 412, body: GOOGLE_ERRORS.conditionNotMet });
    await expect(s.service.delete(s.kid, created.id, { scope: 'this', etag: event.etag })).rejects.toMatchObject({ code: 'conflict' });
    weekly(s);
    const all = await allEvents(s);
    s.fake.failures.push({ path: 'patch', status: 412, body: GOOGLE_ERRORS.conditionNotMet });
    await expect(all.edit({ title: 'Swim team' })).rejects.toMatchObject({ code: 'conflict' });
    s.fake.failures.push({ path: 'delete', status: 412, body: GOOGLE_ERRORS.conditionNotMet });
    await expect(s.service.delete(s.kid, all.event.id, { scope: 'all', etag: all.event.etag, seriesEtag: all.series!.etag })).rejects.toMatchObject({ code: 'conflict' });
    expect(writes(s.t).filter((w) => w.method !== 'POST').every((w) => w.ifMatch !== null)).toBe(true);
    expect(s.fake.event(s.cal, created.id)!.summary).toBe('Dentist');
    expect(s.fake.event(s.cal, 'swim0001')!.summary).toBe('Swim');
    expect(lines.filter((l) => l.etagRejected === true)).toEqual([]);
  });

  it("a refused change doesn't count against the connection; an event that's gone is not found", async () => {
    const s = setup();
    const created = await s.service.create(s.kid, newEvent());
    const { event } = await s.service.detail(created.id);
    s.fake.failures.push({ path: 'patch', status: 403, body: GOOGLE_ERRORS.forbiddenForNonOrganizer });
    await expect(s.service.update(s.kid, created.id, { scope: 'this', etag: event.etag, seriesEtag: null, event: { ...formOf(event), title: 'x' } }))
      .rejects.toMatchObject({ code: 'integration_unavailable', message: CALENDAR_WRITE_MESSAGES.rejected });
    expect(s.t.db.select().from(connections).get()).toMatchObject({ status: 'ok', consecutiveFailures: 0 });
    await expect(s.service.detail('gone00000001')).rejects.toMatchObject({ code: 'not_found', message: CALENDAR_EVENT_GONE });
  });
});

describe('repeating events', () => {
  it('describes the series with its rule and zone, and shows a rule with exceptions or a custom rule read-only', async () => {
    const s = setup();
    weekly(s);
    const instance = (await s.service.window('2026-11-15', '2026-11-22')).events[0]!;
    expect(await s.service.detail(instance.id)).toMatchObject({
      event: { seriesId: 'swim0001', startDate: '2026-11-17' },
      series: {
        id: 'swim0001', startDate: '2026-11-03', startTime: '16:00', timeZone: LA, repeat: { freq: 'weekly', weekdays: ['TU'] },
        repeatEditable: true, repeatText: 'Every week on Tuesday', moveBlocked: null,
      },
    });
    s.fake.addEvent(s.cal, { id: 'yoga0001', summary: 'Yoga', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=WE', 'EXDATE;TZID=America/Los_Angeles:20261111T080000'], start: at('2026-11-04', '08:00'), end: at('2026-11-04', '09:00') });
    s.fake.addEvent(s.cal, { id: 'trash0001', summary: 'Bins', recurrence: ['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TH'], start: at('2026-11-05', '07:00'), end: at('2026-11-05', '07:15') });
    const events = (await s.service.window('2026-11-15', '2026-11-22', { refresh: true })).events;
    const yoga = await s.service.detail(events.find((e) => e.title === 'Yoga')!.id);
    expect(yoga.series).toMatchObject({ repeatEditable: false, repeatText: 'Every week on Wednesday, with some dates skipped or added', moveBlocked: SERIES_MOVE_BLOCKED.datesSkipped });
    const bins = await s.service.detail(events.find((e) => e.title === 'Bins')!.id);
    expect(bins.series).toMatchObject({ repeat: null, repeatEditable: false, repeatText: 'Repeats on a custom schedule', moveBlocked: SERIES_MOVE_BLOCKED.custom });
  });

  it('opened by the series id, offers only "All events" (M-5)', async () => {
    const s = setup();
    weekly(s);
    const { event, series } = await s.service.detail('swim0001');
    expect(event).toMatchObject({ id: 'swim0001', seriesId: 'swim0001', startDate: '2026-11-03' });
    expect(series).toMatchObject({ id: 'swim0001', etag: event.etag });
    await expect(s.service.update(s.kid, 'swim0001', { scope: 'this', etag: event.etag, seriesEtag: null, event: { ...formOf(event), title: 'x' } }))
      .rejects.toMatchObject({ code: 'validation', message: CALENDAR_WRITE_MESSAGES.chooseAll });
    await expect(s.service.delete(s.kid, 'swim0001', { scope: 'this', etag: event.etag })).rejects.toMatchObject({ code: 'validation', message: CALENDAR_WRITE_MESSAGES.chooseAll });
    expect(writes(s.t)).toEqual([]);
    await s.service.update(s.kid, 'swim0001', { scope: 'all', etag: event.etag, seriesEtag: series!.etag, event: { ...formOf(event), title: 'Swim team' } });
    expect(s.fake.event(s.cal, 'swim0001')).toMatchObject({ summary: 'Swim team', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU'] });
  });

  it('"This event" patches just the instance; the series and the other instances stay', async () => {
    const s = setup();
    weekly(s);
    const [first, second] = (await s.service.window('2026-11-15', '2026-11-29')).events;
    const { event } = await s.service.detail(first!.id);
    await s.service.update(s.kid, first!.id, { scope: 'this', etag: event.etag, seriesEtag: null, event: { ...formOf(event), title: 'Swim meet', startTime: '17:00', endTime: '19:00' } });
    expect(writes(s.t).at(-1)).toMatchObject({ method: 'PATCH', path: `/${first!.id}`, ifMatch: event.etag });
    const after = (await s.service.window('2026-11-15', '2026-11-29')).events;
    expect(after.map((e) => [e.title, e.startDate, e.startTime])).toEqual([['Swim meet', '2026-11-17', '17:00'], ['Swim', '2026-11-24', '16:00']]);
    expect(s.fake.event(s.cal, 'swim0001')).toMatchObject({ summary: 'Swim' });
    await expect(s.service.update(s.kid, second!.id, { scope: 'this', etag: second!.etag, seriesEtag: null, event: { ...formOf(second!), repeat: { freq: 'daily', weekdays: [], end: { type: 'never' } } } }))
      .rejects.toMatchObject({ message: CALENDAR_WRITE_MESSAGES.repeatIsSeries });
  });

  it('"This event" falls back to PUT with the whole instance when Google won\'t patch one, keeping every field (I6)', async () => {
    const { lines, logger } = logLines();
    const s = setup({ logger });
    weekly(s, undefined, { attendees: [{ email: 'coach@example.com' }], conferenceData: { entryPoints: [{ uri: 'https://meet.example.com/x' }] } });
    s.fake.instancePatchUnsupported = true;
    const [first, second] = (await s.service.window('2026-11-15', '2026-11-29')).events;
    const { event } = await s.service.detail(first!.id);
    await s.service.update(s.kid, first!.id, { scope: 'this', etag: event.etag, seriesEtag: null, event: { ...formOf(event), title: 'Swim meet' } });
    const [patch, put] = writes(s.t).slice(-2);
    expect(patch).toMatchObject({ method: 'PATCH', path: `/${first!.id}` });
    expect(put).toMatchObject({
      method: 'PUT', path: `/${first!.id}`, ifMatch: event.etag,
      body: { summary: 'Swim meet', attendees: [{ email: 'coach@example.com' }], conferenceData: { entryPoints: [{ uri: 'https://meet.example.com/x' }] }, extendedProperties: { private: { dashboardUpdatedBy: s.by(s.kid) } } },
    });
    expect(s.fake.event(s.cal, first!.id)).toMatchObject({ summary: 'Swim meet', attendees: [{ email: 'coach@example.com' }], recurringEventId: 'swim0001' });
    expect(lines.filter((l) => l.instancePatchUnsupported === true)).toMatchObject([{ op: 'update', status: 405 }]);
    // Deleting one instance cancels it the same way.
    await s.service.delete(s.kid, second!.id, { scope: 'this', etag: second!.etag });
    expect(writes(s.t).at(-1)).toMatchObject({ method: 'PUT', body: { status: 'cancelled', summary: 'Swim' } });
    expect((await s.service.window('2026-11-15', '2026-11-29')).events.map((e) => e.title)).toEqual(['Swim meet']);
  });

  it('"This event" through the PUT fallback keeps shared properties, the whole organizer, guests, reminders, and conference data (R2-I2, R3-C1)', async () => {
    const s = setup();
    const kept = {
      extendedProperties: { private: { someoneElse: 'x' }, shared: { teamApp: 'keep me' } },
      organizer: { email: 'family@example.com', displayName: 'The family', self: true },
      attendees: [{ email: 'coach@example.com', responseStatus: 'accepted', optional: true }],
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }] },
      conferenceData: { conferenceId: 'abc-defg-hij', entryPoints: [{ entryPointType: 'video', uri: 'https://meet.google.com/abc-defg-hij' }], conferenceSolution: { key: { type: 'hangoutsMeet' } } },
      attachments: [{ fileUrl: 'https://drive.google.com/file/d/1', title: 'Schedule' }],
    };
    weekly(s, undefined, kept);
    s.fake.instancePatchUnsupported = true;
    const [first] = (await s.service.window('2026-11-15', '2026-11-22')).events;
    const { event } = await s.service.detail(first!.id);
    await s.service.update(s.kid, first!.id, { scope: 'this', etag: event.etag, seriesEtag: null, event: { ...formOf(event), title: 'Swim meet' } });
    const put = s.fake.requests.filter((r) => r.method === 'PUT').at(-1)!;
    expect(put.query).toMatchObject({ conferenceDataVersion: '1', supportsAttachments: 'true' });
    expect(put.body).toMatchObject({
      ...kept, summary: 'Swim meet',
      extendedProperties: { private: { someoneElse: 'x', dashboardUpdatedBy: s.by(s.kid) }, shared: { teamApp: 'keep me' } },
    });
    expect(s.fake.event(s.cal, first!.id)).toMatchObject({ ...kept, summary: 'Swim meet', extendedProperties: { shared: { teamApp: 'keep me' } } });
  });

  it('"This event" sends once without If-Match when Google refuses an instance\'s own etag (I6)', async () => {
    const { lines, logger } = logLines();
    const s = setup({ logger });
    weekly(s);
    s.fake.instanceEtagsRejected = true;
    const [first, second] = (await s.service.window('2026-11-15', '2026-11-29')).events;
    const { event } = await s.service.detail(first!.id);
    await s.service.update(s.kid, first!.id, { scope: 'this', etag: event.etag, seriesEtag: null, event: { ...formOf(event), title: 'Swim meet' } });
    expect(writes(s.t).slice(-2).map((w) => [w.method, w.ifMatch])).toEqual([['PATCH', event.etag], ['PATCH', null]]);
    expect(s.fake.event(s.cal, first!.id)).toMatchObject({ summary: 'Swim meet' });
    await s.service.delete(s.kid, second!.id, { scope: 'this', etag: second!.etag });
    expect(lines.filter((l) => l.etagRejected === true)).toMatchObject([{ op: 'update', instance: true }, { op: 'delete', instance: true }]);
    expect((await s.service.window('2026-11-15', '2026-11-29')).events.map((e) => e.title)).toEqual(['Swim meet']);
  });

  it('"All events" moves the series by the move, with its weekdays, using the series etag', async () => {
    const s = setup();
    weekly(s);
    const { series, edit } = await allEvents(s);
    // Tuesday the 17th at 4pm moved to Wednesday the 18th at 4:30pm.
    await edit({ title: 'Swim team', startDate: '2026-11-18', endDate: '2026-11-18', startTime: '16:30', endTime: '17:30' });
    expect(writes(s.t).at(-1)).toMatchObject({
      method: 'PATCH', path: '/swim0001', ifMatch: series!.etag,
      body: {
        summary: 'Swim team', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=WE'],
        start: { dateTime: '2026-11-04T16:30:00-08:00', timeZone: LA }, end: { dateTime: '2026-11-04T17:30:00-08:00', timeZone: LA },
        extendedProperties: { private: { dashboardUpdatedBy: s.by(s.grant) } },
      },
    });
    const after = (await s.service.window('2026-11-15', '2026-11-29')).events;
    expect(after.map((e) => [e.title, e.startDate, e.startTime])).toEqual([['Swim team', '2026-11-18', '16:30'], ['Swim team', '2026-11-25', '16:30']]);
  });

  it('"All events" moves the weekdays along with a changed repeat that kept them, and leaves new weekdays alone', async () => {
    const s = setup();
    weekly(s);
    let { edit } = await allEvents(s);
    await edit({ startDate: '2026-11-18', endDate: '2026-11-18', repeat: { freq: 'weekly', weekdays: ['TU'], end: { type: 'after', count: 4 } } });
    expect(s.fake.event(s.cal, 'swim0001')!.recurrence).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=WE;COUNT=4']);
    ({ edit } = await allEvents(s));
    await edit({ startDate: '2026-11-19', endDate: '2026-11-19', repeat: { freq: 'weekly', weekdays: ['MO', 'TH'], end: { type: 'after', count: 4 } } });
    expect(s.fake.event(s.cal, 'swim0001')!.recurrence).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=MO,TH;COUNT=4']);
  });

  it.each([
    // [new weekdays, the series' new first day]
    [['WE', 'FR'], '2026-11-04'],
    [['TH'], '2026-11-05'],
    [['MO'], '2026-11-09'],
    [['MO', 'TU'], '2026-11-03'], // still includes its first day: it stays
  ] as const)('"All events" changing a weekly series\' weekdays to %j moves its first day to the first of them on or after it (R3-M)', async (weekdays, firstDay) => {
    const s = setup();
    weekly(s, ['RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20270101T075959Z']);
    const all = await allEvents(s);
    await all.edit({ repeat: { freq: 'weekly', weekdays: [...weekdays], end: all.series!.repeat!.end } });
    const series = s.fake.event(s.cal, 'swim0001')!;
    expect(series.recurrence).toEqual([`RRULE:FREQ=WEEKLY;BYDAY=${weekdays.join(',')};UNTIL=20270101T075959Z`]);
    expect(series).toMatchObject({ start: { dateTime: `${firstDay}T16:00:00-08:00` }, end: { dateTime: `${firstDay}T17:00:00-08:00` } });
    // No occurrence is left on a day the rule doesn't name.
    const days = (await s.service.window('2026-11-01', '2026-11-15', { refresh: true })).events.map((e) => e.startDate);
    expect(days[0]).toBe(firstDay);
  });

  it('"All events" changing a daily series to weekly on another day starts it on that day (R3-M)', async () => {
    const s = setup();
    s.fake.addEvent(s.cal, { id: 'walk0001', summary: 'Walk', recurrence: ['RRULE:FREQ=DAILY'], start: at('2026-11-03', '07:00'), end: at('2026-11-03', '07:30') });
    const all = await allEvents(s);
    await all.edit({ repeat: { freq: 'weekly', weekdays: ['FR'], end: { type: 'never' } } });
    expect(s.fake.event(s.cal, 'walk0001')).toMatchObject({ recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=FR'], start: { dateTime: '2026-11-06T07:00:00-08:00' } });
  });

  it('"All events" writes a Google rule with BYMONTHDAY or BYMONTH again when the series moves a day (C1)', async () => {
    const s = setup();
    s.fake.addEvent(s.cal, { id: 'rent0001', summary: 'Rent', recurrence: ['RRULE:FREQ=MONTHLY;BYMONTHDAY=3'], start: at('2026-11-03', '09:00'), end: at('2026-11-03', '09:30') });
    s.fake.addEvent(s.cal, { id: 'anniv001', summary: 'Anniversary', recurrence: ['RRULE:FREQ=YEARLY;BYMONTH=12;BYMONTHDAY=10'], start: { date: '2026-12-10' }, end: { date: '2026-12-11' } });
    const rent = await allEvents(s, '2026-12-03', '2026-12-04');
    expect(rent.series).toMatchObject({ repeat: { freq: 'monthly' }, repeatEditable: true, moveBlocked: null });
    expect(rent.event.title).toBe('Rent');
    await rent.edit({ startDate: '2026-12-04', endDate: '2026-12-04' });
    expect(s.fake.event(s.cal, 'rent0001')).toMatchObject({ recurrence: ['RRULE:FREQ=MONTHLY'], start: { dateTime: expect.stringMatching(/^2026-11-04T/) } });
    expect((await s.service.window('2026-12-01', '2027-01-08')).events.filter((e) => e.title === 'Rent').map((e) => e.startDate)).toEqual(['2026-12-04', '2027-01-04']);

    const anniv = await allEvents(s, '2026-12-10', '2026-12-11');
    expect(anniv.event.title).toBe('Anniversary');
    await anniv.edit({ startDate: '2026-12-12', endDate: '2026-12-12' });
    expect(s.fake.event(s.cal, 'anniv001')).toMatchObject({ recurrence: ['RRULE:FREQ=YEARLY'], start: { date: '2026-12-12' }, end: { date: '2026-12-13' } });
  });

  it.each([
    // 18:00Z on December 31 is 10am in Los Angeles: the last one is that day.
    ['20261231T180000Z', '2026-12-31', 'RRULE:FREQ=DAILY;UNTIL=20270101T075959Z'],
    // 17:00Z is 9am, before that day's 10am start: the last one is December 30.
    ['20261231T170000Z', '2026-12-30', 'RRULE:FREQ=DAILY;UNTIL=20261231T075959Z'],
  ])('"All events" keeps a 10am series\' last day when it moves to 11am, with UNTIL %s (R1-I1)', async (until, last, written) => {
    const s = setup();
    s.fake.addEvent(s.cal, { id: 'walk0001', summary: 'Walk', recurrence: [`RRULE:FREQ=DAILY;UNTIL=${until}`], start: at('2026-12-01', '10:00'), end: at('2026-12-01', '10:30') });
    const { series, edit } = await allEvents(s, '2026-12-15', '2026-12-16');
    expect(series).toMatchObject({ repeat: { end: { type: 'on', date: last } }, repeatText: `Every day, until December ${last.slice(-2)}, 2026` });
    // A time-only move rewrites the rule (days is 0).
    await edit({ startTime: '11:00', endTime: '11:30' });
    expect(s.fake.event(s.cal, 'walk0001')!.recurrence).toEqual([written]);
    const after = (await s.service.window('2026-12-29', '2027-01-02', { refresh: true })).events;
    expect(after.at(-1)).toMatchObject({ startDate: last, startTime: '11:00' });
  });

  it('"All events" moves an end the person left alone with the series: a +30 minute move with an exact-instant UNTIL (R3-I3)', async () => {
    const s = setup();
    // UNTIL is the last instance's own start, as in Google's example: 4pm on Tuesday, November 24.
    weekly(s, ['RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261125T000000Z']);
    const { series, edit } = await allEvents(s);
    expect(series!.repeat).toEqual({ freq: 'weekly', weekdays: ['TU'], end: { type: 'on', date: '2026-11-24' } });
    await edit({ startTime: '16:30', endTime: '17:30' });
    expect(s.fake.event(s.cal, 'swim0001')!.recurrence).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261125T075959Z']);
    const after = (await s.service.window('2026-11-15', '2026-12-06', { refresh: true })).events;
    expect(after.map((e) => [e.startDate, e.startTime])).toEqual([['2026-11-17', '16:30'], ['2026-11-24', '16:30']]);
  });

  it.each([
    // Monday, Wednesday, and Friday at 4pm until Friday, December 4, moved from Wednesday the 18th.
    [1, '2026-11-19', ['TU', 'TH', 'SA'], 'RRULE:FREQ=WEEKLY;BYDAY=TU,TH,SA;UNTIL=20261206T075959Z', '2026-12-05'],
    [-1, '2026-11-17', ['SU', 'TU', 'TH'], 'RRULE:FREQ=WEEKLY;BYDAY=SU,TU,TH;UNTIL=20261204T075959Z', '2026-12-03'],
  ])('"All events" moves a MO/WE/FR series %i day with its weekdays and its end (R3-I3)', async (_, to, weekdays, written, last) => {
    const s = setup();
    s.fake.addEvent(s.cal, {
      id: 'gym00001', summary: 'Gym', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;UNTIL=20261205T000000Z'],
      start: at('2026-11-02', '16:00'), end: at('2026-11-02', '17:00'),
    });
    const { series, edit } = await allEvents(s, '2026-11-18', '2026-11-19');
    expect(series!.repeat).toEqual({ freq: 'weekly', weekdays: ['MO', 'WE', 'FR'], end: { type: 'on', date: '2026-12-04' } });
    await edit({ startDate: to, endDate: to });
    expect(s.fake.event(s.cal, 'gym00001')!.recurrence).toEqual([written]);
    const detail = await allEvents(s, '2026-11-15', '2026-11-22');
    expect(detail.series!.repeat).toEqual({ freq: 'weekly', weekdays, end: { type: 'on', date: last } });
    const after = (await s.service.window('2026-11-29', '2026-12-10', { refresh: true })).events;
    expect(after.at(-1)!.startDate).toBe(last);
  });

  it('"All events" moves an all-day series\' date UNTIL by days, and leaves an end the person changed as they set it (R3-I3)', async () => {
    const s = setup();
    s.fake.addEvent(s.cal, { id: 'bins0001', summary: 'Bins', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261208'], start: { date: '2026-11-03' }, end: { date: '2026-11-04' } });
    let all = await allEvents(s);
    await all.edit({ startDate: '2026-11-18', endDate: '2026-11-18' });
    expect(s.fake.event(s.cal, 'bins0001')!.recurrence).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=WE;UNTIL=20261209']);
    all = await allEvents(s);
    await all.edit({ startDate: '2026-11-19', endDate: '2026-11-19', repeat: { freq: 'weekly', weekdays: ['WE'], end: { type: 'on', date: '2026-12-31' } } });
    expect(s.fake.event(s.cal, 'bins0001')!.recurrence).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=TH;UNTIL=20261231']);
  });

  it("\"All events\" checks the repeat's end against the series' first day, not this instance's (M-7)", async () => {
    const s = setup();
    weekly(s);
    const { edit } = await allEvents(s);
    await expect(edit({ repeat: { freq: 'weekly', weekdays: ['TU'], end: { type: 'on', date: '2026-11-01' } } }))
      .rejects.toMatchObject({ code: 'validation', message: 'The repeat has to end on or after the first day' });
    await edit({ repeat: { freq: 'weekly', weekdays: ['TU'], end: { type: 'on', date: '2026-11-10' } } });
    expect(s.fake.event(s.cal, 'swim0001')!.recurrence).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261111T075959Z']);
  });

  it.each([
    // [what, rule, the series' first day, the instance shown, where it's moved, allowed]
    ['the 30th moved to the 1st', 'MONTHLY', '2026-10-30', '2026-11-30', '2026-12-01', false],
    ['the 1st moved to the 30th', 'MONTHLY', '2026-03-01', '2026-12-01', '2026-11-30', false],
    ['the 1st moved to the end of February', 'MONTHLY', '2026-11-01', '2027-03-01', '2027-02-28', false],
    ['yearly February 28 moved to the 29th in a leap year', 'YEARLY', '2027-02-28', '2028-02-28', '2028-02-29', false],
    ['the 31st moved 30 days later', 'MONTHLY', '2027-01-31', '2027-03-31', '2027-04-30', false],
    // Days past the 28th aren't in every month, so a move to or from one adds or drops occurrences (C-C1).
    ['the 31st moved to the 30th', 'MONTHLY', '2026-10-31', '2026-12-31', '2026-12-30', false],
    ['the 1st moved to the 31st', 'MONTHLY', '2026-11-01', '2027-04-01', '2027-03-31', false],
    ['the 28th moved to the 29th', 'MONTHLY', '2026-11-28', '2027-01-28', '2027-01-29', false],
    ['the 29th moved to the 28th', 'MONTHLY', '2026-10-29', '2027-01-29', '2027-01-28', false],
    ['yearly February 29 moved to the 28th', 'YEARLY', '2028-02-29', '2032-02-29', '2032-02-28', false],
    ['yearly February 28 moved to the 29th, from a leap year', 'YEARLY', '2024-02-28', '2028-02-28', '2028-02-29', false],
    ['the 15th moved to the 16th', 'MONTHLY', '2026-10-15', '2026-12-15', '2026-12-16', true],
    ['the 1st moved to the 28th', 'MONTHLY', '2026-11-01', '2027-04-01', '2027-04-28', true],
    ['yearly March 10 moved to March 12', 'YEARLY', '2026-03-10', '2027-03-10', '2027-03-12', true],
    ['yearly January 31 moved to January 30', 'YEARLY', '2026-01-31', '2027-01-31', '2027-01-30', true],
  ] as const)('"All events" on a monthly or yearly series: %s (R3-I2, C-C1)', async (_, freq, first, shown, to, allowed) => {
    const s = setup();
    s.fake.addEvent(s.cal, { id: 'bill0001', summary: 'Bill', recurrence: [`RRULE:FREQ=${freq}`], start: at(first, '09:00'), end: at(first, '09:30') });
    // A full year of a monthly series, and six years of a yearly one (two leap years among them).
    const span = freq === 'MONTHLY' ? ['2027-01-01', '2028-01-01'] as const : ['2027-01-01', '2033-01-01'] as const;
    const count = async () => (await s.service.window(span[0], span[1], { refresh: true })).events.filter((e) => e.title === 'Bill').length;
    const before = await count();
    const all = await allEvents(s, shown, addDays(shown, 1));
    expect(all.event).toMatchObject({ title: 'Bill', startDate: shown });
    expect(all.series!.moveBlocked).toBeNull();
    const move = all.edit({ startDate: to, endDate: to });
    if (!allowed) {
      await expect(move).rejects.toMatchObject({ code: 'validation', message: CALENDAR_WRITE_MESSAGES.moveInGoogle });
      expect(writes(s.t)).toEqual([]);
      return;
    }
    await move;
    const after = (await s.service.window(to, addDays(to, 1), { refresh: true })).events;
    expect(after.map((e) => [e.title, e.startDate])).toEqual([['Bill', to]]);
    // The move adds no occurrence and drops none (C-C1).
    expect(await count()).toBe(before);
    expect(before).toBe(freq === 'MONTHLY' ? 12 : 6);
  });

  it("\"All events\" refuses a new start time that doesn't exist on the series' first day, instead of moving it (R3-M)", async () => {
    const s = setup();
    // Every day at 1:30am from Sunday, March 8, 2026, when Los Angeles skips 2:00 to 3:00.
    s.fake.addEvent(s.cal, { id: 'feed0001', summary: 'Feed baby', recurrence: ['RRULE:FREQ=DAILY;COUNT=400'], start: { dateTime: '2026-03-08T01:30:00-08:00', timeZone: LA }, end: { dateTime: '2026-03-08T02:00:00-08:00', timeZone: LA } });
    const all = await allEvents(s, '2026-11-17', '2026-11-18');
    await expect(all.edit({ startTime: '02:30', endTime: '03:00' })).rejects.toMatchObject({ code: 'validation', message: CALENDAR_WRITE_MESSAGES.startMissing('2026-03-08', '02:30') });
    expect(CALENDAR_WRITE_MESSAGES.startMissing('2026-03-08', '02:30')).toBe("This series starts on March 8, 2026, and 02:30 doesn't happen that day because the clocks change. Pick another time.");
    expect(writes(s.t)).toEqual([]);
    await all.edit({ startTime: '03:30', endTime: '04:00' });
    expect(s.fake.event(s.cal, 'feed0001')).toMatchObject({ start: { dateTime: '2026-03-08T03:30:00-07:00' } });
  });

  it('"All events" moves a Tokyo series by Tokyo days when the family is in Los Angeles (C1)', async () => {
    const s = setup();
    // Tuesdays 09:00 in Tokyo: Mondays 16:00 in Los Angeles.
    s.fake.addEvent(s.cal, {
      id: 'call0001', summary: 'Call grandma', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU'],
      start: { dateTime: '2026-11-03T09:00:00+09:00', timeZone: TOKYO }, end: { dateTime: '2026-11-03T10:00:00+09:00', timeZone: TOKYO },
    });
    const { event, series, edit } = await allEvents(s);
    expect(event).toMatchObject({ startDate: '2026-11-16', startTime: '16:00' });
    expect(series).toMatchObject({ timeZone: TOKYO, startDate: '2026-11-03', startTime: '09:00', repeat: { weekdays: ['TU'] } });
    // 06:00 on the same Monday in Los Angeles is 23:00 on Monday in Tokyo: the series moves a day earlier there.
    await edit({ startTime: '06:00', endTime: '07:00' });
    expect(writes(s.t).at(-1)!.body).toMatchObject({
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO'],
      start: { dateTime: '2026-11-02T23:00:00+09:00', timeZone: TOKYO }, end: { dateTime: '2026-11-03T00:00:00+09:00', timeZone: TOKYO },
    });
    const after = (await s.service.window('2026-11-15', '2026-11-29')).events;
    expect(after.map((e) => [e.startDate, e.startTime])).toEqual([['2026-11-16', '06:00'], ['2026-11-23', '06:00']]);
  });

  it('"All events" won\'t move a series with dates skipped (C1)', async () => {
    const s = setup();
    weekly(s, ['RRULE:FREQ=WEEKLY;BYDAY=TU', 'EXDATE;TZID=America/Los_Angeles:20261110T160000']);
    const all = await allEvents(s);
    await expect(all.edit({ startTime: '16:30', endTime: '17:30' })).rejects.toMatchObject({ code: 'validation', message: CALENDAR_WRITE_MESSAGES.moveInGoogle });
    await expect(all.edit({ repeat: { freq: 'daily', weekdays: [], end: { type: 'never' } } })).rejects.toMatchObject({ message: CALENDAR_WRITE_MESSAGES.repeatReadOnly });
    // Text still goes to the series, and the rule with its EXDATE is left as it is.
    await all.edit({ title: 'Swim!' });
    expect(s.fake.event(s.cal, 'swim0001')).toMatchObject({ summary: 'Swim!', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU', 'EXDATE;TZID=America/Los_Angeles:20261110T160000'] });
  });

  it.each([
    ['moved', { start: at('2026-12-01', '17:00'), end: at('2026-12-01', '18:00') }],
    ['cancelled', { status: 'cancelled' }],
    // R3-I4: fields the dashboard doesn't read count too.
    ['given an extra guest', { attendees: [{ email: 'grandma@example.com' }] }],
    ['given its own Meet link', { conferenceData: { conferenceId: 'abc-defg-hij' } }],
  ])('"All events" won\'t move a series with an instance %s on its own (C1)', async (_, change) => {
    const s = setup();
    weekly(s);
    const dec1 = (await s.service.window('2026-12-01', '2026-12-02')).events[0]!;
    s.fake.editEvent(s.cal, dec1.id, change);
    const all = await allEvents(s);
    expect(all.series!.moveBlocked).toBe(SERIES_MOVE_BLOCKED.changed);
    await expect(all.edit({ startDate: '2026-11-18', endDate: '2026-11-18' })).rejects.toMatchObject({ message: CALENDAR_WRITE_MESSAGES.moveInGoogle });
    await expect(all.edit({ repeat: { freq: 'weekly', weekdays: ['TU'], end: { type: 'after', count: 3 } } })).rejects.toMatchObject({ message: CALENDAR_WRITE_MESSAGES.repeatReadOnly });
    expect(writes(s.t)).toEqual([]);
    await all.edit({ title: 'Swim team' });
    expect(s.fake.event(s.cal, 'swim0001')).toMatchObject({ summary: 'Swim team', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU'] });
  });

  it.each([
    ['Google is rate limiting', 429, GOOGLE_ERRORS.tooManyRequests, 3, SERIES_MOVE_BLOCKED.busy, CALENDAR_MESSAGES.busy, 'ok'],
    ["Google can't be reached", 503, undefined, 3, SERIES_MOVE_BLOCKED.unchecked, CALENDAR_MESSAGES.unreachable, 'ok'],
    ['the link needs reconnecting', 401, GOOGLE_ERRORS.authError, 2, SERIES_MOVE_BLOCKED.reconnect, CALENDAR_MESSAGES.reconnect, 'needs_reconnect'],
  ] as const)("keeps \"couldn't check\" apart from \"has exceptions\" when %s, and the check doesn't count against the connection (R3-M)", async (_, status, body, times, blocked, refused, after) => {
    const s = setup();
    weekly(s);
    const instance = (await s.service.window('2026-11-15', '2026-11-22')).events[0]!;
    s.fake.failures.push(...Array.from({ length: times }, () => ({ path: 'instances' as const, status, body })));
    const detail = await s.service.detail(instance.id);
    expect(detail.series!.moveBlocked).toBe(blocked);
    expect(s.t.db.select().from(connections).get()).toMatchObject({ status: after, consecutiveFailures: 0 });
    if (after === 'ok') {
      s.fake.failures.push(...Array.from({ length: times }, () => ({ path: 'instances' as const, status, body })));
      await expect(s.service.update(s.grant, instance.id, {
        scope: 'all', etag: detail.event.etag, seriesEtag: detail.series!.etag, event: { ...formOf(detail.event), repeat: detail.series!.repeat, startTime: '16:30', endTime: '17:30' },
      })).rejects.toMatchObject({ code: 'integration_unavailable', message: refused });
      expect(s.t.db.select().from(connections).get()).toMatchObject({ status: 'ok', consecutiveFailures: 0 });
    }
    expect(writes(s.t).filter((w) => w.path !== '/token')).toEqual([]);
  });

  it("checks a series' instances once per series version for 5 minutes when opening it, but always again before moving it (R3-M)", async () => {
    const s = setup();
    weekly(s);
    const instances = () => s.fake.requests.filter((r) => r.path.endsWith('/instances')).length;
    const instance = (await s.service.window('2026-11-15', '2026-11-22')).events[0]!;
    await s.service.detail(instance.id);
    await s.service.detail(instance.id);
    expect(instances()).toBe(1);
    s.t.clock.advance(5 * 60_000);
    const detail = await s.service.detail(instance.id);
    expect(instances()).toBe(2);
    // A change in Google gives the series a new etag: checked again.
    s.fake.editEvent(s.cal, 'swim0001', { location: 'Pool' });
    const changed = await s.service.detail(instance.id);
    expect(instances()).toBe(3);
    // Saving a move checks again, whatever was cached.
    await s.service.update(s.grant, instance.id, {
      scope: 'all', etag: changed.event.etag, seriesEtag: changed.series!.etag, event: { ...formOf(changed.event), repeat: changed.series!.repeat, startTime: '16:30', endTime: '17:30' },
    });
    expect(instances()).toBe(4);
    expect(detail.series!.moveBlocked).toBeNull();
  });

  it('forgets cached instance checks after any dashboard write, which may change an instance without changing the series (R3-M)', async () => {
    const s = setup();
    weekly(s);
    const [first, second] = (await s.service.window('2026-11-15', '2026-11-29')).events;
    expect((await s.service.detail(second!.id)).series!.moveBlocked).toBeNull();
    const { event } = await s.service.detail(first!.id);
    await s.service.update(s.kid, first!.id, { scope: 'this', etag: event.etag, seriesEtag: null, event: { ...formOf(event), title: 'Swim meet' } });
    expect((await s.service.detail(second!.id)).series!.moveBlocked).toBe(SERIES_MOVE_BLOCKED.changed);
  });

  it('"All events" says a series is too long to check, and then won\'t move it', async () => {
    const s = setup();
    weekly(s);
    s.fake.pageSize = 1;
    const { series, edit } = await allEvents(s);
    expect(series!.moveBlocked).toBe(SERIES_MOVE_BLOCKED.tooLong);
    await expect(edit({ startTime: '16:30', endTime: '17:30' })).rejects.toMatchObject({ message: CALENDAR_WRITE_MESSAGES.moveInGoogle });
    await edit({ title: 'Swim team' });
    expect(s.fake.event(s.cal, 'swim0001')).toMatchObject({ summary: 'Swim team' });
  });

  it('"All events" refuses a stale series, a switch to all day (judged by the series, M1), and stopping the repeat', async () => {
    const s = setup();
    weekly(s);
    const { edit } = await allEvents(s);
    await expect(edit({ allDay: true, startTime: null, endTime: null })).rejects.toMatchObject({ message: CALENDAR_WRITE_MESSAGES.allDaySeries });
    await expect(edit({ repeat: null })).rejects.toMatchObject({ message: CALENDAR_WRITE_MESSAGES.stopSeries });
    s.fake.editEvent(s.cal, 'swim0001', { location: 'Pool' });
    await expect(edit({ title: 'x' })).rejects.toMatchObject({ code: 'conflict' });

    // An instance made all day on its own: the series is still timed, so "All events" can't make it all day.
    const dec1 = (await s.service.window('2026-12-01', '2026-12-02', { refresh: true })).events[0]!;
    s.fake.editEvent(s.cal, dec1.id, { start: { date: '2026-12-01', dateTime: null, timeZone: null }, end: { date: '2026-12-02', dateTime: null, timeZone: null } });
    const allDay = await allEvents(s, '2026-12-01', '2026-12-02');
    expect(allDay.event.allDay).toBe(true);
    await expect(allDay.edit({ title: 'Swim (all day)' })).rejects.toMatchObject({ message: CALENDAR_WRITE_MESSAGES.allDaySeries });
  });

  it('deletes one instance by cancelling it, or the whole series; an instance already cancelled counts as deleted (M8)', async () => {
    const s = setup();
    weekly(s);
    const [first] = (await s.service.window('2026-11-15', '2026-11-29')).events;
    await s.service.delete(s.kid, first!.id, { scope: 'this', etag: first!.etag });
    expect(writes(s.t).at(-1)).toEqual({ method: 'PATCH', path: `/${first!.id}`, body: { status: 'cancelled' }, ifMatch: first!.etag });
    const sent = writes(s.t).length;
    // The answer was lost and the person tried again with the etag they had.
    await expect(s.service.delete(s.kid, first!.id, { scope: 'this', etag: first!.etag })).resolves.toBeUndefined();
    expect(writes(s.t)).toHaveLength(sent);
    const left = (await s.service.window('2026-11-15', '2026-11-29')).events;
    expect(left.map((e) => e.startDate)).toEqual(['2026-11-24']);

    const { event, series } = await s.service.detail(left[0]!.id);
    await expect(s.service.delete(s.kid, event.id, { scope: 'all', etag: event.etag, seriesEtag: '"stale"' })).rejects.toMatchObject({ code: 'conflict' });
    await s.service.delete(s.kid, event.id, { scope: 'all', etag: event.etag, seriesEtag: series!.etag });
    expect(writes(s.t).at(-1)).toMatchObject({ method: 'DELETE', path: '/swim0001', ifMatch: series!.etag });
    expect((await s.service.window('2026-11-15', '2026-11-29')).events).toEqual([]);
  });

  it('"All events" delete checks the series is one the dashboard can change, not just this instance (M4)', async () => {
    const s = setup();
    weekly(s);
    const dec1 = (await s.service.window('2026-12-01', '2026-12-02')).events[0]!;
    s.fake.editEvent(s.cal, dec1.id, { summary: 'Swim (moved pool)' }); // an exception, kept apart from the series
    s.fake.editEvent(s.cal, 'swim0001', { locked: true });
    const { event, series } = await s.service.detail(dec1.id);
    expect(event.readOnly).toBeNull();
    await expect(s.service.delete(s.kid, event.id, { scope: 'all', etag: event.etag, seriesEtag: series!.etag }))
      .rejects.toMatchObject({ code: 'validation', message: CALENDAR_WRITE_MESSAGES.readOnly });
    expect(writes(s.t)).toEqual([]);
  });

  it.each([
    ['reads a deleted event back as cancelled', true],
    ['answers 404 for a deleted event', false],
  ])("counts a retried delete that already happened as done when Google checks If-Match before saying it's gone, and %s (R2-M16, C-M1)", async (_, cancelled) => {
    const s = setup();
    s.fake.deleteChecksIfMatchFirst = true;
    s.fake.getDeletedAsCancelled = cancelled;
    const created = await s.service.create(s.kid, newEvent());
    // The first DELETE lands but its answer is lost; the client's retry gets a 412.
    s.fake.loseNextResponse = 'delete';
    await expect(s.service.delete(s.kid, created.id, { scope: 'this', etag: created.etag })).resolves.toBeUndefined();
    expect(writes(s.t).filter((w) => w.method === 'DELETE')).toHaveLength(2);
    expect(s.fake.storedEvents(s.cal)).toEqual([]);
  });

  it('says an event deleted in Google is gone when it is edited, not that it changed (C-M1)', async () => {
    const s = setup();
    const created = await s.service.create(s.kid, newEvent());
    s.fake.removeEvent(s.cal, created.id);
    await expect(s.service.update(s.kid, created.id, { scope: 'this', etag: created.etag, seriesEtag: null, event: formOf({ ...created, title: 'Dentist (moved)' }) }))
      .rejects.toMatchObject({ code: 'not_found', message: CALENDAR_EVENT_GONE });
    expect(writes(s.t).filter((w) => w.method === 'PATCH')).toEqual([]);
  });

  it('says an event is gone when a 412 on an edit reads it back cancelled (C-M1)', async () => {
    const s = setup();
    const created = await s.service.create(s.kid, newEvent());
    // Deleted in Google between the dashboard's check and its patch.
    const service = serviceWith(s, async (input, init) => {
      if (init?.method === 'PATCH') {
        s.fake.removeEvent(s.cal, created.id);
        return new Response(JSON.stringify(GOOGLE_ERRORS.conditionNotMet), { status: 412, headers: { 'content-type': 'application/json' } });
      }
      return s.fake.fetch(input, init);
    });
    await expect(service.update(s.kid, created.id, { scope: 'this', etag: created.etag, seriesEtag: null, event: formOf({ ...created, title: 'Dentist (moved)' }) }))
      .rejects.toMatchObject({ code: 'not_found', message: CALENDAR_EVENT_GONE });
  });

  it('"All events" sees a cancelled instance that carries only its id and original start (minimalCancelled, R2-M16)', async () => {
    const s = setup();
    s.fake.minimalCancelled = true;
    weekly(s);
    const dec1 = (await s.service.window('2026-12-01', '2026-12-02')).events[0]!;
    s.fake.editEvent(s.cal, dec1.id, { status: 'cancelled' });
    const all = await allEvents(s);
    expect(all.series!.moveBlocked).toBe(SERIES_MOVE_BLOCKED.changed);
    await expect(all.edit({ startDate: '2026-11-18', endDate: '2026-11-18' })).rejects.toMatchObject({ message: CALENDAR_WRITE_MESSAGES.moveInGoogle });
  });

  it('treats deleting an event that is already gone as done', async () => {
    const s = setup();
    const created = await s.service.create(s.kid, newEvent());
    await s.service.delete(s.kid, created.id, { scope: 'this', etag: created.etag });
    await expect(s.service.delete(s.kid, created.id, { scope: 'this', etag: created.etag })).resolves.toBeUndefined();
  });
});

it('never logs what an event says', async () => {
  const { lines, logger } = logLines();
  const s = setup({ logger });
  const created = await s.service.create(s.kid, newEvent({ title: 'Surprise party', location: 'Secret place', description: 'Do not tell' }));
  const { event } = await s.service.detail(created.id);
  await s.service.update(s.kid, created.id, { scope: 'this', etag: event.etag, seriesEtag: null, event: { ...formOf(event), title: 'Surprise party 2' } });
  await s.service.window('2026-11-15', '2026-11-22');
  const all = lines.map((l) => JSON.stringify(l)).join('\n');
  for (const text of ['Surprise', 'Secret', 'Do not tell']) expect(all).not.toContain(text);
  expect(all).toContain('calendar event updated');
});
