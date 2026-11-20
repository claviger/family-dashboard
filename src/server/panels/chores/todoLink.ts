import { and, eq, gt, isNotNull, isNull, lte, or } from 'drizzle-orm';
import type { StuckTodo, TodoSyncStatus } from '../../../shared/chores.js';
import type { TodoItem } from '../../../shared/todo.js';
import { AppError, loggableError } from '../../core/errors.js';
import type { Actor } from '../../core/events.js';
import type { Db } from '../../db/index.js';
import { choreOccurrences, choreTodoActions, users, type OccurrenceRow, type TodoActionRow } from '../../db/schema.js';
import { getChoreRow, getOccurrenceRow, getsTodo, type ChoresDeps, type DbOrTx } from './store.js';

export type { DbOrTx } from './store.js';

/**
 * The to-do side of an occurrence (spec §11.5). Every change goes through TodoService with the
 * `system` actor, so the Chores panel's own event handlers ignore the events these cause.
 *
 * Failures are retried by the `todo.retryPending` job, with backoff:
 * - A to-do that couldn't be created leaves the occurrence `pending`, with `todo_retry_at`.
 * - A to-do that couldn't be removed or completed stays in `chore_todo_actions`, with its own
 *   retry time.
 *
 * After TODO_RETRY_CAP failed attempts, an item is "stuck": it's no longer retried, the job stops
 * reporting it as an error, and admins see it on the System page, where they can retry or
 * dismiss it. While the owner's writes are blocked (their Todoist link needs reconnecting, or
 * TOKEN_ENCRYPTION_KEY doesn't match), their items are skipped without counting attempts, since
 * nothing can succeed until someone fixes that (`TodoService.writesBlocked`).
 */
const SYSTEM: Actor = { type: 'system' };

export const TODO_RETRY_BASE_MS = 5 * 60_000;
export const TODO_RETRY_MAX_MS = 60 * 60_000;
/**
 * Failed attempts before an item is stuck. With the backoff (5, 10, 20, 40 minutes, then hourly)
 * the 12th failure comes about 9 hours after the first: long enough that an overnight Todoist
 * outage drains on its own, short enough that a permanent failure (a revoked token, a deleted
 * project) reaches an admin within a day instead of retrying hourly forever.
 */
export const TODO_RETRY_CAP = 12;

/** What the System page shows about a failure: an AppError's message is written for people; anything else is cut short. */
function failureMessage(err: unknown): string {
  if (err instanceof AppError) return err.message;
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}

/** 5, 10, 20, 40 minutes, then hourly (spec §14: backoff up to one hour). `attempts` counts failures so far. */
export function todoRetryDelayMs(attempts: number): number {
  return Math.min(TODO_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), TODO_RETRY_MAX_MS);
}

/**
 * The to-do fields for an occurrence that is about to get `assignee`. With a to-do coming, it's
 * `pending` and not due for a retry for 5 minutes, so `todo.retryPending` can't start a second
 * create while the first is still in flight. Callers then run `attachTodo`. It starts over: not
 * stuck, and no last error.
 */
export function pendingTodoFields(db: DbOrTx, assignee: number | null, now: Date) {
  const wantsTodo = assignee !== null && getsTodo(db, assignee);
  if (!wantsTodo) return notApplicableTodoFields();
  return {
    todoSyncStatus: 'pending' as TodoSyncStatus,
    todoAttempts: 0,
    todoRetryAt: new Date(now.getTime() + TODO_RETRY_BASE_MS) as Date | null,
    todoStuckAt: null,
    todoLastError: null,
  };
}

/** The to-do fields for an occurrence that gets no to-do: no retries, not stuck, no last error. */
export function notApplicableTodoFields() {
  return {
    todoSyncStatus: 'not_applicable' as TodoSyncStatus,
    todoAttempts: 0,
    todoRetryAt: null as Date | null,
    todoStuckAt: null,
    todoLastError: null,
  };
}

function hasCode(err: unknown, code: string): boolean {
  return err instanceof AppError && err.code === code;
}

