import { describe, expect, it } from 'vitest';
import { EVERY_WEEKDAY, type ChoreSchedule, type RepeatingSchedule } from '../../../shared/chores.js';
import {
  daysBetween, dueDateToGenerate, dueOnAssignment, fromAfterClose, monthlyDate, nextAfterCompletionDate, nextDueDate, nextScheduledDate,
  upcomingOccurrence, weekdayOf, weekStart, type ChoreTimeline,
} from './schedule.js';

// 2026-11-15 is a Sunday.
const MON_THU: ChoreSchedule = { kind: 'weekly', interval: 1, weekdays: [1, 4] };

describe('calendar helpers', () => {
  it('finds weekdays, week starts, and day differences', () => {
    expect(weekdayOf('2026-11-15')).toBe(0);
    expect(weekdayOf('2026-11-21')).toBe(6);
    expect(weekStart('2026-11-18')).toBe('2026-11-15');
    expect(weekStart('2026-11-15')).toBe('2026-11-15');
    expect(daysBetween('2026-11-15', '2026-11-22')).toBe(7);
    expect(daysBetween('2026-11-22', '2026-11-15')).toBe(-7);
  });

  it('is unaffected by daylight-saving changes in America/Los_Angeles', () => {
    // Clocks change on 2026-03-08 and 2026-11-01; calendar math ignores time zones entirely.
    expect(daysBetween('2026-03-07', '2026-03-09')).toBe(2);
    expect(daysBetween('2026-10-31', '2026-11-02')).toBe(2);
    expect(weekStart('2026-03-10')).toBe('2026-03-08');
    expect(nextScheduledDate({ kind: 'weekly', interval: 1, weekdays: [0] }, '2026-03-01', '2026-03-02')).toBe('2026-03-08');
  });

  it('clamps monthly dates to the month length, including leap years', () => {
    expect(monthlyDate(2026, 2, 31)).toBe('2026-02-28');
    expect(monthlyDate(2028, 2, 31)).toBe('2028-02-29');
    expect(monthlyDate(2028, 2, 29)).toBe('2028-02-29');
    expect(monthlyDate(2027, 2, 29)).toBe('2027-02-28');
    expect(monthlyDate(2026, 4, 31)).toBe('2026-04-30');
    expect(monthlyDate(2026, 11, 'last')).toBe('2026-11-30');
    expect(monthlyDate(2026, 12, 'last')).toBe('2026-12-31');
  });
});

describe('nextAfterCompletionDate', () => {
  it('adds days or weeks to the last close date, or starts on the start date', () => {
    const every3: ChoreSchedule = { kind: 'after', every: 3, unit: 'days' };
    expect(nextAfterCompletionDate(every3, '2026-11-10', null)).toBe('2026-11-10');
    expect(nextAfterCompletionDate(every3, '2026-11-10', '2026-11-30')).toBe('2026-12-03');
    expect(nextAfterCompletionDate({ kind: 'after', every: 2, unit: 'weeks' }, '2026-01-10', '2026-02-20')).toBe('2026-03-06');
  });

  it('never goes before the start date, e.g. after the start date is moved later', () => {
    const every3: ChoreSchedule = { kind: 'after', every: 3, unit: 'days' };
    expect(nextAfterCompletionDate(every3, '2026-12-01', '2026-11-20')).toBe('2026-12-01');
    expect(nextAfterCompletionDate(every3, '2026-11-22', '2026-11-20')).toBe('2026-11-23');
  });
});

