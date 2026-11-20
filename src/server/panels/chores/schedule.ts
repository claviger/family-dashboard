import type { AfterCompletionSchedule, FixedSchedule, RepeatingSchedule } from '../../../shared/chores.js';
import { addDays } from '../../../shared/dates.js';

/**
 * Pure schedule math for chore generation (spec §11.3). Every date is a family-local
 * YYYY-MM-DD string, and the arithmetic is calendar-only (UTC under the hood), so
 * daylight-saving changes can't move a date. Callers turn instants into local dates first.
 */

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/** Whole days from `from` to `to` (negative when `to` is earlier). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** The Sunday that starts `date`'s week. */
export function weekStart(date: string): string {
  return addDays(date, -weekdayOf(date));
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate(); // month is 1-12; day 0 is the last day of `month`
}

/** Day `day` of the month (clamped to the month's length), or its last day. `month` is 1-12. */
export function monthlyDate(year: number, month: number, day: number | 'last'): string {
  const last = daysInMonth(year, month);
  const d = day === 'last' ? last : Math.min(day, last);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function isScheduledWeekly(schedule: Extract<FixedSchedule, { kind: 'weekly' }>, startDate: string, date: string): boolean {
  if (!schedule.weekdays.includes(weekdayOf(date))) return false;
  const weeks = daysBetween(weekStart(startDate), weekStart(date)) / 7;
  return weeks % schedule.interval === 0;
}

function later(a: string, b: string): string {
  return a > b ? a : b;
}

/**
 * The next due date of an after-completion chore: the last close date plus the interval, but never
 * before the start date (an admin may move the start date later). The start date at first.
 */
export function nextAfterCompletionDate(schedule: AfterCompletionSchedule, startDate: string, lastClosedDate: string | null): string {
  if (lastClosedDate === null) return startDate;
  return later(startDate, addDays(lastClosedDate, schedule.every * (schedule.unit === 'weeks' ? 7 : 1)));
}

/**
 * The first date on or after `from`, and on or after the start date, that a fixed schedule hits
 * (chore board spec, "Next due date").
 */
export function nextScheduledDate(schedule: FixedSchedule, startDate: string, from: string): string {
  const first = later(from, startDate);
  switch (schedule.kind) {
    case 'daily':
      return first;
    case 'weekly': {
      // One full cycle of `interval` weeks always holds a match: weekdays is never empty.
      for (let ahead = 0; ahead < 7 * schedule.interval; ahead++) {
        const date = addDays(first, ahead);
        if (isScheduledWeekly(schedule, startDate, date)) return date;
      }
      throw new Error('a weekly schedule always has a date within one cycle');
    }
    case 'monthly': {
      const year = Number(first.slice(0, 4));
      const month = Number(first.slice(5, 7));
      const thisMonth = monthlyDate(year, month, schedule.day);
      if (thisMonth >= first) return thisMonth;
      return month === 12 ? monthlyDate(year + 1, 1, schedule.day) : monthlyDate(year, month + 1, schedule.day);
    }
  }
}

/**
 * The next due date of a repeating chore from date F. Fixed: the first scheduled date on or after F
 * (and the start date). After completion: the later of F and the last close date plus the interval;
 * with no close yet, the later of F and the start date.
 */
export function nextDueDate(schedule: RepeatingSchedule, startDate: string, from: string, lastClosedDate: string | null): string {
  if (schedule.kind === 'after') return later(from, nextAfterCompletionDate(schedule, startDate, lastClosedDate));
  return nextScheduledDate(schedule, startDate, from);
}

/** What a chore's next due date depends on, besides its schedule and start date. */
export interface ChoreTimeline {
  /** Today, family-local. */
  today: string;
  /** The latest due date of any of the chore's occurrences, or null (none, or only as-needed ones). */
  latestDueDate: string | null;
  /** The family-local date of the chore's latest completion or skip, or null. */
  lastClosedDate: string | null;
}

/**
 * F after an occurrence closes: the day after its due date, or the day it was closed, whichever is
 * later. So a chore done early waits for its due date to pass, and one done late comes back right
 * away. Null when the chore has no dated occurrence yet (then F is today).
 */
export function fromAfterClose(latestDueDate: string | null, lastClosedDate: string | null): string | null {
  if (latestDueDate === null) return null;
  const dayAfter = addDays(latestDueDate, 1);
  return lastClosedDate === null ? dayAfter : later(dayAfter, lastClosedDate);
}

/**
 * The due date of the occurrence a chore gets when someone is assigned it (claim, take over, admin
 * assign, added assigned): from today, but never on or before a due date it already has, since that
 * one was done or skipped already (and the unique key would refuse a second row for it).
 */
export function dueOnAssignment(schedule: RepeatingSchedule, startDate: string, t: ChoreTimeline): string {
  const from = t.latestDueDate === null ? t.today : later(t.today, addDays(t.latestDueDate, 1));
  return nextDueDate(schedule, startDate, from, t.lastClosedDate);
}

/**
 * For an assigned repeating chore with nothing open: the day the generation job creates its next
 * occurrence (F), and that occurrence's due date. The due date counts from the later of F and today,
 * so a job that ran late after downtime doesn't create one that's already overdue. The board shows
 * the due date as "Next: …".
 */
export function upcomingOccurrence(schedule: RepeatingSchedule, startDate: string, t: ChoreTimeline): { createOn: string; dueDate: string } {
  const createOn = fromAfterClose(t.latestDueDate, t.lastClosedDate) ?? t.today;
  return { createOn, dueDate: nextDueDate(schedule, startDate, later(createOn, t.today), t.lastClosedDate) };
}

/** The `chores.generate` decision for an assigned repeating chore with nothing open: the due date to create now, or null until today reaches F. */
export function dueDateToGenerate(schedule: RepeatingSchedule, startDate: string, t: ChoreTimeline): string | null {
  const next = upcomingOccurrence(schedule, startDate, t);
  return t.today >= next.createOn ? next.dueDate : null;
}
