import { z } from 'zod';
import { LocalDateSchema } from './dates.js';

export const CHORE_TITLE_MAX = 200;
export const CHORE_NOTES_MAX = 2000;

/** Weekday numbers are 0 = Sunday … 6 = Saturday, like Date.getUTCDay(). Weeks start on Sunday. */
export const WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

const WeekdaysSchema = z
  .array(z.int({ error: 'Pick weekdays from the list' }).min(0).max(6, 'Pick weekdays from the list'), {
    error: 'Pick at least one weekday',
  })
  .min(1, 'Pick at least one weekday')
  .transform((days) => [...new Set(days)].sort((a, b) => a - b));

const MONTH_DAY_MESSAGE = 'Pick a day of the month from 1 to 31, or the last day';

/**
 * A chore's schedule (spec §11.1, chore board spec "Frequencies"). `daily`, `weekly`, and `monthly`
 * are fixed schedules; `after` repeats a set time after the previous occurrence was completed or
 * skipped; `none` is "as needed", with no frequency. `weekly` with `interval` 1 is "every week"; with
 * N > 1 it is "every N weeks", counted from the week of the start date.
 */
export const ChoreScheduleSchema = z.discriminatedUnion(
  'kind',
  [
    z.object({ kind: z.literal('daily') }),
    z.object({
      kind: z.literal('weekly'),
      interval: z.int({ error: 'Enter how many weeks apart' }).min(1, 'Repeat at least every week').max(52, 'Repeat at least once a year'),
      weekdays: WeekdaysSchema,
    }),
    z.object({
      kind: z.literal('monthly'),
      day: z.union([z.int().min(1, MONTH_DAY_MESSAGE).max(31, MONTH_DAY_MESSAGE), z.literal('last')], { error: MONTH_DAY_MESSAGE }),
    }),
    z.object({
      kind: z.literal('after'),
      every: z.int({ error: 'Enter how long after' }).min(1, 'Enter at least 1').max(365, 'Enter 365 or fewer'),
      unit: z.enum(['days', 'weeks'], { error: 'Pick days or weeks' }),
    }),
    z.object({ kind: z.literal('none') }),
  ],
  { error: 'Pick a schedule' },
);
export type ChoreSchedule = z.infer<typeof ChoreScheduleSchema>;
export type FixedSchedule = Extract<ChoreSchedule, { kind: 'daily' | 'weekly' | 'monthly' }>;
export type AfterCompletionSchedule = Extract<ChoreSchedule, { kind: 'after' }>;
/** Every schedule but as needed: the chore comes up again on its own. */
export type RepeatingSchedule = FixedSchedule | AfterCompletionSchedule;

export function isRepeating(schedule: ChoreSchedule): schedule is RepeatingSchedule {
  return schedule.kind !== 'none';
}

export type ScheduleType = 'fixed' | 'after_completion' | 'as_needed';
export function scheduleType(schedule: ChoreSchedule): ScheduleType {
  if (schedule.kind === 'after') return 'after_completion';
  return schedule.kind === 'none' ? 'as_needed' : 'fixed';
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'] as const;

function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
}

/**
 * The board's frequency summary (chore board spec): "Every day", "Fridays", "Every week on Mon, Thu",
 * "Every 2 weeks on Mon", "Monthly on the 1st", "Every 10 days after it's done", "As needed".
 */
export function describeSchedule(schedule: ChoreSchedule): string {
  switch (schedule.kind) {
    case 'daily':
      return 'Every day';
    case 'weekly': {
      if (schedule.interval === 1 && schedule.weekdays.length === 1) return `${DAY_NAMES[schedule.weekdays[0]!]}s`;
      const days = schedule.weekdays.map((d) => WEEKDAY_LABELS[d]).join(', ');
      return schedule.interval === 1 ? `Every week on ${days}` : `Every ${schedule.interval} weeks on ${days}`;
    }
    case 'monthly':
      if (schedule.day === 'last') return 'Monthly on the last day';
      return `Monthly on the ${ordinal(schedule.day)}${schedule.day >= 29 ? ' (or the last day)' : ''}`;
    case 'after': {
      const unit = schedule.unit === 'days' ? 'day' : 'week';
      return schedule.every === 1 ? `Every ${unit} after it's done` : `Every ${schedule.every} ${unit}s after it's done`;
    }
    case 'none':
      return 'As needed';
  }
}

