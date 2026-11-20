import { and, eq, isNull } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { connections, todos } from '../db/schema.js';

/**
 * Todoist was turned off (TODOIST_CLIENT_ID and the rest removed, or a rollback to a build without
 * it) after people had linked. Their to-dos live in the mirror (`backend = 'todoist'`), which only
 * the Todoist backend reads, so their lists look empty. Nothing is lost, and configuring Todoist
 * again brings them back, so the app keeps running: this is the System page's warning, and the
 * startup log line. Null when nobody has a saved link or live Todoist to-dos.
 */
export function todoistUnconfiguredWarning(db: Db): string | null {
  const people = new Set<number>();
  for (const { id } of db.select({ id: connections.ownerUserId }).from(connections).where(eq(connections.kind, 'todoist')).all()) people.add(id);
  for (const { id } of db.selectDistinct({ id: todos.ownerUserId }).from(todos).where(and(eq(todos.backend, 'todoist'), isNull(todos.deletedAt))).all()) people.add(id);
  const n = people.size;
  if (n === 0) return null;
  return `${n === 1 ? '1 person is' : `${n} people are`} linked to Todoist but Todoist isn't configured. ` +
    "Their Todoist to-dos are hidden until it's configured again. Nothing was deleted.";
}
