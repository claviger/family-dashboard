import { and, desc, eq, isNotNull, max, type SQL } from 'drizzle-orm';
import { isRepeating, type AssignmentSource } from '../../../shared/chores.js';
import { localDate } from '../../core/clock.js';
import { choreOccurrences, chores, type ChoreRow, type OccurrenceRow } from '../../db/schema.js';
import { dueDateToGenerate, type ChoreTimeline } from './schedule.js';
import { familyTimeZone, isActiveUser, type ChoresDeps, type DbOrTx } from './store.js';
import { attachTodo, pendingTodoFields } from './todoLink.js';

/**
 * The `chores.generate` job (spec §3.5, chore board spec "Next due date"). Only assigned chores have
 * occurrences. For each active, assigned chore with nothing open:
 * - repeating: once today has reached F, creates the occurrence due on the next due date
 *   (`dueDateToGenerate`)
 * - as needed: creates its occurrence, with no due date (after a paused chore is resumed, say)
 * Each new occurrence gets a to-do. Safe to repeat: the open-occurrence check and the insert are one
 * transaction (as-needed rows have no due date for the unique key to catch), and each run creates
 * at most one occurrence per chore.
 *
 * `choreId` limits the run to one chore, e.g. right after it's created, resumed, or closed.
 * `attach: false` leaves the new occurrences' to-dos to `todo.retryPending` (they're saved
 * `pending`), for a change that came from Todoist sync. Returns the ids it created.
 */
export async function generateChores(deps: ChoresDeps, opts: { choreId?: number; attach?: boolean } = {}): Promise<number[]> {
  const timeZone = familyTimeZone(deps.db);
  const now = deps.clock.now();
  const today = localDate(now, timeZone);
  const conditions: SQL[] = [eq(chores.status, 'active'), isNotNull(chores.assigneeUserId)];
  if (opts.choreId !== undefined) conditions.push(eq(chores.id, opts.choreId));
  const ids = deps.db.select({ id: chores.id }).from(chores).where(and(...conditions)).all();
  const created: number[] = [];
  for (const { id: choreId } of ids) {
    const id = deps.db.transaction((tx) => {
      // Read again inside the transaction: an earlier chore's to-do call was awaited since the list was read.
      const chore = tx.select().from(chores).where(eq(chores.id, choreId)).get();
      if (!chore || chore.status !== 'active' || chore.assigneeUserId === null) return null;
      // Deactivating someone unassigns their chores (releaseUser); this covers the moment in between.
      if (!isActiveUser(tx, chore.assigneeUserId)) return null;
      const { open, timeline } = choreState(tx, chore.id, today, timeZone);
      if (open) return null;
      let dueDate: string | null = null;
      if (isRepeating(chore.schedule)) {
        dueDate = dueDateToGenerate(chore.schedule, chore.startDate, timeline);
        if (dueDate === null) return null;
      }
      return insertOpenOccurrence(tx, chore, dueDate, sourceFor(tx, chore), now);
    });
    if (id === null) continue;
    created.push(id);
    if (opts.attach !== false) await attachTodo(deps, id);
  }
  return created;
}

/**
 * A chore's open occurrence (an assigned chore has at most one; the newest if something went
 * wrong), and the dates the schedule math needs. The latest close instant has the latest local
 * date, since local dates only move forward.
 */
export function choreState(
  db: DbOrTx,
  choreId: number,
  today: string,
  timeZone: string,
): { open: OccurrenceRow | undefined; timeline: ChoreTimeline } {
  const ofChore = eq(choreOccurrences.choreId, choreId);
  const stats = db
    .select({ latestDueDate: max(choreOccurrences.dueDate), lastClosedAt: max(choreOccurrences.completedAt) })
    .from(choreOccurrences)
    .where(ofChore)
    .get()!;
  const open = db
    .select()
    .from(choreOccurrences)
    .where(and(ofChore, eq(choreOccurrences.state, 'open')))
    .orderBy(desc(choreOccurrences.id))
    .get();
  return {
    open,
    timeline: { today, latestDueDate: stats.latestDueDate, lastClosedDate: stats.lastClosedAt ? localDate(stats.lastClosedAt, timeZone) : null },
  };
}

/**
 * How the job marks a new occurrence (Decision 5): like the chore's latest occurrence when that one
 * was the same person's, since it carries how they got the chore; otherwise `admin`. `default` is
 * never copied: it stays only on history from before the chore board (chore board spec, "Data changes").
 */
function sourceFor(db: DbOrTx, chore: ChoreRow): AssignmentSource {
  const last = db
    .select({ assignee: choreOccurrences.assigneeUserId, source: choreOccurrences.assignmentSource })
    .from(choreOccurrences)
    .where(eq(choreOccurrences.choreId, chore.id))
    .orderBy(desc(choreOccurrences.id))
    .get();
  return last && last.assignee === chore.assigneeUserId && last.source !== 'default' ? last.source : 'admin';
}

/**
 * Inserts the chore's open occurrence for its assignee, due on `dueDate` (null for as needed), saved
 * `pending` until `attachTodo` links its to-do, so a crash in between is retried. Call it in a
 * transaction that has checked there's no open occurrence. Null if the unique key refused it.
 */
export function insertOpenOccurrence(db: DbOrTx, chore: ChoreRow, dueDate: string | null, source: AssignmentSource, now: Date): number | null {
  const assignee = chore.assigneeUserId!;
  const row = db
    .insert(choreOccurrences)
    .values({
      choreId: chore.id,
      titleSnapshot: chore.title,
      dueDate,
      assigneeUserId: assignee,
      assignmentSource: source,
      state: 'open',
      ...pendingTodoFields(db, assignee, now),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: choreOccurrences.id })
    .get();
  return row?.id ?? null;
}
