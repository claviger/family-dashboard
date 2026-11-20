import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { PendingCalendar, StoredEvent } from '../../shared/calendar.js';
import type { ChoreSchedule } from '../../shared/chores.js';
import { SPEND_IMPORT_FORMATS, type CardMapping, type PreviewRow, type SpendImportDraftPlan } from '../../shared/spend.js';
import { PLAID_PURPOSES } from '../../shared/plaid.js';
import {
  SAVINGS_ACCOUNT_KINDS, SAVINGS_ACCOUNT_SOURCES, SAVINGS_BALANCE_SOURCES, SAVINGS_FLOW_KINDS, SAVINGS_FLOW_SOURCES, SAVINGS_IMPORT_FORMATS,
  type SavingsGroupChoices, type SavingsImportDraftPlan, type SavingsMapping,
} from '../../shared/savings.js';

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  email: text('email').notNull().unique(),
  googleSub: text('google_sub').unique(),
  displayName: text('display_name').notNull(),
  color: text('color').notNull(),
  role: text('role', { enum: ['admin', 'member'] }).notNull(),
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  lastLoginAt: integer('last_login_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

export const sessions = sqliteTable('sessions', {
  idHash: text('id_hash').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
});

export const panelGrants = sqliteTable(
  'panel_grants',
  {
    userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
    panelId: text('panel_id').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.panelId] })],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

/**
 * The latest error of each job, one row per job name (`recordJobError` updates it in place), so a
 * job that fails every few minutes can't push other jobs' errors out. `occurred_at` is the latest
 * failure; `first_occurred_at` is when the current run of failures started, null once the job has
 * succeeded since.
 */
export const jobErrors = sqliteTable(
  'job_errors',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    job: text('job').notNull(),
    message: text('message').notNull(),
    occurredAt: integer('occurred_at', { mode: 'timestamp_ms' }).notNull(),
    firstOccurredAt: integer('first_occurred_at', { mode: 'timestamp_ms' }),
  },
  (t) => [uniqueIndex('job_errors_job_unique').on(t.job)],
);

/**
 * To-do items (spec §10, §18). Rows with `backend = 'internal'` are the internal list (spec §10.5).
 * Rows with `backend = 'todoist'` are the Todoist mirror (spec §10.6): a local copy of a linked
 * person's tasks, kept current by sync. Linking and unlinking convert rows in place, so a row's id
 * never changes and chore occurrences keep pointing at it.
 *
 * Phase 4 added the Todoist columns with `ALTER TABLE ADD COLUMN`; the table is never rebuilt.
 *
 * `chore_occurrence_id` has no foreign key: SQLite can only add one by rebuilding the table. The link
 * is safe without it. It's set only by TodoService for an occurrence the Chores panel just created;
 * occurrence ids are AUTOINCREMENT, so a deleted occurrence's id is never reused; and the Chores
 * panel's handlers act only when the occurrence still points back at the to-do (`occ.todoId === item.id`).
 */
export const todos = sqliteTable(
  'todos',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    ownerUserId: integer('owner_user_id').notNull().references(() => users.id),
    backend: text('backend', { enum: ['internal', 'todoist'] }).notNull().default('internal'),
    title: text('title').notNull(),
    notes: text('notes'),
    /** Local date (YYYY-MM-DD) in the family time zone. */
    dueDate: text('due_date'),
    /** Local time (HH:MM). Only set when due_date is set. */
    dueTime: text('due_time'),
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
    /** Null when the app created the item (the system actor). */
    createdByUserId: integer('created_by_user_id').references(() => users.id),
    choreOccurrenceId: integer('chore_occurrence_id'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
    /** Soft delete, so chore history (phase 3) can still point at the row. */
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
    /**
     * The Todoist task id (opaque text). On a `todoist` row, the task it mirrors. On an open
     * `internal` row, the task it mirrored before an unlink, so a relink matches it instead of
     * creating it again.
     */
    todoistTaskId: text('todoist_task_id'),
    /**
     * The Todoist user id of the account `todoist_task_id` belongs to, set whenever it is. A relink
     * to a different account can't look up the kept task ids (they'd all 404 as if deleted), so
     * linking clears both on open internal rows from another account, and they're added as new tasks.
     */
    todoistAccountId: text('todoist_account_id'),
    /** The task's Todoist project, shown read-only. */
    todoistProjectId: text('todoist_project_id'),
    /** The task has a repeating due date in Todoist (spec §10.6: completing it moves the date). */
    todoistRecurring: integer('todoist_recurring', { mode: 'boolean' }).notNull().default(false),
    /** A fixed-timezone due time's zone (Todoist `due.timezone`), kept when the time is edited here. Null for dates and floating times. */
    todoistDueTimezone: text('todoist_due_timezone'),
    /**
     * Set on an open internal row of a linked person when Todoist refused to take it during the
     * move (the reason, for the log and System page). It isn't tried again; it stays on the
     * dashboard list, and writes to it are local.
     */
    todoistMoveError: text('todoist_move_error'),
    /**
     * When the `item_add` that moves this internal row into Todoist was first sent, before any
     * response. A replay of that command may come back without a `temp_id_mapping` (UNVERIFIED);
     * then only a mirror row first inserted after this time can be the task it made.
     */
    todoistMoveAttemptedAt: integer('todoist_move_attempted_at', { mode: 'timestamp_ms' }),
    /** Replays of that move that settled nothing (no mapping and no single copy); 3 keep the row local. */
    todoistMoveReplays: integer('todoist_move_replays').notNull().default(0),
  },
  (t) => [
    index('todos_owner_idx').on(t.ownerUserId, t.completedAt),
    // One live mirror row per Todoist task and person. Per person, because a task in a shared
    // project shows up in every member's sync, so two people's mirrors can hold the same task.
    uniqueIndex('todos_todoist_task_unique')
      .on(t.ownerUserId, t.todoistTaskId)
      .where(sql`backend = 'todoist' and deleted_at is null`),
    // At most one live to-do per chore occurrence. Deleted rows don't count, so a chore can get a new one.
    uniqueIndex('todos_chore_occurrence_unique').on(t.choreOccurrenceId).where(sql`deleted_at is null`),
    // A time only makes sense with a date. The API checks this too; this backs it up in the database.
    check('todos_due_time_needs_date', sql`${t.dueTime} is null or ${t.dueDate} is not null`),
  ],
);

