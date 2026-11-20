import { and, eq, isNull, ne } from 'drizzle-orm';
import { isRepeating, TODO_REMOVAL_WARNING, type AssignmentSource, type BoardRowResponse } from '../../../shared/chores.js';
import { localDate } from '../../core/clock.js';
import { AppError } from '../../core/errors.js';
import type { Db } from '../../db/index.js';
import { choreOccurrences, chores, type ChoreRow } from '../../db/schema.js';
import { requireAdmin, stale, unchangedOpen, type ChoreUser } from './actions.js';
import { choreState, insertOpenOccurrence } from './generator.js';
import { dueOnAssignment } from './schedule.js';
import { familyTimeZone, getChoreRow, isActiveUser, type ChoresDeps } from './store.js';
import { attachTodo, findLeftoverTodo, pendingTodoFields, queueTodoAction, removalFor, runTodoAction, type TodoAction } from './todoLink.js';
import { boardRowFor } from './views.js';

/**
 * Who has a chore (chore board spec, "Who can do what" and "What being assigned does"). The
 * assignment lives on the chore, and an assigned chore has at most one open occurrence, which
 * carries the to-do.
 * - To someone (claim, take over, admin assign): an open occurrence moves to them with its due date,
 *   and their to-do replaces the old one. With nothing open, one is created now, due on the next date
 *   the schedule hits (`dueOnAssignment`), or with no due date for as needed.
 * - To nobody (release, admin unassign): the open occurrence is deleted, since it wasn't done or
 *   skipped, and its to-do removed.
 * Each change is one transaction, conditional on the chore's assignee and open occurrence as read,
 * so a request that loses a race gets a 409. The old to-do's removal is queued in that transaction
 * and attempted right after (as in actions.ts); the response carries `warning` when it couldn't be
 * removed yet.
 */

/** Anyone with the panel: an unassigned chore, or one someone else has (take over). */
export async function claimChore(deps: ChoresDeps, user: ChoreUser, choreId: number): Promise<BoardRowResponse> {
  return changeAssignee(deps, choreId, user.id, 'claimed');
}

/** Whoever has the chore puts it back on the board, unassigned. */
export async function releaseChore(deps: ChoresDeps, user: ChoreUser, choreId: number): Promise<BoardRowResponse> {
  return changeAssignee(deps, choreId, null, 'claimed', { onlyFrom: user.id });
}

/** Admins only: assign, reassign, or unassign (`userId` null) any active chore. */
export async function assignChore(deps: ChoresDeps, user: ChoreUser, choreId: number, userId: number | null): Promise<BoardRowResponse> {
  requireAdmin(user);
  if (userId !== null && !isActiveUser(deps.db, userId)) throw new AppError('validation', 'Pick an active person, or Unassigned.');
  return changeAssignee(deps, choreId, userId, 'admin');
}

/** Claim, release, and assign are for chores on the board. */
function requireActiveChore(db: Db, choreId: number): ChoreRow {
  const chore = getChoreRow(db, choreId);
  if (!chore) throw new AppError('not_found', 'Chore not found.');
  if (chore.status === 'paused') throw new AppError('conflict', 'Resume the chore first.');
  if (chore.status === 'archived') throw new AppError('conflict', "Archived chores can't be changed.");
  return chore;
}

function choreAssigneeIs(userId: number | null) {
  return userId === null ? isNull(chores.assigneeUserId) : eq(chores.assigneeUserId, userId);
}

/**
 * Moves the chore to `to` (or to nobody), with its open occurrence and to-do. `onlyFrom`: refuse
 * unless the chore is that person's (release). `source` marks a moved or new occurrence.
 */
