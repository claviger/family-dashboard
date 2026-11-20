import { describe, expect, it } from 'vitest';
import { FakeGoogleCalendar, GOOGLE_ERRORS, googleError } from '../../test/fakeGoogleCalendar.js';
import { classify, GoogleApiError, GoogleCalendarClient, MAX_PAGES } from './calendarClient.js';

function setup() {
  const fake = new FakeGoogleCalendar();
  const family = fake.createAccount({ email: 'family@example.com' });
  const cal = fake.addCalendar(family, { summary: 'Family', timeZone: 'America/Los_Angeles' });
  const sleeps: number[] = [];
  const client = new GoogleCalendarClient(`${fake.origins.api}/calendar/v3`, fake.fetch, { sleep: async (ms) => void sleeps.push(ms), random: () => 0.5 });
  const token = fake.grant(family).access_token;
  return { fake, family, cal, client, token, sleeps };
}

const WINDOW = { timeMin: '2026-11-14T08:00:00.000Z', timeMax: '2026-11-23T08:00:00.000Z', timeZone: 'America/Los_Angeles' };

function timed(day: number, summary = `Event ${day}`) {
  return { summary, start: { dateTime: `2026-11-${day}T09:00:00-08:00` }, end: { dateTime: `2026-11-${day}T10:00:00-08:00` } };
}

describe('GoogleCalendarClient.listCalendars', () => {
  it('keeps only calendars the account owns or can write to, by their own name, across pages', async () => {
    const t = setup();
    const other = t.fake.createAccount({ email: 'friend@example.com' });
    const kids = t.fake.addCalendar(other, { summary: 'Kids' });
    t.fake.share(kids, t.family, 'writer');
    for (const [name, role] of [['Holidays', 'reader'], ['Busy', 'freeBusyReader'], ['Work', 'writerWithoutPrivateAccess']] as const) {
      t.fake.share(t.fake.addCalendar(other, { summary: name }), t.family, role);
    }
    t.fake.pageSize = 1;
    t.fake.emptyFirstPage = true;
    const { calendars } = await t.client.listCalendars(t.token);
    expect(calendars.map((c) => [c.name, c.accessRole]).sort()).toEqual([['Family', 'owner'], ['Kids', 'writer']]);
    expect(t.fake.requests.filter((r) => r.path.endsWith('/calendarList')).every((r) => r.query.minAccessRole === 'writer')).toBe(true);
  });
});

describe('GoogleCalendarClient.listEvents', () => {
  it('asks for expanded instances in start order, in the family time zone, and follows every page', async () => {
    const t = setup();
    for (const day of [16, 17, 18, 19, 20]) t.fake.addEvent(t.cal, timed(day));
    t.fake.pageSize = 2;
    t.fake.emptyFirstPage = true;
    const result = await t.client.listEvents(t.token, t.cal.id, WINDOW);
    expect(result.events.map((e) => e.summary)).toEqual(['Event 16', 'Event 17', 'Event 18', 'Event 19', 'Event 20']);
    expect(result.timeZone).toBe('America/Los_Angeles');
    const first = t.fake.requests.find((r) => r.path.endsWith('/events'))!;
    expect(first.query).toMatchObject({ singleEvents: 'true', orderBy: 'startTime', ...WINDOW, maxResults: '250' });
    expect(t.fake.requests.filter((r) => r.path.endsWith('/events')).length).toBe(4); // an empty page, then three
  });

  it('leaves out events that are not in the documented shape, and counts them', async () => {
    const t = setup();
    t.fake.failures.push({ path: 'list', status: 200, body: { timeZone: 'UTC', items: [{ id: 'no-etag' }, { id: 'ok', etag: '"1"', summary: 'Fine' }] } });
    const result = await t.client.listEvents(t.token, t.cal.id, WINDOW);
    expect(result).toMatchObject({ skipped: 1, timeZone: 'UTC', events: [{ id: 'ok' }] });
  });

  it(`stops after ${MAX_PAGES} pages instead of paging forever`, async () => {
    const t = setup();
    for (let i = 0; i < MAX_PAGES + 1; i++) t.fake.addEvent(t.cal, timed(16, `E${i}`));
    t.fake.pageSize = 1;
    await expect(t.client.listEvents(t.token, t.cal.id, WINDOW)).rejects.toMatchObject({ kind: 'bad_response', reason: 'too_many_pages' });
  });
});

