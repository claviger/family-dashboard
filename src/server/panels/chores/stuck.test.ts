import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import type { StuckTodo } from '../../../shared/chores.js';
import { choreOccurrences, choreTodoActions, chores, connections, todos } from '../../db/schema.js';
import { addUser, call, cookieFor, linkTodoistForTest, makeTestApp, useFlakyTodos, type TestApp } from '../../test/helpers.js';
import { InternalTodoBackend } from '../todo/internalBackend.js';
import { panelJobs } from '../registry.js';
import { generateChores } from './generator.js';
import { reconcileOccurrences } from './linkage.js';
import { getOccurrenceRow } from './store.js';
import {
  completeTodo, detachTodo, dismissStuckTodo, doTodoAction, listStuckTodos, pendingTodoFields, queueTodoAction, retryPendingTodos,
  retryStuckTodo, TODO_RETRY_CAP, todoRetryDelayMs,
} from './todoLink.js';

let t: TestApp;
let kid: number;

beforeEach(() => {
  t = makeTestApp();
  kid = addUser(t.db, t.clock, { email: 'kid@example.com', displayName: 'Kid', panels: ['todo', 'chores'] });
});

function addChore(assignee: number | null = kid) {
  return t.db
    .insert(chores)
    .values({
      title: 'Feed the cat', notes: null, assigneeUserId: assignee, scheduleType: 'fixed', schedule: { kind: 'daily' },
      startDate: '2026-11-01', status: 'active', createdAt: t.clock.now(), updatedAt: t.clock.now(),
    })
    .returning({ id: chores.id })
    .get().id;
}

/** Runs the retry job until the item has failed `TODO_RETRY_CAP` times in all. */
async function failUntilStuck() {
  for (let n = 1; n < TODO_RETRY_CAP; n++) {
    t.clock.advance(todoRetryDelayMs(n));
    await retryPendingTodos(t);
  }
}

describe('the retry cap', () => {
  it('stops retrying a create after 12 failures, stops reporting it, and lists it for admins', async () => {
    useFlakyTodos(t);
    addChore();
    const [id] = await generateChores(t);
    await failUntilStuck();
    const occ = getOccurrenceRow(t.db, id!)!;
    expect(occ).toMatchObject({ todoSyncStatus: 'pending', todoAttempts: TODO_RETRY_CAP, todoLastError: 'Todoist is unavailable' });
    expect(occ.todoStuckAt).toEqual(t.clock.now());
    t.clock.advance(2 * 60 * 60_000);
    expect(await retryPendingTodos(t)).toEqual({ attempted: 0, stillPending: 0, actionsAttempted: 0, actionsPending: 0 });
    expect(await listStuckTodos(t)).toEqual<StuckTodo[]>([
      {
        kind: 'create', id: id!, title: 'Feed the cat', dueDate: '2026-11-15', owner: { id: kid, displayName: 'Kid' },
        attempts: TODO_RETRY_CAP, lastError: 'Todoist is unavailable', stuckSince: occ.todoStuckAt!.toISOString(),
      },
    ]);
  });

  it('lets an admin retry a stuck create (starting over) or dismiss it as not_applicable', async () => {
    const flaky = useFlakyTodos(t);
    addChore();
    const [id] = await generateChores(t);
    await failUntilStuck();
    expect(await retryStuckTodo(t, 'create', id!)).toBe(false);
    expect(getOccurrenceRow(t.db, id!)).toMatchObject({ todoAttempts: 1, todoStuckAt: null });
    await failUntilStuck();
    flaky.failing = false;
    expect(await retryStuckTodo(t, 'create', id!)).toBe(true);
    expect(getOccurrenceRow(t.db, id!)).toMatchObject({ todoSyncStatus: 'ok', todoLastError: null });

    const [other] = await generateChores(t, { choreId: addChore() });
    flaky.failing = true;
    await t.db.update(choreOccurrences).set({ todoSyncStatus: 'pending', todoAttempts: TODO_RETRY_CAP, todoStuckAt: t.clock.now() }).where(eq(choreOccurrences.id, other!)).run();
    dismissStuckTodo(t, 'create', other!);
    expect(getOccurrenceRow(t.db, other!)).toMatchObject({ todoSyncStatus: 'not_applicable', todoStuckAt: null });
    expect(() => dismissStuckTodo(t, 'create', other!)).toThrow(/no longer stuck/);
  });

  it('caps queued removals too; dismissing one drops the queue row and leaves the to-do', async () => {
    addChore();
    const [id] = await generateChores(t);
    const occ = getOccurrenceRow(t.db, id!)!;
    t.db.update(choreOccurrences).set({ state: 'skipped', completedAt: t.clock.now() }).where(eq(choreOccurrences.id, id!)).run();
    useFlakyTodos(t, new Set(['remove']));
    expect(await detachTodo(t, occ)).toBe(false);
    await failUntilStuck();
    const row = t.db.select().from(choreTodoActions).get()!;
    expect(row).toMatchObject({ action: 'remove', attempts: TODO_RETRY_CAP, stuckAt: t.clock.now() });
    expect(await listStuckTodos(t)).toEqual([expect.objectContaining({ kind: 'remove', id: occ.todoId, title: 'Feed the cat', owner: { id: kid, displayName: 'Kid' } })]);
    dismissStuckTodo(t, 'remove', occ.todoId!);
    expect(t.db.select().from(choreTodoActions).all()).toEqual([]);
    expect(await t.todos.get(kid, occ.todoId!)).not.toBeNull();
  });
});

