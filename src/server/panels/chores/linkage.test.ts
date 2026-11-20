import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Actor } from '../../core/events.js';
import { choreOccurrences, choreTodoActions, chores } from '../../db/schema.js';
import { addUser, makeTestApp, useFlakyTodos, type TestApp } from '../../test/helpers.js';
import { completeOccurrence } from './actions.js';
import { createChore, setChoreStatus } from './definitions.js';
import { generateChores } from './generator.js';
import { getOccurrenceRow } from './store.js';
import { retryPendingTodos } from './todoLink.js';

let t: TestApp;
let kidId: number;
let adminId: number;
let kid: Actor;
let admin: Actor;
let occId: number;
let todoId: number;

beforeEach(async () => {
  t = makeTestApp(); // subscribes the Chores panel's handlers
  adminId = addUser(t.db, t.clock, { email: 'admin@example.com', displayName: 'Admin', role: 'admin', panels: ['todo', 'chores'] });
  kidId = addUser(t.db, t.clock, { email: 'kid@example.com', displayName: 'Kid', panels: ['todo', 'chores'] });
  kid = { type: 'user', userId: kidId, role: 'member' };
  admin = { type: 'user', userId: adminId, role: 'admin' };
  const chore = await createChore(t, {
    title: 'Feed the cat', notes: null, assigneeUserId: kidId, schedule: { kind: 'daily' }, startDate: '2026-11-15',
  });
  const occ = t.db.select().from(choreOccurrences).where(eq(choreOccurrences.choreId, chore.id)).get()!;
  occId = occ.id;
  todoId = occ.todoId!;
});

function kid0() {
  return { id: kidId, role: 'member' as const };
}

function occ() {
  return getOccurrenceRow(t.db, occId)!;
}

