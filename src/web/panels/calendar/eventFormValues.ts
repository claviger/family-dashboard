import { repeatEndsTooEarly, timesOutOfOrder, type CalendarEvent, type CalendarEventInput, type CalendarSeries, type EditScope } from '../../../shared/calendar.js';
import { addDays, daysBetween, weekdayOf } from '../../../shared/dates.js';
import { describeRule, MAX_COUNT, WEEKDAYS, type RepeatRule, type Weekday } from '../../../shared/rrule.js';

/**
 * The create and edit form's values (spec §9.4), as the inputs hold them, and their conversion to
 * the API's CalendarEventInput. Dates and times are family-local; an all-day event's end date is
 * inclusive. Pure, and tested in eventFormValues.test.ts.
 */

export type RepeatChoice = 'none' | RepeatRule['freq'];

export interface RepeatValues {
  freq: RepeatChoice;
  weekdays: Weekday[];
  endType: RepeatRule['end']['type'];
  endDate: string;
  /** As typed. */
  count: string;
}

export interface EventFormValues {
  title: string;
  allDay: boolean;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  location: string;
  description: string;
  repeat: RepeatValues;
}

/** The form's fields that a problem can point at (R5-I4). */
export type FormField = 'title' | 'startDate' | 'startTime' | 'endDate' | 'endTime' | 'weekdays' | 'repeatEndDate' | 'repeatCount';

/** What to fix, and the first field to fix it in. */
export interface FormProblem {
  error: string;
  field: FormField;
}

/** What the form is for, which decides what can change. */
export type FormMode =
  | { kind: 'create' }
  /** One event that doesn't repeat, or one instance of a series ("This event"). */
  | { kind: 'edit'; scope: 'this'; instance: boolean }
  /**
   * A whole series, edited through one of its instances ("All events"). `seriesStart` is its first
   * day, which the repeat's end is checked against (M-7). `moveBlocked` says why its dates, times,
   * and repeat can't change here (CalendarSeries.moveBlocked), and locks them.
   */
  | { kind: 'edit'; scope: 'all'; repeatEditable: boolean; moveBlocked: string | null; seriesStart: string };

/** Does the form change the event's dates and times? */
function timesDiffer(a: EventFormValues, b: EventFormValues): boolean {
  if (a.allDay !== b.allDay || a.startDate !== b.startDate || a.endDate !== b.endDate) return true;
  return !a.allDay && (a.startTime !== b.startTime || a.endTime !== b.endTime);
}

export function repeatValues(rule: RepeatRule | null, startDate: string): RepeatValues {
  if (!rule) return { freq: 'none', weekdays: [WEEKDAYS[weekdayOf(startDate)]!], endType: 'never', endDate: addDays(startDate, 30), count: '10' };
  return {
    freq: rule.freq,
    weekdays: rule.weekdays.length > 0 ? rule.weekdays : [WEEKDAYS[weekdayOf(startDate)]!],
    endType: rule.end.type,
    endDate: rule.end.type === 'on' ? rule.end.date : addDays(startDate, 30),
    count: rule.end.type === 'after' ? String(rule.end.count) : '10',
  };
}

/** The repeat the values describe, or what to fix. */
export function repeatFromValues(v: RepeatValues): { rule: RepeatRule | null } | FormProblem {
  if (v.freq === 'none') return { rule: null };
  if (v.freq === 'weekly' && v.weekdays.length === 0) return { error: 'Pick at least one day of the week.', field: 'weekdays' };
  let end: RepeatRule['end'] = { type: 'never' };
  if (v.endType === 'on') {
    if (!v.endDate) return { error: 'Pick the date the repeat ends.', field: 'repeatEndDate' };
    end = { type: 'on', date: v.endDate };
  } else if (v.endType === 'after') {
    const count = /^\d+$/.test(v.count.trim()) ? Number(v.count.trim()) : NaN;
    if (!Number.isInteger(count) || count < 1 || count > MAX_COUNT) return { error: `Enter how many times it repeats, from 1 to ${MAX_COUNT}.`, field: 'repeatCount' };
    end = { type: 'after', count };
  }
  return { rule: { freq: v.freq, weekdays: v.freq === 'weekly' ? WEEKDAYS.filter((d) => v.weekdays.includes(d)) : [], end } };
}