describe('a link that needs reconnecting', () => {
  it('skips that person’s queued items without counting attempts, and leaves them out of the job error', async () => {
    t = makeTestApp({ todoist: true });
    kid = addUser(t.db, t.clock, { email: 'kid@example.com', displayName: 'Kid', panels: ['todo', 'chores'] });
    linkTodoistForTest(t, kid);
    t.db.update(connections).set({ status: 'needs_reconnect' }).run();
    addChore();
    const [id] = await generateChores(t);
    expect(getOccurrenceRow(t.db, id!)).toMatchObject({ todoSyncStatus: 'pending', todoAttempts: 0 });
    for (let i = 0; i < 20; i++) {
      t.clock.advance(5 * 60_000);
      expect(await retryPendingTodos(t)).toMatchObject({ attempted: 0, stillPending: 0 });
    }
    expect(getOccurrenceRow(t.db, id!)).toMatchObject({ todoAttempts: 0, todoStuckAt: null });
    expect(t.fakeTodoist.requests.filter((r) => r.path === '/api/v1/sync')).toEqual([]);
  });
});

describe('the remove race', () => {
  it('unlinks an occurrence that took the to-do back while the delete was out, so it gets a new one', async () => {
    addChore();
    const [id] = await generateChores(t);
    const occ = getOccurrenceRow(t.db, id!)!;
    t.db.update(choreOccurrences).set({ state: 'skipped', completedAt: t.clock.now() }).where(eq(choreOccurrences.id, id!)).run();
    class SlowRemove extends InternalTodoBackend {
      override async remove(ownerId: number, todoId: number) {
        // While the delete is in flight, an admin reopens the occurrence and it takes the to-do back.
        t.db.update(choreOccurrences).set({ state: 'open', completedAt: null, todoId }).where(eq(choreOccurrences.id, id!)).run();
        return super.remove(ownerId, todoId);
      }
    }
    const slow = new SlowRemove(t);
    t.todos.backendFor = () => slow;
    expect(await detachTodo(t, occ)).toBe(true);
    expect(getOccurrenceRow(t.db, id!)).toMatchObject({ state: 'open', todoId: null, todoSyncStatus: 'pending', todoRetryAt: new Date('2026-11-15T12:05:00Z') });
    t.todos.backendFor = () => new InternalTodoBackend(t);
    t.clock.advance(5 * 60_000);
    await retryPendingTodos(t);
    const after = getOccurrenceRow(t.db, id!)!;
    expect(after.todoSyncStatus).toBe('ok');
    expect(after.todoId).not.toBe(occ.todoId);
  });
});