/**
 * Gives an open occurrence its to-do, if its assignee should have one, and records the result in
 * `todo_sync_status`: `ok`, `not_applicable` (no assignee, or one without the To-do panel), or
 * `pending` after a failure, with a retry time for `todo.retryPending`.
 *
 * Safe to repeat: an existing live to-do for the occurrence is reused, and reopened if it was
 * completed (an open occurrence's to-do is open). That is also how an admin's reopen restores the
 * to-do (spec §11.7): reopened if it still exists, created again if not. If a to-do left on someone
 * else's list holds the occurrence (its removal failed earlier), it's removed first. If the
 * occurrence changed while the to-do was being created (completed, reassigned), the new to-do is
 * removed again.
 */
export async function attachTodo(deps: ChoresDeps, occurrenceId: number): Promise<void> {
  const occ = getOccurrenceRow(deps.db, occurrenceId);
  if (!occ || occ.state !== 'open') return;
  const now = deps.clock.now();
  const assignee = occ.assigneeUserId;
  if (assignee === null || !getsTodo(deps.db, assignee)) {
    deps.db
      .update(choreOccurrences)
      .set({ todoId: null, ...notApplicableTodoFields(), updatedAt: now })
      .where(eq(choreOccurrences.id, occ.id))
      .run();
    return;
  }
  let todoId: number;
  try {
    todoId = await findOrCreateTodo(deps, occ, assignee);
  } catch (err) {
    // Blocked writes (a link that needs reconnecting, a key mismatch) don't count as an attempt.
    const blocked = deps.todos.writesBlocked(assignee);
    const attempts = blocked ? occ.todoAttempts : occ.todoAttempts + 1;
    const now = deps.clock.now();
    deps.logger.warn({ ...loggableError(err), occurrenceId: occ.id, attempts, blocked }, "couldn't create a chore's to-do; will retry");
    // Only if nothing else has linked a to-do or moved the occurrence in the meantime.
    deps.db
      .update(choreOccurrences)
      .set({
        todoSyncStatus: 'pending',
        todoAttempts: attempts,
        todoRetryAt: new Date(now.getTime() + (blocked ? TODO_RETRY_BASE_MS : todoRetryDelayMs(attempts))),
        todoLastError: failureMessage(err),
        todoStuckAt: attempts >= TODO_RETRY_CAP ? (occ.todoStuckAt ?? now) : null,
        updatedAt: now,
      })
      .where(
        and(
          eq(choreOccurrences.id, occ.id),
          eq(choreOccurrences.state, 'open'),
          eq(choreOccurrences.assigneeUserId, assignee),
          isNull(choreOccurrences.todoId),
        ),
      )
      .run();
    return;
  }
  const linked = deps.db
    .update(choreOccurrences)
    .set({ todoId, todoSyncStatus: 'ok', todoAttempts: 0, todoRetryAt: null, todoStuckAt: null, todoLastError: null, updatedAt: deps.clock.now() })
    .where(and(eq(choreOccurrences.id, occ.id), eq(choreOccurrences.state, 'open'), eq(choreOccurrences.assigneeUserId, assignee)))
    .returning({ id: choreOccurrences.id })
    .get();
  if (linked) {
    // A to-do that's in use again (e.g. reassigned back) must not be removed by an old queued removal.
    deps.db.delete(choreTodoActions).where(eq(choreTodoActions.todoId, todoId)).run();
  } else {
    await removeTodo(deps, assignee, todoId);
  }
}

async function findOrCreateTodo(deps: ChoresDeps, occ: OccurrenceRow, assignee: number): Promise<number> {
  const reuse = async (item: TodoItem) => {
    if (item.completedAt !== null) await deps.todos.uncomplete(SYSTEM, assignee, item.id);
    return item.id;
  };
  const existing = await deps.todos.findByChoreOccurrence(assignee, occ.id);
  if (existing) return reuse(existing);
  const notes = getChoreRow(deps.db, occ.choreId)?.notes ?? null;
  const create = async () =>
    (await deps.todos.create(SYSTEM, assignee, { title: occ.titleSnapshot, notes, dueDate: occ.dueDate }, { choreOccurrenceId: occ.id })).id;
  try {
    return await create();
  } catch (err) {
    if (!hasCode(err, 'conflict')) throw err;
    // Another live to-do holds this occurrence: one left on a previous assignee's list whose
    // removal failed. Remove it, even if completed (it's stale either way), then create again.
    const other = await deps.todos.findAnyByChoreOccurrence(occ.id);
    if (other?.ownerUserId === assignee) return reuse(other);
    if (!other || !(await removeTodo(deps, other.ownerUserId, other.id, { evenIfCompleted: true }))) throw err;
    return create();
  }
}