/**
 * How many days apart a chore comes up, for the board's order (chore board spec "Sort order"):
 * daily 1, k weekdays every N weeks 7N / k, monthly 30, every N days or weeks after completion N or
 * 7N. Null for as needed, which sorts after everything else.
 */
export function frequencyPeriodDays(schedule: ChoreSchedule): number | null {
  switch (schedule.kind) {
    case 'daily':
      return 1;
    case 'weekly':
      return (7 * schedule.interval) / schedule.weekdays.length;
    case 'monthly':
      return 30;
    case 'after':
      return schedule.unit === 'weeks' ? 7 * schedule.every : schedule.every;
    case 'none':
      return null;
  }
}

type BoardOrdered = { choreId: number; title: string; schedule: ChoreSchedule };

/** The board's order: most often first, as needed last, then by title ignoring case, then the older chore first. */
export function compareBoardOrder(a: BoardOrdered, b: BoardOrdered): number {
  const pa = frequencyPeriodDays(a.schedule) ?? Number.POSITIVE_INFINITY;
  const pb = frequencyPeriodDays(b.schedule) ?? Number.POSITIVE_INFINITY;
  if (pa !== pb) return pa < pb ? -1 : 1;
  return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) || a.choreId - b.choreId;
}

export const CHORE_STATUSES = ['active', 'paused', 'archived'] as const;
export type ChoreStatus = (typeof CHORE_STATUSES)[number];
export const ASSIGNMENT_SOURCES = ['default', 'claimed', 'admin'] as const;
export type AssignmentSource = (typeof ASSIGNMENT_SOURCES)[number];
export const OCCURRENCE_STATES = ['open', 'done', 'skipped'] as const;
export type OccurrenceState = (typeof OCCURRENCE_STATES)[number];
export const TODO_SYNC_STATUSES = ['ok', 'pending', 'not_applicable'] as const;
export type TodoSyncStatus = (typeof TODO_SYNC_STATUSES)[number];

export const ASSIGNMENT_SOURCE_LABELS: Record<AssignmentSource, string> = {
  default: 'Default',
  claimed: 'Claimed',
  admin: 'By an admin',
};

const PositiveIdSchema = z.int({ error: 'Pick a person from the list' }).positive('Pick a person from the list');

/** PUT /chores/:id (admins only): what an edit changes. Who has the chore changes on the board. */
export const ChoreInputSchema = z.object({
  title: z
    .string({ error: 'Enter a title' })
    .trim()
    .min(1, 'Enter a title')
    .max(CHORE_TITLE_MAX, `Keep the title to ${CHORE_TITLE_MAX} characters or fewer`),
  notes: z.string({ error: 'Notes must be text' }).max(CHORE_NOTES_MAX, 'Keep notes to 2,000 characters or fewer').nullable().optional(),
  schedule: ChoreScheduleSchema,
  startDate: LocalDateSchema,
});
export type ChoreInput = z.infer<typeof ChoreInputSchema>;

/** POST /chores (anyone with the panel): a new chore and who has it. Null is Unassigned; a member may only pick themselves. */
export const NewChoreInputSchema = ChoreInputSchema.extend({ assigneeUserId: PositiveIdSchema.nullable() });
export type NewChoreInput = z.infer<typeof NewChoreInputSchema>;

export const ChorePersonSchema = z.object({ id: z.number(), displayName: z.string(), color: z.string() });
export type ChorePerson = z.infer<typeof ChorePersonSchema>;

export const ChoreSchema = z.object({
  id: z.number(),
  title: z.string(),
  notes: z.string().nullable(),
  /** Who has it now; null is Unassigned. */
  assignee: ChorePersonSchema.nullable(),
  schedule: ChoreScheduleSchema,
  startDate: LocalDateSchema,
  status: z.enum(CHORE_STATUSES),
});
export type Chore = z.infer<typeof ChoreSchema>;

/**
 * Shown when a change went through but an old to-do couldn't be removed yet (spec §14: the user
 * hears about it). `todo.retryPending` keeps trying.
 */
export const TODO_REMOVAL_WARNING = "The old to-do couldn't be removed yet. It will be retried automatically.";

