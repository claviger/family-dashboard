import { describe, expect, it } from 'vitest';
import {
  ChoreScheduleSchema, compareBoardOrder, describeSchedule, EVERY_WEEKDAY, frequencyPeriodDays, HistoryQuerySchema, isEveryWeekday, isRepeating, NewChoreInputSchema, scheduleType,
  type ChoreSchedule,
} from './chores.js';

describe('describeSchedule', () => {
  it("words every frequency the board's way", () => {
    expect(describeSchedule({ kind: 'daily' })).toBe('Every day');
    expect(describeSchedule({ kind: 'weekly', interval: 1, weekdays: [5] })).toBe('Fridays');
    expect(describeSchedule({ kind: 'weekly', interval: 1, weekdays: [1, 4] })).toBe('Every week on Mon, Thu');
    expect(describeSchedule({ kind: 'weekly', interval: 2, weekdays: [1] })).toBe('Every 2 weeks on Mon');
    expect(describeSchedule({ kind: 'monthly', day: 1 })).toBe('Monthly on the 1st');
    expect(describeSchedule({ kind: 'monthly', day: 22 })).toBe('Monthly on the 22nd');
    expect(describeSchedule({ kind: 'monthly', day: 13 })).toBe('Monthly on the 13th');
    expect(describeSchedule({ kind: 'monthly', day: 31 })).toBe('Monthly on the 31st (or the last day)');
    expect(describeSchedule({ kind: 'monthly', day: 'last' })).toBe('Monthly on the last day');
    expect(describeSchedule({ kind: 'after', every: 10, unit: 'days' })).toBe("Every 10 days after it's done");
    expect(describeSchedule({ kind: 'after', every: 1, unit: 'days' })).toBe("Every day after it's done");
    expect(describeSchedule({ kind: 'after', every: 1, unit: 'weeks' })).toBe("Every week after it's done");
    expect(describeSchedule({ kind: 'after', every: 3, unit: 'weeks' })).toBe("Every 3 weeks after it's done");
    expect(describeSchedule({ kind: 'none' })).toBe('As needed');
  });

  it('says "Every weekday" for every week on exactly Monday to Friday, and lists the days otherwise', () => {
    expect(describeSchedule({ kind: 'weekly', interval: 1, weekdays: [1, 2, 3, 4, 5] })).toBe('Every weekday');
    expect(describeSchedule(EVERY_WEEKDAY)).toBe('Every weekday');
    expect(describeSchedule({ kind: 'weekly', interval: 1, weekdays: [1, 2, 3, 4] })).toBe('Every week on Mon, Tue, Wed, Thu');
    expect(describeSchedule({ kind: 'weekly', interval: 1, weekdays: [1, 2, 3, 4, 5, 6] })).toBe('Every week on Mon, Tue, Wed, Thu, Fri, Sat');
    expect(describeSchedule({ kind: 'weekly', interval: 1, weekdays: [0, 1, 2, 3, 4] })).toBe('Every week on Sun, Mon, Tue, Wed, Thu');
    expect(describeSchedule({ kind: 'weekly', interval: 2, weekdays: [1, 2, 3, 4, 5] })).toBe('Every 2 weeks on Mon, Tue, Wed, Thu, Fri');
  });
});

describe('isEveryWeekday', () => {
  it('is true only for every week on exactly Monday to Friday', () => {
    expect(EVERY_WEEKDAY).toEqual({ kind: 'weekly', interval: 1, weekdays: [1, 2, 3, 4, 5] });
    expect(isEveryWeekday(EVERY_WEEKDAY)).toBe(true);
    expect(isEveryWeekday(ChoreScheduleSchema.parse({ kind: 'weekly', interval: 1, weekdays: [5, 4, 3, 2, 1, 1] }))).toBe(true);
    expect(isEveryWeekday({ kind: 'weekly', interval: 2, weekdays: [1, 2, 3, 4, 5] })).toBe(false);
    expect(isEveryWeekday({ kind: 'weekly', interval: 1, weekdays: [1, 2, 3, 4] })).toBe(false);
    expect(isEveryWeekday({ kind: 'weekly', interval: 1, weekdays: [0, 1, 2, 3, 4, 5, 6] })).toBe(false);
    expect(isEveryWeekday({ kind: 'daily' })).toBe(false);
  });
});

describe('ChoreScheduleSchema', () => {
  it('sorts and de-duplicates weekdays and classifies the type', () => {
    const s = ChoreScheduleSchema.parse({ kind: 'weekly', interval: 1, weekdays: [4, 1, 4] });
    expect(s).toEqual({ kind: 'weekly', interval: 1, weekdays: [1, 4] });
    expect(scheduleType(s)).toBe('fixed');
    expect(scheduleType({ kind: 'after', every: 2, unit: 'weeks' })).toBe('after_completion');
    expect(ChoreScheduleSchema.parse({ kind: 'none' })).toEqual({ kind: 'none' });
    expect(scheduleType({ kind: 'none' })).toBe('as_needed');
    expect(isRepeating({ kind: 'none' })).toBe(false);
    expect(isRepeating({ kind: 'daily' })).toBe(true);
  });

  it('rejects bad schedules with readable messages', () => {
    const message = (v: unknown) => ChoreScheduleSchema.safeParse(v).error?.issues[0]?.message;
    expect(message({ kind: 'weekly', interval: 1, weekdays: [] })).toBe('Pick at least one weekday');
    expect(message({ kind: 'weekly', interval: 0, weekdays: [1] })).toBe('Repeat at least every week');
    expect(message({ kind: 'monthly', day: 32 })).toBe('Pick a day of the month from 1 to 31, or the last day');
    expect(message({ kind: 'after', every: 0, unit: 'days' })).toBe('Enter at least 1');
    expect(message({ kind: 'hourly' })).toBe('Pick a schedule');
  });
});

