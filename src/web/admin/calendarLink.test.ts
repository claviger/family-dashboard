import { describe, expect, it } from 'vitest';
import { CALENDAR_API_DISABLED_MESSAGE, type CalendarLinkInfo } from '../../shared/calendar.js';
import { calendarLinkOutcome, connectedLine, linkProblem, disconnectCalendarConfirm, lastReachedLine, pickAccountLine, pickExpired, pickLabel, reconnectNote } from './calendarLink.js';

const connection: NonNullable<CalendarLinkInfo['connection']> = {
  account: 'family@example.com', calendarId: 'c1', calendarName: 'Family', calendarTimeZone: 'America/Los_Angeles',
  status: 'ok', lastSuccessAt: null, lastError: null, apiDisabled: false, linkedBy: 'Alex',
};

describe('calendarLinkOutcome', () => {
  it('reads the redirect back from Google, ignoring codes it does not know', () => {
    expect(calendarLinkOutcome('?calendar=choose')).toEqual({ kind: 'choose' });
    expect(calendarLinkOutcome('?calendar_error=scopes')).toEqual({ kind: 'error', code: 'scopes' });
    expect(calendarLinkOutcome('?calendar_error=toString')).toBeNull();
    expect(calendarLinkOutcome('')).toBeNull();
  });
});

describe('copy', () => {
  it('warns that disconnecting ends the Google account consent too, but no dashboard session', () => {
    const text = disconnectCalendarConfirm(connection);
    expect(text).toContain('(family@example.com)');
    expect(text).toContain('Nobody is signed out of the dashboard.');
    expect(text).not.toMatch(/—/);
    expect(disconnectCalendarConfirm({ ...connection, account: null })).toContain("the Google account it's connected with, including");
  });

  it('says what is connected, and labels calendars in the picker', () => {
    expect(connectedLine(connection)).toBe('Showing Family, through Google as family@example.com. Connected by Alex.');
    expect(pickLabel({ name: 'Family', primary: false, timeZone: 'America/Los_Angeles' }, 'America/Los_Angeles')).toBe('Family');
    expect(pickLabel({ name: 'family@example.com', primary: true, timeZone: 'Europe/Berlin' }, 'America/Los_Angeles')).toBe('family@example.com (main calendar, in Europe/Berlin)');
  });
});

describe("what's wrong with the link", () => {
  it("says the Calendar API isn't turned on over it being unreachable, but a reconnect comes first (C-M2)", () => {
    expect(linkProblem(connection)).toBeNull();
    expect(linkProblem({ ...connection, apiDisabled: true })).toEqual({ alert: true, text: CALENDAR_API_DISABLED_MESSAGE });
    expect(linkProblem({ ...connection, status: 'error', lastError: CALENDAR_API_DISABLED_MESSAGE, apiDisabled: true })).toEqual({ alert: true, text: CALENDAR_API_DISABLED_MESSAGE });
    expect(linkProblem({ ...connection, status: 'error', lastError: "Google Calendar couldn't be reached." }))
      .toEqual({ alert: false, text: "Google Calendar hasn't been reachable for a while: Google Calendar couldn't be reached. It keeps trying." });
    expect(linkProblem({ ...connection, status: 'needs_reconnect', apiDisabled: true }))
      .toEqual({ alert: true, text: "Google Calendar needs to be reconnected. Until then the calendar shows what was last fetched, and changes can't be saved." });
  });
});

describe('picking after a sign-in', () => {
  it('says which account signed in, and what choosing does to a different connected one', () => {
    expect(pickAccountLine('family@example.com', 'family@example.com')).toEqual({ signedIn: 'Connected as family@example.com.', replaces: null });
    expect(pickAccountLine('alex@example.com', 'family@example.com')).toEqual({
      signedIn: 'Connected as alex@example.com.',
      replaces: "Choosing a calendar here replaces the connection through family@example.com, and removes the dashboard's access from that account.",
    });
    expect(pickAccountLine(null, null).replaces).toBeNull();
    // Only when both accounts are known is it clear they differ (R4-M5).
    expect(pickAccountLine(null, 'family@example.com').replaces).toBeNull();
    expect(pickAccountLine('alex@example.com', null).replaces).toBeNull();
    expect(reconnectNote(connection)).toContain('removed from family@example.com once you pick a calendar');
  });

  it('says a pick expired only when the page came back for one and never showed it', () => {
    const none = { pending: null };
    const waiting = { pending: { account: null, calendars: [], expiresAt: '2026-11-15T12:10:00Z' } };
    expect(pickExpired({ kind: 'choose' }, none, false)).toBe(true);
    expect(pickExpired({ kind: 'choose' }, none, true)).toBe(false); // picked or cancelled here
    expect(pickExpired({ kind: 'choose' }, waiting, false)).toBe(false);
    expect(pickExpired({ kind: 'choose' }, undefined, false)).toBe(false); // still loading
    expect(pickExpired(null, none, false)).toBe(false);
  });
});

describe('lastReachedLine (R4-M6)', () => {
  it("says when Google was last reached in the family's time zone, not the browser's", () => {
    expect(lastReachedLine('2026-11-15T12:00:00Z', 'America/Los_Angeles', 'en-US')).toMatch(/^Last reached Google Nov 15, 2026, 4:00\sAM\.$/);
    expect(lastReachedLine('2026-11-15T12:00:00Z', 'Europe/Berlin', 'en-US')).toMatch(/^Last reached Google Nov 15, 2026, 1:00\sPM\.$/);
    expect(lastReachedLine(null, 'America/Los_Angeles')).toBe('Not reached Google yet.');
  });
});
