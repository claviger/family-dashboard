import { describe, expect, it } from 'vitest';
import { CALENDAR_API_DISABLED_MESSAGE, CALENDAR_RECONNECT_MESSAGE, CALENDAR_UNREADABLE_MESSAGE, type CalendarEvent, type CalendarFreshness } from '../../../shared/calendar.js';
import { agendaDays, entryTime, summaryAgenda } from './agenda.js';
import { CARD_EVENT_KEY, monthWeeks, newEventDate, openEventId, rangeFor, rangeTitle, step, timesInLine, todayIn, viewFromSearch, weekStartOf, zoneName } from './calendarView.js';
import { cachedEventNote, eventButtonLabel, freshnessLine, readOnlyNote } from './format.js';

function ev(id: string, fields: Partial<CalendarEvent> = {}): CalendarEvent {
  return {
    id, etag: '"1"', seriesId: null, title: id, location: null, description: null, descriptionIsHtml: false, allDay: false,
    startDate: '2026-11-16', endDate: '2026-11-16', lastDate: '2026-11-16', startTime: '09:00', endTime: '10:00', startsAt: '2026-11-16T17:00:00.000Z',
    readOnly: null, eventType: 'default', htmlLink: null, createdBy: null, updatedBy: null, ...fields,
  };
}

describe('views and windows', () => {
  it('defaults to the agenda on phones and the month on wider screens, and reads the date', () => {
    expect(viewFromSearch({}, '2026-11-15', false)).toEqual({ view: 'agenda', anchor: '2026-11-15' });
    expect(viewFromSearch({}, '2026-11-15', true)).toEqual({ view: 'month', anchor: '2026-11-15' });
    expect(viewFromSearch({ view: 'week', date: '2026-12-01' }, '2026-11-15', false)).toEqual({ view: 'week', anchor: '2026-12-01' });
    expect(viewFromSearch({ view: 'year', date: '2026-02-30' }, '2026-11-15', true)).toEqual({ view: 'month', anchor: '2026-11-15' });
  });

  it('covers a week from the day, a Sunday-to-Saturday week, or whole weeks around the month', () => {
    expect(weekStartOf('2026-11-18')).toBe('2026-11-15');
    expect(rangeFor('agenda', '2026-11-18')).toEqual({ start: '2026-11-18', end: '2026-11-25' });
    expect(rangeFor('week', '2026-11-18')).toEqual({ start: '2026-11-15', end: '2026-11-22' });
    expect(rangeFor('month', '2026-11-18')).toEqual({ start: '2026-11-01', end: '2026-12-06' });
    expect(rangeFor('month', '2026-02-10')).toEqual({ start: '2026-02-01', end: '2026-03-01' });
    expect(monthWeeks('2026-11-18')).toHaveLength(5);
    expect(monthWeeks('2026-11-18')[0]).toEqual(['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07']);
    expect(rangeFor('month', '2026-08-01').end).toBe('2026-09-06'); // six weeks, the most a request may ask for
  });

  it('steps a week at a time, or a month', () => {
    expect(step('agenda', '2026-11-18', 1)).toBe('2026-11-25');
    expect(step('week', '2026-11-18', -1)).toBe('2026-11-11');
    expect(step('month', '2026-11-18', 1)).toBe('2026-12-01');
    expect(step('month', '2026-01-31', -1)).toBe('2025-12-01');
  });

  it('titles the range in words, without dashes', () => {
    expect(rangeTitle('month', '2026-11-18')).toBe('November 2026');
    expect(rangeTitle('week', '2026-11-18')).toBe('November 15 to 21, 2026');
    expect(rangeTitle('agenda', '2026-11-28')).toBe('November 28 to December 4, 2026');
    expect(rangeTitle('agenda', '2026-12-28')).toBe('December 28, 2026 to January 3, 2027');
  });

  it("knows today in the family's zone", () => {
    expect(todayIn('America/Los_Angeles', Date.parse('2026-11-16T05:00:00Z'))).toBe('2026-11-15');
    expect(todayIn('Asia/Tokyo', Date.parse('2026-11-16T05:00:00Z'))).toBe('2026-11-16');
  });
});

