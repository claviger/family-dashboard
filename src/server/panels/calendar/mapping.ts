import type { ReadOnlyReason, StoredEvent } from '../../../shared/calendar.js';
import { addDays, isLocalDate } from '../../../shared/dates.js';
import { utcToWall, wallToUtcMs } from '../../../shared/zonedTime.js';
import type { GoogleEvent, GoogleEventTime } from '../../integrations/google/calendarClient.js';

/**
 * Pure conversions from Google's events to what the panel shows, written against
 * docs/research/google-calendar-v3.md §4 and §7. Everything comes out in the family time zone.
 */

/** Private extended property names (spec §9.5); both are under Google's 44-character key limit. */
export const CREATED_BY = 'dashboardCreatedBy';
export const UPDATED_BY = 'dashboardUpdatedBy';

/**
 * Event types shown read-only (anything but `default`), and the one left out: `workingLocation`
 * marks where someone works each weekday, which on a family calendar is only noise. Birthdays,
 * out of office, and focus time are real information for a family, so they're shown, but their
 * type can't be changed and Google restricts what can be edited on them, so they're read-only.
 * Types Google adds later are shown read-only too.
 */
const HIDDEN_TYPES = new Set(['workingLocation']);

/**
 * The window Google is asked for: a day wider on each side than the family-local window. Google
 * places all-day events by the calendar's time zone, not the request's (research notes §7), so
 * when the two differ an all-day event near an edge could otherwise be missed. Zones are at most
 * 26 hours apart, and one day each side covers that (an all-day event lasts 24 hours). The result
 * is filtered back to the window with `inWindow`.
 */
export function fetchBounds(start: string, end: string, timeZone: string): { timeMin: string; timeMax: string } {
  return {
    timeMin: new Date(wallToUtcMs(addDays(start, -1), '00:00', timeZone)).toISOString(),
    timeMax: new Date(wallToUtcMs(addDays(end, 1), '00:00', timeZone)).toISOString(),
  };
}

/** Does the event show on any day of `[start, end)`? */
export function inWindow(e: Pick<StoredEvent, 'startDate' | 'lastDate'>, start: string, end: string): boolean {
  return e.startDate < end && e.lastDate >= start;
}

/** An instant for a timed value: its offset, or else its own zone, the calendar's, or the family's. */
export function instantOf(t: GoogleEventTime, fallbackZone: string): number {
  const dt = t.dateTime!;
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(dt)) return Date.parse(dt);
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(dt);
  return m ? wallToUtcMs(m[1]!, m[2]!, t.timeZone ?? fallbackZone) : NaN;
}

/**
 * An HTML tag: a name of letters and digits, then whitespace, `/`, or `>`. Not `<bob@example.com>`
 * or `<https://...>`, which people type in plain descriptions.
 */
const TAG = /<\/?[a-z][a-z0-9]*(?:\s[^<>]*)?\/?>/i;

/** Google keeps descriptions written in its web UI as HTML. */
export function isHtml(text: string): boolean {
  return TAG.test(text);
}

/**
 * HTML as plain text: line breaks kept, tags removed, the common entities decoded. React escapes the rest.
 *
 * A tag's inside never crosses another `<`. With `[^>]*`, each `<` that has no `>` after it rescans
 * to the end of the text, which is quadratic on the server's only thread, and anyone who can write
 * the calendar controls the description (security scan finding F1). A stray `<` stays as text.
 */
