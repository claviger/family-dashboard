import { describe, expect, it } from 'vitest';
import { ChoreScheduleSchema, type Chore } from '../../../shared/chores.js';
import {
  emptyChoreForm, formInput, scheduleProblem, showsStartDate, toChoreFormValues, toChoreInput, toNewChoreInput, toSchedule, type ChoreFormValues,
} from './choreFormValues.js';

const empty = emptyChoreForm('2026-11-18'); // a Wednesday

describe('emptyChoreForm', () => {
  it("starts today, weekly on today's weekday, unassigned", () => {
    expect(empty).toMatchObject({ startDate: '2026-11-18', type: 'fixed', repeats: 'weekly', interval: '1', weekdays: [3], monthDay: '18', assignee: '' });
  });
});

describe('toSchedule', () => {
  it('builds each schedule kind from the form', () => {
    const v = (over: Partial<ChoreFormValues>) => toSchedule({ ...empty, ...over });
    expect(v({ repeats: 'daily' })).toEqual({ kind: 'daily' });
    expect(v({ repeats: 'weekdays' })).toEqual({ kind: 'weekly', interval: 1, weekdays: [1, 2, 3, 4, 5] });
    // Every weekday ignores the weekly fields the form may still hold.
    expect(v({ repeats: 'weekdays', interval: '3', weekdays: [0] })).toEqual({ kind: 'weekly', interval: 1, weekdays: [1, 2, 3, 4, 5] });
    expect(v({ repeats: 'weekly', interval: '2', weekdays: [1, 4] })).toEqual({ kind: 'weekly', interval: 2, weekdays: [1, 4] });
    expect(v({ repeats: 'monthly', monthDay: '31' })).toEqual({ kind: 'monthly', day: 31 });
    expect(v({ repeats: 'monthly', monthDay: 'last' })).toEqual({ kind: 'monthly', day: 'last' });
    expect(v({ type: 'after', every: '3', unit: 'days' })).toEqual({ kind: 'after', every: 3, unit: 'days' });
    expect(v({ type: 'none' })).toEqual({ kind: 'none' });
  });

  it('turns unfinished numbers into schedules that fail validation', () => {
    expect(ChoreScheduleSchema.safeParse(toSchedule({ ...empty, interval: '' })).success).toBe(false);
    expect(ChoreScheduleSchema.safeParse(toSchedule({ ...empty, type: 'after', every: 'x' })).success).toBe(false);
    expect(ChoreScheduleSchema.safeParse(toSchedule({ ...empty, weekdays: [] })).success).toBe(false);
  });
});

describe('toChoreInput and toNewChoreInput', () => {
  it('trims the title and blanks notes to null; only a new chore carries who has it', () => {
    expect(toChoreInput({ ...empty, title: '  Trash ', notes: '   ', assignee: '7' })).toEqual({
      title: 'Trash', notes: null, schedule: { kind: 'weekly', interval: 1, weekdays: [3] }, startDate: '2026-11-18',
    });
    expect(toNewChoreInput({ ...empty, title: 'Trash', notes: 'Bins too', assignee: '7' })).toMatchObject({ notes: 'Bins too', assigneeUserId: 7 });
    expect(toNewChoreInput({ ...empty, title: 'Trash', assignee: '' })).toMatchObject({ assigneeUserId: null });
  });
});

describe('showsStartDate', () => {
  it('is only for every N weeks, where it picks week one', () => {
    expect(showsStartDate(empty)).toBe(false); // every week
    expect(showsStartDate({ ...empty, interval: '2' })).toBe(true);
    expect(showsStartDate({ ...empty, interval: '2', repeats: 'monthly' })).toBe(false);
    expect(showsStartDate({ ...empty, interval: '2', type: 'after' })).toBe(false);
    expect(showsStartDate({ ...empty, type: 'none' })).toBe(false);
  });
});

describe('formInput', () => {
  const january = { ...empty, title: 'Trash', interval: '2', startDate: '2027-01-04', assignee: '7' };

  it('saves the start date the form shows, but not one left behind when it was hidden', () => {
    expect(formInput(january, empty, true).startDate).toBe('2027-01-04');
    // Every 2 weeks with a January start, then back to every week: the hidden date isn't saved.
    expect(formInput({ ...january, interval: '1' }, empty, true).startDate).toBe('2026-11-18');
    expect(formInput({ ...january, repeats: 'monthly' }, empty, false).startDate).toBe('2026-11-18');
    expect(formInput({ ...january, type: 'none' }, { ...empty, startDate: '2026-10-01' }, false).startDate).toBe('2026-10-01');
  });

  it('carries who has it only for a new chore', () => {
    expect(formInput(january, empty, true)).toMatchObject({ assigneeUserId: 7 });
    const edit = formInput(january, empty, false);
    expect(edit).not.toHaveProperty('assigneeUserId');
    expect(edit).toEqual({ title: 'Trash', notes: null, schedule: { kind: 'weekly', interval: 2, weekdays: [3] }, startDate: '2027-01-04' });
  });
});