/**
 * The repeat choices, worded for the series' first day as `describeRecurrence` words them, so a
 * monthly repeat on the 29th to 31st says "in months that have one" and a yearly one on February
 * 29 "in leap years only" (R5-I5). "All events" can't stop a series repeating (plan decision 8),
 * so it leaves out "Doesn't repeat" (`allowNone: false`, R5-M2).
 */
export function repeatChoices(startDate: string, opts: { allowNone: boolean }): { value: RepeatChoice; label: string }[] {
  const label = (freq: RepeatRule['freq']) => describeRule({ freq, weekdays: [], end: { type: 'never' } }, startDate);
  const all: { value: RepeatChoice; label: string }[] = [
    { value: 'none', label: "Doesn't repeat" },
    { value: 'daily', label: label('daily') },
    { value: 'weekly', label: 'Every week' },
    { value: 'monthly', label: label('monthly') },
    { value: 'yearly', label: label('yearly') },
  ];
  return opts.allowNone ? all : all.filter((c) => c.value !== 'none');
}

/**
 * The day the repeat counts from: the series' first day for "All events", moved by however many
 * days the form moved the start, since saving moves the series by the same amount (R5-M2).
 * Otherwise the form's own start.
 */
export function repeatStartFor(mode: FormMode, initial: EventFormValues | undefined, v: EventFormValues): string {
  if (mode.kind !== 'edit' || mode.scope !== 'all') return v.startDate;
  if (!initial || !initial.startDate || !v.startDate) return mode.seriesStart;
  return addDays(mode.seriesStart, daysBetween(initial.startDate, v.startDate));
}

/**
 * The all-day switch. Turned on for an event that ends at midnight, its last day is the day
 * before (R5-M4): 8 PM to midnight is one day, not two.
 */
export function withAllDay(v: EventFormValues, allDay: boolean): EventFormValues {
  if (allDay && !v.allDay && v.endTime === '00:00' && v.startDate && v.endDate > v.startDate) return { ...v, allDay, endDate: addDays(v.endDate, -1) };
  return { ...v, allDay };
}

/** Anything typed since the form opened, which Cancel and Escape ask about first (R5-M5). */
export function formChanged(v: EventFormValues, initial: EventFormValues): boolean {
  return JSON.stringify(v) !== JSON.stringify(initial);
}

/**
 * A create sent again after it didn't finish can come back as the event the first try made
 * (spec §9.5). True when that isn't what the form sent, so the person is shown it (R5-M14).
 */
export function createdDiffers(input: CalendarEventInput, event: CalendarEvent): boolean {
  const text = (x: string | null | undefined) => x?.trim() || null;
  if (input.title.trim() !== event.title || input.allDay !== event.allDay) return true;
  if (input.startDate !== event.startDate || input.endDate !== event.endDate) return true;
  if (!input.allDay && (input.startTime !== event.startTime || input.endTime !== event.endTime)) return true;
  return text(input.location) !== text(event.location) || text(input.description) !== text(event.description);
}

/**
 * A create that failed this way may still have reached Google (R5-M14, C-M4): no answer at all
 * (0), the proxy in front of the server failing or giving up (502, 504), or the server saying
 * Google may have it (503 `outcome_unknown`). Anything else is a definite refusal: the form shows
 * the error and stays editable.
 */
export function createMayHaveLanded(status: number, code: string): boolean {
  return status === 0 || status === 502 || status === 504 || (status === 503 && code === 'outcome_unknown');
}

/** A new event on `date`, 9 to 10 in the morning. */
export function newEventValues(date: string): EventFormValues {
  return { title: '', allDay: false, startDate: date, startTime: '09:00', endDate: date, endTime: '10:00', location: '', description: '', repeat: repeatValues(null, date) };
}

/** The form for an event as loaded (the instance's own times, even for "All events"), with its series' repeat. */
export function eventValues(e: CalendarEvent, series: CalendarSeries | null): EventFormValues {
  return {
    title: e.title,
    allDay: e.allDay,
    startDate: e.startDate,
    startTime: e.startTime ?? '09:00',
    endDate: e.endDate,
    endTime: e.endTime ?? '10:00',
    location: e.location ?? '',
    description: e.description ?? '',
    repeat: repeatValues(series?.repeat ?? null, series?.startDate ?? e.startDate),
  };
}