describe('GoogleCalendarClient writes', () => {
  it('inserts with the dashboard id, and a second insert of that id is a duplicate', async () => {
    const t = setup();
    const event = await t.client.insertEvent(t.token, t.cal.id, { id: 'dash0000000000000001', ...timed(17) });
    expect(event).toMatchObject({ id: 'dash0000000000000001', etag: expect.stringMatching(/^"\d+"$/) });
    await expect(t.client.insertEvent(t.token, t.cal.id, { id: 'dash0000000000000001', ...timed(17) })).rejects.toMatchObject({ kind: 'duplicate', status: 409 });
  });

  it('patches with If-Match sent exactly as Google gave it, and a stale etag is a 412', async () => {
    const t = setup();
    const created = t.fake.addEvent(t.cal, timed(17, 'Dentist'));
    const patched = await t.client.patchEvent(t.token, t.cal.id, String(created.id), { summary: 'Dentist (Sam)' }, String(created.etag));
    expect(patched!.summary).toBe('Dentist (Sam)');
    expect(patched!.etag).not.toBe(created.etag);
    expect(t.fake.requests.at(-1)!.ifMatch).toBe(created.etag);
    const err = await t.client.patchEvent(t.token, t.cal.id, String(created.id), { summary: 'Late' }, String(created.etag)).catch((e: unknown) => e);
    expect(err).toMatchObject({ kind: 'precondition', status: 412, reason: 'conditionNotMet' });
  });

  it('deletes with If-Match, and an event already deleted is gone (410)', async () => {
    const t = setup();
    const created = t.fake.addEvent(t.cal, timed(17));
    await t.client.deleteEvent(t.token, t.cal.id, String(created.id), String(created.etag));
    await expect(t.client.deleteEvent(t.token, t.cal.id, String(created.id), String(created.etag))).rejects.toMatchObject({ kind: 'gone', status: 410 });
    // Read back, a deleted event is cancelled, with a new etag (C-M1), or, with the switch off, a 404.
    const read = await t.client.getEvent(t.token, t.cal.id, String(created.id));
    expect(read.event).toMatchObject({ id: created.id, status: 'cancelled' });
    expect(read.event.etag).not.toBe(created.etag);
    t.fake.getDeletedAsCancelled = false;
    await expect(t.client.getEvent(t.token, t.cal.id, String(created.id))).rejects.toMatchObject({ kind: 'not_found' });
  });

  it("expands a weekly series into instances that point back at it, and gets one by its id", async () => {
    const t = setup();
    t.fake.addEvent(t.cal, {
      id: 'swim0001', summary: 'Swim', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU,TH'],
      start: { dateTime: '2026-11-17T16:00:00-08:00', timeZone: 'America/Los_Angeles' }, end: { dateTime: '2026-11-17T17:00:00-08:00', timeZone: 'America/Los_Angeles' },
    });
    const { events } = await t.client.listEvents(t.token, t.cal.id, WINDOW);
    expect(events.map((e) => [e.id, e.start?.dateTime])).toEqual([
      ['swim0001_20261118T000000Z', '2026-11-17T16:00:00-08:00'],
      ['swim0001_20261120T000000Z', '2026-11-19T16:00:00-08:00'],
    ]);
    expect(events[0]).toMatchObject({ recurringEventId: 'swim0001', originalStartTime: { timeZone: 'America/Los_Angeles' } });
    expect(events[0]!.recurrence).toBeUndefined();
    const one = await t.client.getEvent(t.token, t.cal.id, 'swim0001_20261120T000000Z');
    expect(one.event.etag).toBe(events[1]!.etag);
  });
});

