import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { AppError } from '../../core/errors.js';
import type { Actor, EventBus, TodoEvent } from '../../core/events.js';
import { choreOccurrences, chores, type OccurrenceRow } from '../../db/schema.js';
import { dropReplaced, newerOnReopen, reopenAssignee, returnToBoardIfAsNeeded } from './actions.js';
import { releaseUser } from './assignment.js';
import { generateChores } from './generator.js';
import { familyTimeZone, getChoreRow, getOccurrenceRow, peopleById, type ChoresDeps } from './store.js';
import {
  doTodoAction, findLeftoverTodo, queueTodoAction, removalFor, runTodoAction, runTodoActionsFor, type TodoAction,
} from './todoLink.js';

/**
 * How to-do events change occurrences (spec §11.5):
 * - `todo.completed`: done, credited to the assignee, checked off by the acting user
 * - `todo.uncompleted`: open again, if it's still the chore's most recent occurrence, or the only newer
 *   one is what its close itself brought (a late close, and created within a minute of it; see
 *   `newerOnReopen`), which is then deleted with its to-do
 * - `todo.deleted`: skipped by the acting user, unless the to-do was already completed
 * For a change that came from Todoist (actor `todoist`, phase 4), the acting user is the assignee.
 * A close moves the chore on, as on the Chores panel: as needed goes back to the board in the same
 * transaction, and a repeating chore closed late gets its next occurrence (`generateChores`). For a
 * change from Todoist sync, that occurrence's to-do is left to `todo.retryPending`.
 * When `todo.uncompleted` is ignored, the to-do is completed again, so nobody is left with an open
 * chore to-do that they can't delete and that would never close. That completion is queued in
 * `chore_todo_actions`, so a failure is retried by `todo.retryPending` instead of failing the event.
 *
 * It also handles `user.deactivated`: that user's chores go back on the board, and their
 * queued to-do changes get one more try before the admin route unlinks their Todoist.
 *
 * An open chore to-do that its occurrence no longer points at is removed (see `linkedOccurrence`).
 *
 * Handlers run inside the to-do request. They mostly make a few local queries, but a close may also
 * generate the chore's next occurrence and, unless the change came from Todoist sync, attach its
 * to-do (one more to-do call), and undoing a close removes the to-do of the occurrence it brought. They ignore
 * `system` events (the Chores panel's own changes), and they don't trust event order: each one
 * re-reads the occurrence and the to-do and acts only if both still say the change applies.
 *
 * For a change that came from Todoist sync, a write-back (completing the to-do again, removing an
 * orphan) is only queued, not attempted: the attempt would be another Todoist call in the middle
 * of the sync, and `todo.retryPending` makes it within 5 minutes.
 */
export function listenForChoreEvents(deps: ChoresDeps & { events: EventBus }): () => void {
  const offs = [
    deps.events.on('todo.completed', (e) => onCompleted(deps, e)),
    deps.events.on('todo.uncompleted', (e) => onUncompleted(deps, e)),
    deps.events.on('todo.deleted', (e) => onDeleted(deps, e)),
    deps.events.on('user.deactivated', async (e) => {
      await releaseUser(deps, e.userId);
      await flushBeforeUnlink(deps, e);
    }),
  ];
  return () => offs.forEach((off) => off());
}

/**
 * After a deactivation releases someone's chores, every chore to-do change still queued for them
 * (removals and completions that were backing off) is tried once more, while their Todoist link
 * still works: the admin route unlinks them next. Those still waiting after that are left in their
 * Todoist (after the unlink, retries only change the dashboard's copy), so the admin is told.
 */
async function flushBeforeUnlink(deps: ChoresDeps, e: { userId: number; warnings: string[] }): Promise<void> {
  const left = await runTodoActionsFor(deps, e.userId);
  if (left === 0 || deps.todos.backendFor(e.userId).kind !== 'todoist') return;
  const name = peopleById(deps.db).get(e.userId)?.displayName ?? 'this person';
  e.warnings.push(
    left === 1
      ? `1 chore to-do couldn't be removed from ${name}'s Todoist before it was disconnected. It stays in their Todoist, and they can delete it there.`
      : `${left} chore to-dos couldn't be removed from ${name}'s Todoist before it was disconnected. They stay in their Todoist, and they can delete them there.`,
  );
}

