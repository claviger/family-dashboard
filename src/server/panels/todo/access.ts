import { and, asc, eq } from 'drizzle-orm';
import type { SessionUser } from '../../../shared/api.js';
import type { TodoOwner, TodoPerson } from '../../../shared/todo.js';
import { getGrants, getUser } from '../../admin/users.js';
import { AppError } from '../../core/errors.js';
import type { Db } from '../../db/index.js';
import { panelGrants, users } from '../../db/schema.js';

/** Active users with the To-do panel, by name. This is the admin person picker (spec §10.2). */
export function listTodoPeople(db: Db): TodoPerson[] {
  return db
    .select({ id: users.id, displayName: users.displayName, color: users.color })
    .from(users)
    .innerJoin(panelGrants, and(eq(panelGrants.userId, users.id), eq(panelGrants.panelId, 'todo')))
    .where(eq(users.active, true))
    .orderBy(asc(users.displayName), asc(users.id))
    .all();
}

/**
 * Whose list a request acts on (spec §10.2). No `requestedId`, or the actor's own id, means the
 * actor's list. Members get 403 for anyone else. Admins get 404 when the target doesn't exist,
 * is deactivated, or doesn't have the To-do panel: from the admin's side that person has no list.
 */
export function resolveOwner(db: Db, actor: SessionUser, requestedId: number | undefined): TodoOwner {
  if (requestedId === undefined || requestedId === actor.id) return { id: actor.id, displayName: actor.displayName };
  if (actor.role !== 'admin') throw new AppError('forbidden', 'You can only see your own to-do list.');
  const target = getUser(db, requestedId);
  if (!target || !target.active || !getGrants(db, target.id).includes('todo')) {
    throw new AppError('not_found', "That person doesn't have a to-do list.");
  }
  return { id: target.id, displayName: target.displayName };
}
