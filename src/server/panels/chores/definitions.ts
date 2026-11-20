import { and, asc, eq, sql } from 'drizzle-orm';
import {
  isRepeating, scheduleType, TODO_REMOVAL_WARNING, type AssignmentSource, type Chore, type ChoreInput, type ChorePerson, type ChoreResponse,
  type ChoreStatus, type NewChoreInput,
} from '../../../shared/chores.js';
import { localDate } from '../../core/clock.js';
import { AppError } from '../../core/errors.js';
import type { Db } from '../../db/index.js';
import { choreOccurrences, chores, type ChoreRow } from '../../db/schema.js';
import type { ChoreUser } from './actions.js';
import { generateChores, insertOpenOccurrence } from './generator.js';
import { dueOnAssignment } from './schedule.js';
import { familyTimeZone, getChoreRow, getOccurrenceRow, isActiveUser, peopleById, personOf, type ChoresDeps } from './store.js';
import { attachTodo, findLeftoverTodo, queueTodoAction, removalFor, runTodoAction } from './todoLink.js';

/** Chore definitions (spec §11.1, chore board spec). Anyone adds; only admins edit, pause, resume, and archive (the routes check the role). */

export function toChore(row: ChoreRow, people: Map<number, ChorePerson>): Chore {
  return {
    id: row.id,
    title: row.title,
    notes: row.notes,
    assignee: personOf(people, row.assigneeUserId),
    schedule: row.schedule,
    startDate: row.startDate,
    status: row.status,
  };
}

/** Active chores first, then paused, then archived; each by title. */
export function listChores(db: Db): Chore[] {
  const people = peopleById(db);
  return db
    .select()
    .from(chores)
    .orderBy(
      sql`case ${chores.status} when 'active' then 0 when 'paused' then 1 else 2 end`,
      asc(sql`lower(${chores.title})`),
      asc(chores.id),
    )
    .all()
    .map((row) => toChore(row, people));
}

export function requireChore(db: Db, id: number): ChoreRow {
  const row = getChoreRow(db, id);
  if (!row) throw new AppError('not_found', 'Chore not found.');
  return row;
}

function checkAssignee(db: Db, userId: number | null): void {
  if (userId !== null && !isActiveUser(db, userId)) throw new AppError('validation', 'Pick an active person, or Unassigned.');
}

function values(input: ChoreInput) {
  return {
    title: input.title,
    notes: input.notes && input.notes.trim() !== '' ? input.notes : null,
    scheduleType: scheduleType(input.schedule),
    schedule: input.schedule,
    startDate: input.startDate,
  };
}

/**
 * Creates a chore (chore board spec, "Who can do what"). A member may take it themselves or leave it
 * unassigned; an admin may give it to any active person. Added already assigned, it gets its
 * occurrence right away, in the same transaction, due on its next due date (none for as needed),
 * and then its to-do. `addedBy` is null for callers that aren't a person (tests, seeding).
 */
export async function createChore(deps: ChoresDeps, input: NewChoreInput, addedBy: ChoreUser | null = null): Promise<Chore> {
  if (addedBy && addedBy.role !== 'admin' && input.assigneeUserId !== null && input.assigneeUserId !== addedBy.id) {
    throw new AppError('forbidden', 'You can add a chore for yourself or leave it unassigned.');
  }
  checkAssignee(deps.db, input.assigneeUserId);
  const now = deps.clock.now();
  const today = localDate(now, familyTimeZone(deps.db));
  const source: AssignmentSource = addedBy !== null && input.assigneeUserId === addedBy.id ? 'claimed' : 'admin';
  const { row, occurrenceId } = deps.db.transaction((tx) => {
    const row = tx
      .insert(chores)
      .values({ ...values(input), assigneeUserId: input.assigneeUserId, status: 'active', createdAt: now, updatedAt: now })
      .returning()
      .get();
    if (row.assigneeUserId === null) return { row, occurrenceId: null };
    const dueDate = isRepeating(row.schedule)
      ? dueOnAssignment(row.schedule, row.startDate, { today, latestDueDate: null, lastClosedDate: null })
      : null;
    return { row, occurrenceId: insertOpenOccurrence(tx, row, dueDate, source, now) };
  });
  if (occurrenceId !== null) await attachTodo(deps, occurrenceId);
  return toChore(row, peopleById(deps.db));
}

/**
 * Replaces a chore's title, notes, schedule, and start date (admins). Who has it doesn't change here
 * (Decision 6). An open occurrence keeps its title and due date; the changes apply to occurrences
 * created from now on, and generation runs at once in case the new schedule has one due.
 */
export async function updateChore(deps: ChoresDeps, id: number, input: ChoreInput): Promise<Chore> {
  const current = requireChore(deps.db, id);
  if (current.status === 'archived') throw new AppError('conflict', "Archived chores can't be changed.");
  const row = deps.db
    .update(chores)
    .set({ ...values(input), updatedAt: deps.clock.now() })
    .where(eq(chores.id, id))
    .returning()
    .get();
  if (row.status === 'active') await generateChores(deps, { choreId: id });
  return toChore(row, peopleById(deps.db));
}

/**
 * Pause, resume, or archive (spec §11.3). Pausing and archiving remove the chore's open
 * occurrences and their unfinished to-dos; resuming generates right away. Archiving is final.
 * `warning` is set when a to-do couldn't be removed yet (it's queued for `todo.retryPending`).
 * Pausing keeps who has the chore, so resuming puts it back on their list; archiving clears it.
 */
export async function setChoreStatus(deps: ChoresDeps, id: number, status: ChoreStatus): Promise<ChoreResponse> {
  const current = requireChore(deps.db, id);
  if (current.status === 'archived') throw new AppError('conflict', "Archived chores can't be changed.");
  const row =
    current.status === status
      ? current
      : deps.db
          .update(chores)
          .set({ status, ...(status === 'archived' ? { assigneeUserId: null } : {}), updatedAt: deps.clock.now() })
          .where(eq(chores.id, id))
          .returning()
          .get();
  const chore = toChore(row, peopleById(deps.db));
  if (status === 'active') {
    await generateChores(deps, { choreId: id });
    return chore;
  }
  return (await removeOpenOccurrences(deps, id)) ? chore : { ...chore, warning: TODO_REMOVAL_WARNING };
}

/**
 * Open occurrences aren't history, so they're deleted. Each one's to-do removal is queued in the
 * same transaction as the delete, then attempted. False if a removal failed and stays queued.
 */
async function removeOpenOccurrences(deps: ChoresDeps, choreId: number): Promise<boolean> {
  const open = deps.db
    .select({ id: choreOccurrences.id })
    .from(choreOccurrences)
    .where(and(eq(choreOccurrences.choreId, choreId), eq(choreOccurrences.state, 'open')))
    .all();
  let allRemoved = true;
  for (const { id } of open) {
    const leftover = await findLeftoverTodo(deps, id);
    // Read again after every await, so a to-do linked in the meantime is removed too.
    const occ = getOccurrenceRow(deps.db, id);
    if (!occ || occ.state !== 'open') continue;
    const removal = removalFor(occ, leftover);
    const deleted = deps.db.transaction((tx) => {
      const row = tx
        .delete(choreOccurrences)
        .where(and(eq(choreOccurrences.id, occ.id), eq(choreOccurrences.state, 'open')))
        .returning({ id: choreOccurrences.id })
        .get();
      if (row && removal) queueTodoAction(tx, removal, deps.clock.now());
      return row !== undefined;
    });
    if (deleted && removal && !(await runTodoAction(deps, removal.todoId))) allRemoved = false;
  }
  return allRemoved;
}