/**
 * On a new repeat (a create, or adding one to an event), a weekly repeat still on just the old
 * start's weekday follows the start to its new weekday (M-8). Weekdays the person picked stay.
 */
export function followStartWeekday(prev: EventFormValues, next: EventFormValues): EventFormValues {
  if (!prev.startDate || !next.startDate) return next;
  const was = WEEKDAYS[weekdayOf(prev.startDate)]!;
  const now = WEEKDAYS[weekdayOf(next.startDate)]!;
  const days = next.repeat.weekdays;
  if (was === now || days.length !== 1 || days[0] !== was) return next;
  return { ...next, repeat: { ...next.repeat, weekdays: [now] } };
}

/** Moving the start keeps the length: the end moves with it. */
export function withStart(v: EventFormValues, startDate: string, startTime: string): EventFormValues {
  if (!startDate) return { ...v, startDate, startTime };
  const days = v.startDate && v.endDate ? daysBetween(v.startDate, v.endDate) : 0;
  const endDate = addDays(startDate, Math.max(0, days));
  if (v.allDay || !v.startTime || !v.endTime || !startTime) return { ...v, startDate, startTime, endDate };
  const length = daysBetween(v.startDate, v.endDate) * 1440 + minutes(v.endTime) - minutes(v.startTime);
  const end = minutes(startTime) + Math.max(length, 0);
  return { ...v, startDate, startTime, endDate: addDays(startDate, Math.floor(end / 1440)), endTime: hhmm(end % 1440) };
}

function minutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return h! * 60 + m!;
}

function hhmm(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * The API body for the form, or a message saying what to fix. An edit checks only what it changed
 * from `initial` (M-6), so an event made in Google that ends when it starts can still get a new
 * title. The repeat goes only where it can change: on a create, on an event that doesn't repeat
 * (adding one), and on "All events" when the series' rule is one the editor offers and nothing
 * blocks moving it; on an edit, only when it changed. Elsewhere it's left out, so the server
 * leaves it alone.
 */
export function toEventInput(v: EventFormValues, mode: FormMode, initial?: EventFormValues): { input: CalendarEventInput } | FormProblem {
  const title = v.title.trim();
  if (!title) return { error: 'Enter a title.', field: 'title' };
  if (!v.startDate || !v.endDate) return { error: 'Enter a start date and an end date.', field: v.startDate ? 'endDate' : 'startDate' };
  if (!v.allDay && (!v.startTime || !v.endTime)) return { error: 'Enter a start time and an end time.', field: v.startTime ? 'endTime' : 'startTime' };
  const timesChanged = mode.kind === 'create' || !initial || timesDiffer(v, initial);
  const input: CalendarEventInput = {
    title,
    allDay: v.allDay,
    startDate: v.startDate,
    endDate: v.endDate,
    startTime: v.allDay ? null : v.startTime,
    endTime: v.allDay ? null : v.endTime,
    location: v.location.trim() === '' ? null : v.location,
    description: v.description.trim() === '' ? null : v.description,
  };
  if (timesChanged) {
    const order = timesOutOfOrder(input);
    if (order) return { error: `${order}.`, field: v.allDay || v.endDate < v.startDate ? 'endDate' : 'endTime' };
  }
  const sendsRepeat = mode.kind === 'create' || (mode.scope === 'this' && !mode.instance) || (mode.scope === 'all' && mode.repeatEditable && mode.moveBlocked === null);
  if (sendsRepeat) {
    const repeat = repeatFromValues(v.repeat);
    if ('error' in repeat) return repeat;
    const before = mode.kind === 'edit' && initial ? repeatFromValues(initial.repeat) : null;
    const changed = before === null || JSON.stringify(before) !== JSON.stringify(repeat);
    if (changed) {
      const early = repeatEndsTooEarly(repeat.rule, repeatStartFor(mode, initial, v));
      if (early) return { error: `${early}.`, field: 'repeatEndDate' };
      input.repeat = repeat.rule;
    }
  }
  return { input };
}

/** How the edit's PATCH body looks, with the etags it was loaded with (spec §9.6). */
export function updateBody(input: CalendarEventInput, scope: EditScope, event: CalendarEvent, series: CalendarSeries | null) {
  return { scope, etag: event.etag, seriesEtag: scope === 'all' ? series?.etag ?? null : null, event: input };
}
