import { addDays, daysBetween, isLocalDate, weekdayOf } from '../../../shared/dates.js';

/**
 * The drill-down's views and their windows (spec §9.4), all in family-local dates. Pure, so it's
 * unit-tested (calendarView.test.ts) and type-checked with the server code.
 */

export const CALENDAR_VIEWS = ['agenda', 'week', 'month'] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];

export const VIEW_LABELS: Record<CalendarView, string> = { agenda: 'Agenda', week: 'Week', month: 'Month' };

/** Weeks start on Sunday, as the family's calendars do. */
export function weekStartOf(date: string): string {
  return addDays(date, -weekdayOf(date));
}

/** Today in the family time zone, as YYYY-MM-DD. */
export function todayIn(timeZone: string, now: number = Date.now()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
}

/**
 * The view and the day it's showing, from the query string (spec §7: `?view=&date=`). Without a
 * view, phones get the agenda and wider screens the month (spec §9.4); without a valid date, today.
 */
export function viewFromSearch(search: Record<string, unknown>, today: string, wide: boolean): { view: CalendarView; anchor: string } {
  const view = (CALENDAR_VIEWS as readonly unknown[]).includes(search.view) ? (search.view as CalendarView) : wide ? 'month' : 'agenda';
  const anchor = typeof search.date === 'string' && isLocalDate(search.date) ? search.date : today;
  return { view, anchor };
}

/**
 * The home card's key for its open event (`/?calendarEvent=<id>`). The drill-down's is `event`, on
 * its own page; on the home page every card shares the query string, so the Calendar's key says
 * whose it is.
 */
export const CARD_EVENT_KEY = 'calendarEvent';

/** The event open in a page's dialog, by that page's key: `event` on `/calendar`, `CARD_EVENT_KEY` on `/`. */
export function openEventId(search: Record<string, unknown>, key: string): string | null {
  const id = search[key];
  return typeof id === 'string' && id !== '' ? id : null;
}

/** `[start, end)` for a view: the agenda is a week from the day; a week is Sunday to Saturday; a month is its whole weeks. */
export function rangeFor(view: CalendarView, anchor: string): { start: string; end: string } {
  if (view === 'agenda') return { start: anchor, end: addDays(anchor, 7) };
  if (view === 'week') {
    const start = weekStartOf(anchor);
    return { start, end: addDays(start, 7) };
  }
  const first = `${anchor.slice(0, 8)}01`;
  const last = addDays(monthAfter(first), -1);
  return { start: weekStartOf(first), end: addDays(weekStartOf(last), 7) };
}

function monthAfter(first: string, months = 1): string {
  const [y, m] = first.split('-').map(Number);
  const total = y! * 12 + (m! - 1) + months;
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}-01`;
}

/** Previous and Next: a week for the agenda and week views, a month (to its first day) for the month view. */
export function step(view: CalendarView, anchor: string, direction: -1 | 1): string {
  if (view === 'month') return monthAfter(`${anchor.slice(0, 8)}01`, direction);
  return addDays(anchor, 7 * direction);
}

/** The month view's rows: the dates of each week in its range. */
export function monthWeeks(anchor: string): string[][] {
  const { start, end } = rangeFor('month', anchor);
  const weeks: string[][] = [];
  for (let d = start; d < end; d = addDays(d, 7)) weeks.push(Array.from({ length: 7 }, (_, i) => addDays(d, i)));
  return weeks;
}

/** Every date in `[start, end)`. */
export function datesIn(start: string, end: string): string[] {
  return Array.from({ length: Math.max(0, daysBetween(start, end)) }, (_, i) => addDays(start, i));
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** The heading over the view: "November 2026", or "November 15 to 21, 2026" (spelled out across months and years). */
export function rangeTitle(view: CalendarView, anchor: string): string {
  if (view === 'month') return `${MONTHS[Number(anchor.slice(5, 7)) - 1]} ${anchor.slice(0, 4)}`;
  const { start, end } = rangeFor(view, anchor);
  const last = addDays(end, -1);
  const [sy, sm, sd] = start.split('-').map(Number);
  const [ly, lm, ld] = last.split('-').map(Number);
  if (sy !== ly) return `${MONTHS[sm! - 1]} ${sd}, ${sy} to ${MONTHS[lm! - 1]} ${ld}, ${ly}`;
  if (sm !== lm) return `${MONTHS[sm! - 1]} ${sd} to ${MONTHS[lm! - 1]} ${ld}, ${sy}`;
  return `${MONTHS[sm! - 1]} ${sd} to ${ld}, ${sy}`;
}

/**
 * The day New event starts on (R5-M3): today when the view shows it; otherwise the month view's
 * own month (its anchor, not the grid's first Sunday, which can be in the month before), or the
 * first day of the agenda or week shown.
 */
export function newEventDate(view: CalendarView, anchor: string, today: string): string {
  if (view === 'month') return today.slice(0, 7) === anchor.slice(0, 7) ? today : anchor;
  const { start, end } = rangeFor(view, anchor);
  return today >= start && today < end ? today : start;
}

/**
 * A zone's name in words, as the device's language says it, the same all year: "Pacific Time"
 * (R5-M8, `longGeneric`), not "Pacific Standard Time" that turns into "Pacific Daylight Time" in summer.
 */
export function zoneName(timeZone: string, locale?: string, at: Date = new Date()): string {
  const part = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: 'longGeneric' }).formatToParts(at).find((p) => p.type === 'timeZoneName');
  return part?.value ?? timeZone;
}

/**
 * "Times are in Pacific Time.", when the device is in another zone than the family's
 * (R5-M8): every time on the Calendar is the family's. Null when they're the same.
 */
export function timesInLine(familyZone: string, deviceZone: string, locale?: string, at?: Date): string | null {
  if (familyZone === deviceZone) return null;
  return `Times are in ${zoneName(familyZone, locale, at)}.`;
}
