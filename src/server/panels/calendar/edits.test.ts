import { describe, expect, it } from 'vitest';
import type { StoredEvent } from '../../../shared/calendar.js';
import type { GoogleEvent } from '../../integrations/google/calendarClient.js';
import { changedInstances, eventTimes, insertTimes, mergePatch, moveSeries, newEventId, seriesStart, seriesZone } from './edits.js';

const LA = 'America/Los_Angeles';
const TOKYO = 'Asia/Tokyo';

describe('eventTimes', () => {
  it('writes a timed event with the offset in force and a zone, clearing date', () => {
    expect(eventTimes({ allDay: false, startDate: '2026-11-20', endDate: '2026-11-20', startTime: '09:00', endTime: '10:30' }, LA)).toEqual({
      start: { dateTime: '2026-11-20T09:00:00-08:00', timeZone: LA, date: null },
      end: { dateTime: '2026-11-20T10:30:00-08:00', timeZone: LA, date: null },
    });
    // Keeps the event's own zone label; the times are still exact.
    expect(eventTimes({ allDay: false, startDate: '2026-07-04', endDate: '2026-07-04', startTime: '18:00', endTime: '19:00' }, LA, 'America/New_York').start)
      .toEqual({ dateTime: '2026-07-04T18:00:00-07:00', timeZone: 'America/New_York', date: null });
  });

  it("writes an all-day event with Google's exclusive end date, clearing dateTime and timeZone", () => {
    expect(eventTimes({ allDay: true, startDate: '2026-11-26', endDate: '2026-11-27', startTime: null, endTime: null }, LA)).toEqual({
      start: { date: '2026-11-26', dateTime: null, timeZone: null },
      end: { date: '2026-11-28', dateTime: null, timeZone: null },
    });
    expect(insertTimes({ allDay: true, startDate: '2026-11-26', endDate: '2026-11-26', startTime: null, endTime: null }, LA)).toEqual({ start: { date: '2026-11-26' }, end: { date: '2026-11-27' } });
  });
});

describe('mergePatch', () => {
  it('merges objects, deletes nulls, replaces arrays, and keeps every field it was not told about', () => {
    const event = {
      id: 'e1', summary: 'Piano', location: 'Hall', attendees: [{ email: 'a@example.com' }], reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] },
      extendedProperties: { private: { dashboardCreatedBy: 'x:1' }, shared: { other: 'app' } },
    };
    expect(mergePatch(event, { summary: 'Cello', location: null, extendedProperties: { private: { dashboardUpdatedBy: 'x:2' } }, recurrence: ['RRULE:FREQ=DAILY'] })).toEqual({
      id: 'e1', summary: 'Cello', attendees: [{ email: 'a@example.com' }], reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] },
      extendedProperties: { private: { dashboardCreatedBy: 'x:1', dashboardUpdatedBy: 'x:2' }, shared: { other: 'app' } },
      recurrence: ['RRULE:FREQ=DAILY'],
    });
    expect(event.location).toBe('Hall'); // the original isn't touched
  });
});

describe('seriesZone and seriesStart', () => {
  it("uses the series' own zone, then the calendar's, then the family's", () => {
    expect(seriesZone({ id: 's', etag: 'e', start: { dateTime: '2026-11-03T09:00:00+09:00', timeZone: TOKYO } }, LA, LA)).toBe(TOKYO);
    expect(seriesZone({ id: 's', etag: 'e', start: { dateTime: '2026-11-03T09:00:00-05:00' } }, 'America/New_York', LA)).toBe('America/New_York');
    expect(seriesZone({ id: 's', etag: 'e', start: { date: '2026-11-03' } }, null, LA)).toBe(LA);
  });

  it("reads a series' first day and time in its own zone", () => {
    const tokyo: GoogleEvent = { id: 's', etag: 'e', start: { dateTime: '2026-11-03T09:00:00+09:00', timeZone: TOKYO } };
    expect(seriesStart(tokyo, TOKYO)).toEqual({ allDay: false, date: '2026-11-03', time: '09:00' });
    // The same instant is Monday afternoon in Los Angeles, which is not what its weekdays mean.
    expect(seriesStart(tokyo, LA)).toEqual({ allDay: false, date: '2026-11-02', time: '16:00' });
    expect(seriesStart({ id: 's', etag: 'e', start: { date: '2026-01-05' } }, LA)).toEqual({ allDay: true, date: '2026-01-05', time: null });
  });
});

/** An instance as the panel stores it: only the fields `moveSeries` reads. */
function instance(fields: Pick<StoredEvent, 'startDate' | 'startsAt'>): StoredEvent {
  return fields as StoredEvent;
}

