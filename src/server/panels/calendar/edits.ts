import { randomBytes } from 'node:crypto';
import { eventIdFromBytes, type CalendarEventInput, type StoredEvent } from '../../../shared/calendar.js';
import { addDays, daysBetween } from '../../../shared/dates.js';
import { minutesOf, timeOf, utcToWall, wallToRfc3339, wallToUtcMs } from '../../../shared/zonedTime.js';
import type { EventBody, GoogleEvent, GoogleEventTime, RawEvent } from '../../integrations/google/calendarClient.js';
import { instantOf } from './mapping.js';

/**
 * Pure pieces of the Calendar panel's writes (spec §9.4 to §9.6), against
 * docs/research/google-calendar-v3.md §5 to §7: event bodies that carry only the dashboard's own
 * fields, the move an "All events" edit makes to its series, and the check that a series has no
 * instances changed on their own before it's moved.
 */

/** A new event's id, as the browser makes them (see `eventIdFromBytes`); for tests and tools, since a create must send its own. */
export function newEventId(): string {
  return eventIdFromBytes(randomBytes(16));
}

type Times = Pick<CalendarEventInput, 'allDay' | 'startDate' | 'endDate' | 'startTime' | 'endTime'>;

/**
 * `start` and `end` for Google (research notes §4, §7). A timed event gets both an offset and a
 * zone, as the research recommends: `zone` is the event's own zone when it has one (an edit keeps
 * it), else the family's. An all-day event gets dates, with Google's end date exclusive. Each side
 * clears the other's fields with `null`, so a patch that switches between timed and all-day leaves
 * no stray `date` or `dateTime` behind (patch merges nested objects).
 */
export function eventTimes(input: Times, familyZone: string, zone: string = familyZone): { start: EventBody; end: EventBody } {
  if (input.allDay) {
    return { start: { date: input.startDate, dateTime: null, timeZone: null }, end: { date: addDays(input.endDate, 1), dateTime: null, timeZone: null } };
  }
  // The form's times are family-local; written with the family zone's offset, they're exact
  // instants whatever `zone` the event is labeled with.
  return {
    start: { dateTime: wallToRfc3339(input.startDate, input.startTime!, familyZone), timeZone: zone, date: null },
    end: { dateTime: wallToRfc3339(input.endDate, input.endTime!, familyZone), timeZone: zone, date: null },
  };
}

/** For a create: the same, without the `null`s (there's nothing to clear). */
export function insertTimes(input: Times, familyZone: string): { start: EventBody; end: EventBody } {
  const strip = (t: EventBody) => Object.fromEntries(Object.entries(t).filter(([, v]) => v !== null));
  const { start, end } = eventTimes(input, familyZone);
  return { start: strip(start), end: strip(end) };
}

function blankToNull(value: string | null): string | null {
  return value === null || value.trim() === '' ? null : value.trim();
}

/** Did the form change when the event happens? */
export function timesChanged(current: StoredEvent, input: Times): boolean {
  return current.allDay !== input.allDay || current.startDate !== input.startDate || current.endDate !== input.endDate
    || current.startTime !== input.startTime || current.endTime !== input.endTime;
}

/**
 * The title, location, and description the form changed, compared with what the person was
 * looking at, and nothing else: an edit leaves every other field alone (spec §9.4). `null` clears
 * a field (research notes §5). A description Google keeps as HTML is never written back, since
 * the dashboard only shows it as text.
 */
export function changedText(current: StoredEvent, input: CalendarEventInput): EventBody {
  const body: EventBody = {};
  if (input.title.trim() !== current.title) body.summary = input.title.trim();
  const location = blankToNull(input.location);
  if (location !== current.location) body.location = location;
  if (!current.descriptionIsHtml) {
    const description = blankToNull(input.description);
    if (description !== current.description) body.description = description;
  }
  return body;
}

/**
 * A patch applied to an event the way Google applies one (research notes §5): objects merge,
 * `null` deletes, arrays and everything else replace. For the PUT fallback, which has to send the
 * whole event: the event as read, with the dashboard's changes on top.
 */
