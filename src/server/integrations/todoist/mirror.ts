import { and, eq, isNull, lte, ne } from 'drizzle-orm';
import type { TodoItem } from '../../../shared/todo.js';
import { choreOccurrences, choreTodoActions, todoistState, todos, type TodoRow } from '../../db/schema.js';
import { toTodoItem } from '../../panels/todo/internalBackend.js';
import type { DbOrTx } from '../connections.js';
import type { SyncResponse, TodoistItem } from './client.js';
import { dueFromTodoist } from './mapping.js';

/**
 * The Todoist mirror is the `todos` table: rows with `backend = 'todoist'` (spec §10.6). This file
 * applies a `/sync` response to it, inside the caller's transaction.
 *
 * What the mirror holds (the owner's change request of 2026-11-16): the person's Todoist Inbox,
 * plus their chore to-dos wherever they are in Todoist (the chores project, or wherever the person
 * moved them). Every other task is left out. A task that leaves that scope (moved out of the
 * Inbox, or seen in another project) is dropped from the mirror quietly (`dropOutOfScope`): it's
 * still in Todoist, so it's never a deletion and no remote change is reported for it. If it moves
 * back into the Inbox, the next sync that lists it mirrors it again, as a new row.
 *
 * A remote change is a mirror row as it was (`before`) and as it is now (`after`, null when it
 * was deleted). Only rows that already existed and changed are reported: a task seen for the first
 * time gets a new row and no change, a row converted in place on a relink gets none either, and
 * neither does a row listed with nothing the dashboard shows changed. The caller hands them to
 * `TodoService.applyRemoteChange(before, after, { type: 'todoist' })` after the transaction
 * commits and the per-user lock is released, so chore handlers that write back can't deadlock on
 * the lock.
 */
export interface RemoteChange {
  before: TodoItem | null;
  after: TodoItem | null;
}

export interface ApplyContext {
  userId: number;
  timeZone: string;
  now: Date;
  /** True when the request was a full sync (`sync_token = '*'`). The response's `full_sync` also counts. */
  requestedFull: boolean;
  /**
   * Rows a command in this request changed successfully, and already applied locally. They're
   * updated from the response like any other row. A remote change is reported for one only when
   * the response moves it further than the write did: it was completed, reopened, or deleted in
   * Todoist meanwhile. Otherwise TodoService emits the write's own event, with the user's actor.
   */
  ownRowIds: ReadonlySet<number>;
}

export interface ApplySummary {
  changes: RemoteChange[];
  full: boolean;
  items: number;
  /** Items the response marked `is_deleted` or `checked` (logged, to confirm incremental-sync behavior). */
  deletedSeen: number;
  checkedSeen: number;
  /**
   * For a full sync: open mirror rows it didn't list (that have a task id, and were last written
   * before its snapshot). A full sync leaves out completed tasks (verified live), so each could be
   * completed or deleted. Nothing is done to them here; `Todoist.confirmMissing` looks each one up.
   */
  missing: TodoRow[];
  /**
   * Rows dropped because their task left the mirror's scope (see the top of this file), as they
   * were just before. Never reported as changes; a write uses them to answer for its own row.
   */
  dropped: TodoItem[];
  /** Items left out because they're in another project and aren't chore to-dos (logged as a count). */
  outOfScope: number;
}

/**
 * True when a task in `projectId` belongs in the mirror by its project: it's in the person's
 * Inbox. While the Inbox isn't known yet (no sync has said), nothing is left out or dropped for
 * its project: better a task too many for a moment than a to-do dropped by mistake.
 */
export function inInbox(projectId: string, inboxProjectId: string | null): boolean {
  return inboxProjectId === null || projectId === inboxProjectId;
}

/**
 * A row the Chores panel depends on, which stays mirrored wherever its task is: it's linked to a
 * chore occurrence, or (defensively) an occurrence or a queued chore action names it. The last two
 * only happen together with the first today, but they're also the foreign keys a hard delete
 * mustn't break.
 */
export function isChoreLinked(db: DbOrTx, row: TodoRow): boolean {
  if (row.choreOccurrenceId !== null) return true;
  if (db.select({ id: choreOccurrences.id }).from(choreOccurrences).where(eq(choreOccurrences.todoId, row.id)).get()) return true;
  return db.select({ id: choreTodoActions.todoId }).from(choreTodoActions).where(eq(choreTodoActions.todoId, row.id)).get() !== undefined;
}