/**
 * The occurrence this event's to-do belongs to, if it's still linked to that to-do.
 *
 * A chore to-do that its occurrence no longer points at (or whose occurrence is gone) is an
 * orphan. If it's open, its removal is queued and attempted, so nobody is left with an open chore
 * to-do that they can't delete and that nothing would ever close. A completed orphan is left as it
 * is, like any completed to-do. The exception is an open, `pending` occurrence for the same person
 * with no to-do linked yet: its retried create reuses this to-do (`findByChoreOccurrence`).
 * `gone` is true for `todo.deleted`, whose to-do needs no removal.
 */
async function linkedOccurrence(deps: ChoresDeps, e: TodoEvent, gone = false): Promise<OccurrenceRow | null> {
  if (e.actor.type === 'system' || e.item.choreOccurrenceId === null) return null;
  const occ = getOccurrenceRow(deps.db, e.item.choreOccurrenceId);
  if (occ && occ.todoId === e.item.id) return occ;
  const reusable = occ?.state === 'open' && occ.todoId === null && occ.assigneeUserId === e.item.ownerUserId;
  if (!gone && e.item.completedAt === null && !reusable) {
    await writeBack(deps, e.actor, { todoId: e.item.id, ownerUserId: e.item.ownerUserId, action: 'remove' });
  }
  return null;
}

/** Queues a to-do action, and attempts it at once unless the change came from Todoist sync. */
async function writeBack(deps: ChoresDeps, actor: Actor, a: TodoAction): Promise<void> {
  if (actor.type === 'todoist') queueTodoAction(deps.db, a, deps.clock.now());
  else await doTodoAction(deps, a);
}

/** The user who made the change: the acting user, or the assignee when it came from Todoist. */
function actingUser(actor: Actor, occ: OccurrenceRow, ownerId: number): number {
  return actor.type === 'user' ? actor.userId : (occ.assigneeUserId ?? ownerId);
}

function isLinked(occ: OccurrenceRow, state: OccurrenceRow['state']) {
  return and(eq(choreOccurrences.id, occ.id), eq(choreOccurrences.state, state), eq(choreOccurrences.todoId, occ.todoId!));
}

async function onCompleted(deps: ChoresDeps, e: TodoEvent): Promise<void> {
  const occ = await linkedOccurrence(deps, e);
  if (!occ || occ.state !== 'open') return;
  const todo = await deps.todos.get(e.item.ownerUserId, e.item.id);
  if (!todo || todo.completedAt === null) return; // reopened again since
  const now = deps.clock.now();
  const changed = deps.db.transaction((tx) => {
    const n = tx
      .update(choreOccurrences)
      .set({
        state: 'done',
        completedAt: new Date(todo.completedAt!),
        actorUserId: actingUser(e.actor, occ, e.item.ownerUserId),
        creditedUserId: occ.assigneeUserId ?? e.item.ownerUserId,
        updatedAt: now,
      })
      .where(isLinked(occ, 'open'))
      .run().changes;
    if (n > 0) returnToBoardIfAsNeeded(tx, occ, now);
    return n > 0;
  });
  if (changed) await generateChores(deps, { choreId: occ.choreId, attach: e.actor.type !== 'todoist' });
}

async function onUncompleted(deps: ChoresDeps, e: TodoEvent): Promise<void> {
  const occ = await linkedOccurrence(deps, e);
  if (!occ || occ.state !== 'done') return;
  const todo = await deps.todos.get(e.item.ownerUserId, e.item.id);
  if (!todo || todo.completedAt !== null) return; // completed again since, or deleted
  const timeZone = familyTimeZone(deps.db);
  const before = newerOnReopen(deps.db, occ, timeZone);
  const leftover = !before.blocked && before.replaces ? await findLeftoverTodo(deps, before.replaces.id) : null;
  // Read again after the await: the writes below depend on these.
  const chore = getChoreRow(deps.db, occ.choreId);
  const assignee = chore ? reopenAssignee(deps.db, chore, occ) : null;
  const newer = newerOnReopen(deps.db, occ, timeZone);
  const sameNewer = !before.blocked && !newer.blocked && newer.replaces?.id === before.replaces?.id;
  const completeAgain: TodoAction = { todoId: todo.id, ownerUserId: todo.ownerUserId, action: 'complete' };
  // The occurrence stays done (a newer one blocks it, the chore is paused or archived, or it can't go
  // back to the person whose to-do this is), so its to-do goes back to done too: queued, so a failure
  // is retried by `todo.retryPending` instead of failing the event.
  if (!chore || chore.status !== 'active' || newer.blocked || !sameNewer || assignee !== todo.ownerUserId) {
    await writeBack(deps, e.actor, completeAgain);
    return;
  }
  const removal = newer.replaces ? removalFor(newer.replaces, leftover) : null;
  const now = deps.clock.now();
  let reopened: boolean;
  try {
    reopened = deps.db.transaction((tx) => {
      const n = tx
        .update(choreOccurrences)
        .set({ state: 'open', completedAt: null, actorUserId: null, creditedUserId: null, updatedAt: now })
        .where(isLinked(occ, 'done'))
        .run().changes;
      if (n === 0) return false;
      // Undoing the close that brought the newer occurrence: it goes, with its to-do.
      if (newer.replaces) dropReplaced(tx, newer.replaces, removal, now);
      // An as-needed chore went back to the board when this was done: it's theirs again.
      if (chore.assigneeUserId === null) {
        tx.update(chores).set({ assigneeUserId: assignee, updatedAt: now }).where(and(eq(chores.id, chore.id), isNull(chores.assigneeUserId))).run();
      }
      return true;
    });
  } catch (err) {
    // The newer occurrence changed in the meantime, so this stays done.
    if (err instanceof AppError && err.code === 'conflict') {
      await writeBack(deps, e.actor, completeAgain);
      return;
    }
    throw err;
  }
  // Queued in the transaction; from Todoist sync it waits for `todo.retryPending`, like other write-backs.
  if (reopened && removal && e.actor.type !== 'todoist') await runTodoAction(deps, removal.todoId);
}