/** Pause, resume, and archive responses; `warning` is set when a to-do removal is still pending. */
export const ChoreResponseSchema = ChoreSchema.extend({ warning: z.string().optional() });
export type ChoreResponse = z.infer<typeof ChoreResponseSchema>;

/** GET /chores */
export const ChoreListResponseSchema = z.object({ today: LocalDateSchema, chores: z.array(ChoreSchema) });
export type ChoreListResponse = z.infer<typeof ChoreListResponseSchema>;

export const OccurrenceSchema = z.object({
  id: z.number(),
  choreId: z.number(),
  /** The chore's title when the occurrence was created. */
  title: z.string(),
  /** Null for an as-needed chore, which has no due date. */
  dueDate: LocalDateSchema.nullable(),
  /** Who has it. */
  assignee: ChorePersonSchema.nullable(),
  assignmentSource: z.enum(ASSIGNMENT_SOURCES),
  state: z.enum(OCCURRENCE_STATES),
  /** When it was completed or skipped (ISO instant). */
  closedAt: z.string().nullable(),
  /** Who completed or skipped it. */
  closedBy: ChorePersonSchema.nullable(),
  credited: ChorePersonSchema.nullable(),
  todoSyncStatus: z.enum(TODO_SYNC_STATUSES),
});
export type Occurrence = z.infer<typeof OccurrenceSchema>;

/** Occurrence action responses; `warning` is set when a to-do removal is still pending. */
export const OccurrenceResponseSchema = OccurrenceSchema.extend({ warning: z.string().optional() });
export type OccurrenceResponse = z.infer<typeof OccurrenceResponseSchema>;

/** A chore's state on the board (chore board spec, "The board"). */
export const BOARD_STATES = ['unassigned', 'due', 'overdue', 'waiting', 'on_list'] as const;
export type BoardState = (typeof BOARD_STATES)[number];

/** One row of the board: a chore, how often it comes up, who has it, and its state. */
export const BoardRowSchema = z.object({
  choreId: z.number(),
  title: z.string(),
  notes: z.string().nullable(),
  schedule: ChoreScheduleSchema,
  /** describeSchedule(schedule): "Every day", "Fridays", … "As needed". */
  frequency: z.string(),
  assignee: ChorePersonSchema.nullable(),
  state: z.enum(BOARD_STATES),
  /** `due` and `overdue`: the open occurrence's due date. `waiting`: the next due date. Otherwise null. */
  date: LocalDateSchema.nullable(),
  /** The open occurrence, to complete or skip it. Null when nothing is open. */
  occurrenceId: z.number().nullable(),
  /** The open occurrence's to-do status ("Not on to-do list yet" while `pending`). Null when nothing is open. */
  todoSyncStatus: z.enum(TODO_SYNC_STATUSES).nullable(),
});
export type BoardRow = z.infer<typeof BoardRowSchema>;

/** GET /board: every active chore, most often first (compareBoardOrder). */
export const BoardResponseSchema = z.object({ today: LocalDateSchema, rows: z.array(BoardRowSchema) });
export type BoardResponse = z.infer<typeof BoardResponseSchema>;

/** Claim, release, and assign responses: the chore's row; `warning` is set when an old to-do couldn't be removed yet. */
export const BoardRowResponseSchema = BoardRowSchema.extend({ warning: z.string().optional() });
export type BoardRowResponse = z.infer<typeof BoardRowResponseSchema>;

/** The home tile shows at most this many rows, unless your due chores alone are more (chore board spec, "Home tile"). */
export const TILE_ROWS = 6;

/** GET /summary: the home tile, already trimmed to TILE_ROWS. */
export const ChoreSummaryResponseSchema = z.object({
  today: LocalDateSchema,
  /** Yours with an open occurrence: overdue first, then by due date, then as-needed ones. Always every one. */
  due: z.array(BoardRowSchema),
  /** Yours with nothing due yet, soonest first. */
  waiting: z.array(BoardRowSchema),
  /** The top of the board's unassigned chores, in board order. */
  upForGrabs: z.array(BoardRowSchema),
});
export type ChoreSummaryResponse = z.infer<typeof ChoreSummaryResponseSchema>;