/** A change to a chore to-do that is queued in `chore_todo_actions` until it succeeds. */
export interface TodoAction {
  todoId: number;
  ownerUserId: number;
  action: TodoActionRow['action'];
  /** For `remove`: remove it even if it's completed. */
  evenIfCompleted?: boolean;
}

/**
 * Queues an action on a to-do. Call it in the same transaction as the occurrence change that calls
 * for it, so a crash before the to-do changes leaves it queued, then attempt it with
 * `runTodoAction`. It isn't due for a retry for 5 minutes, so `todo.retryPending` doesn't start a
 * second attempt while the first is still in flight.
 *
 * One row per to-do, and a removal wins: a `remove` replaces a queued `complete` (and keeps
 * `even_if_completed` if either asked for it), and a `complete` never replaces a `remove` (that
 * row stays as it was). Otherwise the row starts over, like a new one: no failed attempts, not
 * stuck, no last error, and a new row's retry time. Something asked for the change again, so an
 * old backoff or stuck mark doesn't carry over to it.
 */
export function queueTodoAction(db: DbOrTx, a: TodoAction, now: Date): void {
  const retryAt = new Date(now.getTime() + TODO_RETRY_BASE_MS);
  const evenIfCompleted = a.action === 'remove' && (a.evenIfCompleted ?? false);
  const startOver = { ownerUserId: a.ownerUserId, attempts: 0, stuckAt: null, lastError: null, retryAt };
  const insert = db
    .insert(choreTodoActions)
    .values({ todoId: a.todoId, ownerUserId: a.ownerUserId, action: a.action, evenIfCompleted, attempts: 0, retryAt, createdAt: now });
  if (a.action === 'complete') {
    insert.onConflictDoUpdate({ target: choreTodoActions.todoId, set: startOver, setWhere: eq(choreTodoActions.action, 'complete') }).run();
  } else {
    insert
      .onConflictDoUpdate({
        target: choreTodoActions.todoId,
        set: { ...startOver, action: 'remove', ...(evenIfCompleted ? { evenIfCompleted: true } : {}) },
      })
      .run();
  }
}

/**
 * One removal attempt. Throws on failure; a to-do that's already gone counts as removed. The
 * "linked again?" check is repeated after the awaited read, right before the delete, because an
 * open occurrence can take the to-do back (e.g. an admin reassigns it back) while the read is out.
 */
async function tryRemove(deps: ChoresDeps, ownerId: number, todoId: number, evenIfCompleted: boolean): Promise<void> {
  try {
    const item = await deps.todos.get(ownerId, todoId);
    if (!item || (item.completedAt !== null && !evenIfCompleted)) return;
    if (linkedToOpenOccurrence(deps.db, todoId)) return;
    await deps.todos.delete(SYSTEM, ownerId, todoId);
  } catch (err) {
    if (!hasCode(err, 'not_found')) throw err;
  }
  releaseIfRelinked(deps, todoId, 'deleted');
}

/**
 * For a Todoist user a delete or a completion is a network round trip, and an open occurrence can
 * link the to-do while it's out (an admin reassigns it back, a reopen reuses it). That occurrence
 * now points at a deleted or completed to-do, so it's unlinked and saved as `pending`
 * (`pendingTodoFields`), and `todo.retryPending` attaches one in 5 minutes: a new one after a
 * delete, or the same one reopened after a completion (`attachTodo` reuses it).
 */
function releaseIfRelinked(deps: ChoresDeps, todoId: number, change: 'deleted' | 'completed'): void {
  const occ = deps.db
    .select()
    .from(choreOccurrences)
    .where(and(eq(choreOccurrences.todoId, todoId), eq(choreOccurrences.state, 'open')))
    .get();
  if (!occ) return;
  const now = deps.clock.now();
  deps.db
    .update(choreOccurrences)
    .set({ todoId: null, ...pendingTodoFields(deps.db, occ.assigneeUserId, now), updatedAt: now })
    .where(and(eq(choreOccurrences.id, occ.id), eq(choreOccurrences.todoId, todoId), eq(choreOccurrences.state, 'open')))
    .run();
  deps.logger.info({ occurrenceId: occ.id, todoId, change }, 'a chore to-do was linked again while it was being changed; it will be attached again');
}