it('gives each attempt a timeout, and starts no retry that would end past the deadline', async () => {
  // A server that never answers: each attempt ends at its own timeout.
  const hanging = (_url: string | URL | Request, init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));
  const waits: number[] = [];
  const client = new GoogleCalendarClient('https://api.google.test/calendar/v3', hanging, { attemptTimeoutMs: 20, callDeadlineMs: 1_000, sleep: async (ms) => void waits.push(ms), random: () => 0 });
  const started = Date.now();
  await expect(client.getEvent('t', 'c', 'e')).rejects.toMatchObject({ kind: 'network' });
  expect(Date.now() - started).toBeLessThan(900);
  // A retry would wait 1 second, and then 2, both past what's left of the second.
  expect(waits).toEqual([]);
});

describe('series, PUT, and unknown fields', () => {
  it("lists a series' instances with the cancelled ones, across pages", async () => {
    const t = setup();
    t.fake.addEvent(t.cal, {
      id: 'swim0001', summary: 'Swim', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=4'],
      start: { dateTime: '2026-11-17T16:00:00-08:00', timeZone: 'America/Los_Angeles' }, end: { dateTime: '2026-11-17T17:00:00-08:00', timeZone: 'America/Los_Angeles' },
    });
    t.fake.editEvent(t.cal, 'swim0001_20261125T000000Z', { status: 'cancelled' });
    t.fake.pageSize = 1;
    const instances = await t.client.listInstances(t.token, t.cal.id, 'swim0001', { timeMin: '2026-11-17T00:00:00Z', timeMax: '2027-01-01T00:00:00Z' });
    expect(instances.map((i) => [i.event.id, i.event.status])).toEqual([
      ['swim0001_20261118T000000Z', 'confirmed'], ['swim0001_20261125T000000Z', 'cancelled'], ['swim0001_20261202T000000Z', 'confirmed'], ['swim0001_20261209T000000Z', 'confirmed'],
    ]);
    expect(t.fake.requests.find((r) => r.path.endsWith('/instances'))!.query).toMatchObject({ showDeleted: 'true' });
  });

  it('counts a cancelled instance that carries only its id, series, and original start (minimalCancelled, R2-M16)', async () => {
    const t = setup();
    t.fake.minimalCancelled = true;
    t.fake.addEvent(t.cal, {
      id: 'swim0001', summary: 'Swim', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=3'],
      start: { dateTime: '2026-11-17T16:00:00-08:00', timeZone: 'America/Los_Angeles' }, end: { dateTime: '2026-11-17T17:00:00-08:00', timeZone: 'America/Los_Angeles' },
    });
    t.fake.editEvent(t.cal, 'swim0001_20261125T000000Z', { status: 'cancelled' });
    const instances = await t.client.listInstances(t.token, t.cal.id, 'swim0001', { timeMin: '2026-11-17T00:00:00Z', timeMax: '2027-01-01T00:00:00Z' });
    expect(instances.map((i) => [i.event.id, i.event.status])).toEqual([
      ['swim0001_20261118T000000Z', 'confirmed'], ['swim0001_20261125T000000Z', 'cancelled'], ['swim0001_20261202T000000Z', 'confirmed'],
    ]);
    expect(instances[1]!.raw).toEqual({
      id: 'swim0001_20261125T000000Z', recurringEventId: 'swim0001', status: 'cancelled',
      originalStartTime: { dateTime: '2026-11-24T16:00:00-08:00', timeZone: 'America/Los_Angeles' },
    });
  });

  it("skips an EXDATE given in the series' own zone (TZID), and lists an instance moved into the window from outside it (R2-M16)", async () => {
    const t = setup();
    t.fake.addEvent(t.cal, {
      id: 'swim0001', summary: 'Swim', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU', 'EXDATE;TZID=America/Los_Angeles:20261117T160000'],
      start: { dateTime: '2026-11-10T16:00:00-08:00', timeZone: 'America/Los_Angeles' }, end: { dateTime: '2026-11-10T17:00:00-08:00', timeZone: 'America/Los_Angeles' },
    });
    // December 29's instance, moved to Thursday, November 19.
    t.fake.editEvent(t.cal, 'swim0001_20261230T000000Z', { start: { dateTime: '2026-11-19T10:00:00-08:00' }, end: { dateTime: '2026-11-19T11:00:00-08:00' } });
    const { events } = await t.client.listEvents(t.token, t.cal.id, WINDOW);
    expect(events.map((e) => e.id)).toEqual(['swim0001_20261230T000000Z']);
  });

  it('answers 404, not 412, for an If-Match on an instance that does not exist (instanceEtagsRejected, R2-M16)', async () => {
    const t = setup();
    t.fake.instanceEtagsRejected = true;
    t.fake.addEvent(t.cal, {
      id: 'swim0001', summary: 'Swim', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU;COUNT=2'],
      start: { dateTime: '2026-11-17T16:00:00-08:00', timeZone: 'America/Los_Angeles' }, end: { dateTime: '2026-11-17T17:00:00-08:00', timeZone: 'America/Los_Angeles' },
    });
    await expect(t.client.patchEvent(t.token, t.cal.id, 'swim0001_20261118T000000Z', { summary: 'x' }, '"1"')).rejects.toMatchObject({ kind: 'precondition' });
    await expect(t.client.patchEvent(t.token, t.cal.id, 'swim0001_20991231T000000Z', { summary: 'x' }, '"1"')).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('keeps fields it does not read, and can PUT the whole event back, or patch without If-Match', async () => {
    const t = setup();
    const created = t.fake.addEvent(t.cal, { ...timed(17, 'Recital'), attendees: [{ email: 'sam@example.com' }], conferenceData: { conferenceId: 'abc' } });
    const { event: got, raw } = await t.client.getEvent(t.token, t.cal.id, String(created.id));
    expect(got).toMatchObject({ attendees: [{ email: 'sam@example.com' }], conferenceData: { conferenceId: 'abc' } });
    await t.client.updateEvent(t.token, t.cal.id, got.id, { ...raw, summary: 'Recital!' }, got.etag);
    expect(t.fake.requests.at(-1)).toMatchObject({ method: 'PUT', ifMatch: got.etag });
    expect(t.fake.event(t.cal, got.id)).toMatchObject({ summary: 'Recital!', attendees: [{ email: 'sam@example.com' }] });
    await t.client.patchEvent(t.token, t.cal.id, got.id, { location: 'Hall' }, null);
    expect(t.fake.requests.at(-1)!.ifMatch).toBeNull();
  });

  it('returns the raw JSON untouched beside a parsed view that keeps nested fields too (R2-I2, R3-C1)', async () => {
    const t = setup();
    const fields = {
      ...timed(17, 'Recital'),
      start: { dateTime: '2026-11-17T09:00:00-08:00', timeZone: 'America/Los_Angeles', futureField: 1 },
      extendedProperties: { private: { dashboardCreatedBy: 'x:1' }, shared: { teamApp: 'keep me' } },
      organizer: { email: 'family@example.com', displayName: 'Family', self: true },
      reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] },
    };
    const created = t.fake.addEvent(t.cal, fields);
    const { event, raw } = await t.client.getEvent(t.token, t.cal.id, String(created.id));
    expect(raw).toEqual(t.fake.event(t.cal, String(created.id)));
    expect(event).toMatchObject({
      start: { futureField: 1 }, extendedProperties: { shared: { teamApp: 'keep me' } }, organizer: { email: 'family@example.com', displayName: 'Family' },
      reminders: fields.reminders,
    });
  });

  it('asks the PUT to keep conference data and attachments (R3-C1)', async () => {
    const t = setup();
    const created = t.fake.addEvent(t.cal, timed(17));
    const { event, raw } = await t.client.getEvent(t.token, t.cal.id, String(created.id));
    await t.client.updateEvent(t.token, t.cal.id, event.id, raw, event.etag);
    expect(t.fake.requests.at(-1)).toMatchObject({ method: 'PUT', query: { conferenceDataVersion: '1', supportsAttachments: 'true' } });
  });

  it('tells Google not to email guests on every insert, patch, PUT, and delete (C-M8)', async () => {
    const t = setup();
    const inserted = (await t.client.insertEvent(t.token, t.cal.id, { id: 'abcdefghij0123456789', ...timed(17) }))!;
    const patched = (await t.client.patchEvent(t.token, t.cal.id, inserted.id, { summary: 'Moved' }, inserted.etag))!;
    const { event, raw } = await t.client.getEvent(t.token, t.cal.id, patched.id);
    const put = (await t.client.updateEvent(t.token, t.cal.id, event.id, raw, event.etag))!;
    await t.client.deleteEvent(t.token, t.cal.id, put.id, put.etag);
    const writes = t.fake.requests.filter((r) => r.method !== 'GET');
    expect(writes.map((r) => r.method)).toEqual(['POST', 'PATCH', 'PUT', 'DELETE']);
    for (const r of writes) expect(r.query, r.method).toMatchObject({ sendUpdates: 'none' });
  });
});