async function changeAssignee(
  deps: ChoresDeps,
  choreId: number,
  to: number | null,
  source: AssignmentSource,
  opts: { onlyFrom?: number } = {},
): Promise<BoardRowResponse> {
  const first = requireActiveChore(deps.db, choreId);
  if (opts.onlyFrom !== undefined && first.assigneeUserId !== opts.onlyFrom) {
    throw new AppError('forbidden', 'You can only release chores you have.');
  }
  if (first.assigneeUserId === to) return boardRowFor(deps, choreId);
  const timeZone = familyTimeZone(deps.db);
  const now = deps.clock.now();
  const today = localDate(now, timeZone);

  // The leftover lookup is the one await, so it comes before the reads the writes depend on (see findLeftoverTodo).
  const openBefore = choreState(deps.db, choreId, today, timeZone).open;
  const leftover = openBefore ? await findLeftoverTodo(deps, openBefore.id) : null;
  const chore = requireActiveChore(deps.db, choreId);
  const { open } = choreState(deps.db, choreId, today, timeZone);
  if (chore.assigneeUserId !== first.assigneeUserId || open?.id !== openBefore?.id) throw stale();
  // A leftover on the new person's own list stays, for attachTodo to reuse.
  const removal: TodoAction | null = open ? removalFor(open, leftover, to) : null;

  const occurrenceId = deps.db.transaction((tx) => {
    const moved = tx
      .update(chores)
      .set({ assigneeUserId: to, updatedAt: now })
      .where(and(eq(chores.id, choreId), eq(chores.status, 'active'), choreAssigneeIs(chore.assigneeUserId)))
      .returning({ id: chores.id })
      .get();
    if (!moved) throw stale();
    let id: number | null = null;
    if (open && to === null) {
      if (tx.delete(choreOccurrences).where(unchangedOpen(open)).run().changes === 0) throw stale();
    } else if (open) {
      const row = tx
        .update(choreOccurrences)
        .set({ assigneeUserId: to, assignmentSource: source, todoId: null, ...pendingTodoFields(tx, to, now), updatedAt: now })
        .where(unchangedOpen(open))
        .returning({ id: choreOccurrences.id })
        .get();
      if (!row) throw stale();
      id = row.id;
    } else if (to !== null) {
      const dueDate = isRepeating(chore.schedule)
        ? dueOnAssignment(chore.schedule, chore.startDate, choreState(tx, choreId, today, timeZone).timeline)
        : null;
      id = insertOpenOccurrence(tx, { ...chore, assigneeUserId: to }, dueDate, source, now);
      if (id === null) throw stale();
    }
    if (removal) queueTodoAction(tx, removal, now);
    return id;
  });

  const removed = removal ? await runTodoAction(deps, removal.todoId) : true;
  if (occurrenceId !== null) await attachTodo(deps, occurrenceId);
  const row = boardRowFor(deps, choreId);
  return removed ? row : { ...row, warning: TODO_REMOVAL_WARNING };
}

/**
 * When a user is deactivated (spec §2): their chores go back on the board, unassigned, paused ones
 * included, and their open occurrences are deleted with their to-dos, as when released. Called from
 * the `user.deactivated` event. Returns how many chores were released.
 */
export async function releaseUser(deps: ChoresDeps, userId: number): Promise<number> {
  const theirs = deps.db.select({ id: chores.id, status: chores.status }).from(chores).where(eq(chores.assigneeUserId, userId)).all();
  let released = 0;
  for (const chore of theirs) {
    try {
      if (chore.status === 'active') {
        await changeAssignee(deps, chore.id, null, 'admin', { onlyFrom: userId });
      } else {
        // Paused (archived chores have nobody): nothing is open, so it's only the assignment.
        const changed = deps.db
          .update(chores)
          .set({ assigneeUserId: null, updatedAt: deps.clock.now() })
          .where(and(eq(chores.id, chore.id), eq(chores.assigneeUserId, userId)))
          .run().changes;
        if (changed === 0) continue;
      }
      released++;
    } catch (err) {
      if (!(err instanceof AppError) || (err.code !== 'conflict' && err.code !== 'forbidden')) throw err;
      // Paused (or archived) since it was listed: nothing of theirs is open, so only the assignment
      // is left to clear. Otherwise someone else took it meanwhile, and it isn't theirs to release.
      const changed = deps.db
        .update(chores)
        .set({ assigneeUserId: null, updatedAt: deps.clock.now() })
        .where(and(eq(chores.id, chore.id), eq(chores.assigneeUserId, userId), ne(chores.status, 'active')))
        .run().changes;
      if (changed > 0) released++;
    }
  }
  return released;
}