describe('toChoreFormValues', () => {
  it('round-trips a chore through the form', () => {
    const chore: Chore = {
      id: 1, title: 'Trash', notes: null, assignee: { id: 7, displayName: 'Riley', color: '#1D9E75' },
      schedule: { kind: 'after', every: 2, unit: 'weeks' }, startDate: '2026-11-01', status: 'active',
    };
    const v = toChoreFormValues(chore, '2026-11-18');
    expect(v).toMatchObject({ title: 'Trash', notes: '', assignee: '7', startDate: '2026-11-01', type: 'after', every: '2', unit: 'weeks' });
    expect(toChoreInput(v)).toEqual({
      title: 'Trash', notes: null, schedule: { kind: 'after', every: 2, unit: 'weeks' }, startDate: '2026-11-01',
    });
    for (const schedule of [{ kind: 'daily' }, { kind: 'monthly', day: 'last' }, { kind: 'weekly', interval: 3, weekdays: [0, 6] }, { kind: 'none' }] as const) {
      expect(toSchedule(toChoreFormValues({ ...chore, schedule: { ...schedule } as Chore['schedule'] }, '2026-11-18'))).toEqual(schedule);
    }
  });
});

describe('every weekday in the form', () => {
  const chore: Chore = {
    id: 2, title: 'Pack lunches', notes: null, assignee: null,
    schedule: { kind: 'weekly', interval: 1, weekdays: [1, 2, 3, 4, 5] }, startDate: '2026-11-01', status: 'active',
  };

  it('opens a weekly, every week, Monday to Friday chore as "Every weekday" and saves it unchanged', () => {
    const v = toChoreFormValues(chore, '2026-11-18');
    expect(v).toMatchObject({ type: 'fixed', repeats: 'weekdays' });
    expect(toChoreInput(v).schedule).toEqual({ kind: 'weekly', interval: 1, weekdays: [1, 2, 3, 4, 5] });
  });

  it('has the five days ticked, every week, when switched to Weekly', () => {
    const v = toChoreFormValues(chore, '2026-11-18');
    expect(v).toMatchObject({ interval: '1', weekdays: [1, 2, 3, 4, 5] });
    expect(toSchedule({ ...v, repeats: 'weekly' })).toEqual({ kind: 'weekly', interval: 1, weekdays: [1, 2, 3, 4, 5] });
  });

  it('opens other weekly schedules as Weekly', () => {
    for (const schedule of [
      { kind: 'weekly', interval: 2, weekdays: [1, 2, 3, 4, 5] },
      { kind: 'weekly', interval: 1, weekdays: [1, 2, 3, 4] },
      { kind: 'weekly', interval: 1, weekdays: [0, 1, 2, 3, 4, 5, 6] },
    ] as const) {
      const v = toChoreFormValues({ ...chore, schedule: { ...schedule, weekdays: [...schedule.weekdays] } }, '2026-11-18');
      expect(v.repeats).toBe('weekly');
      expect(toSchedule(v)).toEqual(schedule);
    }
  });

  it('has no schedule problem and no start date', () => {
    expect(scheduleProblem({ ...empty, repeats: 'weekdays', weekdays: [] })).toBeNull();
    expect(showsStartDate({ ...empty, repeats: 'weekdays', interval: '2' })).toBe(false);
  });
});

describe('scheduleProblem', () => {
  const v = (over: Partial<ChoreFormValues>) => scheduleProblem({ ...empty, ...over });

  it('is null for a schedule that can be saved', () => {
    expect(v({})).toBeNull();
    expect(v({ repeats: 'weekly', interval: '3', weekdays: [0, 6] })).toBeNull();
    expect(v({ repeats: 'daily', weekdays: [] })).toBeNull(); // weekdays only matter for weekly
    expect(v({ type: 'after', every: '2', unit: 'days', weekdays: [] })).toBeNull();
  });

  it('needs at least one weekday for weekly and every-N-weeks schedules', () => {
    expect(v({ weekdays: [] })).toEqual({ message: 'Pick at least one weekday', fields: ['weekdays'] });
    expect(v({ interval: '2', weekdays: [] })).toEqual({ message: 'Pick at least one weekday', fields: ['weekdays'] });
  });

  it('needs N of at least 1', () => {
    expect(v({ interval: '0' })).toEqual({ message: 'Repeat at least every week', fields: ['interval'] });
    expect(v({ interval: '' })).toMatchObject({ fields: ['interval'] });
    expect(v({ interval: '1.5' })).toMatchObject({ fields: ['interval'] });
    expect(v({ type: 'after', every: '0' })).toEqual({ message: 'Enter at least 1', fields: ['every'] });
  });

  it("names every field with a problem, and the first one's message", () => {
    expect(v({ interval: '0', weekdays: [] })).toEqual({ message: 'Repeat at least every week', fields: ['interval', 'weekdays'] });
  });
});