/**
 * One completion attempt. Throws on failure. A to-do that's gone or already completed counts as
 * done, and so does one whose occurrence was reopened since: an open occurrence's to-do stays open
 * (and `attachTodo` reuses it). The "reopened?" check is repeated after the awaited completion,
 * like `tryRemove`'s: an open occurrence that linked the to-do while it was out is released.
 */
async function tryComplete(deps: ChoresDeps, ownerId: number, todoId: number): Promise<void> {
  try {
    const item = await deps.todos.get(ownerId, todoId);
    if (!item || item.completedAt !== null) return;
    if (item.choreOccurrenceId !== null && getOccurrenceRow(deps.db, item.choreOccurrenceId)?.state === 'open') return;
    await deps.todos.complete(SYSTEM, ownerId, todoId);
  } catch (err) {
    if (!hasCode(err, 'not_found')) throw err;
    return;
  }
  releaseIfRelinked(deps, todoId, 'completed');
}

/** True when an open occurrence links the to-do, so it's in use and must not be removed. */
function linkedToOpenOccurrence(db: Db, todoId: number): boolean {
  return (
    db
      .select({ id: choreOccurrences.id })
      .from(choreOccurrences)
      .where(and(eq(choreOccurrences.todoId, todoId), eq(choreOccurrences.state, 'open')))
      .get() !== undefined
  );
}

/**
 * One attempt at a to-do's queued action, re-read from the queue just before it's tried, since
 * the retry pass and the request that queued it can overlap. Returns true when nothing is left to
 * do: it succeeded, the row is gone, or it no longer applies. A removal no longer applies once an
 * open occurrence links the to-do again (closed occurrences keep pointing at their old to-do). On
 * failure, the row backs off (5, 10, 20, 40 minutes, then hourly) and this returns false, so the
 * caller can tell the user (spec §14).
 */
export async function runTodoAction(deps: ChoresDeps, todoId: number): Promise<boolean> {
  const row = deps.db.select().from(choreTodoActions).where(eq(choreTodoActions.todoId, todoId)).get();
  if (!row) return true;
  if (row.action === 'remove' && linkedToOpenOccurrence(deps.db, todoId)) {
    deps.db.delete(choreTodoActions).where(and(eq(choreTodoActions.todoId, todoId), eq(choreTodoActions.action, 'remove'))).run();
    return true;
  }
  try {
    if (row.action === 'remove') await tryRemove(deps, row.ownerUserId, todoId, row.evenIfCompleted);
    else await tryComplete(deps, row.ownerUserId, todoId);
  } catch (err) {
    const blocked = deps.todos.writesBlocked(row.ownerUserId);
    const attempts = blocked ? row.attempts : row.attempts + 1;
    const now = deps.clock.now();
    deps.logger.warn({ ...loggableError(err), todoId, action: row.action, attempts, blocked }, `couldn't ${row.action} a chore's to-do; will retry`);
    deps.db
      .update(choreTodoActions)
      .set({
        attempts,
        retryAt: new Date(now.getTime() + (blocked ? TODO_RETRY_BASE_MS : todoRetryDelayMs(attempts))),
        lastError: failureMessage(err),
        stuckAt: attempts >= TODO_RETRY_CAP ? (row.stuckAt ?? now) : null,
      })
      .where(and(eq(choreTodoActions.todoId, todoId), eq(choreTodoActions.action, row.action)))
      .run();
    return false;
  }
  // Only the row as it was read: if it became a removal, or a removal even if completed, in the
  // meantime, that still has to happen.
  deps.db
    .delete(choreTodoActions)
    .where(
      and(
        eq(choreTodoActions.todoId, todoId),
        eq(choreTodoActions.action, row.action),
        eq(choreTodoActions.evenIfCompleted, row.evenIfCompleted),
      ),
    )
    .run();
  return true;
}

/** Queues an action, then attempts it at once. False when it failed and stays queued for `todo.retryPending`. */
export async function doTodoAction(deps: ChoresDeps, a: TodoAction): Promise<boolean> {
  queueTodoAction(deps.db, a, deps.clock.now());
  return runTodoAction(deps, a.todoId);
}

