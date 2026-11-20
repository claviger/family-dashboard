import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { HistoryQuerySchema, type ChoreSchedule } from '../../../shared/chores.js';
import { updateUser } from '../../admin/users.js';
import type { Actor } from '../../core/events.js';
import { AppError } from '../../core/errors.js';
import { choreOccurrences } from '../../db/schema.js';
import { addUser, makeTestApp, type TestApp } from '../../test/helpers.js';
import { completeOccurrence, reopenOccurrence, skipOccurrence, type ChoreUser } from './actions.js';
import { claimChore } from './assignment.js';
import { createChore } from './definitions.js';
import { generateChores } from './generator.js';
import { reconcileOccurrences } from './linkage.js';
import { getChoreRow, getOccurrenceRow } from './store.js';
import { retryPendingTodos } from './todoLink.js';
import { boardRowFor, history } from './views.js';

let t: TestApp;
let admin: ChoreUser;
let kid: ChoreUser;
let sib: ChoreUser;
let kidActor: Actor;

beforeEach(() => {
  t = makeTestApp(); // 2026-11-15T12:00:00Z, a Sunday, family time zone UTC
  admin = { id: addUser(t.db, t.clock, { email: 'admin@example.com', displayName: 'Admin', role: 'admin', panels: ['todo', 'chores'] }), role: 'admin' };
  kid = { id: addUser(t.db, t.clock, { email: 'kid@example.com', displayName: 'Kid', panels: ['todo', 'chores'] }), role: 'member' };
  sib = { id: addUser(t.db, t.clock, { email: 'sib@example.com', displayName: 'Sib', panels: ['todo', 'chores'] }), role: 'member' };
  kidActor = { type: 'user', userId: kid.id, role: 'member' };
});

/** A chore of the kid's, with its open occurrence. */
async function kidsChore(schedule: ChoreSchedule, title = 'Feed the cat') {
  const chore = await createChore(t, { title, notes: null, assigneeUserId: kid.id, schedule, startDate: '2026-11-01' });
  return { choreId: chore.id, occId: openOf(chore.id)[0]!.id };
}

function openOf(choreId: number) {
  return t.db.select().from(choreOccurrences).where(and(eq(choreOccurrences.choreId, choreId), eq(choreOccurrences.state, 'open'))).all();
}

const MONDAYS: ChoreSchedule = { kind: 'weekly', interval: 1, weekdays: [1] };
const FRIDAYS: ChoreSchedule = { kind: 'weekly', interval: 1, weekdays: [5] };

