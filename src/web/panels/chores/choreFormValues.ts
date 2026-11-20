import { ChoreScheduleSchema, type Chore, type ChoreInput, type ChoreSchedule, type NewChoreInput } from '../../../shared/chores.js';

/** The chore editor's fields as the form holds them (strings, as inputs give them). Pure, so it's unit-tested. */
export interface ChoreFormValues {
  title: string;
  notes: string;
  /** '' is Unassigned. Only a new chore's form has the field. */
  assignee: string;
  startDate: string;
  type: 'fixed' | 'after' | 'none';
  repeats: 'daily' | 'weekly' | 'monthly';
  interval: string;
  weekdays: number[];
  /** '1' to '31', or 'last'. */
  monthDay: string;
  every: string;
  unit: 'days' | 'weeks';
}

export function emptyChoreForm(today: string): ChoreFormValues {
  return {
    title: '', notes: '', assignee: '', startDate: today, type: 'fixed', repeats: 'weekly', interval: '1',
    weekdays: [new Date(`${today}T00:00:00Z`).getUTCDay()], monthDay: String(Number(today.slice(8, 10))), every: '1', unit: 'weeks',
  };
}

export function toChoreFormValues(chore: Chore, today: string): ChoreFormValues {
  const v: ChoreFormValues = {
    ...emptyChoreForm(today),
    title: chore.title,
    notes: chore.notes ?? '',
    assignee: chore.assignee ? String(chore.assignee.id) : '',
    startDate: chore.startDate,
  };
  const s = chore.schedule;
  switch (s.kind) {
    case 'daily':
      return { ...v, repeats: 'daily' };
    case 'weekly':
      return { ...v, repeats: 'weekly', interval: String(s.interval), weekdays: s.weekdays };
    case 'monthly':
      return { ...v, repeats: 'monthly', monthDay: String(s.day) };
    case 'after':
      return { ...v, type: 'after', every: String(s.every), unit: s.unit };
    case 'none':
      return { ...v, type: 'none' };
  }
}

/** The schedule the form describes. Numbers that aren't filled in come out as 0 (or NaN) and fail validation. */
export function toSchedule(v: ChoreFormValues): ChoreSchedule {
  if (v.type === 'none') return { kind: 'none' };
  if (v.type === 'after') return { kind: 'after', every: Number(v.every), unit: v.unit };
  if (v.repeats === 'daily') return { kind: 'daily' };
  if (v.repeats === 'weekly') return { kind: 'weekly', interval: Number(v.interval), weekdays: v.weekdays };
  return { kind: 'monthly', day: v.monthDay === 'last' ? 'last' : Number(v.monthDay) };
}

/** What an edit saves: everything but who has the chore (that changes on the Board). */
export function toChoreInput(v: ChoreFormValues): ChoreInput {
  return {
    title: v.title.trim(),
    notes: v.notes.trim() === '' ? null : v.notes,
    schedule: toSchedule(v),
    startDate: v.startDate,
  };
}

/** What adding a chore saves: the chore and who has it ('' is Unassigned). */
export function toNewChoreInput(v: ChoreFormValues): NewChoreInput {
  return { ...toChoreInput(v), assigneeUserId: v.assignee === '' ? null : Number(v.assignee) };
}

/**
 * The start date only matters for "every N weeks", where its week is week one, so the form shows it
 * only then (chore board spec, "Frequencies"). Otherwise the form keeps it as it was: today for a new
 * chore, the chore's own for an edit.
 */
export function showsStartDate(v: ChoreFormValues): boolean {
  return v.type === 'fixed' && v.repeats === 'weekly' && Number(v.interval) > 1;
}

/**
 * What the form submits. The start date comes from the form only while it shows (`showsStartDate`);
 * otherwise it's `initial`'s (today for a new chore, the chore's own for an edit), so a date picked
 * for "every N weeks" and then hidden by changing the schedule isn't saved invisibly. Who has it is
 * sent only for a new chore (`isNew`); an edit never changes it.
 */
export function formInput(v: ChoreFormValues, initial: ChoreFormValues, isNew: true): NewChoreInput;
export function formInput(v: ChoreFormValues, initial: ChoreFormValues, isNew: false): ChoreInput;
export function formInput(v: ChoreFormValues, initial: ChoreFormValues, isNew: boolean): ChoreInput | NewChoreInput {
  const sent = showsStartDate(v) ? v : { ...v, startDate: initial.startDate };
  return isNew ? toNewChoreInput(sent) : toChoreInput(sent);
}

/** The schedule inputs that can be wrong, by `ChoreFormValues` name. */
export type ScheduleField = 'interval' | 'weekdays' | 'monthDay' | 'every' | 'unit';

const FIELD_OF: Record<string, ScheduleField> = { interval: 'interval', weekdays: 'weekdays', day: 'monthDay', every: 'every', unit: 'unit' };

/**
 * What stops the schedule from being saved, checked on the client before submitting with the same
 * rules the server applies: weekly and every-N-weeks schedules need at least one weekday, N is a
 * whole number of at least 1, and so on. `fields` lists every input with a problem, in form order;
 * `message` is the first problem. Null when the schedule is fine.
 */
export function scheduleProblem(v: ChoreFormValues): { message: string; fields: ScheduleField[] } | null {
  const result = ChoreScheduleSchema.safeParse(toSchedule(v));
  if (result.success) return null;
  const fields = [...new Set(result.error.issues.map((i) => FIELD_OF[String(i.path[0])]).filter((f) => f !== undefined))];
  return { message: result.error.issues[0]?.message ?? 'Finish the schedule', fields };
}