describe('agendas', () => {
  const trip = ev('Trip', { allDay: true, startDate: '2026-11-16', endDate: '2026-11-18', lastDate: '2026-11-18', startTime: null, endTime: null, startsAt: null });
  const overnight = ev('Sleepover', { startDate: '2026-11-16', lastDate: '2026-11-18', endDate: '2026-11-18', startTime: '19:00', endTime: '10:00', startsAt: '2026-11-17T03:00:00.000Z' });

  it("shows each event on every day it covers, all-day ones first, and a longer event's middle days as all day", () => {
    const days = agendaDays([ev('Late', { startsAt: '2026-11-16T20:00:00.000Z' }), overnight, ev('Early'), trip], '2026-11-16', '2026-11-19');
    expect(days.map((d) => [d.date, d.entries.map((e) => `${e.event.id}:${e.part}`)])).toEqual([
      ['2026-11-16', ['Trip:first', 'Early:only', 'Late:only', 'Sleepover:first']],
      ['2026-11-17', ['Trip:middle', 'Sleepover:middle']],
      ['2026-11-18', ['Trip:last', 'Sleepover:last']],
    ]);
    const fmt = (t: string) => t;
    expect(days[0]!.entries.map((e) => entryTime(e, fmt, true))).toEqual(['All day', '09:00 to 10:00', '09:00 to 10:00', '19:00']);
    expect(days[2]!.entries.map((e) => entryTime(e, fmt))).toEqual(['All day', 'Until 10:00']);
  });

  it('lists each event once on the card, up to 6, and counts the rest of the week', () => {
    const events = [trip, ...['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id, i) => ev(id, { startDate: `2026-11-${16 + (i % 3)}`, lastDate: `2026-11-${16 + (i % 3)}`, startsAt: `2026-11-${16 + (i % 3)}T1${i}:00:00.000Z` }))];
    const { days, more } = summaryAgenda(events, '2026-11-15', '2026-11-22');
    expect(days.flatMap((d) => d.entries.map((e) => e.event.id))).toEqual(['Trip', 'a', 'd', 'g', 'b', 'e']);
    expect(more).toBe(2);
    expect(summaryAgenda([], '2026-11-15', '2026-11-22')).toEqual({ days: [], more: 0 });
  });
});

describe('freshness and read-only notes', () => {
  const f: CalendarFreshness = { connected: true, calendarName: 'Family', status: 'ok', readOnly: null, fetchedAt: '2026-11-15T12:00:00.000Z', serverNow: '2026-11-15T12:00:00.000Z' };
  it('says how old the events are, and warns after 10 minutes', () => {
    expect(freshnessLine(f, Date.parse('2026-11-15T12:04:00Z'))).toEqual({ text: 'Google Calendar · updated 4 minutes ago', stale: false });
    expect(freshnessLine(f, Date.parse('2026-11-15T12:11:00Z'))).toEqual({ text: 'Google Calendar · updated 11 minutes ago', stale: true });
    expect(freshnessLine({ ...f, fetchedAt: null }, 0)).toEqual({ text: 'Google Calendar · not fetched yet', stale: false });
    expect(freshnessLine({ ...f, connected: false }, 0)).toBeNull();
  });

  it('explains why changes are off', () => {
    expect(readOnlyNote(f, false)).toBeNull();
    for (const readOnly of ['needs_reconnect', 'key_mismatch', 'unreachable', 'api_disabled'] as const) {
      for (const isAdmin of [false, true]) {
        const note = readOnlyNote({ ...f, readOnly }, isAdmin);
        expect(note).toMatch(/last fetched/);
        expect(note).not.toMatch(/—/);
      }
    }
  });

  it("tells an admin the Calendar API isn't turned on, and everyone else that an admin needs to fix it (C-M2)", () => {
    expect(readOnlyNote({ ...f, readOnly: 'api_disabled' }, true)).toBe(`${CALENDAR_API_DISABLED_MESSAGE} Until then, this shows what was last fetched, and changes can't be saved.`);
    expect(readOnlyNote({ ...f, readOnly: 'api_disabled' }, false)).toBe("Google Calendar isn't working right now, so this shows what was last fetched, and changes can't be saved. An admin needs to fix it.");
  });
});

describe('the day a new event starts on (R5-M3)', () => {
  it('is today when the view shows it, else the shown month, or the start of the shown week', () => {
    expect(newEventDate('month', '2026-11-01', '2026-11-15')).toBe('2026-11-15');
    // The December grid starts on Sunday, November 29, but a new event belongs in December.
    expect(newEventDate('month', '2026-12-01', '2026-11-15')).toBe('2026-12-01');
    expect(newEventDate('month', '2026-12-01', '2026-11-30')).toBe('2026-12-01');
    expect(newEventDate('week', '2026-11-25', '2026-11-15')).toBe('2026-11-22');
    expect(newEventDate('week', '2026-11-18', '2026-11-15')).toBe('2026-11-15');
    expect(newEventDate('agenda', '2026-11-20', '2026-11-15')).toBe('2026-11-20');
  });
});

describe("the device's time zone (R5-M8)", () => {
  it('names the family zone in words, and says so only when the device is elsewhere', () => {
    expect(zoneName('America/Los_Angeles', 'en-US', new Date('2026-11-15T12:00:00Z'))).toBe('Pacific Time');
    expect(zoneName('America/Los_Angeles', 'en-US', new Date('2026-07-15T12:00:00Z'))).toBe('Pacific Time');
    expect(timesInLine('America/Los_Angeles', 'America/Los_Angeles')).toBeNull();
    expect(timesInLine('America/Los_Angeles', 'Europe/Berlin', 'en-US', new Date('2026-11-15T12:00:00Z'))).toBe('Times are in Pacific Time.');
  });
});

describe('an event opened while Google is out of reach (R5-M12)', () => {
  it('says it is the version last fetched, and why it is read-only', () => {
    expect(cachedEventNote('needs_reconnect')).toBe("Google Calendar needs to be reconnected, so this is the event as last fetched, and it can't be changed until then.");
    expect(cachedEventNote('key_mismatch')).toMatch(/^Google Calendar is off until an admin fixes the server's encryption key/);
    expect(cachedEventNote('unreachable')).toBe("Couldn't reach Google Calendar, so this is the event as last fetched, and it can't be changed right now.");
    expect(cachedEventNote(null)).toBe(cachedEventNote('unreachable'));
  });

  it("says why by the event's own read when the window was fine: unreachable, needs reconnecting, or couldn't read it (C-M3)", () => {
    expect(cachedEventNote(null, CALENDAR_RECONNECT_MESSAGE)).toBe(cachedEventNote('needs_reconnect'));
    expect(cachedEventNote('unreachable', CALENDAR_RECONNECT_MESSAGE)).toBe(cachedEventNote('needs_reconnect'));
    expect(cachedEventNote(null, CALENDAR_UNREADABLE_MESSAGE)).toBe("Google Calendar sent this event in a form the dashboard can't read, so this is the event as last fetched. Open it in Google Calendar to change it.");
    expect(cachedEventNote(null, "Couldn't reach Google Calendar. Try again in a few minutes.")).toBe(cachedEventNote('unreachable'));
    expect(cachedEventNote('key_mismatch', 'anything')).toBe(cachedEventNote('key_mismatch'));
    expect(cachedEventNote(null, CALENDAR_API_DISABLED_MESSAGE)).toBe(cachedEventNote('api_disabled'));
    expect(cachedEventNote('api_disabled')).toMatch(/turned on/);
    for (const note of [cachedEventNote(null, CALENDAR_UNREADABLE_MESSAGE), cachedEventNote('api_disabled')]) expect(note).not.toMatch(/—/);
  });
});

describe("an event button's name (R5-I2)", () => {
  it('carries the date in the month view, where the cell around it is not read with it', () => {
    expect(eventButtonLabel('Swim', '9:00 AM', null)).toBe('Swim, 9:00 AM');
    expect(eventButtonLabel('Swim', '9:00 AM', 'Wednesday, November 18')).toBe('Swim, Wednesday, November 18, 9:00 AM');
  });
});

describe('the open event in the query string', () => {
  it("reads the drill-down's ?event= and the home card's own key", () => {
    expect(CARD_EVENT_KEY).toBe('calendarEvent');
    expect(openEventId({ event: 'abc123', view: 'week' }, 'event')).toBe('abc123');
    expect(openEventId({ calendarEvent: 'abc123' }, CARD_EVENT_KEY)).toBe('abc123');
    // Each page reads only its own key, so the card never opens the drill-down's event or the other way round.
    expect(openEventId({ event: 'abc123' }, CARD_EVENT_KEY)).toBeNull();
    expect(openEventId({ calendarEvent: 'abc123' }, 'event')).toBeNull();
  });

  it('is closed for an empty or missing id, or anything that is not text', () => {
    expect(openEventId({}, 'event')).toBeNull();
    expect(openEventId({ calendarEvent: '' }, CARD_EVENT_KEY)).toBeNull();
    for (const value of [12, true, null, ['a'], { id: 'a' }]) expect(openEventId({ calendarEvent: value }, CARD_EVENT_KEY)).toBeNull();
  });
});
