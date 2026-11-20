import { describe, expect, it } from 'vitest';
import type { GoogleEvent } from '../../integrations/google/calendarClient.js';
import { compareEvents, fetchBounds, inWindow, plainText, safeHtmlLink, toStoredEvent } from './mapping.js';

const INSTALL = '0f1e2d3c4b5a6978';
const LA = { timeZone: 'America/Los_Angeles', calendarTimeZone: 'America/Los_Angeles', installId: INSTALL };

function event(fields: Partial<GoogleEvent>): GoogleEvent {
  return { id: 'evt00001', etag: '"1"', summary: 'Dentist', start: { dateTime: '2026-11-20T09:00:00-08:00' }, end: { dateTime: '2026-11-20T10:00:00-08:00' }, ...fields };
}

describe('toStoredEvent', () => {
  it('keeps an all-day event on its dates, making the exclusive end inclusive', () => {
    // Documented example (research notes §4): a single all-day event on June 1.
    expect(toStoredEvent(event({ start: { date: '2015-06-01' }, end: { date: '2015-06-02' } }), LA)).toMatchObject({
      allDay: true, startDate: '2015-06-01', endDate: '2015-06-01', lastDate: '2015-06-01', startTime: null, endTime: null, startsAt: null,
    });
    expect(toStoredEvent(event({ start: { date: '2026-11-20' }, end: { date: '2026-11-23' } }), LA)).toMatchObject({ startDate: '2026-11-20', endDate: '2026-11-22', lastDate: '2026-11-22' });
  });

  it('puts a timed event in the family time zone, which can move it to another day', () => {
    expect(toStoredEvent(event({}), LA)).toMatchObject({ allDay: false, startDate: '2026-11-20', startTime: '09:00', endDate: '2026-11-20', endTime: '10:00', startsAt: '2026-11-20T17:00:00.000Z' });
    const late = event({ start: { dateTime: '2026-11-21T01:30:00-05:00' }, end: { dateTime: '2026-11-21T02:30:00-05:00' } });
    expect(toStoredEvent(late, LA)).toMatchObject({ startDate: '2026-11-20', startTime: '22:30', endTime: '23:30' });
  });

  it("shows an overnight event on both days, but one that ends at midnight only on its own day", () => {
    const overnight = event({ start: { dateTime: '2026-11-20T22:00:00-08:00' }, end: { dateTime: '2026-11-21T01:00:00-08:00' } });
    expect(toStoredEvent(overnight, LA)).toMatchObject({ startDate: '2026-11-20', endDate: '2026-11-21', lastDate: '2026-11-21' });
    const untilMidnight = event({ start: { dateTime: '2026-11-20T22:00:00-08:00' }, end: { dateTime: '2026-11-21T00:00:00-08:00' } });
    expect(toStoredEvent(untilMidnight, LA)).toMatchObject({ endDate: '2026-11-21', endTime: '00:00', lastDate: '2026-11-20' });
  });

  it('reads a time with no offset in its own zone, else the calendar zone', () => {
    const own = event({ start: { dateTime: '2026-11-20T09:00:00', timeZone: 'America/New_York' }, end: { dateTime: '2026-11-20T10:00:00', timeZone: 'America/New_York' } });
    expect(toStoredEvent(own, LA)).toMatchObject({ startTime: '06:00' });
    const calendars = event({ start: { dateTime: '2026-11-20T09:00:00' }, end: { dateTime: '2026-11-20T10:00:00' } });
    expect(toStoredEvent(calendars, { ...LA, calendarTimeZone: 'America/Chicago' })).toMatchObject({ startTime: '07:00' });
  });

  it('leaves out cancelled events, working-location markers, and times it cannot read', () => {
    expect(toStoredEvent(event({ status: 'cancelled' }), LA)).toBeNull();
    expect(toStoredEvent(event({ eventType: 'workingLocation' }), LA)).toBeNull();
    expect(toStoredEvent(event({ start: { dateTime: 'soon' } }), LA)).toBeNull();
    expect(toStoredEvent(event({ start: undefined }), LA)).toBeNull();
    expect(toStoredEvent(event({ start: { date: '2026-02-30' } }), LA)).toBeNull();
  });

  it('shows other event types, locked events, and invitations read-only', () => {
    expect(toStoredEvent(event({ eventType: 'birthday', start: { date: '2026-11-20' }, end: { date: '2026-11-21' } }), LA)).toMatchObject({ readOnly: 'event_type', eventType: 'birthday' });
    expect(toStoredEvent(event({ eventType: 'outOfOffice' }), LA)).toMatchObject({ readOnly: 'event_type' });
    expect(toStoredEvent(event({ eventType: 'somethingNew' }), LA)).toMatchObject({ readOnly: 'event_type' });
    expect(toStoredEvent(event({ locked: true }), LA)).toMatchObject({ readOnly: 'locked' });
    expect(toStoredEvent(event({ organizer: { self: false } }), LA)).toMatchObject({ readOnly: 'not_organizer' });
    expect(toStoredEvent(event({ organizer: { self: true } }), LA)).toMatchObject({ readOnly: null, eventType: 'default' });
  });

  it('shows a private or confidential event only as being there', () => {
    for (const visibility of ['private', 'confidential']) {
      expect(toStoredEvent(event({ visibility, summary: 'Surprise party', location: 'Home', description: 'Shh' }), LA)).toMatchObject({
        title: 'Private event', location: null, description: null, readOnly: 'private', startTime: '09:00',
      });
      // Nor who added or changed it, or a link to its details (R3-M).
      const attributed = event({
        visibility, htmlLink: 'https://www.google.com/calendar/event?eid=x',
        extendedProperties: { private: { dashboardCreatedBy: `${INSTALL}:3`, dashboardUpdatedBy: `${INSTALL}:5` } },
      });
      expect(toStoredEvent(attributed, LA)).toMatchObject({ createdById: null, updatedById: null, htmlLink: null });
    }
  });

  it("gives a description kept as HTML as plain text, flagged so it isn't edited", () => {
    const html = '<b>Bring</b>:<br>snacks &amp; water<ul><li>towel</li></ul>';
    expect(toStoredEvent(event({ description: html }), LA)).toMatchObject({ description: 'Bring:\nsnacks & water• towel', descriptionIsHtml: true });
    expect(toStoredEvent(event({ description: 'Gate code 1234 < 5' }), LA)).toMatchObject({ description: 'Gate code 1234 < 5', descriptionIsHtml: false });
    for (const plain of ['Questions to <bob@example.com>', 'Agenda at <https://example.com/a>', 'Ages 3 < 5 > 2']) {
      expect(toStoredEvent(event({ description: plain }), LA)).toMatchObject({ description: plain, descriptionIsHtml: false });
    }
    expect(toStoredEvent(event({ description: 'Line one<br/>Line two' }), LA)).toMatchObject({ description: 'Line one\nLine two', descriptionIsHtml: true });
    expect(toStoredEvent(event({ summary: '  ', location: ' ', description: '' }), LA)).toMatchObject({ title: '(No title)', location: null, description: null });
  });

  it('reads attribution from the private properties, only when this install wrote it', () => {
    expect(toStoredEvent(event({ extendedProperties: { private: { dashboardCreatedBy: `${INSTALL}:3`, dashboardUpdatedBy: `${INSTALL}:5` } } }), LA)).toMatchObject({ createdById: 3, updatedById: 5 });
    // Another install's user 3 is someone else; a bare id, or junk, is nobody.
    expect(toStoredEvent(event({ extendedProperties: { private: { dashboardCreatedBy: 'aaaaaaaaaaaaaaaa:3', dashboardUpdatedBy: '5' } } }), LA)).toMatchObject({ createdById: null, updatedById: null });
    expect(toStoredEvent(event({ extendedProperties: { private: { dashboardCreatedBy: 'alex', dashboardUpdatedBy: `${INSTALL}:0` } } }), LA)).toMatchObject({ createdById: null, updatedById: null });
  });
});