describe('repeating chores', () => {
  it('done early: nothing new until the due date has passed', async () => {
    const { choreId, occId } = await kidsChore(FRIDAYS); // due Fri 11-20
    await completeOccurrence(t, kid, occId);
    expect(openOf(choreId)).toEqual([]);
    expect(boardRowFor(t, choreId)).toMatchObject({ state: 'waiting', date: '2026-11-27' });
    t.clock.set(new Date('2026-11-20T23:45:00Z'));
    expect(await generateChores(t)).toEqual([]);
    t.clock.set(new Date('2026-11-21T00:00:00Z'));
    expect(await generateChores(t)).toHaveLength(1);
    expect(openOf(choreId)).toMatchObject([{ dueDate: '2026-11-27', assigneeUserId: kid.id }]);
  });

  it('done late: the next one comes right away, due on the next date from today, with its to-do', async () => {
    t.clock.set(new Date('2026-11-16T12:00:00Z'));
    const { choreId, occId } = await kidsChore(MONDAYS); // due Mon 11-16
    t.clock.set(new Date('2026-11-18T12:00:00Z'));
    await completeOccurrence(t, kid, occId);
    const [next] = openOf(choreId);
    expect(next).toMatchObject({ dueDate: '2026-11-23', assigneeUserId: kid.id, todoSyncStatus: 'ok' });
    expect((await t.todos.get(kid.id, next!.todoId!))?.dueDate).toBe('2026-11-23');
  });

  it('a late skip moves it on like a completion', async () => {
    t.clock.set(new Date('2026-11-16T12:00:00Z'));
    const { choreId, occId } = await kidsChore(MONDAYS);
    t.clock.set(new Date('2026-11-17T12:00:00Z'));
    await skipOccurrence(t, admin, occId);
    expect(openOf(choreId)).toMatchObject([{ dueDate: '2026-11-23' }]);
  });

  it('completing the to-do late brings the next one too, from the To-do panel', async () => {
    t.clock.set(new Date('2026-11-16T12:00:00Z'));
    const { choreId, occId } = await kidsChore(MONDAYS);
    t.clock.set(new Date('2026-11-18T12:00:00Z'));
    await t.todos.complete(kidActor, kid.id, getOccurrenceRow(t.db, occId)!.todoId!);
    expect(openOf(choreId)).toMatchObject([{ dueDate: '2026-11-23', todoSyncStatus: 'ok' }]);
    expect(t.eventErrors).toEqual([]);
  });

  it('from Todoist sync, the next one is created at once and its to-do waits for todo.retryPending', async () => {
    t.clock.set(new Date('2026-11-16T12:00:00Z'));
    const { choreId, occId } = await kidsChore(MONDAYS);
    t.clock.set(new Date('2026-11-18T12:00:00Z'));
    const todoId = getOccurrenceRow(t.db, occId)!.todoId!;
    const before = (await t.todos.get(kid.id, todoId))!;
    const after = await t.todos.backendFor(kid.id).complete(kid.id, todoId, t.clock.now());
    await t.todos.applyRemoteChange(before, after, { type: 'todoist' });
    expect(openOf(choreId)).toMatchObject([{ dueDate: '2026-11-23', todoSyncStatus: 'pending', todoId: null }]);
    t.clock.advance(5 * 60_000);
    await retryPendingTodos(t);
    expect(openOf(choreId)).toMatchObject([{ todoSyncStatus: 'ok' }]);
  });
});

describe('as-needed chores', () => {
  it('completing one puts it back on the board, unassigned, and creates nothing new', async () => {
    const { choreId, occId } = await kidsChore({ kind: 'none' }, 'Clean the gutters');
    t.clock.set(new Date('2026-11-25T12:00:00Z'));
    await completeOccurrence(t, kid, occId);
    expect(getChoreRow(t.db, choreId)?.assigneeUserId).toBeNull();
    expect(boardRowFor(t, choreId)).toMatchObject({ state: 'unassigned', assignee: null });
    expect(await generateChores(t)).toEqual([]);
    // Ten days after it was claimed, and still never late.
    const entry = history(t, HistoryQuerySchema.parse({})).entries.find((e) => e.id === occId);
    expect(entry).toMatchObject({ state: 'done', dueDate: null, late: false, credited: { id: kid.id } });
  });

  it('deleting its to-do (a skip) puts it back on the board too', async () => {
    const { choreId, occId } = await kidsChore({ kind: 'none' });
    await t.todos.delete({ type: 'user', userId: admin.id, role: 'admin' }, kid.id, getOccurrenceRow(t.db, occId)!.todoId!);
    expect(getOccurrenceRow(t.db, occId)?.state).toBe('skipped');
    expect(getChoreRow(t.db, choreId)?.assigneeUserId).toBeNull();
  });

  it('a missed to-do completion, caught up by reconcile, puts it back on the board', async () => {
    const { choreId, occId } = await kidsChore({ kind: 'none' });
    await t.todos.backendFor(kid.id).complete(kid.id, getOccurrenceRow(t.db, occId)!.todoId!, t.clock.now());
    expect(reconcileOccurrences(t)).toEqual({ done: 1, skipped: 0 });
    expect(getChoreRow(t.db, choreId)?.assigneeUserId).toBeNull();
  });
});

