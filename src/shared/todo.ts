import { z } from 'zod';
import { LocalDateSchema, LocalTimeSchema } from './dates.js';
import { TodoistFreshnessSchema } from './integrations.js';

export const TODO_TITLE_MAX = 500;
export const TODO_NOTES_MAX = 10_000;

/** Spec §10.3. The first entry is the default. */
export const TODO_SUMMARY_VIEWS = ['overdue_today_undated', 'overdue_today', 'next_7_days', 'everything'] as const;
export const TodoSummaryViewSchema = z.enum(TODO_SUMMARY_VIEWS, { error: 'Pick what the home card shows' });
export type TodoSummaryView = z.infer<typeof TodoSummaryViewSchema>;
export const DEFAULT_TODO_SUMMARY_VIEW: TodoSummaryView = 'overdue_today_undated';

export const TODO_SUMMARY_VIEW_LABELS: Record<TodoSummaryView, string> = {
  overdue_today_undated: 'Overdue, today, and undated',
  overdue_today: 'Overdue and today',
  next_7_days: 'Next 7 days',
  everything: 'Everything',
};

export const TodoItemSchema = z.object({
  id: z.number(),
  ownerUserId: z.number(),
  title: z.string(),
  notes: z.string().nullable(),
  dueDate: LocalDateSchema.nullable(),
  dueTime: LocalTimeSchema.nullable(),
  /** ISO instant, or null while open. */
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  /** Null when the app created it (system actor), e.g. a chore's to-do. */
  createdByUserId: z.number().nullable(),
  /** Set for to-dos created by the Chores panel (phase 3). */
  choreOccurrenceId: z.number().nullable(),
  /** The Todoist project, for someone linked to Todoist (shown read-only; names come with the list). */
  todoistProjectId: z.string().nullable(),
  /** The Todoist task repeats: completing it moves its date forward, and its date can only be changed in Todoist. */
  recurring: z.boolean(),
});
export type TodoItem = z.infer<typeof TodoItemSchema>;

const TitleSchema = z
  .string({ error: 'Enter a title' })
  .trim()
  .min(1, 'Enter a title')
  .max(TODO_TITLE_MAX, `Keep the title to ${TODO_TITLE_MAX} characters or fewer`);
const NotesSchema = z
  .string({ error: 'Notes must be text' })
  .max(TODO_NOTES_MAX, 'Keep notes to 10,000 characters or fewer')
  .nullable();

export const CreateTodoInputSchema = z
  .object({
    title: TitleSchema,
    notes: NotesSchema.optional(),
    dueDate: LocalDateSchema.nullable().optional(),
    dueTime: LocalTimeSchema.nullable().optional(),
  })
  .refine((v) => !v.dueTime || !!v.dueDate, { message: 'Pick a date before setting a time', path: ['dueTime'] });
export type CreateTodoInput = z.infer<typeof CreateTodoInputSchema>;

/** Every field is optional, but at least one must be present. The due-time rule is checked by the service against the merged item. */
export const UpdateTodoInputSchema = z
  .object({
    title: TitleSchema.optional(),
    notes: NotesSchema.optional(),
    dueDate: LocalDateSchema.nullable().optional(),
    dueTime: LocalTimeSchema.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change' });
export type UpdateTodoInput = z.infer<typeof UpdateTodoInputSchema>;

/** `?userId=` on list and item routes. Omitted means the signed-in user's own list. */
// Plain decimal digits only: z.coerce.number() would also accept '0x10', '1e1', and ' 7'.
export const TodoOwnerQuerySchema = z.object({
  userId: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).optional(),
});

export const TodoGroupsSchema = z.object({
  overdue: z.array(TodoItemSchema),
  today: z.array(TodoItemSchema),
  upcoming: z.array(TodoItemSchema),
  none: z.array(TodoItemSchema),
});
export type TodoGroups = z.infer<typeof TodoGroupsSchema>;
export type TodoGroupKey = keyof TodoGroups;

export const TodoOwnerSchema = z.object({ id: z.number(), displayName: z.string() });
export type TodoOwner = z.infer<typeof TodoOwnerSchema>;

/** GET /api/panels/todo/items */
export const TodoListResponseSchema = z.object({
  owner: TodoOwnerSchema,
  /** Today in the family time zone. */
  today: LocalDateSchema,
  /** Open items, each group sorted by due date and time, then creation. */
  groups: TodoGroupsSchema,
  /** Items completed in the last 7 days, most recent first. */
  completed: z.array(TodoItemSchema),
  /** Set when the list's owner is linked to Todoist: sync status, last sync, project names. */
  todoist: TodoistFreshnessSchema.nullable(),
});
export type TodoListResponse = z.infer<typeof TodoListResponseSchema>;

/** GET /api/panels/todo/summary */
export const TodoSummaryResponseSchema = z.object({
  view: TodoSummaryViewSchema,
  today: LocalDateSchema,
  /** At most 8 open items matching the view, overdue first. */
  items: z.array(TodoItemSchema),
  /** How many more matching items there are beyond `items`. */
  more: z.number(),
  /** Set when the signed-in person is linked to Todoist, for "Updated X ago" and the Reconnect prompt. */
  todoist: TodoistFreshnessSchema.nullable(),
});
export type TodoSummaryResponse = z.infer<typeof TodoSummaryResponseSchema>;

/** GET /api/panels/todo/people (admins only) */
export const TodoPersonSchema = z.object({ id: z.number(), displayName: z.string(), color: z.string() });
export type TodoPerson = z.infer<typeof TodoPersonSchema>;

/** GET and PUT /api/panels/todo/prefs */
export const TodoPrefsSchema = z.object({ summaryView: TodoSummaryViewSchema });
export type TodoPrefs = z.infer<typeof TodoPrefsSchema>;