export function plainText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<li[^<>]*>/gi, '• ')
    .replace(/<[^<>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Google's link to the event, only if it's https on a google.com host (it's shown as a link). */
export function safeHtmlLink(link: string | undefined): string | null {
  if (!link) return null;
  try {
    const url = new URL(link);
    return url.protocol === 'https:' && (url.hostname === 'google.com' || url.hostname.endsWith('.google.com')) ? url.href : null;
  } catch {
    return null;
  }
}

/** What `dashboardCreatedBy` and `dashboardUpdatedBy` hold: this install's id and the user's (spec §9.5). */
export function attributionValue(installId: string, userId: number): string {
  return `${installId}:${userId}`;
}

/**
 * A dashboard user id from a private property, or null: only when it was written by this install,
 * since another install's user ids mean other people. Anyone who can write the calendar can set
 * these, so they're informational.
 */
function userIdOf(value: string | undefined, installId: string): number | null {
  const m = value === undefined ? null : /^([0-9a-f]{1,64}):(\d{1,15})$/.exec(value);
  if (!m || m[1] !== installId) return null;
  const id = Number(m[2]);
  return id > 0 ? id : null;
}

function readOnlyOf(g: GoogleEvent): ReadOnlyReason | null {
  if (g.visibility === 'private' || g.visibility === 'confidential') return 'private';
  if ((g.eventType ?? 'default') !== 'default') return 'event_type';
  if (g.locked === true) return 'locked';
  if (g.organizer?.self === false) return 'not_organizer';
  return null;
}

/**
 * One Google event as the panel stores and shows it, or null for one it doesn't show: cancelled,
 * a working-location marker, or one whose times can't be read. All-day events keep their dates
 * (with the exclusive end made inclusive); timed events are converted to the family time zone,
 * which can move them to another day. A private or confidential event shows only that it's there
 * and when: Google shows its details only to people who can change the calendar, and the
 * dashboard can't tell who those are.
 */
export function toStoredEvent(g: GoogleEvent, ctx: { timeZone: string; calendarTimeZone: string | null; installId: string }): StoredEvent | null {
  if (g.status === 'cancelled' || HIDDEN_TYPES.has(g.eventType ?? 'default') || !g.start) return null;
  const readOnly = readOnlyOf(g);
  const hidden = readOnly === 'private';
  const description = hidden ? undefined : g.description?.trim() || undefined;
  const html = description !== undefined && isHtml(description);
  const common = {
    id: g.id,
    etag: g.etag,
    seriesId: g.recurringEventId ?? null,
    title: hidden ? 'Private event' : g.summary?.trim() || '(No title)',
    location: hidden ? null : g.location?.trim() || null,
    description: description === undefined ? null : (html ? plainText(description) : description) || null,
    descriptionIsHtml: html,
    readOnly,
    eventType: g.eventType ?? 'default',
    // A private event shows nothing about itself: not who added or changed it, nor a link to it (R3-M).
    htmlLink: hidden ? null : safeHtmlLink(g.htmlLink),
    createdById: hidden ? null : userIdOf(g.extendedProperties?.private?.[CREATED_BY], ctx.installId),
    updatedById: hidden ? null : userIdOf(g.extendedProperties?.private?.[UPDATED_BY], ctx.installId),
  };
  if (g.start.date !== undefined) {
    const start = g.start.date;
    if (!isLocalDate(start)) return null;
    const endExclusive = g.end?.date && isLocalDate(g.end.date) && g.end.date > start ? g.end.date : addDays(start, 1);
    const endDate = addDays(endExclusive, -1);
    return { ...common, allDay: true, startDate: start, endDate, startTime: null, endTime: null, lastDate: endDate, startsAt: null };
  }
  if (g.start.dateTime === undefined) return null;
  const zone = ctx.calendarTimeZone ?? ctx.timeZone;
  const startMs = instantOf(g.start, zone);
  const endMs = g.end?.dateTime !== undefined ? instantOf(g.end, zone) : startMs;
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) return null;
  const s = utcToWall(startMs, ctx.timeZone);
  const e = utcToWall(Math.max(endMs, startMs), ctx.timeZone);
  // An event that ends at midnight doesn't show on the next day.
  const lastDate = endMs > startMs ? utcToWall(endMs - 1, ctx.timeZone).date : s.date;
  return {
    ...common, allDay: false, startDate: s.date, endDate: e.date, startTime: s.time, endTime: e.time, lastDate,
    startsAt: new Date(startMs).toISOString(),
  };
}

/** All-day events first, then by start, then by title (spec §9.3). */
export function compareEvents(a: StoredEvent, b: StoredEvent): number {
  if (a.startDate !== b.startDate) return a.startDate < b.startDate ? -1 : 1;
  if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
  if (a.startsAt !== b.startsAt) return (a.startsAt ?? '') < (b.startsAt ?? '') ? -1 : 1;
  return a.title.localeCompare(b.title);
}