/**
 * Tries each of the owner's queued to-do actions once now, due or not, stuck or not. For a
 * deactivation, while their Todoist link still works. Returns how many are still waiting.
 */
export async function runTodoActionsFor(deps: ChoresDeps, ownerId: number): Promise<number> {
  const queued = deps.db.select({ todoId: choreTodoActions.todoId }).from(choreTodoActions).where(eq(choreTodoActions.ownerUserId, ownerId)).all();
  let left = 0;
  for (const { todoId } of queued) if (!(await runTodoAction(deps, todoId))) left++;
  return left;
}

/**
 * Deletes a to-do unless it's completed (or even then, with `evenIfCompleted`). Returns true when
 * it's gone or never needed removing. On failure, the removal stays queued for `todo.retryPending`
 * and this returns false, so the caller can tell the user (spec §14).
 */
export async function removeTodo(
  deps: ChoresDeps,
  ownerId: number,
  todoId: number,
  opts: { evenIfCompleted?: boolean } = {},
): Promise<boolean> {
  return doTodoAction(deps, { todoId, ownerUserId: ownerId, action: 'remove', evenIfCompleted: opts.evenIfCompleted ?? false });
}

/**
 * The occurrence's open to-do on anyone's list, or null: what a change uses when the occurrence
 * links no to-do. Such a leftover exists after a reopen whose to-do call failed: the queued
 * completion of the old to-do is dropped while the occurrence is open (its to-do stays open for
 * `attachTodo` to reuse), so until the retried create links it again, nothing points at it.
 * Completed to-dos stay, so they don't count.
 *
 * Call it before reading the occurrence row that the change is based on, and pass the result to
 * `removalFor` or `completionFor`. Then the read and the write stay synchronous, so a to-do that
 * `attachTodo` links in the meantime shows up in the row and isn't missed.
 */
export async function findLeftoverTodo(deps: ChoresDeps, occurrenceId: number): Promise<TodoItem | null> {
  const item = await deps.todos.findAnyByChoreOccurrence(occurrenceId);
  return item && item.completedAt === null ? item : null;
}

/**
 * The removal of an occurrence's to-do, from the row as it was before the change: the linked one,
 * or else the open leftover from `findLeftoverTodo`. Null if there is none. A leftover owned by
 * `keepFor` (the new assignee) is kept, so `attachTodo` reuses it.
 */
export function removalFor(occ: OccurrenceRow, leftover: TodoItem | null = null, keepFor: number | null = null): TodoAction | null {
  if (occ.todoId !== null) {
    return occ.assigneeUserId === null ? null : { todoId: occ.todoId, ownerUserId: occ.assigneeUserId, action: 'remove' };
  }
  if (!leftover || leftover.choreOccurrenceId !== occ.id || leftover.ownerUserId === keepFor) return null;
  return { todoId: leftover.id, ownerUserId: leftover.ownerUserId, action: 'remove' };
}

/** The completion of an occurrence's to-do: the linked one, or else the open leftover. Null if there is none. */
export function completionFor(occ: OccurrenceRow, leftover: TodoItem | null = null): TodoAction | null {
  if (occ.todoId !== null) {
    return occ.assigneeUserId === null ? null : { todoId: occ.todoId, ownerUserId: occ.assigneeUserId, action: 'complete' };
  }
  if (!leftover || leftover.choreOccurrenceId !== occ.id) return null;
  return { todoId: leftover.id, ownerUserId: leftover.ownerUserId, action: 'complete' };
}

/**
 * Removes the occurrence's unfinished to-do: on skip, unassign, reassign away, pause, and archive
 * (spec §11.5). Pass the row as it was before the change, so the to-do's owner is known. Returns
 * false when the removal failed and was queued.
 */
export async function detachTodo(deps: ChoresDeps, occ: OccurrenceRow): Promise<boolean> {
  const removal = removalFor(occ, await findLeftoverTodo(deps, occ.id));
  return removal ? doTodoAction(deps, removal) : true;
}

/**
 * Marks the occurrence's to-do complete after it was completed on the Chores panel. Returns false
 * when that failed and was queued for `todo.retryPending`.
 */
export async function completeTodo(deps: ChoresDeps, occ: OccurrenceRow): Promise<boolean> {
  const completion = completionFor(occ, await findLeftoverTodo(deps, occ.id));
  return completion ? doTodoAction(deps, completion) : true;
}