describe('to-do events → occurrences', () => {
  it('completing the to-do completes the occurrence, credited to the assignee', async () => {
    t.clock.advance(60_000);
    await t.todos.complete(kid, kidId, todoId);
    expect(occ()).toMatchObject({ state: 'done', creditedUserId: kidId, actorUserId: kidId, completedAt: new Date('2026-11-15T12:01:00Z') });
  });

  it('records the admin as the one who checked it off', async () => {
    await t.todos.complete(admin, kidId, todoId);
    expect(occ()).toMatchObject({ state: 'done', creditedUserId: kidId, actorUserId: adminId });
  });

  it('treats a Todoist change as made by the assignee', async () => {
    // Phase 4's sync saves the change to the mirror first, then reports it.
    const before = (await t.todos.get(kidId, todoId))!;
    const after = await t.todos.backendFor(kidId).complete(kidId, todoId, new Date('2026-11-15T12:30:00Z'));
    await t.todos.applyRemoteChange(before, after, { type: 'todoist' });
    expect(occ()).toMatchObject({ state: 'done', creditedUserId: kidId, actorUserId: kidId, completedAt: new Date('2026-11-15T12:30:00Z') });
  });

  it('ignores system events', async () => {
    await t.todos.complete({ type: 'system' }, kidId, todoId);
    expect(occ().state).toBe('open');
  });

  it('reopening the to-do reopens the occurrence while it is the most recent', async () => {
    await t.todos.complete(kid, kidId, todoId);
    await t.todos.uncomplete(kid, kidId, todoId);
    expect(occ()).toMatchObject({ state: 'open', completedAt: null, creditedUserId: null, actorUserId: null });

    await t.todos.complete(kid, kidId, todoId);
    t.clock.set(new Date('2026-11-16T12:00:00Z'));
    await completeOccurrence(t, kid0(), (await generateChores(t))[0]!); // a newer, closed occurrence exists now
    await t.todos.uncomplete(kid, kidId, todoId);
    expect(occ().state).toBe('done');
  });

  it('completes the to-do again when reopening it is ignored, so it never lingers open', async () => {
    await t.todos.complete(kid, kidId, todoId);
    t.clock.set(new Date('2026-11-16T12:00:00Z'));
    await completeOccurrence(t, kid0(), (await generateChores(t))[0]!); // a newer, closed occurrence exists now
    await t.todos.uncomplete(kid, kidId, todoId);
    expect(occ().state).toBe('done');
    expect((await t.todos.get(kidId, todoId))?.completedAt).not.toBeNull();

    // The same when the chore is paused.
    const other = await createChore(t, {
      title: 'Dishes', notes: null, assigneeUserId: kidId, schedule: { kind: 'daily' }, startDate: '2026-11-16',
    });
    const dishes = t.db.select().from(choreOccurrences).where(eq(choreOccurrences.choreId, other.id)).get()!;
    await t.todos.complete(kid, kidId, dishes.todoId!);
    await setChoreStatus(t, other.id, 'paused');
    await t.todos.uncomplete(kid, kidId, dishes.todoId!);
    expect(getOccurrenceRow(t.db, dishes.id)?.state).toBe('done');
    expect((await t.todos.get(kidId, dishes.todoId!))?.completedAt).not.toBeNull();
    expect(t.eventErrors).toEqual([]);
  });

  it('queues completing the to-do again when that fails, instead of failing the event', async () => {
    await t.todos.complete(kid, kidId, todoId);
    t.clock.set(new Date('2026-11-16T12:00:00Z'));
    await completeOccurrence(t, kid0(), (await generateChores(t))[0]!); // a newer, closed occurrence exists now
    const flaky = useFlakyTodos(t, new Set(['complete']));
    await t.todos.uncomplete(kid, kidId, todoId);
    expect(t.eventErrors).toEqual([]);
    expect(occ().state).toBe('done');
    expect(t.db.select().from(choreTodoActions).all()).toMatchObject([
      { todoId, ownerUserId: kidId, action: 'complete', attempts: 1, retryAt: new Date('2026-11-16T12:05:00Z') },
    ]);

    flaky.failing = false;
    t.clock.advance(5 * 60_000);
    expect(await retryPendingTodos(t)).toMatchObject({ actionsAttempted: 1, actionsPending: 0 });
    expect((await t.todos.get(kidId, todoId))?.completedAt).not.toBeNull();
    expect(occ().state).toBe('done');
  });

  it("puts a deactivated user's chores back on the board", async () => {
    await t.events.emit('user.deactivated', { userId: kidId, warnings: [] });
    expect(getOccurrenceRow(t.db, occId)).toBeUndefined();
    expect(t.db.select().from(chores).get()?.assigneeUserId).toBeNull();
    expect(await t.todos.get(kidId, todoId)).toBeNull();
  });

  it('deleting the to-do skips the occurrence, by the acting user', async () => {
    await t.todos.delete(admin, kidId, todoId);
    expect(occ()).toMatchObject({ state: 'skipped', actorUserId: adminId, creditedUserId: null });
  });

  it('deleting a to-do that was already completed leaves the occurrence done', async () => {
    await t.todos.complete(kid, kidId, todoId);
    await t.todos.delete(admin, kidId, todoId);
    expect(occ()).toMatchObject({ state: 'done', creditedUserId: kidId });
  });

  it('completing on the Chores panel completes the to-do without a second change', async () => {
    await completeOccurrence(t, { id: kidId, role: 'member' }, occId);
    expect((await t.todos.get(kidId, todoId))?.completedAt).not.toBeNull();
    expect(occ()).toMatchObject({ state: 'done', actorUserId: kidId });
  });

  it("acts on current state, not on a stale event's payload", async () => {
    const open = (await t.todos.get(kidId, todoId))!;
    // A completed event that arrives after the to-do was reopened again changes nothing.
    await t.events.emit('todo.completed', { item: { ...open, completedAt: '2026-11-15T12:00:00.000Z' }, actor: kid });
    expect(occ().state).toBe('open');
    // A deleted event for a to-do that still exists changes nothing.
    await t.events.emit('todo.deleted', { item: open, actor: admin });
    expect(occ().state).toBe('open');
  });

  it('ignores completing a to-do the occurrence no longer points at', async () => {
    t.db.update(choreOccurrences).set({ todoId: null }).where(eq(choreOccurrences.id, occId)).run();
    await t.todos.complete(kid, kidId, todoId);
    expect(occ().state).toBe('open');
    expect((await t.todos.get(kidId, todoId))?.completedAt).not.toBeNull(); // left as it is
    expect(t.db.select().from(choreTodoActions).all()).toEqual([]);
  });

  it('removes a reopened to-do the occurrence no longer points at, retrying if that fails', async () => {
    await t.todos.complete(kid, kidId, todoId);
    t.db.update(choreOccurrences).set({ todoId: null }).where(eq(choreOccurrences.id, occId)).run();
    const flaky = useFlakyTodos(t, new Set(['remove']));
    await t.todos.uncomplete(kid, kidId, todoId);
    expect(t.eventErrors).toEqual([]);
    expect(occ().state).toBe('done');
    expect(t.db.select().from(choreTodoActions).all()).toMatchObject([{ todoId, ownerUserId: kidId, action: 'remove', attempts: 1 }]);

    flaky.failing = false;
    t.clock.advance(5 * 60_000);
    expect(await retryPendingTodos(t)).toMatchObject({ actionsAttempted: 1, actionsPending: 0 });
    expect(await t.todos.get(kidId, todoId)).toBeNull();
    expect(occ().state).toBe('done');
  });

  it("removes a reopened to-do whose occurrence is gone", async () => {
    await t.todos.complete(kid, kidId, todoId);
    // As if its occurrence had been deleted, e.g. with the chore paused before this to-do was found.
    t.sqlite.prepare('update todos set chore_occurrence_id = 9999 where id = ?').run(todoId);
    await t.todos.uncomplete(kid, kidId, todoId);
    expect(t.eventErrors).toEqual([]);
    expect(await t.todos.get(kidId, todoId)).toBeNull();
  });

  it('keeps an open to-do that a pending create for the same person will reuse', async () => {
    await t.todos.complete(kid, kidId, todoId);
    // An admin's reopen whose to-do call failed: open, pending, and not yet linked.
    t.db
      .update(choreOccurrences)
      .set({ state: 'open', completedAt: null, todoId: null, todoSyncStatus: 'pending' })
      .where(eq(choreOccurrences.id, occId))
      .run();
    await t.todos.uncomplete(kid, kidId, todoId);
    expect(await t.todos.get(kidId, todoId)).not.toBeNull();
    expect(t.db.select().from(choreTodoActions).all()).toEqual([]);
  });

  it('records no handler errors along the way', async () => {
    await t.todos.complete(kid, kidId, todoId);
    await t.todos.uncomplete(kid, kidId, todoId);
    await t.todos.delete(admin, kidId, todoId);
    expect(t.eventErrors).toEqual([]);
  });
});