describe('frequencyPeriodDays', () => {
  it('gives each frequency its period in days, and none for as needed', () => {
    expect(frequencyPeriodDays({ kind: 'daily' })).toBe(1);
    expect(frequencyPeriodDays({ kind: 'weekly', interval: 1, weekdays: [5] })).toBe(7);
    expect(frequencyPeriodDays({ kind: 'weekly', interval: 1, weekdays: [1, 4] })).toBe(3.5);
    expect(frequencyPeriodDays({ kind: 'weekly', interval: 2, weekdays: [1, 3, 5] })).toBeCloseTo(14 / 3);
    expect(frequencyPeriodDays({ kind: 'monthly', day: 'last' })).toBe(30);
    expect(frequencyPeriodDays({ kind: 'after', every: 10, unit: 'days' })).toBe(10);
    expect(frequencyPeriodDays({ kind: 'after', every: 2, unit: 'weeks' })).toBe(14);
    expect(frequencyPeriodDays({ kind: 'none' })).toBeNull();
  });

  it('gives every weekday 7 / 5 = 1.4 days', () => {
    expect(frequencyPeriodDays(EVERY_WEEKDAY)).toBeCloseTo(1.4);
  });
});

describe('compareBoardOrder', () => {
  it('puts the most frequent first and as needed last, then sorts by title ignoring case', () => {
    const row = (choreId: number, title: string, schedule: ChoreSchedule) => ({ choreId, title, schedule });
    const rows = [
      row(1, 'Fix the gate', { kind: 'none' }),
      row(2, 'Yard', { kind: 'monthly', day: 1 }),
      row(3, 'Trash', { kind: 'weekly', interval: 1, weekdays: [5] }),
      row(4, 'b dishes', { kind: 'daily' }),
      row(5, 'A cat', { kind: 'daily' }),
      row(6, 'Water plants', { kind: 'after', every: 2, unit: 'days' }),
      row(7, 'Laundry', { kind: 'weekly', interval: 1, weekdays: [1, 4] }),
      row(8, 'Air out', { kind: 'none' }),
      row(9, 'a cat', { kind: 'daily' }),
    ];
    expect([...rows].sort(compareBoardOrder).map((r) => r.choreId)).toEqual([5, 9, 4, 6, 7, 3, 2, 8, 1]);
  });

  it('puts every weekday right after every day, ahead of every 2 days and twice a week', () => {
    const row = (choreId: number, title: string, schedule: ChoreSchedule) => ({ choreId, title, schedule });
    const rows = [
      row(1, 'Water plants', { kind: 'after', every: 2, unit: 'days' }),
      row(2, 'Laundry', { kind: 'weekly', interval: 1, weekdays: [1, 4] }),
      row(3, 'Pack lunches', EVERY_WEEKDAY),
      row(4, 'Dishes', { kind: 'daily' }),
      row(5, 'Six days', { kind: 'weekly', interval: 1, weekdays: [1, 2, 3, 4, 5, 6] }),
    ];
    expect([...rows].sort(compareBoardOrder).map((r) => r.choreId)).toEqual([4, 5, 3, 1, 2]);
  });
});

describe('NewChoreInputSchema', () => {
  it('trims the title and requires a start date', () => {
    const ok = NewChoreInputSchema.parse({
      title: '  Trash  ', assigneeUserId: null, schedule: { kind: 'daily' }, startDate: '2026-11-15',
    });
    expect(ok.title).toBe('Trash');
    const bad = NewChoreInputSchema.safeParse({ title: '', assigneeUserId: null, schedule: { kind: 'daily' } });
    expect(bad.error?.issues.map((i) => i.message)).toEqual(['Enter a title', 'Enter a date written as YYYY-MM-DD']);
  });
});

describe('HistoryQuerySchema', () => {
  it('defaults to everyone, the last 30 days, and showing skipped', () => {
    expect(HistoryQuerySchema.parse({})).toEqual({ person: 'all', range: 'last_30_days', skipped: true });
    expect(HistoryQuerySchema.parse({ person: '7', choreId: '3', skipped: 'false' })).toMatchObject({ person: 7, choreId: 3, skipped: false });
  });

  it('needs both ends of a custom range, in order', () => {
    const message = (v: unknown) => HistoryQuerySchema.safeParse(v).error?.issues[0]?.message;
    expect(message({ range: 'custom', from: '2026-11-01' })).toBe('Pick both dates for a custom range');
    expect(message({ range: 'custom', from: '2026-11-10', to: '2026-11-01' })).toBe('The start date must be on or before the end date');
    expect(message({ person: '1e3' })).toBe('Pick a person from the list');
  });
});
