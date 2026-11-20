import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import type { Role } from '../../../shared/api.js';
import { isRepeating, TODO_REMOVAL_WARNING, type Occurrence, type OccurrenceResponse } from '../../../shared/chores.js';
import { localDate } from '../../core/clock.js';
import { AppError } from '../../core/errors.js';
import type { Db } from '../../db/index.js';
import { choreOccurrences, chores, type ChoreRow, type OccurrenceRow } from '../../db/schema.js';
import { generateChores } from './generator.js';
import {
  familyTimeZone, getChoreRow, getOccurrenceRow, isActiveUser, peopleById, requireOccurrence, toOccurrence, type ChoresDeps,
} from './store.js';
import {
  attachTodo, completionFor, findLeftoverTodo, pendingTodoFields, queueTodoAction, removalFor, runTodoAction, type DbOrTx,
  type TodoAction,
} from './todoLink.js';

/**
 * What people do to occurrences on the Chores panel: complete and skip (spec §11.6), and the history
 * corrections (§11.7). Who has a chore changes in assignment.ts. Each write is conditional on the
 * state it checked, so a request that loses a race gets a 409 instead of overwriting.
 *
 * An occurrence that is about to get a to-do is saved as `pending` with a retry time first
 * (`pendingTodoFields`), then `attachTodo` runs. A change that removes or completes the old to-do
 * saves the occurrence and queues that to-do action in one transaction (`saveAndQueue`), then
 * attempts it at once; a crash in between leaves it queued for `todo.retryPending` instead of
 * orphaned. Responses carry `warning` when an old to-do couldn't be removed yet (spec §14).
 *
 * An occurrence with no linked to-do can still have an open leftover one (after a reopen whose
 * to-do call failed), so these changes look it up first, then read the occurrence; see
 * `findLeftoverTodo`.
 */
export interface ChoreUser {
  id: number;
  role: Role;
}

export function requireAdmin(user: ChoreUser): void {
  if (user.role !== 'admin') throw new AppError('forbidden', 'Only admins can do that.');
}

function requireOpen(occ: OccurrenceRow): void {
  if (occ.state !== 'open') throw new AppError('conflict', "That chore isn't open any more.");
}

export function stale(): AppError {
  return new AppError('conflict', 'That chore just changed. Refresh and try again.');
}

function assigneeIs(userId: number | null) {
  return userId === null ? isNull(choreOccurrences.assigneeUserId) : eq(choreOccurrences.assigneeUserId, userId);
}

/** Matches the row only if it's still open and assigned as it was when we read it. */
export function unchangedOpen(occ: OccurrenceRow) {
  return and(eq(choreOccurrences.id, occ.id), eq(choreOccurrences.state, 'open'), assigneeIs(occ.assigneeUserId));
}

/**
 * Runs the occurrence's conditional write and, only if it matched, queues `action` (the old to-do's
 * removal or completion) in the same transaction. Returns the write's result, as `write` did.
 */
function saveAndQueue<T>(deps: ChoresDeps, write: (tx: DbOrTx) => T | undefined, action: TodoAction | null): T | undefined {
  return deps.db.transaction((tx) => {
    const result = write(tx);
    if (result !== undefined && action) queueTodoAction(tx, action, deps.clock.now());
    return result;
  });
}

/** Attempts a to-do action queued by `saveAndQueue`. False when it failed and stays queued. */
async function runQueued(deps: ChoresDeps, action: TodoAction | null): Promise<boolean> {
  return action ? runTodoAction(deps, action.todoId) : true;
}

function view(db: Db, id: number, removed = true): OccurrenceResponse {
  const occ: Occurrence = toOccurrence(getOccurrenceRow(db, id)!, peopleById(db));
  return removed ? occ : { ...occ, warning: TODO_REMOVAL_WARNING };
}

/**
 * In the same transaction as an occurrence's close: an as-needed chore goes back to the board,
 * unassigned (chore board spec). Only while it's still the closing occurrence's person's, so a
 * take-over that already happened isn't undone.
 */
export function returnToBoardIfAsNeeded(tx: DbOrTx, occ: OccurrenceRow, now: Date): void {
  if (occ.assigneeUserId === null) return;
  const chore = tx.select({ schedule: chores.schedule }).from(chores).where(eq(chores.id, occ.choreId)).get();
  if (!chore || isRepeating(chore.schedule)) return;
  tx.update(chores)
    .set({ assigneeUserId: null, updatedAt: now })
    .where(and(eq(chores.id, occ.choreId), eq(chores.assigneeUserId, occ.assigneeUserId)))
    .run();
}

/**
 * Who a reopened occurrence goes to (Decision 7): the chore's assignee or, for a chore back on the
 * board, whoever had the occurrence, if they're still active. Null when nobody can have it.
 */
