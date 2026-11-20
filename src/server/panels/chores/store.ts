import { and, eq } from 'drizzle-orm';
import type { Logger } from 'pino';
import type { ChorePerson, Occurrence } from '../../../shared/chores.js';
import { localDate, type Clock } from '../../core/clock.js';
import { AppError } from '../../core/errors.js';
import type { Db } from '../../db/index.js';
import { choreOccurrences, chores, panelGrants, users, type ChoreRow, type OccurrenceRow } from '../../db/schema.js';
import { getFamilySettings } from '../../settings.js';
import type { TodoService } from '../todo/service.js';

/** What the Chores panel needs. AppDeps has all of it. */
export interface ChoresDeps {
  db: Db;
  clock: Clock;
  /** The one TodoService: chores never touch the todos table directly (spec §3.3). */
  todos: TodoService;
  logger: Logger;
}

/** A database handle or a transaction on it. */
export type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export function familyTimeZone(db: Db): string {
  return getFamilySettings(db).timeZone;
}

/** Today's date in the family time zone. */
export function familyToday(deps: Pick<ChoresDeps, 'db' | 'clock'>): string {
  return localDate(deps.clock.now(), familyTimeZone(deps.db));
}

export function getChoreRow(db: Db, id: number): ChoreRow | undefined {
  return db.select().from(chores).where(eq(chores.id, id)).get();
}

export function getOccurrenceRow(db: Db, id: number): OccurrenceRow | undefined {
  return db.select().from(choreOccurrences).where(eq(choreOccurrences.id, id)).get();
}

export function requireOccurrence(db: Db, id: number): OccurrenceRow {
  const row = getOccurrenceRow(db, id);
  if (!row) throw new AppError('not_found', 'Chore not found.');
  return row;
}

/** Every user, including deactivated ones, since history still shows their names (spec §2). */
export function peopleById(db: Db): Map<number, ChorePerson> {
  const rows = db.select({ id: users.id, displayName: users.displayName, color: users.color }).from(users).all();
  return new Map(rows.map((r) => [r.id, r]));
}

export function personOf(people: Map<number, ChorePerson>, id: number | null): ChorePerson | null {
  return id === null ? null : (people.get(id) ?? null);
}

export function toOccurrence(row: OccurrenceRow, people: Map<number, ChorePerson>): Occurrence {
  return {
    id: row.id,
    choreId: row.choreId,
    title: row.titleSnapshot,
    dueDate: row.dueDate,
    assignee: personOf(people, row.assigneeUserId),
    assignmentSource: row.assignmentSource,
    state: row.state,
    closedAt: row.completedAt ? row.completedAt.toISOString() : null,
    closedBy: personOf(people, row.actorUserId),
    credited: personOf(people, row.creditedUserId),
    todoSyncStatus: row.todoSyncStatus,
  };
}

export function isActiveUser(db: DbOrTx, userId: number): boolean {
  return db.select({ id: users.id }).from(users).where(and(eq(users.id, userId), eq(users.active, true))).get() !== undefined;
}

/** Chores create a to-do only for an active assignee with the To-do panel (spec §6, §11.5). */
export function getsTodo(db: DbOrTx, userId: number): boolean {
  return (
    db
      .select({ id: users.id })
      .from(users)
      .innerJoin(panelGrants, and(eq(panelGrants.userId, users.id), eq(panelGrants.panelId, 'todo')))
      .where(and(eq(users.id, userId), eq(users.active, true)))
      .get() !== undefined
  );
}