/**
 * Drops a row whose task left the mirror's scope. It's a hard delete, not a soft one:
 * - a soft-deleted row would read as a to-do deleted on purpose wherever `deleted_at` is read (the
 *   Chores panel's reconcile, the chore-create generation count, unlink's conversion);
 * - nothing points at it (it isn't chore-linked; the caller checked `isChoreLinked`), so no
 *   history is lost, and the per-person unique index on live rows has nothing left to trip on;
 * - the task is still in Todoist, and if it comes back into scope it's simply mirrored again.
 * No remote change is reported: the to-do wasn't deleted, it just isn't shown here any more.
 * Returns the row as it was, for a write that has to answer for it.
 */
export function dropOutOfScope(tx: DbOrTx, row: TodoRow): TodoItem {
  tx.delete(todos).where(eq(todos.id, row.id)).run();
  return toTodoItem(row);
}

/** The person's Inbox project id, as the last sync left it. */
function inboxOf(db: DbOrTx, userId: number): string | null {
  return db.select({ inbox: todoistState.inboxProjectId }).from(todoistState).where(eq(todoistState.userId, userId)).get()?.inbox ?? null;
}

/** The row's fields from a Todoist item. */
function fieldsOf(item: TodoistItem, timeZone: string) {
  const due = dueFromTodoist(item.due, timeZone);
  return {
    title: item.content,
    notes: item.description.trim() === '' ? null : item.description,
    dueDate: due.dueDate,
    dueTime: due.dueTime,
    todoistProjectId: item.project_id,
    todoistRecurring: due.recurring,
    todoistDueTimezone: due.timezone,
  };
}

/** The live mirror row for a task. */
export function mirrorRow(db: DbOrTx, userId: number, taskId: string): TodoRow | undefined {
  return db
    .select()
    .from(todos)
    .where(and(eq(todos.ownerUserId, userId), eq(todos.backend, 'todoist'), eq(todos.todoistTaskId, taskId), isNull(todos.deletedAt)))
    .get();
}

/**
 * An open internal row that mirrored this task, in this same Todoist account, before an unlink
 * (spec §10.6, "Relinking later"). Completed internal rows don't match: they're history, and the
 * task may have moved on.
 */
function relinkRow(db: DbOrTx, userId: number, accountId: string, taskId: string): TodoRow | undefined {
  return db
    .select()
    .from(todos)
    .where(
      and(
        eq(todos.ownerUserId, userId),
        eq(todos.backend, 'internal'),
        eq(todos.todoistTaskId, taskId),
        eq(todos.todoistAccountId, accountId),
        isNull(todos.deletedAt),
        isNull(todos.completedAt),
      ),
    )
    .get();
}

/**
 * Applies one `/sync` response: project names, the Inbox id, every item, and (for a full sync)
 * a reconcile, then saves the new sync token.
 *
 * - `is_deleted`: the row is soft-deleted.
 * - `checked`: the row is completed. Completed rows stay in the mirror (spec §10.5's 7-day group).
 * - otherwise: the row is created or updated, and reopened if it was completed.
 * - An item with no row is matched to an open internal row with the same `todoist_task_id` (a
 *   relink), which is converted in place; otherwise it gets a new row.
 * - Scope (see the top of this file): an item outside the Inbox gets no new row, and the row of
 *   one that isn't chore-linked is dropped quietly, checked or not. A kept internal row whose task
 *   is now out of scope is dropped too, rather than re-attached or added to the Inbox again.
 *   Deleted items don't count here: their project id is a placeholder (verified live).
 *
 * Incremental syncs report deletions and completions (verified live). A full sync lists only
 * active tasks, so an open row it doesn't list is returned in `missing`, never removed here: it
 * could be completed or deleted, and treating a completion as a deletion would skip a chore that
 * was done.
 *
 * A row is per person (`owner_user_id`): a task in a shared project is in every member's sync,
 * with the same id, and each member's mirror has its own row for it.
 */