describe('errors and retries', () => {
  it("classifies Google's documented error bodies, and the newer format, falling back to the status", () => {
    expect(classify(401, GOOGLE_ERRORS.authError).kind).toBe('auth');
    for (const body of [GOOGLE_ERRORS.rateLimitExceeded, GOOGLE_ERRORS.userRateLimitExceeded, GOOGLE_ERRORS.quotaExceeded]) expect(classify(403, body).kind).toBe('rate_limited');
    expect(classify(429, GOOGLE_ERRORS.tooManyRequests).kind).toBe('rate_limited');
    expect(classify(403, GOOGLE_ERRORS.insufficientPermissions).kind).toBe('scope');
    expect(classify(403, { error: { code: 403, status: 'PERMISSION_DENIED', details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] } }).kind).toBe('scope');
    expect(classify(403, GOOGLE_ERRORS.forbiddenForNonOrganizer)).toMatchObject({ kind: 'forbidden', reason: 'forbiddenForNonOrganizer' });
    expect(classify(403, null)).toMatchObject({ kind: 'forbidden', reason: null });
    expect(classify(404, GOOGLE_ERRORS.notFound).kind).toBe('not_found');
    expect(classify(409, GOOGLE_ERRORS.duplicate).kind).toBe('duplicate');
    expect(classify(410, GOOGLE_ERRORS.deleted).kind).toBe('gone');
    expect(classify(412, GOOGLE_ERRORS.conditionNotMet).kind).toBe('precondition');
    expect(classify(400, googleError(400, 'timeRangeEmpty', 'empty', 'calendar'))).toMatchObject({ kind: 'rejected', reason: 'timeRangeEmpty' });
    expect(classify(503, 'html').kind).toBe('server');
  });

  it('reads every reason in an error body, never throws on an odd one, and takes a usageLimits 403 as a rate limit (R2-M10)', () => {
    // The rate-limit reason isn't first.
    const mixed = { error: { errors: [{ domain: 'global', reason: 'somethingElse' }, { domain: 'usageLimits', reason: 'rateLimitExceeded' }], code: 403 } };
    expect(classify(403, mixed).kind).toBe('rate_limited');
    expect(classify(403, { error: { errors: [{ domain: 'global', reason: 'other' }, { reason: 'insufficientPermissions' }] } }).kind).toBe('scope');
    // A reason Google adds later, in the usage limits domain.
    expect(classify(403, googleError(403, 'dailyLimitExceeded2', 'x', 'usageLimits')).kind).toBe('rate_limited');
    expect(classify(403, { error: { code: 403, details: [{ reason: 'nope' }, { domain: 'usageLimits', reason: 'RATE_LIMIT_EXCEEDED' }] } }).kind).toBe('rate_limited');
    for (const body of [
      { error: { errors: 'not a list', details: { reason: 'x' } } },
      { error: { errors: [null, 7, 'x'], details: [null] } },
      { error: null }, { error: 'x' }, [], 'text', 42, null, undefined,
      Object.defineProperty({}, 'error', { get() { throw new Error('boom'); } }),
    ]) {
      expect(() => classify(403, body)).not.toThrow();
      expect(classify(403, body).kind).toBe('forbidden');
      expect(classify(500, body).kind).toBe('server');
    }
  });

  it("takes a 403 saying the Calendar API isn't enabled as its own kind, never a rate limit (C-M2)", () => {
    // In the usageLimits domain, which would otherwise be a rate limit.
    expect(classify(403, GOOGLE_ERRORS.accessNotConfigured)).toMatchObject({ kind: 'api_disabled', reason: 'accessNotConfigured', retryAfterSec: null });
    expect(classify(403, googleError(403, 'accessNotConfigured', 'Access Not Configured.', 'usageLimits')).kind).toBe('api_disabled');
    expect(classify(403, { error: { code: 403, status: 'PERMISSION_DENIED', details: [{ reason: 'SERVICE_DISABLED', domain: 'googleapis.com' }] } }).kind).toBe('api_disabled');
    // Only the message says so.
    expect(classify(403, googleError(403, 'forbidden', 'Google Calendar API has not been used in project 1 before or it is disabled.')).kind).toBe('api_disabled');
    expect(classify(403, { error: { code: 403, message: 'Calendar API is not enabled for this project.' } }).kind).toBe('api_disabled');
    expect(classify(403, { error: { code: 403, message: 7, errors: [{ message: null }] } }).kind).toBe('forbidden');
    // Other things that are disabled aren't the API.
    expect(classify(403, googleError(403, 'forbidden', 'The user account is disabled.')).kind).toBe('forbidden');
    // Only a 403 says it.
    expect(classify(400, GOOGLE_ERRORS.accessNotConfigured).kind).toBe('rejected');
  });

  it("doesn't retry a call when the Calendar API isn't enabled (C-M2)", async () => {
    const t = setup();
    t.fake.failures.push({ path: 'list', status: 403, body: GOOGLE_ERRORS.accessNotConfigured }, { path: 'list', status: 403, body: GOOGLE_ERRORS.accessNotConfigured });
    await expect(t.client.listEvents(t.token, t.cal.id, WINDOW)).rejects.toMatchObject({ kind: 'api_disabled' });
    expect(t.fake.requests.filter((r) => r.path.endsWith('/events'))).toHaveLength(1);
    expect(t.sleeps).toEqual([]);
  });

  it('starts a retry only when its wait plus a second fits before the deadline (R2-M8)', async () => {
    const t = setup();
    // 2 seconds of Retry-After with 2.4 left: the retry couldn't finish in time.
    t.fake.failures.push({ path: 'get', status: 429, body: GOOGLE_ERRORS.tooManyRequests, headers: { 'retry-after': '2' } });
    await expect(t.client.getEvent(t.token, t.cal.id, 'x', { deadline: Date.now() + 2_400 })).rejects.toMatchObject({ kind: 'rate_limited' });
    expect(t.sleeps).toEqual([]);
    // 1 second of it with 2.4 left: it does.
    const e = t.fake.addEvent(t.cal, timed(17));
    t.fake.failures.push({ path: 'get', status: 429, body: GOOGLE_ERRORS.tooManyRequests, headers: { 'retry-after': '1' } });
    await expect(t.client.getEvent(t.token, t.cal.id, String(e.id), { deadline: Date.now() + 2_400 })).resolves.toMatchObject({ event: { id: e.id } });
    expect(t.sleeps).toEqual([1000]);
  });

  it("takes a 2xx whose body couldn't be read as no answer (R2-M9)", async () => {
    const broken = async () => new Response(new ReadableStream({ start(c) { c.error(new Error('connection reset')); } }), { status: 200, headers: { 'content-type': 'application/json' } });
    const client = new GoogleCalendarClient('https://api.google.test/calendar/v3', broken, { sleep: async () => {} });
    await expect(client.patchEvent('t', 'c', 'e', { summary: 'x' }, '"1"')).rejects.toMatchObject({ kind: 'network', status: null });
  });

  it('retries an insert after a 5xx only when it carries its own id (R2-M11)', async () => {
    const t = setup();
    t.fake.failures.push({ path: 'insert', status: 503 });
    await expect(t.client.insertEvent(t.token, t.cal.id, timed(17))).rejects.toMatchObject({ kind: 'server' });
    expect(t.fake.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/events'))).toHaveLength(1);
    t.fake.failures.push({ path: 'insert', status: 503 });
    await expect(t.client.insertEvent(t.token, t.cal.id, { id: 'dash0000000000000002', ...timed(17) })).resolves.toMatchObject({ id: 'dash0000000000000002' });
    expect(t.fake.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/events'))).toHaveLength(3);
  });

  it('backs off and retries a rate limit, and a 5xx on a read, a bounded number of times', async () => {
    const t = setup();
    t.fake.failures.push({ path: 'list', status: 429, body: GOOGLE_ERRORS.tooManyRequests }, { path: 'list', status: 500, body: GOOGLE_ERRORS.backendError });
    await t.client.listEvents(t.token, t.cal.id, WINDOW);
    expect(t.sleeps).toEqual([1500, 2500]);
    t.fake.failures.push(...[1, 2, 3].map(() => ({ path: 'get' as const, status: 503 })));
    await expect(t.client.getEvent(t.token, t.cal.id, 'x')).rejects.toMatchObject({ kind: 'server' });
    expect(t.fake.requests.filter((r) => r.method === 'GET' && r.path.endsWith('/events/x'))).toHaveLength(3);
  });

  it("doesn't resend a patch after a 5xx (it may have been applied), only after a rate limit", async () => {
    const t = setup();
    const e = t.fake.addEvent(t.cal, timed(17));
    t.fake.failures.push({ path: 'patch', status: 500 });
    await expect(t.client.patchEvent(t.token, t.cal.id, String(e.id), { summary: 'x' }, String(e.etag))).rejects.toMatchObject({ kind: 'server' });
    t.fake.failures.push({ path: 'patch', status: 403, body: GOOGLE_ERRORS.rateLimitExceeded });
    await expect(t.client.patchEvent(t.token, t.cal.id, String(e.id), { summary: 'x' }, String(e.etag))).resolves.toMatchObject({ summary: 'x' });
  });

  it("gives up at once on a Retry-After longer than it's willing to wait, and on no answer for a patch", async () => {
    const t = setup();
    t.fake.failures.push({ path: 'list', status: 429, body: GOOGLE_ERRORS.tooManyRequests, headers: { 'retry-after': '120' } });
    await expect(t.client.listEvents(t.token, t.cal.id, WINDOW)).rejects.toMatchObject({ kind: 'rate_limited', retryAfterSec: 120 });
    expect(t.sleeps).toEqual([]);
    const offline = new GoogleCalendarClient('https://api.google.test/calendar/v3', () => Promise.reject(new TypeError('fetch failed')), { sleep: async () => {} });
    await expect(offline.getEvent('t', 'c', 'e', { deadline: Date.now() - 1 })).rejects.toMatchObject({ kind: 'network', reason: 'deadline' });
    const err = await offline.patchEvent('t', 'c', 'e', {}, '"1"').catch((x: unknown) => x);
    expect(err).toBeInstanceOf(GoogleApiError);
    expect(err).toMatchObject({ kind: 'network', status: null });
  });
});