/** GET /people: everyone, for pickers, filters, and the "won't see it" warning. */
export const ChorePeopleEntrySchema = ChorePersonSchema.extend({
  active: z.boolean(),
  hasChores: z.boolean(),
  hasTodo: z.boolean(),
});
export type ChorePeopleEntry = z.infer<typeof ChorePeopleEntrySchema>;

export const HISTORY_RANGES = ['this_week', 'this_month', 'last_30_days', 'custom'] as const;
export type HistoryRange = (typeof HISTORY_RANGES)[number];
export const HISTORY_RANGE_LABELS: Record<HistoryRange, string> = {
  this_week: 'This week',
  this_month: 'This month',
  last_30_days: 'Last 30 days',
  custom: 'Custom',
};

const QueryIdSchema = z
  .string()
  .regex(/^\d+$/, 'Pick from the list')
  .transform(Number)
  .pipe(z.number().int().positive('Pick from the list').max(Number.MAX_SAFE_INTEGER, 'Pick from the list'));

/** GET /history query string (spec §11.7). Every field arrives as text. */
export const HistoryQuerySchema = z
  .object({
    /** 'all' is Everyone; a user id is one person. */
    person: z.union([z.literal('all'), QueryIdSchema], { error: 'Pick a person from the list' }).default('all'),
    range: z.enum(HISTORY_RANGES, { error: 'Pick a date range' }).default('last_30_days'),
    from: LocalDateSchema.optional(),
    to: LocalDateSchema.optional(),
    choreId: QueryIdSchema.optional(),
    skipped: z.enum(['true', 'false'], { error: 'Show skipped must be true or false' }).default('true').transform((v) => v === 'true'),
  })
  .refine((q) => q.range !== 'custom' || (q.from !== undefined && q.to !== undefined), {
    message: 'Pick both dates for a custom range',
  })
  .refine((q) => q.range !== 'custom' || !q.from || !q.to || q.from <= q.to, {
    message: 'The start date must be on or before the end date',
  });
export type HistoryQuery = z.infer<typeof HistoryQuerySchema>;

export const HistoryEntrySchema = z.object({
  id: z.number(),
  choreId: z.number(),
  title: z.string(),
  dueDate: LocalDateSchema.nullable(),
  state: z.enum(['done', 'skipped']),
  closedAt: z.string(),
  /** The family-local date it was completed or skipped. */
  closedDate: LocalDateSchema,
  credited: ChorePersonSchema.nullable(),
  closedBy: ChorePersonSchema.nullable(),
  assignee: ChorePersonSchema.nullable(),
  assignmentSource: z.enum(ASSIGNMENT_SOURCES),
  /** Completed on a date after its due date. */
  late: z.boolean(),
  /** The chore's most recent occurrence and the chore is active, so an admin can reopen it. */
  canReopen: z.boolean(),
});
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

export const HistoryResponseSchema = z.object({
  today: LocalDateSchema,
  from: LocalDateSchema,
  to: LocalDateSchema,
  /** Counted over the whole filter, whether or not skipped entries are shown. */
  totals: z.object({ completed: z.number(), late: z.number(), skipped: z.number() }),
  entries: z.array(HistoryEntrySchema),
});
export type HistoryResponse = z.infer<typeof HistoryResponseSchema>;

/** POST /chores/:id/assign (admins only). Null means Unassigned. */
export const AssignInputSchema = z.object({ userId: PositiveIdSchema.nullable() });
/** POST /occurrences/:id/credit (admins only). */
export const CreditInputSchema = z.object({ userId: PositiveIdSchema });

/** GET /api/admin/panels/chores/stuck: chore to-do changes that hit the retry cap (System page). */
export const StuckTodoSchema = z.object({
  /** `create`: the occurrence's to-do couldn't be created (`id` is the occurrence). Otherwise a queued change to a to-do (`id` is the to-do). */
  kind: z.enum(['create', 'remove', 'complete']),
  id: z.number(),
  title: z.string(),
  dueDate: z.string().nullable(),
  /** Whose to-do list. */
  owner: z.object({ id: z.number(), displayName: z.string() }).nullable(),
  attempts: z.number(),
  lastError: z.string().nullable(),
  stuckSince: z.string(),
});
export type StuckTodo = z.infer<typeof StuckTodoSchema>;
