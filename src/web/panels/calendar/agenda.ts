import type { CalendarEvent } from '../../../shared/calendar.js';
import { datesIn } from './calendarView.js';

/**
 * Events by day (spec §9.3, §9.4). An event shows on every day from its start to its last day.
 * Within a day, all-day events (and days a longer event covers completely) come first; then the
 * last day of an event that started earlier ("Until 10:00 AM"), since it began before the day
 * did; then by start time, then by title. Pure, and tested in calendarView.test.ts.
 */

export interface AgendaEntry {
  event: CalendarEvent;
  /** Where this day falls in the event: its only day, its first, one in the middle, or its last. */
  part: 'only' | 'first' | 'middle' | 'last';
}

export interface AgendaDay {
  date: string;
  entries: AgendaEntry[];
}

function partOf(e: CalendarEvent, date: string): AgendaEntry['part'] {
  if (e.startDate === e.lastDate) return 'only';
  if (date === e.startDate) return 'first';
  return date === e.lastDate ? 'last' : 'middle';
}

/** Shown at the top of its day: an all-day event, or a day a longer timed event covers from start to end. */
function wholeDay(entry: AgendaEntry): boolean {
  return entry.event.allDay || entry.part === 'middle';
}

function compareEntries(a: AgendaEntry, b: AgendaEntry): number {
  if (wholeDay(a) !== wholeDay(b)) return wholeDay(a) ? -1 : 1;
  const at = (x: AgendaEntry) => (x.part === 'last' ? '' : x.event.startsAt ?? '');
  if (at(a) !== at(b)) return at(a) < at(b) ? -1 : 1;
  return a.event.title.localeCompare(b.event.title);
}

/** Every day of `[start, end)` with the events on it. */
export function agendaDays(events: readonly CalendarEvent[], start: string, end: string): AgendaDay[] {
  return datesIn(start, end).map((date) => ({
    date,
    entries: events.filter((e) => e.startDate <= date && e.lastDate >= date).map((event) => ({ event, part: partOf(event, date) })).sort(compareEntries),
  }));
}

/**
 * The home card (spec §9.3): an agenda from today, each event once, on the first day it shows,
 * up to `limit` events, and how many more there are this week.
 */
export function summaryAgenda(events: readonly CalendarEvent[], today: string, end: string, limit = 6): { days: AgendaDay[]; more: number } {
  const seen = new Set<string>();
  const days: AgendaDay[] = [];
  let shown = 0;
  let more = 0;
  for (const day of agendaDays(events, today, end)) {
    const entries: AgendaEntry[] = [];
    for (const entry of day.entries) {
      if (seen.has(entry.event.id)) continue;
      seen.add(entry.event.id);
      if (shown < limit) {
        entries.push(entry);
        shown++;
      } else {
        more++;
      }
    }
    if (entries.length > 0) days.push({ date: day.date, entries });
  }
  return { days, more };
}

/**
 * An entry's time: "All day", the start ("9:00 AM", or with `withEnd` "9:00 AM to 10:00 AM"),
 * and for an event over several days, "Until 1:00 AM" on its last day.
 */
export function entryTime(entry: AgendaEntry, fmt: (time: string) => string, withEnd = false): string {
  const { event, part } = entry;
  if (event.allDay || part === 'middle') return 'All day';
  if (part === 'last') return `Until ${fmt(event.endTime!)}`;
  if (withEnd && part === 'only') return `${fmt(event.startTime!)} to ${fmt(event.endTime!)}`;
  return fmt(event.startTime!);
}