/**
 * The `todo.retryPending` job (spec §3.5, §11.5). First retries queued to-do actions (removals and
 * completions), then to-dos that couldn't be created, each once its retry time has come. The queue
 * goes first, so a to-do that blocked a new one (the one-live-to-do-per-occurrence rule) is out of
 * the way.
 *
 * Stuck items aren't retried. Items whose owner's writes are blocked (`TodoService.writesBlocked`)
 * are skipped and pushed back 5 minutes without counting an attempt.
 *
 * `stillPending` and `actionsPending` count everything still waiting afterwards that has failed at
 * least once, due or not, except stuck items (the System page lists those) and blocked items (the
 * owner sees a Reconnect prompt, or the System page warns about the key; admins see each link's
 * status on the Users page).
 */
export async function retryPendingTodos(
  deps: ChoresDeps,
): Promise<{ attempted: number; stillPending: number; actionsAttempted: number; actionsPending: number }> {
  const now = deps.clock.now();
  const later = new Date(now.getTime() + TODO_RETRY_BASE_MS);
  const blocked = (ownerId: number | null) => ownerId !== null && deps.todos.writesBlocked(ownerId);

  const actions = deps.db
    .select({ todoId: choreTodoActions.todoId, ownerUserId: choreTodoActions.ownerUserId })
    .from(choreTodoActions)
    .where(and(lte(choreTodoActions.retryAt, now), isNull(choreTodoActions.stuckAt)))
    .all();
  let actionsAttempted = 0;
  for (const a of actions) {
    if (blocked(a.ownerUserId)) {
      deps.db.update(choreTodoActions).set({ retryAt: later }).where(eq(choreTodoActions.todoId, a.todoId)).run();
      continue;
    }
    actionsAttempted++;
    await runTodoAction(deps, a.todoId);
  }

  const due = deps.db
    .select({ id: choreOccurrences.id, assignee: choreOccurrences.assigneeUserId })
    .from(choreOccurrences)
    .where(
      and(
        eq(choreOccurrences.state, 'open'),
        eq(choreOccurrences.todoSyncStatus, 'pending'),
        isNull(choreOccurrences.todoStuckAt),
        or(isNull(choreOccurrences.todoRetryAt), lte(choreOccurrences.todoRetryAt, now)),
      ),
    )
    .all();
  let attempted = 0;
  for (const occ of due) {
    if (blocked(occ.assignee)) {
      deps.db.update(choreOccurrences).set({ todoRetryAt: later }).where(eq(choreOccurrences.id, occ.id)).run();
      continue;
    }
    attempted++;
    await attachTodo(deps, occ.id);
  }

  // Everything still waiting, due now or not, so the recorded job error doesn't come and go between
  // retries: every create and every queued to-do action that has failed at least once. One that
  // hasn't is a first attempt still in flight.
  const stillPending = deps.db
    .select({ assignee: choreOccurrences.assigneeUserId })
    .from(choreOccurrences)
    .where(
      and(
        eq(choreOccurrences.state, 'open'),
        eq(choreOccurrences.todoSyncStatus, 'pending'),
        gt(choreOccurrences.todoAttempts, 0),
        isNull(choreOccurrences.todoStuckAt),
      ),
    )
    .all()
    .filter((o) => !blocked(o.assignee)).length;
  const actionsPending = deps.db
    .select({ ownerUserId: choreTodoActions.ownerUserId })
    .from(choreTodoActions)
    .where(and(gt(choreTodoActions.attempts, 0), isNull(choreTodoActions.stuckAt)))
    .all()
    .filter((a) => !blocked(a.ownerUserId)).length;
  return { attempted, stillPending, actionsAttempted, actionsPending };
}

/**
 * Stuck items, for the System page: creates (by occurrence) and queued removals and completions
 * (by to-do), with whose list, the last error, and since when.
 */