describe('moveSeries', () => {
  // A Tuesday series from November 3, 09:00 to 10:00 in Los Angeles.
  const la: GoogleEvent = { id: 's', etag: 'e', start: { dateTime: '2026-11-03T09:00:00-08:00', timeZone: LA }, end: { dateTime: '2026-11-03T10:00:00-08:00', timeZone: LA } };
  const nov17 = instance({ startDate: '2026-11-17', startsAt: '2026-11-17T17:00:00.000Z' });

  it('moves the series by what the instance moved, never to the instance date', () => {
    expect(moveSeries(la, nov17, { allDay: false, startDate: '2026-11-18', endDate: '2026-11-18', startTime: '09:30', endTime: '10:30' }, LA, LA)).toEqual({
      start: { dateTime: '2026-11-04T09:30:00-08:00', timeZone: LA, date: null },
      end: { dateTime: '2026-11-04T10:30:00-08:00', timeZone: LA, date: null },
      days: 1,
      startDate: '2026-11-04',
      startTime: '09:30',
      minutes: 1470,
      startMissing: false,
    });
  });

  it('keeps the series where it is when only the length changes', () => {
    expect(moveSeries(la, nov17, { allDay: false, startDate: '2026-11-17', endDate: '2026-11-17', startTime: '09:00', endTime: '11:00' }, LA, LA)).toMatchObject({
      start: { dateTime: '2026-11-03T09:00:00-08:00' }, end: { dateTime: '2026-11-03T11:00:00-08:00' }, days: 0, startDate: '2026-11-03',
    });
  });

  it('carries a move past midnight into the date', () => {
    expect(moveSeries(la, nov17, { allDay: false, startDate: '2026-11-16', endDate: '2026-11-16', startTime: '23:00', endTime: '23:45' }, LA, LA)).toMatchObject({
      start: { dateTime: '2026-11-02T23:00:00-08:00' }, days: -1, startDate: '2026-11-02',
    });
  });

  it("moves a series by its own zone's days: a Tokyo series viewed from Los Angeles", () => {
    // Tuesdays 09:00 in Tokyo, which is Monday 16:00 in Los Angeles.
    const tokyo: GoogleEvent = { id: 's', etag: 'e', start: { dateTime: '2026-11-03T09:00:00+09:00', timeZone: TOKYO }, end: { dateTime: '2026-11-03T10:00:00+09:00', timeZone: TOKYO } };
    const shown = instance({ startDate: '2026-11-16', startsAt: '2026-11-17T00:00:00.000Z' });
    // An hour later is the same Tokyo day.
    expect(moveSeries(tokyo, shown, { allDay: false, startDate: '2026-11-16', endDate: '2026-11-16', startTime: '17:00', endTime: '18:00' }, LA, TOKYO)).toEqual({
      start: { dateTime: '2026-11-03T10:00:00+09:00', timeZone: TOKYO, date: null },
      end: { dateTime: '2026-11-03T11:00:00+09:00', timeZone: TOKYO, date: null },
      days: 0,
      startDate: '2026-11-03',
      startTime: '10:00',
      minutes: 60,
      startMissing: false,
    });
    // Ten hours earlier is the same day in Los Angeles but the day before in Tokyo: the weekdays have to move.
    expect(moveSeries(tokyo, shown, { allDay: false, startDate: '2026-11-16', endDate: '2026-11-16', startTime: '06:00', endTime: '07:00' }, LA, TOKYO)).toMatchObject({
      start: { dateTime: '2026-11-02T23:00:00+09:00', timeZone: TOKYO }, days: -1, startDate: '2026-11-02',
    });
  });

  it("says when the series' new start doesn't exist on its first day, in a spring-forward gap (R3-M)", () => {
    // A 1:30am Los Angeles series from Sunday, March 8, 2026, when 2:00 to 3:00 is skipped.
    const march: GoogleEvent = { id: 's', etag: 'e', start: { dateTime: '2026-03-08T01:30:00-08:00', timeZone: LA }, end: { dateTime: '2026-03-08T02:00:00-08:00', timeZone: LA } };
    const shown = instance({ startDate: '2026-11-17', startsAt: '2026-11-17T09:30:00.000Z' });
    expect(moveSeries(march, shown, { allDay: false, startDate: '2026-11-17', endDate: '2026-11-17', startTime: '02:30', endTime: '03:00' }, LA, LA))
      .toMatchObject({ startDate: '2026-03-08', startTime: '02:30', startMissing: true });
    expect(moveSeries(march, shown, { allDay: false, startDate: '2026-11-17', endDate: '2026-11-17', startTime: '03:30', endTime: '04:00' }, LA, LA))
      .toMatchObject({ startDate: '2026-03-08', startTime: '03:30', startMissing: false });
  });

  it('moves an all-day series by days and keeps its length in days', () => {
    const allDay: GoogleEvent = { id: 's', etag: 'e', start: { date: '2026-01-05' }, end: { date: '2026-01-06' } };
    expect(moveSeries(allDay, instance({ startDate: '2026-11-16', startsAt: null }), { allDay: true, startDate: '2026-11-17', endDate: '2026-11-18', startTime: null, endTime: null }, LA, LA)).toEqual({
      start: { date: '2026-01-06', dateTime: null, timeZone: null },
      end: { date: '2026-01-08', dateTime: null, timeZone: null },
      days: 1,
      startDate: '2026-01-06',
      startTime: null,
      minutes: 1440,
      startMissing: false,
    });
  });
});