describe('reopening', () => {
  it("gives a reopened as-needed occurrence back to whoever had it, and the chore with it", async () => {
    const { choreId, occId } = await kidsChore({ kind: 'none' });
    await completeOccurrence(t, kid, occId);
    expect(await reopenOccurrence(t, admin, occId)).toMatchObject({ state: 'open', assignee: { id: kid.id }, todoSyncStatus: 'ok' });
    expect(getChoreRow(t.db, choreId)?.assigneeUserId).toBe(kid.id);
  });

  it('unchecking an as-needed to-do reopens it and gives the chore back, unless someone took it since', async () => {
    const { choreId, occId } = await kidsChore({ kind: 'none' });
    const todoId = getOccurrenceRow(t.db, occId)!.todoId!;
    await t.todos.complete(kidActor, kid.id, todoId);
    await t.todos.uncomplete(kidActor, kid.id, todoId);
    expect(getOccurrenceRow(t.db, occId)?.state).toBe('open');
    expect(getChoreRow(t.db, choreId)?.assigneeUserId).toBe(kid.id);

    await t.todos.complete(kidActor, kid.id, todoId);
    await claimChore(t, sib, choreId); // Sib has it now, with a newer occurrence
    await t.todos.uncomplete(kidActor, kid.id, todoId);
    expect(getOccurrenceRow(t.db, occId)?.state).toBe('done');
    expect((await t.todos.get(kid.id, todoId))?.completedAt).not.toBeNull(); // completed again, so it doesn't linger
    expect(t.eventErrors).toEqual([]);
  });

  it('refuses to reopen when nobody can have it', async () => {
    const { occId } = await kidsChore({ kind: 'none' });
    await completeOccurrence(t, kid, occId);
    updateUser(t.db, kid.id, { active: false });
    const err = (await reopenOccurrence(t, admin, occId).catch((e: unknown) => e)) as AppError;
    expect([err.code, err.message]).toEqual(['conflict', 'Assign the chore before reopening it.']);
  });
});