export function mergePatch(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    const t = out[k];
    if (v === null) delete out[k];
    else if (typeof v === 'object' && !Array.isArray(v) && typeof t === 'object' && t !== null && !Array.isArray(t)) out[k] = mergePatch(t as Record<string, unknown>, v as Record<string, unknown>);
    else out[k] = v;
  }
  return out;
}

/** The zone a series repeats in (research notes §7): its start's own zone, else the calendar's, else the family's. */
export function seriesZone(master: GoogleEvent, calendarZone: string | null, familyZone: string): string {
  return master.start?.timeZone ?? calendarZone ?? familyZone;
}

/** A series' first day and time in its own zone. */
export function seriesStart(master: GoogleEvent, zone: string): { allDay: boolean; date: string; time: string | null } {
  const start = master.start!;
  if (start.date !== undefined) return { allDay: true, date: start.date, time: null };
  const wall = utcToWall(instantOf(start, zone), zone);
  return { allDay: false, date: wall.date, time: wall.time };
}

export interface SeriesMove {
  start: EventBody;
  end: EventBody;
  /** How many days the series' first day moved, in its own zone: what a weekly rule's weekdays move by. */
  days: number;
  /** The series' new first day, in its own zone. */
  startDate: string;
  /** The series' new start time in its own zone, or null for an all-day series. */
  startTime: string | null;
  /** How far the series' start moved, in minutes of wall-clock time in its zone (days * 1440 for an all-day series). */
  minutes: number;
  /**
   * The new start time doesn't exist on the series' new first day, in its zone: a spring-forward
   * gap. Google would be sent the instant it resolves to, an hour later, so the caller refuses it (R3-M).
   */
  startMissing: boolean;
}

/**
 * An "All events" edit made on one instance, as a move of the whole series (research notes §6,
 * "Editing all events"): the series' start moves by however far the person moved this instance,
 * in days and minutes, and never to the instance's date. Its length becomes the instance's new
 * length. Worked out in the series' own zone (`zone`), where Google expands its rule, so a Tokyo
 * series viewed from Los Angeles moves by Tokyo days. The new times keep that zone.
 */
export function moveSeries(master: GoogleEvent, instance: StoredEvent, input: Times, familyZone: string, zone: string): SeriesMove {
  const first = seriesStart(master, zone);
  if (input.allDay) {
    const days = daysBetween(instance.startDate, input.startDate);
    const startDate = addDays(first.date, days);
    const end = addDays(startDate, daysBetween(input.startDate, input.endDate) + 1);
    return { start: { date: startDate, dateTime: null, timeZone: null }, end: { date: end, dateTime: null, timeZone: null }, days, startDate, startTime: null, minutes: days * 1440, startMissing: false };
  }
  const was = utcToWall(Date.parse(instance.startsAt!), zone);
  const newStart = wallToUtcMs(input.startDate, input.startTime!, familyZone);
  const length = wallToUtcMs(input.endDate, input.endTime!, familyZone) - newStart;
  const now = utcToWall(newStart, zone);
  const shift = daysBetween(was.date, now.date) * 1440 + minutesOf(now.time) - minutesOf(was.time);
  const total = minutesOf(first.time!) + shift;
  const startDate = addDays(first.date, Math.floor(total / 1440));
  const startTime = timeOf(((total % 1440) + 1440) % 1440);
  const resolved = utcToWall(wallToUtcMs(startDate, startTime, zone), zone);
  const end = utcToWall(wallToUtcMs(startDate, startTime, zone) + length, zone);
  return {
    start: { dateTime: wallToRfc3339(startDate, startTime, zone), timeZone: zone, date: null },
    end: { dateTime: wallToRfc3339(end.date, end.time, zone), timeZone: zone, date: null },
    days: daysBetween(first.date, startDate),
    startDate,
    startTime,
    minutes: shift,
    startMissing: resolved.date !== startDate || resolved.time !== startTime,
  };
}

/**
 * A series' start and end (as Google has them, or as `moveSeries` made them) moved by whole days
 * in its zone, keeping their wall-clock times: for a weekly rule whose first day isn't one of its
 * weekdays any more (R3-M). `startMissing` as in SeriesMove.
 */