export async function listStuckTodos(deps: ChoresDeps): Promise<StuckTodo[]> {
  const names = new Map(deps.db.select({ id: users.id, displayName: users.displayName }).from(users).all().map((u) => [u.id, u.displayName]));
  const owner = (id: number | null) => (id === null ? null : { id, displayName: names.get(id) ?? 'Unknown' });
  const creates: StuckTodo[] = deps.db
    .select()
    .from(choreOccurrences)
    .where(and(eq(choreOccurrences.state, 'open'), eq(choreOccurrences.todoSyncStatus, 'pending'), isNotNull(choreOccurrences.todoStuckAt)))
    .all()
    .map((o) => ({
      kind: 'create',
      id: o.id,
      title: o.titleSnapshot,
      dueDate: o.dueDate,
      owner: owner(o.assigneeUserId),
      attempts: o.todoAttempts,
      lastError: o.todoLastError,
      stuckSince: o.todoStuckAt!.toISOString(),
    }));
  const actions: StuckTodo[] = [];
  for (const a of deps.db.select().from(choreTodoActions).where(isNotNull(choreTodoActions.stuckAt)).all()) {
    const item = await deps.todos.get(a.ownerUserId, a.todoId);
    const occ = item?.choreOccurrenceId != null ? getOccurrenceRow(deps.db, item.choreOccurrenceId) : undefined;
    actions.push({
      kind: a.action,
      id: a.todoId,
      title: item?.title ?? occ?.titleSnapshot ?? `To-do ${a.todoId}`,
      dueDate: occ?.dueDate ?? item?.dueDate ?? null,
      owner: owner(a.ownerUserId),
      attempts: a.attempts,
      lastError: a.lastError,
      stuckSince: a.stuckAt!.toISOString(),
    });
  }
  return [...creates, ...actions].sort((x, y) => x.stuckSince.localeCompare(y.stuckSince));
}

/** A stuck create, on an occurrence that's still open (one closed since needs no to-do). */
function stuckCreate(id: number) {
  return and(
    eq(choreOccurrences.id, id),
    eq(choreOccurrences.state, 'open'),
    eq(choreOccurrences.todoSyncStatus, 'pending'),
    isNotNull(choreOccurrences.todoStuckAt),
  );
}

/**
 * An admin's Retry: the item starts over (no failed attempts, not stuck) and is tried once now.
 * Like a new item, it isn't due again for 5 minutes, so `todo.retryPending` can't start a second
 * attempt while this one is in flight. Returns true when it succeeded; otherwise it's waiting
 * again, with the normal backoff.
 */
export async function retryStuckTodo(deps: ChoresDeps, kind: StuckTodo['kind'], id: number): Promise<boolean> {
  const retryAt = new Date(deps.clock.now().getTime() + TODO_RETRY_BASE_MS);
  if (kind === 'create') {
    const done = deps.db
      .update(choreOccurrences)
      .set({ todoAttempts: 0, todoStuckAt: null, todoRetryAt: retryAt })
      .where(stuckCreate(id))
      .returning({ id: choreOccurrences.id })
      .get();
    if (!done) throw new AppError('not_found', 'That item is no longer stuck.');
    await attachTodo(deps, id);
    return getOccurrenceRow(deps.db, id)?.todoSyncStatus !== 'pending';
  }
  const done = deps.db
    .update(choreTodoActions)
    .set({ attempts: 0, stuckAt: null, retryAt })
    .where(and(eq(choreTodoActions.todoId, id), eq(choreTodoActions.action, kind), isNotNull(choreTodoActions.stuckAt)))
    .returning({ id: choreTodoActions.todoId })
    .get();
  if (!done) throw new AppError('not_found', 'That item is no longer stuck.');
  return runTodoAction(deps, id);
}

/**
 * An admin's Dismiss: a stuck removal or completion is dropped from the queue (the to-do stays as
 * it is), and a stuck create is given up on, leaving the occurrence `not_applicable` (completed
 * from the Chores panel, like one whose assignee has no To-do panel).
 */
export function dismissStuckTodo(deps: ChoresDeps, kind: StuckTodo['kind'], id: number): void {
  const now = deps.clock.now();
  const changed =
    kind === 'create'
      ? deps.db
          .update(choreOccurrences)
          .set({ ...notApplicableTodoFields(), updatedAt: now })
          .where(stuckCreate(id))
          .run().changes
      : deps.db
          .delete(choreTodoActions)
          .where(and(eq(choreTodoActions.todoId, id), eq(choreTodoActions.action, kind), isNotNull(choreTodoActions.stuckAt)))
          .run().changes;
  if (changed === 0) throw new AppError('not_found', 'That item is no longer stuck.');
}