describe('a Todoist reopen that the chore ignores', () => {
  it('queues completing the to-do again without trying it during the sync', async () => {
    addChore();
    const [id] = await generateChores(t);
    const occ = getOccurrenceRow(t.db, id!)!;
    await t.todos.complete({ type: 'user', userId: kid, role: 'member' }, kid, occ.todoId!);
    // A newer, closed occurrence exists, so reopening the old to-do doesn't reopen its chore.
    t.db.insert(choreOccurrences).values({ ...occ, id: undefined, dueDate: '2026-11-16', state: 'done', completedAt: t.clock.now(), todoId: null, todoSyncStatus: 'not_applicable', createdAt: t.clock.now(), updatedAt: t.clock.now() }).run();
    const reopened = (await t.todos.backendFor(kid).reopen(kid, occ.todoId!))!;
    await t.todos.applyRemoteChange({ ...reopened, completedAt: t.clock.now().toISOString() }, reopened, { type: 'todoist' });
    expect(t.db.select().from(choreTodoActions).all()).toEqual([expect.objectContaining({ todoId: occ.todoId, action: 'complete', attempts: 0 })]);
    expect((await t.todos.get(kid, occ.todoId!))!.completedAt).toBeNull(); // not tried yet
    t.clock.advance(5 * 60_000);
    await retryPendingTodos(t);
    expect((await t.todos.get(kid, occ.todoId!))!.completedAt).not.toBeNull();
  });
});

describe('/api/admin/panels/chores/stuck', () => {
  it('is for admins, and retries and dismisses', async () => {
    const admin = addUser(t.db, t.clock, { email: 'admin@example.com', role: 'admin' });
    useFlakyTodos(t);
    addChore();
    const [id] = await generateChores(t);
    await failUntilStuck();
    const adminCookie = cookieFor(t.db, t.clock, admin);
    expect((await call(t.app, 'GET', '/api/admin/panels/chores/stuck', { cookie: cookieFor(t.db, t.clock, kid) })).status).toBe(403);
    const list = (await (await call(t.app, 'GET', '/api/admin/panels/chores/stuck', { cookie: adminCookie })).json()) as StuckTodo[];
    expect(list.map((s) => [s.kind, s.id])).toEqual([['create', id]]);
    expect(await (await call(t.app, 'POST', `/api/admin/panels/chores/stuck/create/${id}/retry`, { cookie: adminCookie })).json()).toEqual({ ok: false });
    await failUntilStuck();
    expect((await call(t.app, 'POST', `/api/admin/panels/chores/stuck/create/${id}/dismiss`, { cookie: adminCookie })).status).toBe(204);
    expect((await call(t.app, 'POST', `/api/admin/panels/chores/stuck/create/${id}/dismiss`, { cookie: adminCookie })).status).toBe(404);
    expect((await call(t.app, 'POST', '/api/admin/panels/chores/stuck/bogus/1/dismiss', { cookie: adminCookie })).status).toBe(404);
  });
});