describe('changedInstances', () => {
  const master: GoogleEvent = {
    id: 's', etag: 'e', summary: 'Piano', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU'],
    start: { dateTime: '2026-11-03T09:00:00+09:00', timeZone: TOKYO }, end: { dateTime: '2026-11-03T10:00:00+09:00', timeZone: TOKYO },
  };
  const at = (date: string, from: string, to: string, extra: Partial<GoogleEvent> = {}): GoogleEvent => ({
    id: `s_${date}`, etag: 'i', recurringEventId: 's', summary: 'Piano',
    originalStartTime: { dateTime: `${date}T09:00:00+09:00`, timeZone: TOKYO },
    start: { dateTime: `${date}T${from}:00+09:00`, timeZone: TOKYO }, end: { dateTime: `${date}T${to}:00+09:00`, timeZone: TOKYO },
    ...extra,
  });

  it('counts nothing for instances that are just the series', () => {
    // The same instant written with another offset is the same start.
    const utc = at('2026-11-10', '09:00', '10:00', { start: { dateTime: '2026-11-10T00:00:00Z' }, end: { dateTime: '2026-11-10T01:00:00Z' } });
    expect(changedInstances(master, [at('2026-11-03', '09:00', '10:00'), utc], TOKYO)).toEqual({ count: 0, fields: [] });
  });

  it('counts instances moved, made longer, renamed, or cancelled on their own', () => {
    expect(changedInstances(master, [
      at('2026-11-03', '09:00', '10:00'),
      at('2026-11-10', '11:00', '12:00'),
      at('2026-11-17', '09:00', '11:00'),
      at('2026-11-24', '09:00', '10:00', { summary: 'Piano recital' }),
      { id: 's_2026-12-01', etag: 'c', status: 'cancelled', recurringEventId: 's' },
    ], TOKYO)).toMatchObject({ count: 4 });
  });

  it("compares each instance's whole JSON with the series', leaving out only what differs per instance (R3-I4)", () => {
    const full = {
      ...master, kind: 'calendar#event', status: 'confirmed', created: '2026-10-01T00:00:00Z', updated: '2026-10-02T00:00:00Z', sequence: 0,
      iCalUID: 's@google.com', htmlLink: 'https://www.google.com/calendar/event?eid=s',
      organizer: { email: 'family@example.com', self: true }, attendees: [{ email: 'teacher@example.com', responseStatus: 'accepted' }],
      reminders: { useDefault: true },
    };
    const { recurrence: _r, ...base } = full;
    const instance = (date: string, extra: Record<string, unknown> = {}) => ({
      ...base, ...at(date, '09:00', '10:00'), htmlLink: `https://www.google.com/calendar/event?eid=${date}`, updated: '2026-11-01T00:00:00Z',
      sequence: 3, iCalUID: 's@google.com', status: 'confirmed', ...extra,
    });
    // Only per-instance fields differ: no exceptions.
    expect(changedInstances(full, [instance('2026-11-03'), instance('2026-11-10', { status: 'tentative' })], TOKYO)).toEqual({ count: 0, fields: [] });
    // An extra guest, or its own conference data: exceptions, which the dashboard doesn't read but Google keeps apart.
    const extraGuest = instance('2026-11-17', { attendees: [...full.attendees, { email: 'grandma@example.com' }] });
    const ownMeet = instance('2026-11-24', { conferenceData: { conferenceId: 'abc-defg-hij' } });
    expect(changedInstances(full, [extraGuest, ownMeet], TOKYO)).toEqual({ count: 2, fields: ['attendees', 'conferenceData'] });
    // Key order doesn't matter, nested or not.
    const reordered = instance('2026-12-01', { reminders: { useDefault: true }, organizer: { self: true, email: 'family@example.com' } });
    expect(changedInstances(full, [reordered], TOKYO).count).toBe(0);
    // A field the series has that the instance lacks is a difference too.
    const { reminders: _x, ...noReminders } = instance('2026-12-08');
    expect(changedInstances(full, [noReminders], TOKYO)).toEqual({ count: 1, fields: ['reminders'] });
  });
});

it('makes event ids Google accepts (base32hex, 26 characters)', () => {
  const ids = new Set(Array.from({ length: 50 }, newEventId));
  expect(ids.size).toBe(50);
  for (const id of ids) expect(id).toMatch(/^[a-v0-9]{26}$/);
});
