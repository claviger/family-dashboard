import { CALENDAR_API_DISABLED_MESSAGE, CALENDAR_RECONNECT_MESSAGE, CALENDAR_STALE_AFTER_MS, CALENDAR_UNREADABLE_MESSAGE, type CalendarFreshness, type CalendarReadOnlyState, type ReadOnlyReason } from '../../../shared/calendar.js';
import { addDays } from '../../../shared/dates.js';
import { formatAgo, isStale } from '../../freshness.js';

/** "07:30" in the viewer's locale, e.g. "7:30 AM". The time is already family-local. */
export function formatTime(time: string, locale?: string): string {
  const [h, m] = time.split(':').map(Number);
  return new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' }).format(new Date(Date.UTC(2000, 0, 1, h ?? 0, m ?? 0)));
}

/** "Today", "Tomorrow", or a day like "Wednesday, November 18" (with the year if it differs). */
export function dayHeading(date: string, today: string, locale?: string): string {
  if (date === today) return 'Today';
  if (date === addDays(today, 1)) return 'Tomorrow';
  return longDay(date, today, locale);
}

/** "Wednesday, November 18", with the year if it isn't this year's. */
export function longDay(date: string, today: string, locale?: string): string {
  return new Intl.DateTimeFormat(locale, {
    weekday: 'long', month: 'long', day: 'numeric', year: date.slice(0, 4) === today.slice(0, 4) ? undefined : 'numeric', timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}

/** "Sun", "Mon", ... and the full name, for the month view's column headers. */
export function weekdayNames(locale?: string): { short: string; long: string }[] {
  // 2026-11-15 is a Sunday.
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 10, 15 + i));
    return {
      short: new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' }).format(d),
      long: new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone: 'UTC' }).format(d),
    };
  });
}

/**
 * "Updated X ago" for the calendar (spec §7, §8), with a warning once it's older than twice the
 * 5-minute refresh. `now` is by the server's clock (`serverNowEstimate`).
 */
export function freshnessLine(f: CalendarFreshness, now: number): { text: string; stale: boolean } | null {
  if (!f.connected) return null;
  if (!f.fetchedAt) return { text: 'Google Calendar · not fetched yet', stale: false };
  return { text: `Google Calendar · updated ${formatAgo(f.fetchedAt, now)}`, stale: isStale(f.fetchedAt, now, CALENDAR_STALE_AFTER_MS) };
}

/**
 * Why the events can't be changed right now (spec §9.2, §14), or null when they can. The Calendar
 * API being off is something only an admin can fix, in the Google Cloud console, so only an admin
 * is told how (C-M2).
 */
export function readOnlyNote(f: CalendarFreshness, isAdmin: boolean): string | null {
  switch (f.readOnly) {
    case 'api_disabled':
      return isAdmin
        ? `${CALENDAR_API_DISABLED_MESSAGE} Until then, this shows what was last fetched, and changes can't be saved.`
        : "Google Calendar isn't working right now, so this shows what was last fetched, and changes can't be saved. An admin needs to fix it.";
    case 'needs_reconnect':
      return "Google Calendar needs to be reconnected, so this shows what was last fetched and changes can't be saved.";
    case 'key_mismatch':
      return "Google Calendar is off until an admin fixes the server's encryption key. This shows what was last fetched.";
    case 'unreachable':
      return "Couldn't reach Google Calendar. This shows what was last fetched, and changes can't be saved right now.";
    default:
      return null;
  }
}

/**
 * Opening an event fetches it fresh from Google. When that can't happen, the event as the window
 * last fetched it is shown, read-only, with this note (R5-M12). It says why by the event's own
 * read (`detailError`, its message) first, since the window may have been fetched before things
 * changed: the link needs reconnecting, or Google sent the event in a form the dashboard can't
 * read (C-M3). Otherwise it's the window's state, and anything else reads as unreachable.
 */
export function cachedEventNote(readOnly: CalendarReadOnlyState | null, detailError?: string): string {
  const reason = readOnly === 'key_mismatch' ? 'key_mismatch'
    : detailError === CALENDAR_RECONNECT_MESSAGE ? 'needs_reconnect'
    : detailError === CALENDAR_UNREADABLE_MESSAGE ? 'unreadable'
    : detailError === CALENDAR_API_DISABLED_MESSAGE ? 'api_disabled'
    : readOnly;
  switch (reason) {
    case 'needs_reconnect':
      return "Google Calendar needs to be reconnected, so this is the event as last fetched, and it can't be changed until then.";
    case 'key_mismatch':
      return "Google Calendar is off until an admin fixes the server's encryption key, so this is the event as last fetched.";
    case 'unreadable':
      return "Google Calendar sent this event in a form the dashboard can't read, so this is the event as last fetched. Open it in Google Calendar to change it.";
    case 'api_disabled':
      return "The Google Calendar API isn't turned on for the dashboard's Google Cloud project, so this is the event as last fetched, and it can't be changed until an admin turns it on.";
    default:
      return "Couldn't reach Google Calendar, so this is the event as last fetched, and it can't be changed right now.";
  }
}

/**
 * An event button's accessible name: its title and time, and in the month view its day too
 * (R5-I2), since a screen reader moving between buttons doesn't hear the cell's date.
 */
export function eventButtonLabel(title: string, time: string, day: string | null): string {
  return day ? `${title}, ${day}, ${time}` : `${title}, ${time}`;
}

/** Why one event can't be changed here. */
export const READ_ONLY_EVENT_NOTES: Record<ReadOnlyReason, string> = {
  event_type: "This kind of event can only be changed in Google Calendar.",
  locked: 'Google Calendar has locked this event, so it can only be changed there.',
  private: "This event is private, so the dashboard shows only when it is. Open it in Google Calendar to see more.",
  not_organizer: 'This is an invitation from someone else. Only its organizer can change it.',
};