export function shiftSeriesDays(start: GoogleEventTime | EventBody, end: GoogleEventTime | EventBody, zone: string, days: number): {
  start: EventBody; end: EventBody; startDate: string; startTime: string | null; startMissing: boolean;
} {
  const s = start as GoogleEventTime;
  const e = end as GoogleEventTime;
  if (typeof s.date === 'string' && typeof e.date === 'string') {
    const startDate = addDays(s.date, days);
    return { start: { date: startDate, dateTime: null, timeZone: null }, end: { date: addDays(e.date, days), dateTime: null, timeZone: null }, startDate, startTime: null, startMissing: false };
  }
  const from = utcToWall(instantOf(s, zone), zone);
  const to = utcToWall(instantOf(e, zone), zone);
  const startDate = addDays(from.date, days);
  const resolved = utcToWall(wallToUtcMs(startDate, from.time, zone), zone);
  return {
    start: { dateTime: wallToRfc3339(startDate, from.time, zone), timeZone: zone, date: null },
    end: { dateTime: wallToRfc3339(addDays(to.date, days), to.time, zone), timeZone: zone, date: null },
    startDate,
    startTime: from.time,
    startMissing: resolved.date !== startDate || resolved.time !== from.time,
  };
}

function sameTime(a: GoogleEventTime | undefined, b: GoogleEventTime | undefined, zone: string): boolean {
  if (!a || !b) return a === b;
  if (a.date !== undefined || b.date !== undefined) return a.date === b.date;
  return instantOf(a, zone) === instantOf(b, zone);
}

function lengthOf(e: GoogleEvent, zone: string): number | null {
  if (!e.start || !e.end) return null;
  if (e.start.date !== undefined && e.end.date !== undefined) return daysBetween(e.start.date, e.end.date);
  if (e.start.dateTime !== undefined && e.end.dateTime !== undefined) return instantOf(e.end, zone) - instantOf(e.start, zone);
  return null;
}

/**
 * The fields that differ between one instance and its series in their own right (R3-I4). The
 * series has `recurrence` and the instances don't; `status` is compared separately (a cancelled
 * instance is an exception, a tentative one isn't).
 */
const PER_INSTANCE_FIELDS = new Set([
  'id', 'etag', 'start', 'end', 'originalStartTime', 'recurringEventId', 'htmlLink', 'updated', 'created', 'sequence', 'iCalUID', 'status', 'recurrence',
]);

/** JSON values equal, ignoring the order of object keys. */
function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => sameJson(x, b[i]));
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && sameJson((a as RawEvent)[k], (b as RawEvent)[k]));
}

/**
 * The series' instances changed or cancelled on their own (exceptions), from the raw JSON Google
 * sent (R3-I4): cancelled, moved from their original start, a different length, or any field other
 * than the per-instance ones different from the series' (a title, an extra guest, its own
 * reminders or Meet link). `fields` names the fields that differed, for the log; never their
 * values. What Google does to exceptions when their series moves is UNVERIFIED (research notes
 * §6), so a series with any isn't moved from here. A field Google sends on instances but not on
 * the series (or the other way round) would count too: UNVERIFIED, and the safe side.
 */
export function changedInstances(master: RawEvent, instances: RawEvent[], zone: string): { count: number; fields: string[] } {
  const m = master as GoogleEvent;
  const len = lengthOf(m, zone);
  const fields = new Set<string>();
  let count = 0;
  for (const raw of instances) {
    const i = raw as GoogleEvent;
    let changed = i.status === 'cancelled'
      || (i.originalStartTime !== undefined && !sameTime(i.start, i.originalStartTime, zone))
      || lengthOf(i, zone) !== len;
    for (const key of new Set([...Object.keys(master), ...Object.keys(raw)])) {
      if (PER_INSTANCE_FIELDS.has(key) || sameJson(master[key], raw[key])) continue;
      fields.add(key);
      changed = true;
    }
    if (changed) count++;
  }
  return { count, fields: [...fields].sort() };
}