export function applySyncResponse(tx: DbOrTx, ctx: ApplyContext, res: SyncResponse): ApplySummary {
  const state = tx.select().from(todoistState).where(eq(todoistState.userId, ctx.userId)).get();
  if (!state) throw new Error('No Todoist state for this user');
  const full = ctx.requestedFull || res.fullSync;
  const summary: ApplySummary = { changes: [], full, items: res.items.length, deletedSeen: 0, checkedSeen: 0, missing: [], dropped: [], outOfScope: 0 };
  const now = ctx.now;

  const projects: Record<string, string> = full ? {} : { ...state.projects };
  let inboxProjectId = state.inboxProjectId;
  for (const p of res.projects) {
    // An archived project is treated like a deleted one: it can't take new chore to-dos.
    if (p.is_deleted || p.is_archived) delete projects[p.id];
    else projects[p.id] = p.name;
    if (p.inbox_project) inboxProjectId = p.id;
  }
  if (res.user?.inboxProjectId) inboxProjectId = res.user.inboxProjectId;
  // A deleted or archived chores project falls back to Inbox (spec §10.6's default), and its name
  // is kept for the note on /settings.
  const choresProjectId = state.choresProjectId && Object.hasOwn(projects, state.choresProjectId) ? state.choresProjectId : null;
  const choresProjectLost = state.choresProjectId && !choresProjectId
    ? (state.projects[state.choresProjectId] ?? 'Your chores project')
    : state.choresProjectLost;

  const listed = new Set<string>();
  for (const item of res.items) {
    listed.add(item.id);
    if (item.is_deleted) summary.deletedSeen++;
    if (item.checked) summary.checkedSeen++;
    let row = mirrorRow(tx, ctx.userId, item.id);
    if (item.is_deleted) {
      // Verified live: a deleted item's fields are blanked, so the row keeps its last known fields.
      // A row that's still live here wasn't deleted by this request's own write, so this is news
      // even for an own row.
      if (!row) continue;
      tx.update(todos).set({ deletedAt: now, updatedAt: now }).where(eq(todos.id, row.id)).run();
      summary.changes.push({ before: toTodoItem(row), after: null });
      continue;
    }
    const inbox = inInbox(item.project_id, inboxProjectId);
    let converted = false;
    if (!row) {
      const kept = relinkRow(tx, ctx.userId, state.todoistUserId, item.id);
      if (kept && !inbox && !isChoreLinked(tx, kept)) {
        // The task this row mirrored before the unlink is in another project now. It's that same
        // task, so it isn't added to the Inbox again: it's out of scope, like any other.
        summary.dropped.push(dropOutOfScope(tx, kept));
        continue;
      }
      row = kept;
      converted = row !== undefined;
    }
    if (!row && !inbox) {
      summary.outOfScope++;
      continue;
    }
    if (row && !inbox && !isChoreLinked(tx, row)) {
      // Moved out of the Inbox (or listed in another project), completed or not: dropped quietly.
      // No change is reported, so TodoService emits nothing, and no chore is touched.
      summary.dropped.push(dropOutOfScope(tx, row));
      continue;
    }
    const own = row !== undefined && ctx.ownRowIds.has(row.id);
    const fields = fieldsOf(item, ctx.timeZone);
    const completedAt = item.checked ? (row?.completedAt ?? (item.completed_at ? new Date(item.completed_at) : now)) : null;
    if (!row) {
      tx.insert(todos)
        .values({
          ownerUserId: ctx.userId,
          backend: 'todoist',
          ...fields,
          todoistTaskId: item.id,
          todoistAccountId: state.todoistUserId,
          completedAt,
          createdByUserId: null,
          choreOccurrenceId: null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      continue;
    }
    const after = tx
      .update(todos)
      .set({ ...fields, backend: 'todoist', todoistTaskId: item.id, todoistAccountId: state.todoistUserId, completedAt, updatedAt: now })
      .where(eq(todos.id, row.id))
      .returning()
      .get();
    // `row` is the row as this request's own write left it, so for an own row, a different
    // completion state means Todoist moved it further (e.g. completed it while a title edit was out).
    const movedFurther = (completedAt !== null) !== (row.completedAt !== null);
    const before = toTodoItem(row);
    const current = toTodoItem(after);
    // A row listed with nothing the dashboard shows changed (every row a full sync lists, or a
    // change to a field the mirror doesn't keep, like labels) isn't news.
    const changed = JSON.stringify(before) !== JSON.stringify(current);
    if (!converted && changed && (!own || movedFurther)) summary.changes.push({ before, after: current });
  }

  if (full) {
    // Only rows last written before Todoist took the snapshot: a big account's full sync can lag
    // (research notes §2), and a task added since then isn't in it yet.
    const snapshotAt = res.fullSyncDateUtc ? new Date(res.fullSyncDateUtc) : now;
    summary.missing = tx
      .select()
      .from(todos)
      .where(
        and(
          eq(todos.ownerUserId, ctx.userId),
          eq(todos.backend, 'todoist'),
          isNull(todos.deletedAt),
          isNull(todos.completedAt),
          lte(todos.updatedAt, snapshotAt),
        ),
      )
      .all()
      // A row with no task id can't be looked up, so it mustn't hold up the full sync.
      .filter((row) => row.todoistTaskId !== null && !listed.has(row.todoistTaskId));
  }

  tx.update(todoistState)
    .set({
      syncToken: res.syncToken,
      projects,
      inboxProjectId,
      choresProjectId,
      choresProjectLost,
      lastSyncAt: now,
      updatedAt: now,
    })
    .where(eq(todoistState.userId, ctx.userId))
    .run();
  return summary;
}

/** What looking up a task that a full sync didn't list found (`TodoistClient.getTask`). */
export type Confirmation = { state: 'open' | 'completed'; item: TodoistItem } | { state: 'deleted' };

/**
 * Applies one confirmation to its row, and returns the remote change: completed (it stays, as a
 * completed row), deleted (soft-deleted), or open after all (its fields refreshed from Todoist).
 * An open task whose fields the dashboard shows are as they were isn't news: `change` is null.
 *
 * Open or completed in another project, for a row that isn't chore-linked, means the task left
 * the mirror's scope: the row is dropped quietly (`dropped`, and no change), never deleted, and a
 * completion there isn't reported either.
 *
 * The row is re-read here, inside the transaction: the lookup took a request, and if the row is no
 * longer a live, open mirror row by now, the answer is out of date and nothing is done (null).
 */
export function applyConfirmation(
  tx: DbOrTx,
  ctx: Pick<ApplyContext, 'timeZone' | 'now'>,
  rowId: number,
  found: Confirmation,
): { change: RemoteChange | null; dropped?: true } | null {
  const row = tx.select().from(todos).where(eq(todos.id, rowId)).get();
  if (!row || row.backend !== 'todoist' || row.deletedAt !== null || row.completedAt !== null) return null;
  const now = ctx.now;
  if (found.state === 'deleted') {
    tx.update(todos).set({ deletedAt: now, updatedAt: now }).where(eq(todos.id, row.id)).run();
    return { change: { before: toTodoItem(row), after: null } };
  }
  if (!inInbox(found.item.project_id, inboxOf(tx, row.ownerUserId)) && !isChoreLinked(tx, row)) {
    dropOutOfScope(tx, row);
    return { change: null, dropped: true };
  }
  const completedAt = found.state === 'completed' ? (found.item.completed_at ? new Date(found.item.completed_at) : now) : null;
  const after = tx
    .update(todos)
    .set({ ...fieldsOf(found.item, ctx.timeZone), completedAt, updatedAt: now })
    .where(eq(todos.id, row.id))
    .returning()
    .get()!;
  const before = toTodoItem(row);
  const current = toTodoItem(after);
  return { change: JSON.stringify(before) === JSON.stringify(current) ? null : { before, after: current } };
}

/**
 * On a relink, an internal row that kept its `todoist_task_id` from the earlier link, and that the
 * first sync didn't list (so `relinkRow` didn't convert it), was looked up before being added to
 * Todoist again. Applies what the lookup found:
 * - open or completed: it's still that task. The row is converted in place, with Todoist's fields
 *   and completion (`converted`). A completion that happened while unlinked is reported.
 * - deleted: the row is deleted too, and that's reported (`gone`).
 * - open or completed in another project, for a row that isn't chore-linked: it's still that
 *   task, but outside the mirror's scope. It isn't re-attached, and it isn't added to the Inbox
 *   as a new task either: the row is dropped quietly (`dropped`, no change).
 * Null when the row isn't an internal row waiting for this any more, its task id is from another
 * Todoist account (`accountId` is the one linked now: a 404 there says nothing about the task), or
 * a live mirror row already has that task; the caller then adds it as a new task, as it would
 * without the lookup.
 */
export function applyRelinkLookup(
  tx: DbOrTx,
  ctx: Pick<ApplyContext, 'userId' | 'timeZone' | 'now'> & { accountId: string },
  rowId: number,
  found: Confirmation,
): { outcome: 'converted' | 'gone' | 'dropped'; change: RemoteChange | null } | null {
  const row = tx.select().from(todos).where(eq(todos.id, rowId)).get();
  if (!row || row.backend !== 'internal' || row.deletedAt !== null || !row.todoistTaskId) return null;
  if (row.todoistAccountId !== ctx.accountId) return null;
  const now = ctx.now;
  if (found.state === 'deleted') {
    tx.update(todos).set({ deletedAt: now, updatedAt: now }).where(eq(todos.id, row.id)).run();
    return { outcome: 'gone', change: { before: toTodoItem(row), after: null } };
  }
  if (!inInbox(found.item.project_id, inboxOf(tx, ctx.userId)) && !isChoreLinked(tx, row)) {
    dropOutOfScope(tx, row);
    return { outcome: 'dropped', change: null };
  }
  if (mirrorRow(tx, ctx.userId, row.todoistTaskId)) return null;
  const completedAt = found.state === 'completed' ? (row.completedAt ?? (found.item.completed_at ? new Date(found.item.completed_at) : now)) : null;
  const after = tx
    .update(todos)
    .set({ ...fieldsOf(found.item, ctx.timeZone), backend: 'todoist', completedAt, todoistMoveAttemptedAt: null, todoistMoveReplays: 0, updatedAt: now })
    .where(eq(todos.id, row.id))
    .returning()
    .get()!;
  // Only a completion that happened in Todoist is news; the rest is the same task as before.
  const completedThere = row.completedAt === null && completedAt !== null;
  return { outcome: 'converted', change: completedThere ? { before: toTodoItem(row), after: toTodoItem(after) } : null };
}

/**
 * A row made by an earlier sync for a task this app created but never recorded: `item_add` ran in
 * Todoist and the app crashed (or lost the response) before saving the task id. Used when a
 * replayed `item_add` returns no `temp_id_mapping` (UNVERIFIED either way). Exactly one plausible
 * match, or none.
 *
 * `attemptedAt` is when that `item_add` was first sent. Only rows first inserted strictly after it
 * count: the person's own tasks, which a full sync mirrored before then (with the same title,
 * perhaps), can't be the task the command made.
 */
export function findOrphanCopy(db: DbOrTx, p: { userId: number; exceptRowId: number; title: string; projectId: string | null; attemptedAt: Date }): TodoRow | null {
  const candidates = db
    .select()
    .from(todos)
    .where(
      and(
        eq(todos.ownerUserId, p.userId),
        eq(todos.backend, 'todoist'),
        isNull(todos.deletedAt),
        isNull(todos.choreOccurrenceId),
        isNull(todos.createdByUserId),
        eq(todos.title, p.title),
        ne(todos.id, p.exceptRowId),
      ),
    )
    .all()
    .filter((r) => r.createdAt.getTime() > p.attemptedAt.getTime() && (p.projectId === null || r.todoistProjectId === p.projectId));
  return candidates.length === 1 ? candidates[0]! : null;
}

/**
 * `findOrphanCopy` for a task outside the Inbox (a chore to-do in a chores project that isn't the
 * Inbox): syncs leave those out of the mirror until something claims them, so there's no row to
 * find. `items` is that project's open tasks, looked up in Todoist (`GET /api/v1/tasks`). A
 * candidate has the same title, project, and due date (the date part: occurrences of one chore
 * share a title but never a date), was added no earlier than `attemptedAt` (by Todoist's
 * `added_at`; a Todoist clock behind ours only makes it miss, never claim the wrong task), and no
 * live mirror row has it. `match` is set only when there's exactly one; `candidates` counts them,
 * so two or more can be logged as ambiguous.
 */
export function matchLostCreate(
  db: DbOrTx,
  p: { userId: number; items: readonly TodoistItem[]; title: string; projectId: string; dueDate: string | null; attemptedAt: Date },
): { match: TodoistItem | null; candidates: number } {
  const found = p.items.filter((i) =>
    !i.is_deleted
    && !i.checked
    && i.content === p.title
    && i.project_id === p.projectId
    && (i.due?.date.slice(0, 10) ?? null) === p.dueDate
    && typeof i.added_at === 'string'
    && Date.parse(i.added_at) >= p.attemptedAt.getTime()
    && mirrorRow(db, p.userId, i.id) === undefined);
  return { match: found.length === 1 ? found[0]! : null, candidates: found.length };
}

/** The cached projects for the picker and tags: Inbox first, then by name. */
export function projectList(projects: Record<string, string>, inboxProjectId: string | null): { id: string; name: string }[] {
  return Object.entries(projects)
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => (a.id === inboxProjectId ? -1 : b.id === inboxProjectId ? 1 : a.name.localeCompare(b.name)));
}