describe('reconcileOccurrences', () => {
  /** An occurrence with a to-do, and that to-do changed through the backend directly, so no event fires. */
  async function withMissedChange(change: 'complete' | 'remove' | 'both' | 'none') {
    addChore();
    const [id] = await generateChores(t);
    const occ = getOccurrenceRow(t.db, id!)!;
    const backend = t.todos.backendFor(kid);
    if (change === 'complete' || change === 'both') await backend.complete(kid, occ.todoId!, new Date('2026-11-15T12:30:00Z'));
    if (change === 'remove' || change === 'both') await backend.remove(kid, occ.todoId!);
    return id!;
  }

  it('marks done an occurrence whose to-do was completed without the event, credited to the assignee', async () => {
    const id = await withMissedChange('complete');
    expect(reconcileOccurrences(t)).toEqual({ done: 1, skipped: 0 });
    expect(getOccurrenceRow(t.db, id)).toMatchObject({ state: 'done', creditedUserId: kid, actorUserId: kid, completedAt: new Date('2026-11-15T12:30:00Z') });
  });

  it('skips one whose to-do was deleted, and counts completed-then-deleted as done', async () => {
    const skipped = await withMissedChange('remove');
    expect(reconcileOccurrences(t)).toEqual({ done: 0, skipped: 1 });
    expect(getOccurrenceRow(t.db, skipped)).toMatchObject({ state: 'skipped', actorUserId: kid, creditedUserId: null });
    t = makeTestApp();
    kid = addUser(t.db, t.clock, { email: 'kid@example.com', displayName: 'Kid', panels: ['todo', 'chores'] });
    const done = await withMissedChange('both');
    expect(reconcileOccurrences(t)).toEqual({ done: 1, skipped: 0 });
    expect(getOccurrenceRow(t.db, done)!.state).toBe('done');
  });

  it('leaves an occurrence with an open to-do alone, and runs as part of todo.retryPending', async () => {
    const open = await withMissedChange('none');
    expect(reconcileOccurrences(t)).toEqual({ done: 0, skipped: 0 });
    expect(getOccurrenceRow(t.db, open)!.state).toBe('open');
    await t.todos.backendFor(kid).complete(kid, getOccurrenceRow(t.db, open)!.todoId!, t.clock.now());
    await panelJobs(t).find((j) => j.name === 'todo.retryPending')!.run();
    expect(getOccurrenceRow(t.db, open)!.state).toBe('done');
  });
});

describe('the complete race', () => {
  it('unlinks an occurrence that took the to-do back while the completion was out, so it gets it back open', async () => {
    addChore();
    const [id] = await generateChores(t);
    const occ = getOccurrenceRow(t.db, id!)!;
    t.db.update(choreOccurrences).set({ state: 'done', completedAt: t.clock.now() }).where(eq(choreOccurrences.id, id!)).run();
    class SlowComplete extends InternalTodoBackend {
      override async complete(ownerId: number, todoId: number, at: Date) {
        // While the completion is in flight, an admin reopens the occurrence and it takes the to-do back.
        t.db.update(choreOccurrences).set({ state: 'open', completedAt: null, todoId }).where(eq(choreOccurrences.id, id!)).run();
        return super.complete(ownerId, todoId, at);
      }
    }
    const slow = new SlowComplete(t);
    t.todos.backendFor = () => slow;
    expect(await completeTodo(t, { ...occ, state: 'done' })).toBe(true);
    expect(getOccurrenceRow(t.db, id!)).toMatchObject({ state: 'open', todoId: null, todoSyncStatus: 'pending', todoRetryAt: new Date('2026-11-15T12:05:00Z') });
    t.todos.backendFor = () => new InternalTodoBackend(t);
    t.clock.advance(5 * 60_000);
    await retryPendingTodos(t);
    expect(getOccurrenceRow(t.db, id!)).toMatchObject({ todoSyncStatus: 'ok', todoId: occ.todoId });
    expect((await t.todos.get(kid, occ.todoId!))!.completedAt).toBeNull();
  });
});

describe("a TOKEN_ENCRYPTION_KEY that doesn't match", () => {
  it("blocks that person's items like a reconnect: no attempts counted, and no job error", async () => {
    t = makeTestApp({ todoist: true, keyMismatch: true });
    kid = addUser(t.db, t.clock, { email: 'kid@example.com', displayName: 'Kid', panels: ['todo', 'chores'] });
    linkTodoistForTest(t, kid);
    addChore();
    const [id] = await generateChores(t);
    expect(getOccurrenceRow(t.db, id!)).toMatchObject({ todoSyncStatus: 'pending', todoAttempts: 0 });
    // A queued removal of one of their Todoist to-dos is blocked the same way.
    const todoId = t.db.insert(todos).values({
      ownerUserId: kid, backend: 'todoist', title: 'Old chore', todoistTaskId: '6X7rM8997g3RQmvh', createdAt: t.clock.now(), updatedAt: t.clock.now(),
    }).returning({ id: todos.id }).get().id;
    expect(await doTodoAction(t, { todoId, ownerUserId: kid, action: 'remove' })).toBe(false);
    for (let i = 0; i < 20; i++) {
      t.clock.advance(5 * 60_000);
      expect(await retryPendingTodos(t)).toEqual({ attempted: 0, stillPending: 0, actionsAttempted: 0, actionsPending: 0 });
    }
    expect(getOccurrenceRow(t.db, id!)).toMatchObject({ todoAttempts: 0, todoStuckAt: null });
    expect(t.db.select().from(choreTodoActions).get()).toMatchObject({ attempts: 0, stuckAt: null });
  });
});