export function reopenAssignee(db: Db, chore: ChoreRow, occ: OccurrenceRow): number | null {
  for (const id of [chore.assigneeUserId, occ.assigneeUserId]) {
    if (id !== null && isActiveUser(db, id)) return id;
  }
  return null;
}

/**
 * Marks an open occurrence done (spec §11.6), and its to-do complete. Members complete their own;
 * admins any, with credit to the assignee. Then the chore moves on: as needed, back to the board
 * (in the same transaction); repeating, its next occurrence now if it was done late (generateChores
 * creates it only once F has come).
 */
export async function completeOccurrence(deps: ChoresDeps, user: ChoreUser, id: number): Promise<OccurrenceResponse> {
  const leftover = await findLeftoverTodo(deps, id);
  const occ = requireOccurrence(deps.db, id);
  requireOpen(occ);
  if (user.role !== 'admin' && occ.assigneeUserId !== user.id) throw new AppError('forbidden', 'You can only complete your own chores.');
  const now = deps.clock.now();
  const completion = completionFor(occ, leftover);
  const row = saveAndQueue(
    deps,
    (tx) => {
      const done = tx
        .update(choreOccurrences)
        .set({ state: 'done', completedAt: now, actorUserId: user.id, creditedUserId: occ.assigneeUserId ?? user.id, updatedAt: now })
        .where(unchangedOpen(occ))
        .returning()
        .get();
      if (done) returnToBoardIfAsNeeded(tx, occ, now);
      return done;
    },
    completion,
  );
  if (!row) throw stale();
  await runQueued(deps, completion);
  await generateChores(deps, { choreId: occ.choreId });
  return view(deps.db, id);
}

/** Admins only: skips an open occurrence and deletes its unfinished to-do. The chore moves on as after a completion. */
export async function skipOccurrence(deps: ChoresDeps, user: ChoreUser, id: number): Promise<OccurrenceResponse> {
  requireAdmin(user);
  const leftover = await findLeftoverTodo(deps, id);
  const occ = requireOccurrence(deps.db, id);
  requireOpen(occ);
  const now = deps.clock.now();
  const removal = removalFor(occ, leftover);
  const row = saveAndQueue(
    deps,
    (tx) => {
      const skipped = tx
        .update(choreOccurrences)
        .set({ state: 'skipped', completedAt: now, actorUserId: user.id, creditedUserId: null, updatedAt: now })
        .where(unchangedOpen(occ))
        .returning()
        .get();
      if (skipped) returnToBoardIfAsNeeded(tx, occ, now);
      return skipped;
    },
    removal,
  );
  if (!row) throw stale();
  const removed = await runQueued(deps, removal);
  await generateChores(deps, { choreId: occ.choreId });
  return view(deps.db, id, removed);
}

/** Admins only (spec §11.7): changes who gets credit for a completion. */
export async function setCredit(deps: ChoresDeps, user: ChoreUser, id: number, userId: number): Promise<OccurrenceResponse> {
  requireAdmin(user);
  if (!isActiveUser(deps.db, userId)) throw new AppError('validation', 'Pick an active person to get the credit.');
  const occ = requireOccurrence(deps.db, id);
  if (occ.state !== 'done') throw new AppError('conflict', 'Only completed chores have credit to change.');
  deps.db
    .update(choreOccurrences)
    .set({ creditedUserId: userId, updatedAt: deps.clock.now() })
    .where(and(eq(choreOccurrences.id, id), eq(choreOccurrences.state, 'done')))
    .run();
  return view(deps.db, id);
}

/**
 * How soon after a late close its next occurrence must have been created to count as brought by
 * that close (`newerOnReopen`). The close creates it at once; the job's next run is minutes away.
 */
export const BROUGHT_BY_CLOSE_MS = 60_000;

/**
 * What the chore's newer occurrences mean for reopening `occ` (a done or skipped one). Ids only
 * grow, so "newer" is "created after", which also works for as-needed occurrences with no due date.
 * - none: it can be reopened.
 * - exactly one that the close itself brought: `occ` was closed late (its family-local close date is
 *   after its due date), and the newer one is still open, the same person's, and was created within
 *   BROUGHT_BY_CLOSE_MS after the close. Then the reopen undoes the close: it deletes that occurrence
 *   and its to-do (`replaces`), so an accidental tick on an overdue chore can be taken back. As-needed
 *   occurrences have no due date and never bring a next one, so they never qualify.
 * - anything else (closed, someone else's, an on-time or early close whose next one the job made
 *   later, or one created later than that): it can't (`blocked`).
 */
export type NewerOnReopen = { blocked: true } | { blocked: false; replaces: OccurrenceRow | null };