async function onDeleted(deps: ChoresDeps, e: TodoEvent): Promise<void> {
  if (e.item.completedAt !== null) return; // deleting a finished to-do doesn't undo or skip the chore
  const occ = await linkedOccurrence(deps, e, true);
  if (!occ || occ.state !== 'open') return;
  if (await deps.todos.get(e.item.ownerUserId, e.item.id)) return; // still there
  const now = deps.clock.now();
  const changed = deps.db.transaction((tx) => {
    const n = tx
      .update(choreOccurrences)
      .set({ state: 'skipped', completedAt: now, actorUserId: actingUser(e.actor, occ, e.item.ownerUserId), creditedUserId: null, updatedAt: now })
      .where(isLinked(occ, 'open'))
      .run().changes;
    if (n > 0) returnToBoardIfAsNeeded(tx, occ, now);
    return n > 0;
  });
  if (changed) await generateChores(deps, { choreId: occ.choreId, attach: e.actor.type !== 'todoist' });
}

/**
 * Catches up open occurrences whose to-do changed without the event being handled, for example
 * when the app stopped between saving a synced change and handing it to the handlers. Runs at
 * the start of every `todo.retryPending` run. Only local reads and writes.
 *
 * The same rules as the handlers, with the change taken as coming from Todoist (nobody knows who
 * made it, so the acting user is the assignee):
 * - the linked to-do is completed: done, credited to the assignee, at the to-do's completion time
 *   (like `todo.completed`; this includes a to-do completed and then deleted);
 * - the linked to-do is deleted and wasn't completed: skipped (like `todo.deleted`).
 * Each update is conditional on the occurrence still being open and linked to that to-do.
 * An as-needed chore goes back to the board; a late repeating chore's next occurrence comes with the
 * next chores.generate run.
 */
export function reconcileOccurrences(deps: ChoresDeps): { done: number; skipped: number } {
  const open = deps.db
    .select()
    .from(choreOccurrences)
    .where(and(eq(choreOccurrences.state, 'open'), isNotNull(choreOccurrences.todoId)))
    .all();
  const counts = { done: 0, skipped: 0 };
  for (const occ of open) {
    const fate = deps.todos.todoFate(occ.todoId!);
    if (!fate || (fate.completedAt === null && !fate.deleted)) continue;
    const now = deps.clock.now();
    const assignee = occ.assigneeUserId ?? fate.ownerUserId;
    const changed = deps.db.transaction((tx) => {
      const n = tx
        .update(choreOccurrences)
        .set(
          fate.completedAt !== null
            ? { state: 'done', completedAt: fate.completedAt, actorUserId: assignee, creditedUserId: assignee, updatedAt: now }
            : { state: 'skipped', completedAt: now, actorUserId: assignee, creditedUserId: null, updatedAt: now },
        )
        .where(isLinked(occ, 'open'))
        .run().changes;
      if (n > 0) returnToBoardIfAsNeeded(tx, occ, now);
      return n;
    });
    if (changed > 0) counts[fate.completedAt !== null ? 'done' : 'skipped']++;
  }
  if (counts.done + counts.skipped > 0) deps.logger.warn(counts, 'caught up chore occurrences whose to-do change was missed');
  return counts;
}