export const userPrefs = sqliteTable('user_prefs', {
  userId: integer('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  // Keep in sync with TODO_SUMMARY_VIEWS in src/shared/todo.ts (drizzle-kit can't import it).
  todoSummaryView: text('todo_summary_view', {
    enum: ['overdue_today_undated', 'overdue_today', 'next_7_days', 'everything'],
  })
    .notNull()
    .default('overdue_today_undated'),
});

/**
 * Chore definitions (spec §11.1, §18). Never deleted: archiving keeps history pointing at them.
 * `schedule` is ChoreSchedule as JSON; `schedule_type` is derived from it, for reading the table by eye.
 */
export const chores = sqliteTable('chores', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  notes: text('notes'),
  /** Who has the chore now (chore board spec). Null means Unassigned: it's on the board, up for grabs, with no occurrence. */
  assigneeUserId: integer('assignee_user_id').references(() => users.id),
  scheduleType: text('schedule_type', { enum: ['fixed', 'after_completion', 'as_needed'] }).notNull(),
  schedule: text('schedule', { mode: 'json' }).$type<ChoreSchedule>().notNull(),
  /** Local date (YYYY-MM-DD) in the family time zone. */
  startDate: text('start_date').notNull(),
  status: text('status', { enum: ['active', 'paused', 'archived'] }).notNull().default('active'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

/** One instance of a chore (spec §11.2, §18). Done and skipped rows are the completion history. */
export const choreOccurrences = sqliteTable(
  'chore_occurrences',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    choreId: integer('chore_id').notNull().references(() => chores.id),
    /** The chore's title when this occurrence was created. */
    titleSnapshot: text('title_snapshot').notNull(),
    /** Local date (YYYY-MM-DD) in the family time zone. Null for an as-needed chore's occurrence. */
    dueDate: text('due_date'),
    /** Who has this occurrence: the chore's assignee while it's open. */
    assigneeUserId: integer('assignee_user_id').references(() => users.id),
    assignmentSource: text('assignment_source', { enum: ['default', 'claimed', 'admin'] }).notNull(),
    state: text('state', { enum: ['open', 'done', 'skipped'] }).notNull().default('open'),
    /** When it was completed or skipped. */
    completedAt: integer('completed_at', { mode: 'timestamp_ms' }),
    /** Who completed or skipped it ("checked off by" / "skipped by"). */
    actorUserId: integer('actor_user_id').references(() => users.id),
    /** Who gets credit for a completion. Null while open and for skips. */
    creditedUserId: integer('credited_user_id').references(() => users.id),
    todoId: integer('todo_id').references(() => todos.id),
    todoSyncStatus: text('todo_sync_status', { enum: ['ok', 'pending', 'not_applicable'] }).notNull(),
    /** Failed attempts to create the to-do, for todo.retryPending's backoff. */
    todoAttempts: integer('todo_attempts').notNull().default(0),
    /** When todo.retryPending may try again. */
    todoRetryAt: integer('todo_retry_at', { mode: 'timestamp_ms' }),
    /** Set when the create hit the retry cap: it's no longer retried, and admins see it on the System page. */
    todoStuckAt: integer('todo_stuck_at', { mode: 'timestamp_ms' }),
    /** The last failed create's message (never contains secrets), for the System page. */
    todoLastError: text('todo_last_error'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    // At most one occurrence per chore and due date; this is what makes generation safe to repeat.
    // SQLite allows several nulls, and an as-needed chore has at most one open occurrence anyway.
    uniqueIndex('chore_occurrences_chore_due_unique').on(t.choreId, t.dueDate),
    index('chore_occurrences_state_idx').on(t.state, t.dueDate),
    index('chore_occurrences_completed_idx').on(t.completedAt),
    // Open rows have no close time; done and skipped rows always do.
    check('chore_occurrences_closed_at', sql`(${t.state} = 'open') = (${t.completedAt} is null)`),
  ],
);

/**
 * Changes to chore to-dos that are queued until they succeed (spec §11.5, §14): a `remove` for a
 * to-do that should be deleted, or a `complete` for one whose occurrence is done. The row is
 * written in the same transaction as the occurrence change that calls for it, then the change is
 * attempted at once and the row deleted when it succeeds. `todo.retryPending` retries what's left
 * with backoff. One row per to-do: a `remove` replaces a `complete`, never the other way round.
 */
export const choreTodoActions = sqliteTable('chore_todo_actions', {
  todoId: integer('todo_id').primaryKey().references(() => todos.id),
  ownerUserId: integer('owner_user_id').notNull().references(() => users.id),
  action: text('action', { enum: ['remove', 'complete'] }).notNull(),
  /** For `remove`: remove it even if it's completed, because it blocks another person's to-do for the same occurrence. */
  evenIfCompleted: integer('even_if_completed', { mode: 'boolean' }).notNull().default(false),
  /** Failed attempts so far. */
  attempts: integer('attempts').notNull().default(0),
  retryAt: integer('retry_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  /** Set when the action hit the retry cap: it's no longer retried, and admins see it on the System page. */
  stuckAt: integer('stuck_at', { mode: 'timestamp_ms' }),
  /** The last failed attempt's message (never contains secrets). */
  lastError: text('last_error'),
});

/**
 * Linked services (spec §8, §18): Todoist (`scope = 'user'`, one per person), the family's Google
 * Calendar (`scope = 'family'`, exactly one), and Plaid in phase 6 (family, any number).
 *
 * `credentials_enc` is `encryptSecret()` output (src/server/core/crypto.ts), bound to the row's
 * kind and owner for a user connection, or to the row's id for a family one (`connectionAad`). It's
 * never returned to the client and never logged.
 *
 * For the Google Calendar row, `meta` holds `account` (the Google account's email), `accountId`
 * (its `sub`), and the chosen calendar's `calendarId`, `calendarName`, and `calendarTimeZone`.
 */
export const connections = sqliteTable(
  'connections',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    kind: text('kind', { enum: ['google_calendar', 'todoist', 'plaid'] }).notNull(),
    scope: text('scope', { enum: ['family', 'user'] }).notNull(),
    /** Who linked it. For a user connection, also whose it is. */
    ownerUserId: integer('owner_user_id').notNull().references(() => users.id),
    credentialsEnc: text('credentials_enc').notNull(),
    status: text('status', { enum: ['ok', 'needs_reconnect', 'error'] }).notNull().default('ok'),
    /** Failures in a row that weren't authorization failures; 3 sets `error` (spec §8). */
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    lastSuccessAt: integer('last_success_at', { mode: 'timestamp_ms' }),
    /** A plain message for people; never a token or a raw response body. */
    lastError: text('last_error'),
    lastErrorAt: integer('last_error_at', { mode: 'timestamp_ms' }),
    meta: text('meta', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    // Spec §8: each user has at most one connection of a kind (one Todoist link).
    uniqueIndex('connections_user_kind_unique').on(t.kind, t.ownerUserId).where(sql`scope = 'user'`),
    // Spec §8, §9.1: the family has exactly one Google Calendar connection. Plaid (phase 6) can have many.
    uniqueIndex('connections_family_calendar_unique').on(t.kind).where(sql`scope = 'family' and kind = 'google_calendar'`),
  ],
);

/**
 * One linked person's Todoist sync state (spec §10.6, §18). Deleted on unlink.
 * `projects` caches project names by id, for display and the chores-project picker.
 */
export const todoistState = sqliteTable(
  'todoist_state',
  {
    userId: integer('user_id').primaryKey().references(() => users.id),
    /** Todoist's id for the account, which maps a webhook's `user_id` to a local user. */
    todoistUserId: text('todoist_user_id').notNull(),
    /** Null until the first full sync; then the token from the last response. */
    syncToken: text('sync_token'),
    inboxProjectId: text('inbox_project_id'),
    /** Where chore to-dos go. Null means Inbox (spec §10.6). */
    choresProjectId: text('chores_project_id'),
    /**
     * The name of the chores project, after it was deleted or archived in Todoist and chore to-dos
     * went back to Inbox. /settings shows a note until the person picks a project again.
     */
    choresProjectLost: text('chores_project_lost'),
    projects: text('projects', { mode: 'json' }).$type<Record<string, string>>().notNull().default({}),
    lastSyncAt: integer('last_sync_at', { mode: 'timestamp_ms' }),
    /** When the last full sync (`sync_token = '*'`) finished, including looking up the rows it didn't list. */
    lastFullSyncAt: integer('last_full_sync_at', { mode: 'timestamp_ms' }),
    /**
     * While a full sync's lookups are in progress: when Todoist took that full sync's snapshot.
     * Null otherwise. A row written after it has been heard from since, so it needn't be looked up.
     */
    lookupsSnapshotAt: integer('lookups_snapshot_at', { mode: 'timestamp_ms' }),
    /**
     * Mirror row ids that full sync didn't list and that haven't been looked up yet
     * (`GET /api/v1/tasks/{id}`). Each sync works through up to CONFIRM_PER_SYNC of them; the full
     * sync is done once the list is empty.
     */
    pendingLookups: text('pending_lookups', { mode: 'json' }).$type<number[]>().notNull().default([]),
    /**
     * 16 random bytes (hex), made when the person first links and kept across reconnects. Every
     * stable command uuid includes it (`stableUuid`), so another install, a reinstall, or a second
     * instance linked to the same Todoist account, whose row and connection ids start over, never
     * sends a uuid Todoist has already run and would answer `ok` without doing anything.
     */
    uuidSeed: text('uuid_seed').notNull().$defaultFn(() => randomBytes(16).toString('hex')),
    /**
     * Chore creates that were sent but haven't settled: command uuid to when it was first sent
     * (epoch ms). Like `todos.todoist_move_attempted_at`, it bounds which mirror rows a replay
     * without a mapping may claim.
     */
    createAttempts: text('create_attempts', { mode: 'json' }).$type<Record<string, number>>().notNull().default({}),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [uniqueIndex('todoist_state_todoist_user_unique').on(t.todoistUserId)],
);

/**
 * Tokens of an unlinked connection that Todoist didn't confirm revoking (it was down, or slow).
 * The link itself is gone; these are kept only so the hourly retry can revoke them, and deleted
 * once it has. While any are here, the System page warns.
 *
 * `credentials_enc` is `encryptSecret()` output. Todoist's rows are bound to
 * `revocationAad(kind, owner)` and hold `{ accessToken, refreshToken }` (each null once revoked).
 * The Google Calendar's are bound to the row (`familyRevocationAad`) and hold `{ refreshToken }`.
 * Never returned and never logged.
 */
export const pendingRevocations = sqliteTable('pending_revocations', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  kind: text('kind', { enum: ['google_calendar', 'todoist', 'plaid'] }).notNull(),
  ownerUserId: integer('owner_user_id').notNull().references(() => users.id),
  credentialsEnc: text('credentials_enc').notNull(),
  /**
   * The provider's id for the account the tokens belong to (for Todoist, its user id), or null if
   * it wasn't known. If the owner links that same account again, they've authorized it again, so
   * revoking would end the new link: the retry drops the row instead.
   */
  accountId: text('account_id'),
  /**
   * The account's email, when the provider gave one (Google Calendar), so a warning can name the
   * account whose access to remove by hand.
   */
  accountEmail: text('account_email'),
  /** Retries that failed so far. */
  attempts: integer('attempts').notNull().default(0),
  /** A plain message about the last failure; never a token or a raw response body. */
  lastError: text('last_error'),
  lastAttemptAt: integer('last_attempt_at', { mode: 'timestamp_ms' }),
  /**
   * When retrying stopped (Google Calendar). The row stays, with its token wiped
   * (`credentials_enc` is empty), for the System page's warning, until an admin dismisses it.
   */
  gaveUpAt: integer('gave_up_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

/**
 * Google Calendar windows as last fetched (spec §9.2): what makes the 5-minute freshness work, and
 * the last good result that survives a restart and an outage. One row per window: the calendar,
 * the family time zone the dates are in, and `[window_start, window_end)` as family-local dates.
 *
 * A cache, never a mirror: a row is replaced whole by the next fetch of that window, nothing is
 * ever deleted because a listing left it out, and nothing reads it to decide what's in Google.
 * A dashboard write marks every row `stale`, so the next read fetches again while the old result
 * is still there to fall back on. Disconnecting deletes the rows; `calendar.refreshSummary` prunes
 * windows nobody has fetched for a while.
 *
 * `events` holds only what the panel shows (StoredEvent), not Google's whole event.
 */
export const calendarCache = sqliteTable(
  'calendar_cache',
  {
    calendarId: text('calendar_id').notNull(),
    timeZone: text('time_zone').notNull(),
    windowStart: text('window_start').notNull(),
    windowEnd: text('window_end').notNull(),
    fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' }).notNull(),
    /**
     * When the fetch that wrote this row started, and the count of dashboard writes then (the
     * service's generation): a fetch is saved only over a row from an earlier write count, or the
     * same count and an earlier start, so an older fetch never replaces a newer one (C-I1).
     */
    fetchStartedAt: integer('fetch_started_at', { mode: 'timestamp_ms' }).notNull(),
    fetchGeneration: integer('fetch_generation').notNull().default(0),
    stale: integer('stale', { mode: 'boolean' }).notNull().default(false),
    events: text('events', { mode: 'json' }).$type<StoredEvent[]>().notNull(),
  },
  (t) => [primaryKey({ columns: [t.calendarId, t.timeZone, t.windowStart, t.windowEnd] }), index('calendar_cache_fetched_idx').on(t.fetchedAt)],
);

/**
 * A Google Calendar link waiting for its admin to pick the calendar (spec §9.1), one per admin.
 * The tokens are already saved here, encrypted (`pendingLinkAad`), so nothing is lost if picking
 * takes a while, and the working connection (if any) keeps working until the choice is made. Bound
 * to the session that started it (`session_hash`, a SHA-256 of the session token) and gone after
 * `expires_at`, when picking or cancelling, or when the admin's account is deleted.
 */
export const calendarLinkPending = sqliteTable('calendar_link_pending', {
  userId: integer('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  sessionHash: text('session_hash').notNull(),
  credentialsEnc: text('credentials_enc').notNull(),
  /** The Google account's `sub` and email, from the ID token. */
  accountId: text('account_id'),
  account: text('account'),
  calendars: text('calendars', { mode: 'json' }).$type<PendingCalendar[]>().notNull(),
  /**
   * For "Change calendar", which reuses the connection's saved token: the connection it came from,
   * and a SHA-256 of that token. If the connection is disconnected or relinked before the pick,
   * these no longer match and the pick is refused, so a stale pick can't bring back a link.
   * Null for a pick that came from the consent page.
   */
  sourceConnectionId: integer('source_connection_id'),
  sourceFingerprint: text('source_fingerprint'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
});

/**
 * One account of a Plaid Item, as `/accounts/get` last listed it (docs/research/plaid-6b.md §4.3):
 * what the pick step offers, and what reconnecting compares with the cards. Only the fields the
 * dashboard reads. Balances aren't kept.
 */
export interface PlaidItemAccount {
  accountId: string;
  name: string;
  officialName: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
  isoCurrencyCode: string | null;
  unofficialCurrencyCode: string | null;
  /**
   * The admin chose Skip for it in the pick (banks.ts): its transactions are dropped, and it isn't
   * waiting for a decision. Kept across reconnects. Absent otherwise (JSON, so no migration).
   */
  skipped?: boolean;
  /**
   * False: `/accounts/get` stopped listing it (the bank stopped sharing it, or Plaid changed its
   * id). It stays on the list so the Item's account ids still cover its rows (removing the bank
   * with its transactions deletes them too), but it isn't offered in the pick. Absent while listed.
   */
  listed?: false;
}

/**
 * A bank login linked through Plaid: one Item (spec §12.2, §18). Phase 6a created it empty so
 * `cards.plaid_item_id` could have a foreign key (SQLite can only add one by rebuilding a table);
 * phase 6b fills it in, and its 6b columns are all nullable, added without a rebuild.
 *
 * `connection_id` is nullable, and cleared when its connection row is deleted, so a removed Item's
 * row (and its cards' history) outlives its connection. Status, failures in a row, and the last
 * success are the connection's (spec §8); what's here is Plaid's own state for the Item.
 */
export const plaidItems = sqliteTable(
  'plaid_items',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    connectionId: integer('connection_id').references(() => connections.id, { onDelete: 'set null' }),
    plaidItemId: text('plaid_item_id').notNull(),
    institutionId: text('institution_id'),
    institutionName: text('institution_name'),
    /**
     * The `/transactions/sync` cursor, saved only after a whole run of pages, in the same database
     * transaction as the run (research §5.2). Null until Plaid has one: its `next_cursor` is `""`
     * while data isn't ready, and that's stored as null.
     */
    cursor: text('cursor'),
    /** Plaid's `consent_expiration_time` from `/item/get` or `CONSENT_UPDATED`: BofA's consent lasts 12 months (research §3.5). */
    consentExpirationTime: text('consent_expiration_time'),
    lastWebhookCode: text('last_webhook_code'),
    /** The accounts `/accounts/get` last listed, replaced after each link and reconnect. */
    accounts: text('accounts', { mode: 'json' }).$type<PlaidItemAccount[]>(),
    /**
     * When the admin last decided every listed account (attach, create, or skip). Null until then,
     * and the Item isn't synced: a transaction needs a card, and a cursor saved past one for an
     * account without a card would lose it for good.
     */
    pickedAt: integer('picked_at', { mode: 'timestamp_ms' }),
    /** After a transient failure, scheduled and webhook syncs skip the Item until then (spec §14). Refresh ignores it. */
    backoffUntil: integer('backoff_until', { mode: 'timestamp_ms' }),
    /** When `NEW_ACCOUNTS_AVAILABLE` arrived: Spend settings offers "Add accounts" until a reconnect clears it. */
    newAccountsAt: integer('new_accounts_at', { mode: 'timestamp_ms' }),
    /** `PENDING_DISCONNECT`'s `disconnect_time` (ISO 8601, as Plaid sent it): "Reconnect before" that date. */
    disconnectAt: text('disconnect_at'),
    /** The last `transactions_update_status` from `/transactions/sync`, e.g. `HISTORICAL_UPDATE_COMPLETE`. Plaid may add values. */
    transactionsStatus: text('transactions_status'),
    /** When a sync run last finished and was saved. */
    lastSyncAt: integer('last_sync_at', { mode: 'timestamp_ms' }),
    /**
     * A full resync is wanted (review C-S-I1): set when the pick attaches or creates a card for an
     * account, since that account's history has to come again from the start. The cursor is never
     * cleared for it. The next sync run first brings the Item current from the stored cursor (so
     * removals Plaid queued since are applied), then asks for the whole history with no cursor, and
     * clears this in the same transaction that saves that pass's cursor. Null otherwise.
     */
    fullResyncAt: integer('full_resync_at', { mode: 'timestamp_ms' }),
    removedAt: integer('removed_at', { mode: 'timestamp_ms' }),
    /**
     * Why `removed_at` is set: an admin removed the bank and kept its transactions (`removed`) or
     * deleted them (`removed_with_transactions`), or a key reset forgot it (its token couldn't be
     * read to revoke it).
     */
    removedReason: text('removed_reason', { enum: ['removed', 'removed_with_transactions', 'key_reset'] }),
    /** Which panel the Item is for (the Savings spec). Every Item made before the Savings panel is `spend`. */
    purpose: text('purpose', { enum: PLAID_PURPOSES }).notNull().default('spend'),
    /**
     * Savings Items only (plan decision 8): whether `/investments/transactions/get` worked last time
     * (`available`), or Plaid refused the product (`unavailable`, with the code). Null until tried.
     * `investments_error_code` without `unavailable` is a passing failure on the last read
     * (`PRODUCT_NOT_READY`, a 5xx, or `NO_ANSWER`): retried by the next sync, cleared when it works.
     */
    investmentsStatus: text('investments_status', { enum: ['available', 'unavailable'] }),
    investmentsErrorCode: text('investments_error_code'),
    /** Savings Items only: the last day (YYYY-MM-DD) investment transactions were read through, for the next window (decision 7). */
    investmentsThrough: text('investments_through'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [uniqueIndex('plaid_items_item_unique').on(t.plaidItemId)],
);

/**
 * A Plaid Link session waiting to finish (spec §12.2), one per admin, like `calendar_link_pending`.
 * It holds the link token so the OAuth return page can open Link again with the same token, which
 * Plaid requires (research §3.4), even when the bank sends the admin back in another browser.
 *
 * Bound to the session that started it (`session_hash`) and gone after `expires_at` (30 minutes),
 * when the link finishes or is cancelled, or with its admin. `mode` is `new` for a first link and
 * `update` to reconnect `plaid_item_id` (`add_accounts` for "Add accounts").
 *
 * The link token is plain text: it can open Link for this client, but it can't read any data, and
 * it's single-use and short-lived. So it isn't encrypted and isn't in the key check.
 */
export const plaidLinkPending = sqliteTable('plaid_link_pending', {
  userId: integer('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  sessionHash: text('session_hash').notNull(),
  linkToken: text('link_token').notNull(),
  mode: text('mode', { enum: ['new', 'update'] }).notNull(),
  /** The local `plaid_items.id` being reconnected; null for a new link. */
  plaidItemId: integer('plaid_item_id').references(() => plaidItems.id, { onDelete: 'cascade' }),
  addAccounts: integer('add_accounts', { mode: 'boolean' }).notNull().default(false),
  /** Which panel a new Item is for; an update-mode link takes its Item's. */
  purpose: text('purpose', { enum: PLAID_PURPOSES }).notNull().default('spend'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
});

/**
 * A Savings account (the Savings spec, "Linking" and "Data"; the CSV import spec, "Accounts"):
 * `source` `plaid` for one the admin chose to show from a Savings Item (with `plaid_item_id` and
 * `plaid_account_id`), or `manual` for one added by hand (with neither). `kind` is `cash` or
 * `investment` (from Plaid's `type`, or the admin's choice). `hidden_at`: not shown, still synced.
 * `removed_at`: its connection was removed, or the hand-added account was, and its data kept.
 * Plaid's own name for a linked account stays on the Item's account list, as for Spend.
 */
export const savingsAccounts = sqliteTable(
  'savings_accounts',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    source: text('source', { enum: SAVINGS_ACCOUNT_SOURCES }).notNull().default('plaid'),
    plaidItemId: integer('plaid_item_id').references(() => plaidItems.id),
    plaidAccountId: text('plaid_account_id'),
    nickname: text('nickname').notNull(),
    kind: text('kind', { enum: SAVINGS_ACCOUNT_KINDS }).notNull(),
    mask: text('mask'),
    isoCurrencyCode: text('iso_currency_code'),
    hiddenAt: integer('hidden_at', { mode: 'timestamp_ms' }),
    removedAt: integer('removed_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    uniqueIndex('savings_accounts_plaid_account_unique').on(t.plaidAccountId),
    index('savings_accounts_item_idx').on(t.plaidItemId),
    check('savings_accounts_source_link', sql`(${t.source} = 'plaid') = (${t.plaidItemId} is not null and ${t.plaidAccountId} is not null)`),
  ],
);

/**
 * One saved Fidelity CSV import (the CSV import spec, "Importing"): the account, the file's name
 * and SHA-256, who and when, and what it added. Never the file. Its flows and balances point at it
 * and go with it: Undo deletes this row.
 */
export const savingsImports = sqliteTable(
  'savings_imports',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id').notNull().references(() => savingsAccounts.id, { onDelete: 'cascade' }),
    fileName: text('file_name'),
    fileSha256: text('file_sha256').notNull(),
    /** The format id (plan decision 2): `fidelity_cash`, `fidelity_brokerage`, or `custom`. The column keeps 0012's name. */
    layout: text('layout', { enum: SAVINGS_IMPORT_FORMATS }).notNull(),
    uploadedByUserId: integer('uploaded_by_user_id').notNull().references(() => users.id),
    uploadedAt: integer('uploaded_at', { mode: 'timestamp_ms' }).notNull(),
    depositsAdded: integer('deposits_added').notNull(),
    withdrawalsAdded: integer('withdrawals_added').notNull(),
    balancesAdded: integer('balances_added').notNull(),
    /** Deposits, withdrawals, and daily balances in the file that were already here, or a day Plaid or a hand-set balance had. */
    skipped: integer('skipped').notNull(),
    /**
     * The first and last day of the file's rows after mapping (YYYY-MM-DD), whether or not they were
     * stored: the months the import covers. Null on imports from before 0014; the read model then
     * falls back to the days of the rows still stored.
     */
    firstDate: text('first_date'),
    lastDate: text('last_date'),
  },
  (t) => [index('savings_imports_account_idx').on(t.accountId, t.uploadedAt)],
);

/**
 * One balance per account per day, family time (the Savings spec, "Data"). Cents. `available_cents`
 * only where Plaid gives one. `source`: `plaid` (the sync; a later fetch the same day replaces it, and
 * it replaces any other source), `csv` (an import, with `import_id`), or `manual` (Set balance).
 */
export const savingsBalances = sqliteTable(
  'savings_balances',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id').notNull().references(() => savingsAccounts.id, { onDelete: 'cascade' }),
    date: text('date').notNull(),
    currentCents: integer('current_cents').notNull(),
    availableCents: integer('available_cents'),
    fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' }).notNull(),
    source: text('source', { enum: SAVINGS_BALANCE_SOURCES }).notNull().default('plaid'),
    importId: integer('import_id').references(() => savingsImports.id, { onDelete: 'cascade' }),
  },
  (t) => [
    uniqueIndex('savings_balances_account_date_unique').on(t.accountId, t.date),
    index('savings_balances_import_idx').on(t.importId),
    check('savings_balances_import', sql`(${t.source} = 'csv') = (${t.importId} is not null)`),
  ],
);

/**
 * Money in or out of an account (the Savings spec, "Data"): for Plaid's sources, Plaid's id; for
 * `csv`, the occurrence key's SHA-256 (plan decision 3), with `import_id`. The date, the amount as
 * positive cents, and the kind. No names or descriptions, ever.
 */
export const savingsFlows = sqliteTable(
  'savings_flows',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id').notNull().references(() => savingsAccounts.id, { onDelete: 'cascade' }),
    source: text('source', { enum: SAVINGS_FLOW_SOURCES }).notNull(),
    plaidId: text('plaid_id').notNull(),
    date: text('date').notNull(),
    amountCents: integer('amount_cents').notNull(),
    kind: text('kind', { enum: SAVINGS_FLOW_KINDS }).notNull(),
    importId: integer('import_id').references(() => savingsImports.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    uniqueIndex('savings_flows_source_plaid_unique').on(t.source, t.plaidId),
    index('savings_flows_account_date_idx').on(t.accountId, t.date),
    index('savings_flows_import_idx').on(t.importId),
    check('savings_flows_amount_positive', sql`${t.amountCents} > 0`),
    check('savings_flows_import', sql`(${t.source} = 'csv') = (${t.importId} is not null)`),
  ],
);

/**
 * A CSV import an admin hasn't finished (the CSV import spec, "Importing"; plan decision 4): the
 * table's header and cells, and the mapping and choices so far. Bound to the admin under a random
 * id, gone after an hour, on Import or Cancel, or with its account or admin. Never the file.
 */
export const savingsImportPreviews = sqliteTable('savings_import_previews', {
  id: text('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  accountId: integer('account_id').notNull().references(() => savingsAccounts.id, { onDelete: 'cascade' }),
  fileName: text('file_name'),
  fileSha256: text('file_sha256').notNull(),
  layout: text('layout', { enum: SAVINGS_IMPORT_FORMATS }).notNull(),
  plan: text('plan', { mode: 'json' }).$type<SavingsImportDraftPlan>().notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
});

/**
 * An account's saved import settings (the CSV import spec, "Saved per account"; plan decision 16):
 * the header they were made for (column names), the format, the mapping, and each group's choice
 * by its short label. Applied to the next file whose header matches. One per account, gone with it.
 */
export const savingsImportProfiles = sqliteTable(
  'savings_import_profiles',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    accountId: integer('account_id').notNull().references(() => savingsAccounts.id, { onDelete: 'cascade' }),
    header: text('header', { mode: 'json' }).$type<string[]>().notNull(),
    format: text('format', { enum: SAVINGS_IMPORT_FORMATS }).notNull(),
    mapping: text('mapping', { mode: 'json' }).$type<SavingsMapping>().notNull(),
    choices: text('choices', { mode: 'json' }).$type<SavingsGroupChoices>().notNull(),
    updatedByUserId: integer('updated_by_user_id').notNull().references(() => users.id),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [uniqueIndex('savings_import_profiles_account_unique').on(t.accountId)],
);

/**
 * A credit card (spec §12.2, §18). In phase 6a admins make cards by hand for CSV import; phase 6b
 * attaches a Plaid account to an existing card (filling the `plaid_*` columns), so a card's CSV
 * history and its Plaid transactions share one card and the duplicate test (§12.13) can match them.
 *
 * - `included`: shown on the home card and in the drill-down. Excluded cards appear only in Spend settings.
 * - `archived_at`: retired. Not on the home card, not offered for import or rules, but its history
 *   stays viewable. A card with transactions can be archived, never deleted.
 * - `mask`: the last 2 to 4 characters, typed by an admin or (6b) from Plaid. Not unique, not a key.
 * - `usual_closing_day`: 1 to 31; inferred closing dates clamp it to the month's length (§12.4).
 */
export const cards = sqliteTable(
  'cards',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    nickname: text('nickname').notNull(),
    mask: text('mask'),
    included: integer('included', { mode: 'boolean' }).notNull().default(false),
    usualClosingDay: integer('usual_closing_day'),
    archivedAt: integer('archived_at', { mode: 'timestamp_ms' }),
    plaidItemId: integer('plaid_item_id').references(() => plaidItems.id),
    plaidAccountId: text('plaid_account_id'),
    plaidName: text('plaid_name'),
    plaidOfficialName: text('plaid_official_name'),
    plaidType: text('plaid_type'),
    plaidSubtype: text('plaid_subtype'),
    isoCurrencyCode: text('iso_currency_code').default('USD'),
    /** Its Plaid Item was removed (6b); the card and its history stay. */
    removedAt: integer('removed_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    uniqueIndex('cards_plaid_account_unique').on(t.plaidAccountId).where(sql`plaid_account_id is not null`),
    check('cards_usual_closing_day', sql`${t.usualClosingDay} is null or ${t.usualClosingDay} between 1 and 31`),
  ],
);

/**
 * Known closing dates (spec §12.4): `manual` (an admin's) and, from phase 6b, `plaid`. Inferred
 * dates are computed from the usual closing day when needed (cycles.ts), never stored, so they
 * can't go stale. An admin's edit of a Plaid date turns that row into a manual one.
 */
export const statements = sqliteTable(
  'statements',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    cardId: integer('card_id').notNull().references(() => cards.id),
    /** Local date (YYYY-MM-DD). */
    closingDate: text('closing_date').notNull(),
    source: text('source', { enum: ['plaid', 'inferred', 'manual'] }).notNull(),
    statementBalanceCents: integer('statement_balance_cents'),
    paymentDueDate: text('payment_due_date'),
    minimumPaymentCents: integer('minimum_payment_cents'),
    fetchedAt: integer('fetched_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [uniqueIndex('statements_card_date_unique').on(t.cardId, t.closingDate)],
);

/**
 * Spend categories (spec §12.5). Two special rows, one of each special `kind`, can't be deleted or
 * archived: Payments and transfers (`excluded`, left out of totals) and Uncategorized. The
 * defaults are seeded by migration 0007. Names are unique ignoring ASCII case.
 */
export const categories = sqliteTable(
  'categories',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['normal', 'excluded', 'uncategorized'] }).notNull().default('normal'),
    sortOrder: integer('sort_order').notNull(),
    archived: integer('archived', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    uniqueIndex('categories_name_unique').on(sql`lower(${t.name})`),
    uniqueIndex('categories_special_unique').on(t.kind).where(sql`kind <> 'normal'`),
  ],
);

/**
 * Plaid `personal_finance_category` codes to family categories (spec §12.7): the detailed code is
 * looked up first, then the primary. Codes are unique across PFC v1 and v2 (research §2.2), so one
 * row per code; `taxonomy_version` says which version the code is from. Seeded by migration 0007
 * with the research's v2 mapping. Phase 6b uses it and adds the editor.
 */
export const categoryMappings = sqliteTable('category_mappings', {
  plaidPfc: text('plaid_pfc').primaryKey(),
  taxonomyVersion: text('taxonomy_version').notNull(),
  categoryId: integer('category_id').notNull().references(() => categories.id),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
});

/**
 * Categorization rules (spec §12.8), applied in `position` order. A rule matches on text against
 * the merchant name, or the raw description when there's none; optionally a card and an amount
 * range (inclusive, in the app's sign). It sets a category, a person, or both:
 * `set_person` is `household`, or `user` with `set_person_user_id`.
 */
export const rules = sqliteTable(
  'rules',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    position: integer('position').notNull(),
    matchText: text('match_text').notNull(),
    matchType: text('match_type', { enum: ['contains', 'exact'] }).notNull(),
    cardId: integer('card_id').references(() => cards.id),
    minCents: integer('min_cents'),
    maxCents: integer('max_cents'),
    setCategoryId: integer('set_category_id').references(() => categories.id),
    setPerson: text('set_person', { enum: ['household', 'user'] }),
    setPersonUserId: integer('set_person_user_id').references(() => users.id),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    index('rules_position_idx').on(t.position),
    check('rules_person_user', sql`(coalesce(${t.setPerson}, '') = 'user') = (${t.setPersonUserId} is not null)`),
    check('rules_has_action', sql`${t.setCategoryId} is not null or ${t.setPerson} is not null`),
  ],
);

/** One CSV upload that was saved (spec §12.13): for "Updated X ago" and an audit trail. Never the file itself. */
export const csvImports = sqliteTable(
  'csv_imports',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    cardId: integer('card_id').notNull().references(() => cards.id),
    fileName: text('file_name'),
    fileSha256: text('file_sha256').notNull(),
    uploadedByUserId: integer('uploaded_by_user_id').notNull().references(() => users.id),
    uploadedAt: integer('uploaded_at', { mode: 'timestamp_ms' }).notNull(),
    rowCount: integer('row_count').notNull(),
    importedCount: integer('imported_count').notNull(),
    skippedCount: integer('skipped_count').notNull(),
    /** The format it was read with (the generic import plan, decision 12): `bofa_credit` or `custom`; null, from before 0015, reads as `bofa_credit`. */
    format: text('format', { enum: SPEND_IMPORT_FORMATS }),
  },
  (t) => [index('csv_imports_card_idx').on(t.cardId, t.uploadedAt)],
);

/**
 * An uploaded CSV waiting for its admin (spec §12.13, the generic import design): the table's header
 * and cells and the mapping so far (`plan`), and the rows as they'd import once it's mapped
 * (`rows`). Never the file. Bound to the admin who uploaded it, under a random id, and gone after
 * an hour, when it's saved or cancelled, or when its card or admin is deleted. A preview from before
 * 0015 has no plan and is treated as expired (plan decision 4).
 */
export const csvImportPreviews = sqliteTable('csv_import_previews', {
  id: text('id').primaryKey(),
  userId: integer('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  cardId: integer('card_id').notNull().references(() => cards.id, { onDelete: 'cascade' }),
  fileName: text('file_name'),
  fileSha256: text('file_sha256').notNull(),
  rows: text('rows', { mode: 'json' }).$type<PreviewRow[]>().notNull(),
  plan: text('plan', { mode: 'json' }).$type<SpendImportDraftPlan>(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
});

/**
 * A card's saved columns (the generic import design, "Saved per card"; plan decision 13): the
 * header they were made for (column names only) and the mapping. Applied to the next file whose
 * header matches exactly and that the mapping reads. One per card, gone with it.
 */
export const spendImportProfiles = sqliteTable(
  'spend_import_profiles',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    cardId: integer('card_id').notNull().references(() => cards.id, { onDelete: 'cascade' }),
    header: text('header', { mode: 'json' }).$type<string[]>().notNull(),
    mapping: text('mapping', { mode: 'json' }).$type<CardMapping>().notNull(),
    updatedByUserId: integer('updated_by_user_id').notNull().references(() => users.id),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [uniqueIndex('spend_import_profiles_card_unique').on(t.cardId)],
);

/**
 * Card transactions (spec §12, §18, and the research's "Columns to create now"). Amounts are whole
 * cents, positive for money spent (Plaid's convention; the CSV importer flips BofA's sign). `date`
 * is Plaid's `date` or the CSV's Posted Date, and decides the billing cycle (§12.4).
 *
 * `category_id` always holds a category (Uncategorized by default), and `category_source` says
 * where it came from; `person_user_id` null is Household, and `person_source` likewise (§12.9).
 *
 * The `plaid_*`, `merchant_entity_id`, `logo_url`, and `counterparties` columns are for phase 6b
 * and stay null for CSV rows. Sources have no CHECK list, so later ones can be added in code.
 */
/** What Remove duplicate copied to the one twin (`transactions.duplicate_carry`): only the keys of fields it copied. */
export interface DuplicateCarry {
  categoryId?: number;
  /** Null: Household, set by hand. */
  personUserId?: number | null;
  note?: string;
}

export const transactions = sqliteTable(
  'transactions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    cardId: integer('card_id').notNull().references(() => cards.id),
    source: text('source', { enum: ['plaid', 'csv'] }).notNull(),
    plaidTransactionId: text('plaid_transaction_id'),
    /** The raw Plaid account id at sync time, so rows can be re-matched if Plaid changes account ids (research conflict 9). */
    plaidAccountId: text('plaid_account_id'),
    pending: integer('pending', { mode: 'boolean' }).notNull().default(false),
    pendingTransactionId: text('pending_transaction_id'),
    /** Local date (YYYY-MM-DD). */
    date: text('date').notNull(),
    authorizedDate: text('authorized_date'),
    amountCents: integer('amount_cents').notNull(),
    isoCurrencyCode: text('iso_currency_code').default('USD'),
    unofficialCurrencyCode: text('unofficial_currency_code'),
    /** Plaid's `merchant_name`. Null for CSV rows. */
    merchant: text('merchant'),
    /** Plaid's `name`, or the CSV's Payee, whitespace collapsed. */
    rawName: text('raw_name').notNull(),
    originalDescription: text('original_description'),
    /** The CSV's Address column. */
    csvAddress: text('csv_address'),
    plaidPfcPrimary: text('plaid_pfc_primary'),
    plaidPfcDetailed: text('plaid_pfc_detailed'),
    plaidPfcConfidence: text('plaid_pfc_confidence'),
    plaidPfcVersion: text('plaid_pfc_version'),
    merchantEntityId: text('merchant_entity_id'),
    logoUrl: text('logo_url'),
    counterparties: text('counterparties', { mode: 'json' }).$type<unknown[]>(),
    categoryId: integer('category_id').notNull().references(() => categories.id),
    categorySource: text('category_source', { enum: ['manual', 'rule', 'mapping', 'default'] }).notNull(),
    personUserId: integer('person_user_id').references(() => users.id),
    personSource: text('person_source', { enum: ['manual', 'rule', 'default'] }).notNull(),
    note: text('note'),
    /** BofA's Reference Number: TEXT, since 23 digits overflow an integer (research §1.2). */
    csvReference: text('csv_reference'),
    csvImportId: integer('csv_import_id').references(() => csvImports.id),
    /** When Plaid's sync listed it in `removed` (6b). */
    removedAt: integer('removed_at', { mode: 'timestamp_ms' }),
    /** Soft delete (6b: a removed pending row, or a CSV row a Plaid transaction replaced). */
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
    /**
     * The row that took this one's place (6b): the posted version of a pending row, the new id of a
     * churned row, or the Plaid row that replaced a CSV row. Set once, so a row is never carried
     * over or matched twice. No foreign key: the prune and "delete its transactions" hard-delete
     * rows, and a dangling id is harmless.
     */
    replacedById: integer('replaced_by_id'),
    /**
     * Why an admin deleted it by hand: `duplicate` is **Remove duplicate** (spec §12.12). Null for
     * every other delete (a sync's removal, a replacement), which have their own markers.
     */
    deletedReason: text('deleted_reason', { enum: ['duplicate'] }),
    /**
     * Removed as a duplicate: a live twin it was removed against (same card, date, and amount), so
     * losing that twin for good brings this one back (`restoreDuplicatesOf`). No foreign key, like
     * `replaced_by_id`.
     */
    duplicateOfId: integer('duplicate_of_id'),
    /**
     * Removed as a duplicate with exactly one twin: the manual category, manual person, and note
     * copied to it (the keys present are the fields copied), so Undo can take them back.
     */
    duplicateCarry: text('duplicate_carry', { mode: 'json' }).$type<DuplicateCarry>(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => [
    index('transactions_card_date_idx').on(t.cardId, t.date),
    // Losing a row brings back what was removed as its duplicate: found by it.
    index('transactions_duplicate_of_idx').on(t.duplicateOfId),
    // Restoring what a row had replaced finds them by it, on every removal, prune and Remove (review C-S-M6).
    index('transactions_replaced_by_idx').on(t.replacedById),
    uniqueIndex('transactions_plaid_unique').on(t.plaidTransactionId).where(sql`plaid_transaction_id is not null`),
    // A re-import skips what's stored, deleted rows included, so a CSV row a Plaid transaction replaced never comes back.
    uniqueIndex('transactions_csv_reference_unique').on(t.cardId, t.csvReference).where(sql`csv_reference is not null`),
  ],
);

export type UserRow = typeof users.$inferSelect;
export type TodoRow = typeof todos.$inferSelect;
export type ChoreRow = typeof chores.$inferSelect;
export type OccurrenceRow = typeof choreOccurrences.$inferSelect;
export type TodoActionRow = typeof choreTodoActions.$inferSelect;
export type ConnectionRow = typeof connections.$inferSelect;
export type TodoistStateRow = typeof todoistState.$inferSelect;
export type CalendarCacheRow = typeof calendarCache.$inferSelect;
export type CalendarLinkPendingRow = typeof calendarLinkPending.$inferSelect;
export type PendingRevocationRow = typeof pendingRevocations.$inferSelect;
export type PlaidItemRow = typeof plaidItems.$inferSelect;
export type PlaidLinkPendingRow = typeof plaidLinkPending.$inferSelect;
export type CardRow = typeof cards.$inferSelect;
export type StatementRow = typeof statements.$inferSelect;
export type CategoryRow = typeof categories.$inferSelect;
export type RuleRow = typeof rules.$inferSelect;
export type TransactionRow = typeof transactions.$inferSelect;
export type CsvImportPreviewRow = typeof csvImportPreviews.$inferSelect;
export type SpendImportProfileRow = typeof spendImportProfiles.$inferSelect;
export type SavingsAccountRow = typeof savingsAccounts.$inferSelect;
export type SavingsBalanceRow = typeof savingsBalances.$inferSelect;
export type SavingsFlowRow = typeof savingsFlows.$inferSelect;
export type SavingsImportRow = typeof savingsImports.$inferSelect;
export type SavingsImportPreviewRow = typeof savingsImportPreviews.$inferSelect;
export type SavingsImportProfileRow = typeof savingsImportProfiles.$inferSelect;