describe('nextScheduledDate', () => {
  it('daily: the date itself, but never before the start date', () => {
    expect(nextScheduledDate({ kind: 'daily' }, '2026-11-01', '2026-11-15')).toBe('2026-11-15');
    expect(nextScheduledDate({ kind: 'daily' }, '2026-11-20', '2026-11-15')).toBe('2026-11-20');
  });

  it('weekly: the first chosen weekday on or after the date', () => {
    expect(nextScheduledDate(MON_THU, '2026-11-01', '2026-11-15')).toBe('2026-11-16'); // Sun → Mon
    expect(nextScheduledDate(MON_THU, '2026-11-01', '2026-11-16')).toBe('2026-11-16');
    expect(nextScheduledDate(MON_THU, '2026-11-01', '2026-11-17')).toBe('2026-11-19');
    expect(nextScheduledDate(MON_THU, '2026-11-20', '2026-11-15')).toBe('2026-11-23'); // a start date in the future
  });

  it('every N weeks: counted from the week of the start date', () => {
    // Start Wed 2026-11-18; that week (from Sun 11-15) is week 0. Every 2 weeks on Mon and Fri.
    const s: ChoreSchedule = { kind: 'weekly', interval: 2, weekdays: [1, 5] };
    expect(nextScheduledDate(s, '2026-11-18', '2026-11-15')).toBe('2026-11-20'); // Mon 11-16 is before the start
    expect(nextScheduledDate(s, '2026-11-18', '2026-11-21')).toBe('2026-11-30'); // week 1 is off
    expect(nextScheduledDate(s, '2026-11-18', '2026-12-01')).toBe('2026-12-04'); // Fri, week 2
    // Every 3 weeks on Sunday, started on a Saturday: week 0 has no Sunday on or after the start.
    const sun3: ChoreSchedule = { kind: 'weekly', interval: 3, weekdays: [0] };
    expect(nextScheduledDate(sun3, '2026-11-21', '2026-11-21')).toBe('2026-12-06'); // week 3
    expect(nextScheduledDate(sun3, '2026-11-21', '2026-12-07')).toBe('2026-12-27'); // week 6
  });

  it('monthly: day N clamped to the month, or the last day, across month and year ends', () => {
    const on31: ChoreSchedule = { kind: 'monthly', day: 31 };
    expect(nextScheduledDate(on31, '2026-01-01', '2026-01-31')).toBe('2026-01-31');
    expect(nextScheduledDate(on31, '2026-01-01', '2026-02-01')).toBe('2026-02-28');
    expect(nextScheduledDate(on31, '2026-01-01', '2026-03-01')).toBe('2026-03-31');
    expect(nextScheduledDate({ kind: 'monthly', day: 29 }, '2028-01-01', '2028-02-01')).toBe('2028-02-29'); // leap year
    expect(nextScheduledDate({ kind: 'monthly', day: 15 }, '2026-01-01', '2026-12-16')).toBe('2027-01-15');
    expect(nextScheduledDate({ kind: 'monthly', day: 'last' }, '2026-01-01', '2026-04-30')).toBe('2026-04-30');
    expect(nextScheduledDate({ kind: 'monthly', day: 'last' }, '2026-01-01', '2026-05-01')).toBe('2026-05-31');
    expect(nextScheduledDate({ kind: 'monthly', day: 1 }, '2026-12-05', '2026-11-15')).toBe('2027-01-01'); // start in the future
  });
});

describe('nextDueDate', () => {
  it('after completion: the later of the date and the last close plus the interval, or of the date and the start date', () => {
    const every10: RepeatingSchedule = { kind: 'after', every: 10, unit: 'days' };
    expect(nextDueDate(every10, '2026-11-01', '2026-11-15', null)).toBe('2026-11-15');
    expect(nextDueDate(every10, '2026-11-20', '2026-11-15', null)).toBe('2026-11-20'); // start in the future
    expect(nextDueDate(every10, '2026-11-01', '2026-11-16', '2026-11-15')).toBe('2026-11-25');
    expect(nextDueDate(every10, '2026-11-01', '2026-11-30', '2026-11-15')).toBe('2026-11-30');
    expect(nextDueDate({ kind: 'after', every: 2, unit: 'weeks' }, '2026-11-01', '2026-11-16', '2026-11-15')).toBe('2026-11-29');
  });

  it('fixed: the first scheduled date on or after it, whatever the last close', () => {
    expect(nextDueDate(MON_THU as RepeatingSchedule, '2026-11-01', '2026-11-17', '2026-11-16')).toBe('2026-11-19');
  });
});

describe('fromAfterClose', () => {
  it('is the day after the due date, or the close date when that is later', () => {
    expect(fromAfterClose('2026-11-20', '2026-11-16')).toBe('2026-11-21'); // done early: wait for the due date to pass
    expect(fromAfterClose('2026-11-16', '2026-11-18')).toBe('2026-11-18'); // done late: right away
    expect(fromAfterClose('2026-11-16', '2026-11-16')).toBe('2026-11-17'); // done on the day
    expect(fromAfterClose(null, null)).toBeNull(); // nothing yet: F is today
    expect(fromAfterClose(null, '2026-11-16')).toBeNull(); // only as-needed occurrences so far
  });
});