describe('helpers', () => {
  it('asks Google for a day more on each side of the window', () => {
    expect(fetchBounds('2026-11-15', '2026-11-22', 'America/Los_Angeles')).toEqual({ timeMin: '2026-11-14T08:00:00.000Z', timeMax: '2026-11-23T08:00:00.000Z' });
  });

  it('keeps events that show on a day of the window', () => {
    expect(inWindow({ startDate: '2026-11-14', lastDate: '2026-11-15' }, '2026-11-15', '2026-11-22')).toBe(true);
    expect(inWindow({ startDate: '2026-11-14', lastDate: '2026-11-14' }, '2026-11-15', '2026-11-22')).toBe(false);
    expect(inWindow({ startDate: '2026-11-22', lastDate: '2026-11-22' }, '2026-11-15', '2026-11-22')).toBe(false);
  });

  it("links only to Google's own https hosts", () => {
    expect(safeHtmlLink('https://www.google.com/calendar/event?eid=abc')).toBe('https://www.google.com/calendar/event?eid=abc');
    expect(safeHtmlLink('javascript:alert(1)')).toBeNull();
    expect(safeHtmlLink('http://www.google.com/calendar')).toBeNull();
    expect(safeHtmlLink('https://www.google.com.evil.example/')).toBeNull();
    expect(safeHtmlLink(undefined)).toBeNull();
  });

  it('turns HTML into text', () => {
    expect(plainText('<p>One</p><p>Two</p>')).toBe('One\nTwo');
    expect(plainText('a&nbsp;b &lt;c&gt; &quot;d&quot; &#39;e&#39;')).toBe('a b <c> "d" \'e\'');
    expect(plainText('<ul><li class="x">One</li><li>Two</li></ul><a href="https://example.com">link</a>')).toBe('• One\n• Two\nlink');
  });

  it('takes linear time on a description full of unclosed tags (scan finding F1)', () => {
    // Each `<` with no `>` after it used to rescan to the end of the text: quadratic, on the only thread.
    // 100,000 characters took billions of steps before (seconds); linear stripping takes a millisecond.
    for (const filler of ['<', '<li']) {
      const text = `<b>x</b>${filler.repeat(Math.floor(100_000 / filler.length))}`;
      const started = performance.now();
      const out = plainText(text);
      expect(performance.now() - started).toBeLessThan(250);
      expect(out.startsWith('x')).toBe(true);
    }
  });

  it('orders all-day events first within a day, then by start, then by title', () => {
    const e = (id: string, startDate: string, startsAt: string | null, title = id) =>
      ({ ...toStoredEvent(event({}), LA)!, id, startDate, startsAt, allDay: startsAt === null, title });
    const sorted = [e('b', '2026-11-20', '2026-11-20T18:00:00Z'), e('day2', '2026-11-21', null), e('a', '2026-11-20', '2026-11-20T17:00:00Z'), e('all', '2026-11-20', null)]
      .sort(compareEvents).map((x) => x.id);
    expect(sorted).toEqual(['all', 'a', 'b', 'day2']);
  });
});