export function newerOnReopen(db: DbOrTx, occ: OccurrenceRow, timeZone: string): NewerOnReopen {
  const newer = db
    .select()
    .from(choreOccurrences)
    .where(and(eq(choreOccurrences.choreId, occ.choreId), gt(choreOccurrences.id, occ.id)))
    .orderBy(asc(choreOccurrences.id))
    .limit(2)
    .all();
  if (newer.length === 0) return { blocked: false, replaces: null };
  const [next] = newer;
  const closedLate = occ.completedAt !== null && occ.dueDate !== null && localDate(occ.completedAt, timeZone) > occ.dueDate;
  const sinceClose = occ.completedAt === null ? -1 : next!.createdAt.getTime() - occ.completedAt.getTime();
  const undoable =
    newer.length === 1 &&
    closedLate &&
    next!.state === 'open' &&
    next!.assigneeUserId !== null &&
    next!.assigneeUserId === occ.assigneeUserId &&
    sinceClose >= 0 &&
    sinceClose <= BROUGHT_BY_CLOSE_MS;
  return undoable ? { blocked: false, replaces: next! } : { blocked: true };
}

/**
 * In a reopen's transaction: deletes the open occurrence the reopen replaces (see `newerOnReopen`)
 * and queues its to-do's removal. Throws `stale()` (rolling the reopen back) if it changed since it
 * was read.
 */
export function dropReplaced(tx: DbOrTx, replaces: OccurrenceRow, removal: TodoAction | null, now: Date): void {
  if (tx.delete(choreOccurrences).where(unchangedOpen(replaces)).run().changes === 0) throw stale();
  if (removal) queueTodoAction(tx, removal, now);
}

/**
 * Admins only (spec §11.7): sets a done or skipped occurrence back to open, if the chore is active
 * and it's the chore's most recent occurrence, or the only newer one is what its late close brought
 * (`newerOnReopen`), which is then deleted with its to-do. It goes to `reopenAssignee` (Decision 7),
 * and a chore back on the board is assigned to them again; refused when nobody can have it.
 * `attachTodo` then restores its to-do: the live one is reopened, a deleted one is created again,
 * and an assignee without the To-do panel gets none (`not_applicable`).
 */
export async function reopenOccurrence(deps: ChoresDeps, user: ChoreUser, id: number): Promise<OccurrenceResponse> {
  requireAdmin(user);
  // The replaced occurrence's leftover lookup is the one await, so it comes before the reads the writes depend on.
  const first = requireOccurrence(deps.db, id);
  const timeZone = familyTimeZone(deps.db);
  const before = first.state === 'open' ? null : newerOnReopen(deps.db, first, timeZone);
  const leftover = before && !before.blocked && before.replaces ? await findLeftoverTodo(deps, before.replaces.id) : null;

  const occ = requireOccurrence(deps.db, id);
  if (occ.state === 'open') throw new AppError('conflict', 'That chore is already open.');
  const chore = getChoreRow(deps.db, occ.choreId);
  if (!chore || chore.status !== 'active') throw new AppError('conflict', 'Resume the chore before reopening it.');
  const newer = newerOnReopen(deps.db, occ, timeZone);
  if (newer.blocked) throw new AppError('conflict', 'Only the most recent occurrence of a chore can be reopened.');
  const expected = before && !before.blocked ? before.replaces?.id : undefined;
  if (newer.replaces?.id !== expected) throw stale();
  const assignee = reopenAssignee(deps.db, chore, occ);
  if (assignee === null) throw new AppError('conflict', 'Assign the chore before reopening it.');
  const removal = newer.replaces ? removalFor(newer.replaces, leftover) : null;
  const now = deps.clock.now();
  const row = deps.db.transaction((tx) => {
    const reopened = tx
      .update(choreOccurrences)
      .set({
        state: 'open',
        completedAt: null,
        actorUserId: null,
        creditedUserId: null,
        assigneeUserId: assignee,
        todoId: null,
        ...pendingTodoFields(tx, assignee, now),
        updatedAt: now,
      })
      .where(and(eq(choreOccurrences.id, id), eq(choreOccurrences.state, occ.state)))
      .returning()
      .get();
    if (!reopened) return undefined;
    if (newer.replaces) dropReplaced(tx, newer.replaces, removal, now);
    if (chore.assigneeUserId === null) {
      tx.update(chores).set({ assigneeUserId: assignee, updatedAt: now }).where(and(eq(chores.id, chore.id), isNull(chores.assigneeUserId))).run();
    }
    return reopened;
  });
  if (!row) throw stale();
  const removed = await runQueued(deps, removal);
  await attachTodo(deps, id);
  return view(deps.db, id, removed);
}