describe('undoing a close that brought the next occurrence', () => {
  /** The kid's Monday chore, due 11-16, completed late on 11-18, which brought 11-23's at once. */
  async function lateTick(close: (occId: number) => Promise<unknown>) {
    t.clock.set(new Date('2026-11-16T12:00:00Z'));
    const { choreId, occId } = await kidsChore(MONDAYS);
    t.clock.set(new Date('2026-11-18T12:00:00Z'));
    await close(occId);
    const [next] = openOf(choreId);
    expect(next).toMatchObject({ dueDate: '2026-11-23', assigneeUserId: kid.id });
    return { choreId, occId, next: next!, todoId: getOccurrenceRow(t.db, occId)!.todoId! };
  }

  it('unchecking the to-do reopens the original and removes the one its close created, with its to-do', async () => {
    const { choreId, occId, next, todoId } = await lateTick((id) => t.todos.complete(kidActor, kid.id, getOccurrenceRow(t.db, id)!.todoId!));
    expect(history(t, HistoryQuerySchema.parse({})).entries.find((e) => e.id === occId)?.canReopen).toBe(true);
    await t.todos.uncomplete(kidActor, kid.id, todoId);
    expect(openOf(choreId)).toMatchObject([{ id: occId, dueDate: '2026-11-16', state: 'open', todoId }]);
    expect(getOccurrenceRow(t.db, next.id)).toBeUndefined();
    expect(await t.todos.get(kid.id, next.todoId!)).toBeNull();
    expect((await t.todos.get(kid.id, todoId))?.completedAt).toBeNull();
    expect(t.eventErrors).toEqual([]);
  });

  it("an admin's Reopen does the same", async () => {
    const { choreId, occId, next } = await lateTick((id) => completeOccurrence(t, kid, id));
    expect(await reopenOccurrence(t, admin, occId)).toMatchObject({ state: 'open', assignee: { id: kid.id }, todoSyncStatus: 'ok' });
    expect(openOf(choreId).map((o) => o.id)).toEqual([occId]);
    expect(await t.todos.get(kid.id, next.todoId!)).toBeNull();
    expect((await t.todos.list(kid.id)).groups.overdue.map((i) => i.choreOccurrenceId)).toEqual([occId]);
  });

  it.each([
    ['completed', async (next: number) => { await completeOccurrence(t, kid, next); }],
    ["someone else's", async (_next: number, choreId: number) => { await claimChore(t, sib, choreId); }],
  ] as const)('still blocks the undo when the newer one is %s', async (_name, change) => {
    const { choreId, occId, next, todoId } = await lateTick((id) => completeOccurrence(t, kid, id));
    await change(next.id, choreId);
    expect(history(t, HistoryQuerySchema.parse({})).entries.find((e) => e.id === occId)?.canReopen).toBe(false);
    const err = (await reopenOccurrence(t, admin, occId).catch((e: unknown) => e)) as AppError;
    expect([err.code, err.message]).toEqual(['conflict', 'Only the most recent occurrence of a chore can be reopened.']);
    await t.todos.uncomplete(kidActor, kid.id, todoId);
    expect(getOccurrenceRow(t.db, occId)?.state).toBe('done');
    expect((await t.todos.get(kid.id, todoId))?.completedAt).not.toBeNull(); // completed again
    expect(t.eventErrors).toEqual([]);
  });

  /** Unchecking the to-do completes it again, and an admin's Reopen is refused. */
  async function expectNoUndo(occId: number, todoId: number) {
    expect(history(t, HistoryQuerySchema.parse({})).entries.find((e) => e.id === occId)?.canReopen).toBe(false);
    const err = (await reopenOccurrence(t, admin, occId).catch((e: unknown) => e)) as AppError;
    expect([err.code, err.message]).toEqual(['conflict', 'Only the most recent occurrence of a chore can be reopened.']);
    await t.todos.uncomplete(kidActor, kid.id, todoId);
    expect(getOccurrenceRow(t.db, occId)?.state).toBe('done');
    expect((await t.todos.get(kid.id, todoId))?.completedAt).not.toBeNull();
    expect(t.eventErrors).toEqual([]);
  }

  it("doesn't undo an early close whose next occurrence the job created days later", async () => {
    const { choreId, occId } = await kidsChore(FRIDAYS); // due Fri 11-20
    const todoId = getOccurrenceRow(t.db, occId)!.todoId!;
    await t.todos.complete(kidActor, kid.id, todoId); // Sunday 11-15, early
    t.clock.set(new Date('2026-11-21T00:00:00Z'));
    expect(await generateChores(t)).toHaveLength(1);
    expect(openOf(choreId)).toMatchObject([{ dueDate: '2026-11-27', assigneeUserId: kid.id }]);
    await expectNoUndo(occId, todoId);
    expect(openOf(choreId)).toMatchObject([{ dueDate: '2026-11-27' }]);
  });

  it("doesn't undo a late close whose next occurrence came more than a minute later", async () => {
    t.clock.set(new Date('2026-11-16T12:00:00Z'));
    const { choreId, occId } = await kidsChore(MONDAYS); // due Mon 11-16
    const todoId = getOccurrenceRow(t.db, occId)!.todoId!;
    t.clock.set(new Date('2026-11-18T12:00:00Z'));
    // A missed completion: reconcile closes it, and the next generation run brings the next one.
    await t.todos.backendFor(kid.id).complete(kid.id, todoId, t.clock.now());
    expect(reconcileOccurrences(t)).toEqual({ done: 1, skipped: 0 });
    expect(openOf(choreId)).toEqual([]);
    t.clock.advance(15 * 60_000);
    expect(await generateChores(t)).toHaveLength(1);
    await expectNoUndo(occId, todoId);
  });
});

describe('completing', () => {
  it("lets members complete only their own, and admins anyone's, credited to the assignee", async () => {
    const { occId } = await kidsChore({ kind: 'daily' });
    const err = (await completeOccurrence(t, sib, occId).catch((e: unknown) => e)) as AppError;
    expect([err.code, err.message]).toEqual(['forbidden', 'You can only complete your own chores.']);
    expect(await completeOccurrence(t, admin, occId)).toMatchObject({ credited: { id: kid.id }, closedBy: { id: admin.id } });
  });
});