describe('stuck items', () => {
  it("an admin's Retry isn't due for another try for 5 minutes while it's in flight", async () => {
    const flaky = useFlakyTodos(t);
    addChore();
    const [id] = await generateChores(t);
    await failUntilStuck();
    let retryAtDuringCreate: Date | null | undefined;
    class Watching extends InternalTodoBackend {
      override async create(...args: Parameters<InternalTodoBackend['create']>) {
        retryAtDuringCreate = getOccurrenceRow(t.db, id!)!.todoRetryAt;
        return super.create(...args);
      }
    }
    flaky.failing = false;
    const watching = new Watching(t);
    t.todos.backendFor = () => watching;
    expect(await retryStuckTodo(t, 'create', id!)).toBe(true);
    expect(retryAtDuringCreate).toEqual(new Date(t.clock.now().getTime() + 5 * 60_000));
  });

  it('queuing the same action again starts it over: not stuck, no failed attempts', () => {
    const now = t.clock.now();
    const todoId = t.db.insert(todos).values({ ownerUserId: kid, backend: 'internal', title: 'Feed the cat', createdAt: now, updatedAt: now }).returning({ id: todos.id }).get().id;
    for (const action of ['complete', 'remove'] as const) {
      t.db.delete(choreTodoActions).run();
      t.db.insert(choreTodoActions).values({
        todoId, ownerUserId: kid, action, evenIfCompleted: false, attempts: TODO_RETRY_CAP, retryAt: now, stuckAt: now, lastError: 'Nope', createdAt: now,
      }).run();
      queueTodoAction(t.db, { todoId, ownerUserId: kid, action }, now);
      expect(t.db.select().from(choreTodoActions).get(), action).toMatchObject({
        action, attempts: 0, stuckAt: null, lastError: null, retryAt: new Date(now.getTime() + 5 * 60_000),
      });
    }
    // A completion still never replaces a removal, and leaves it as it was.
    t.db.update(choreTodoActions).set({ attempts: 3 }).run();
    queueTodoAction(t.db, { todoId, ownerUserId: kid, action: 'complete' }, now);
    expect(t.db.select().from(choreTodoActions).get()).toMatchObject({ action: 'remove', attempts: 3 });
  });

  it("clears the stuck time and last error whenever an occurrence's to-do starts over or stops applying", async () => {
    expect(pendingTodoFields(t.db, kid, t.clock.now())).toMatchObject({ todoStuckAt: null, todoLastError: null });
    expect(pendingTodoFields(t.db, null, t.clock.now())).toMatchObject({ todoSyncStatus: 'not_applicable', todoStuckAt: null, todoLastError: null });
    useFlakyTodos(t);
    addChore();
    const [id] = await generateChores(t);
    await failUntilStuck();
    dismissStuckTodo(t, 'create', id!);
    expect(getOccurrenceRow(t.db, id!)).toMatchObject({ todoSyncStatus: 'not_applicable', todoStuckAt: null, todoLastError: null });
  });

  it("can't retry or dismiss a stuck create once its occurrence isn't open", async () => {
    useFlakyTodos(t);
    addChore();
    const [id] = await generateChores(t);
    await failUntilStuck();
    t.db.update(choreOccurrences).set({ state: 'done', completedAt: t.clock.now() }).where(eq(choreOccurrences.id, id!)).run();
    await expect(retryStuckTodo(t, 'create', id!)).rejects.toThrow(/no longer stuck/);
    expect(() => dismissStuckTodo(t, 'create', id!)).toThrow(/no longer stuck/);
    expect(getOccurrenceRow(t.db, id!)).toMatchObject({ state: 'done', todoAttempts: TODO_RETRY_CAP });
  });
});