describe('the next due date for every kind', () => {
  // 2026-11-15 is a Sunday. Each kind: on assignment, done early, done late, and a start date in the future.
  const none = (today: string): ChoreTimeline => ({ today, latestDueDate: null, lastClosedDate: null });
  const closed = (today: string, latestDueDate: string, lastClosedDate: string): ChoreTimeline => ({ today, latestDueDate, lastClosedDate });

  it('daily', () => {
    const s: RepeatingSchedule = { kind: 'daily' };
    expect(dueOnAssignment(s, '2026-11-01', none('2026-11-15'))).toBe('2026-11-15');
    expect(upcomingOccurrence(s, '2026-11-01', closed('2026-11-15', '2026-11-15', '2026-11-15'))).toEqual({ createOn: '2026-11-16', dueDate: '2026-11-16' });
    expect(upcomingOccurrence(s, '2026-11-01', closed('2026-11-17', '2026-11-15', '2026-11-17'))).toEqual({ createOn: '2026-11-17', dueDate: '2026-11-17' });
    expect(dueOnAssignment(s, '2026-11-20', none('2026-11-15'))).toBe('2026-11-20');
  });

  it('weekly on one day', () => {
    const fridays: RepeatingSchedule = { kind: 'weekly', interval: 1, weekdays: [5] };
    expect(dueOnAssignment(fridays, '2026-11-01', none('2026-11-15'))).toBe('2026-11-20');
    // Due Fri 11-20, done Wed 11-18: nothing until Sat 11-21, then due Fri 11-27.
    expect(upcomingOccurrence(fridays, '2026-11-01', closed('2026-11-18', '2026-11-20', '2026-11-18'))).toEqual({ createOn: '2026-11-21', dueDate: '2026-11-27' });
    // Due Fri 11-20, done Mon 11-23: right away, due Fri 11-27.
    expect(upcomingOccurrence(fridays, '2026-11-01', closed('2026-11-23', '2026-11-20', '2026-11-23'))).toEqual({ createOn: '2026-11-23', dueDate: '2026-11-27' });
    expect(dueOnAssignment(fridays, '2026-11-25', none('2026-11-15'))).toBe('2026-11-27');
  });

  it('every N weeks', () => {
    // Start Sun 11-01: weeks from 11-01, 11-15, 11-29 are on. Every 2 weeks on Mon.
    const s: RepeatingSchedule = { kind: 'weekly', interval: 2, weekdays: [1] };
    expect(dueOnAssignment(s, '2026-11-01', none('2026-11-15'))).toBe('2026-11-16');
    expect(upcomingOccurrence(s, '2026-11-01', closed('2026-11-16', '2026-11-16', '2026-11-16'))).toEqual({ createOn: '2026-11-17', dueDate: '2026-11-30' });
    expect(upcomingOccurrence(s, '2026-11-01', closed('2026-11-20', '2026-11-16', '2026-11-20'))).toEqual({ createOn: '2026-11-20', dueDate: '2026-11-30' });
    // Starting Wed 11-18, week 0 (from Sun 11-15) has no Monday on or after the start; week 2's is 11-30.
    expect(dueOnAssignment(s, '2026-11-18', none('2026-11-15'))).toBe('2026-11-30');
  });

  it('monthly, across month ends', () => {
    const on31: RepeatingSchedule = { kind: 'monthly', day: 31 };
    expect(dueOnAssignment(on31, '2026-11-01', none('2026-11-15'))).toBe('2026-11-30');
    expect(upcomingOccurrence(on31, '2026-11-01', closed('2026-11-20', '2026-11-30', '2026-11-20'))).toEqual({ createOn: '2026-12-01', dueDate: '2026-12-31' });
    expect(upcomingOccurrence(on31, '2026-11-01', closed('2026-12-02', '2026-11-30', '2026-12-02'))).toEqual({ createOn: '2026-12-02', dueDate: '2026-12-31' });
    expect(dueOnAssignment(on31, '2027-02-10', none('2026-11-15'))).toBe('2027-02-28');
  });

  it('every N days after it is done', () => {
    const every10: RepeatingSchedule = { kind: 'after', every: 10, unit: 'days' };
    expect(dueOnAssignment(every10, '2026-11-01', none('2026-11-15'))).toBe('2026-11-15');
    // Due 11-25, done early on 11-20: created 11-26, due 10 days after it was done.
    expect(upcomingOccurrence(every10, '2026-11-01', closed('2026-11-20', '2026-11-25', '2026-11-20'))).toEqual({ createOn: '2026-11-26', dueDate: '2026-11-30' });
    // Due 11-25, done late on 11-28: created right away, due 10 days later.
    expect(upcomingOccurrence(every10, '2026-11-01', closed('2026-11-28', '2026-11-25', '2026-11-28'))).toEqual({ createOn: '2026-11-28', dueDate: '2026-12-08' });
    expect(dueOnAssignment(every10, '2026-11-20', none('2026-11-15'))).toBe('2026-11-20');
  });

  it('on assignment, never on or before a due date the chore already has', () => {
    // Friday's was done early, then the chore changed hands: the new person's is the next Friday.
    const fridays: RepeatingSchedule = { kind: 'weekly', interval: 1, weekdays: [5] };
    expect(dueOnAssignment(fridays, '2026-11-01', closed('2026-11-19', '2026-11-20', '2026-11-18'))).toBe('2026-11-27');
    // A long-ago due date doesn't hold it back.
    expect(dueOnAssignment({ kind: 'daily' }, '2026-11-01', closed('2026-11-15', '2026-11-02', '2026-11-03'))).toBe('2026-11-15');
  });

  it('the job creates it once today reaches F, due from today after downtime (Decision 3)', () => {
    const fridays: RepeatingSchedule = { kind: 'weekly', interval: 1, weekdays: [5] };
    expect(dueDateToGenerate(fridays, '2026-11-01', closed('2026-11-20', '2026-11-20', '2026-11-18'))).toBeNull();
    expect(dueDateToGenerate(fridays, '2026-11-01', closed('2026-11-21', '2026-11-20', '2026-11-18'))).toBe('2026-11-27');
    expect(dueDateToGenerate({ kind: 'daily' }, '2026-11-01', closed('2026-11-21', '2026-11-15', '2026-11-15'))).toBe('2026-11-21');
    expect(dueDateToGenerate({ kind: 'daily' }, '2026-11-01', none('2026-11-15'))).toBe('2026-11-15'); // nothing yet: F is today
  });
});

describe('every weekday (weekly, every week, Monday to Friday)', () => {
  // 2026-11-20 is a Friday, 2026-11-21 a Saturday, 2026-11-23 a Monday.
  const none = (today: string): ChoreTimeline => ({ today, latestDueDate: null, lastClosedDate: null });
  const closed = (today: string, latestDueDate: string, lastClosedDate: string): ChoreTimeline => ({ today, latestDueDate, lastClosedDate });

  it('lands on each weekday and skips Saturday and Sunday', () => {
    expect(nextScheduledDate(EVERY_WEEKDAY, '2026-11-01', '2026-11-18')).toBe('2026-11-18'); // Wednesday
    expect(nextScheduledDate(EVERY_WEEKDAY, '2026-11-01', '2026-11-20')).toBe('2026-11-20'); // Friday
    expect(nextScheduledDate(EVERY_WEEKDAY, '2026-11-01', '2026-11-21')).toBe('2026-11-23'); // Saturday → Monday
    expect(nextScheduledDate(EVERY_WEEKDAY, '2026-11-01', '2026-11-22')).toBe('2026-11-23'); // Sunday → Monday
  });

  it('claimed on a Saturday is due Monday', () => {
    expect(dueOnAssignment(EVERY_WEEKDAY, '2026-11-01', none('2026-11-21'))).toBe('2026-11-23');
    expect(dueOnAssignment(EVERY_WEEKDAY, '2026-11-01', none('2026-11-22'))).toBe('2026-11-23');
  });

  it('done on Friday comes back due Monday once Friday has passed', () => {
    const doneFriday = closed('2026-11-20', '2026-11-20', '2026-11-20');
    expect(upcomingOccurrence(EVERY_WEEKDAY, '2026-11-01', doneFriday)).toEqual({ createOn: '2026-11-21', dueDate: '2026-11-23' });
    expect(dueDateToGenerate(EVERY_WEEKDAY, '2026-11-01', doneFriday)).toBeNull(); // still Friday
    expect(dueDateToGenerate(EVERY_WEEKDAY, '2026-11-01', { ...doneFriday, today: '2026-11-21' })).toBe('2026-11-23');
    expect(dueDateToGenerate(EVERY_WEEKDAY, '2026-11-01', { ...doneFriday, today: '2026-11-22' })).toBe('2026-11-23');
  });

  it('done on Wednesday comes back due Thursday', () => {
    expect(dueDateToGenerate(EVERY_WEEKDAY, '2026-11-01', closed('2026-11-19', '2026-11-18', '2026-11-18'))).toBe('2026-11-19');
  });
});
