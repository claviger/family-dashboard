import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { TODO_REMOVAL_WARNING, type NewChoreInput } from '../../../shared/chores.js';
import { setGrant, updateUser } from '../../admin/users.js';
import { AppError } from '../../core/errors.js';
import { choreOccurrences, choreTodoActions, chores } from '../../db/schema.js';
import { addUser, makeTestApp, useFlakyTodos, type TestApp } from '../../test/helpers.js';
import { completeOccurrence, reopenOccurrence, setCredit, skipOccurrence, type ChoreUser } from './actions.js';
import { assignChore, releaseChore, releaseUser } from './assignment.js';
import { createChore, setChoreStatus } from './definitions.js';
import { generateChores } from './generator.js';
import { getOccurrenceRow } from './store.js';
import { retryPendingTodos } from './todoLink.js';

let t: TestApp;
let admin: ChoreUser;
let kid: ChoreUser;
let sib: ChoreUser;
let noTodo: number;

beforeEach(() => {
  t = makeTestApp();
  admin = { id: addUser(t.db, t.clock, { email: 'admin@example.com', displayName: 'Admin', role: 'admin', panels: ['todo', 'chores'] }), role: 'admin' };
  kid = { id: addUser(t.db, t.clock, { email: 'kid@example.com', displayName: 'Kid', panels: ['todo', 'chores'] }), role: 'member' };
  sib = { id: addUser(t.db, t.clock, { email: 'sib@example.com', displayName: 'Sib', panels: ['todo', 'chores'] }), role: 'member' };
  noTodo = addUser(t.db, t.clock, { email: 'nt@example.com', displayName: 'No todo', panels: [] });
});

/** Creates a daily chore, which generates today's occurrence, and returns that occurrence's id. */
async function occurrence(over: Partial<NewChoreInput> = {}): Promise<number> {
  const chore = await createChore(t, {
    title: 'Feed the cat', notes: null, assigneeUserId: null, schedule: { kind: 'daily' }, startDate: '2026-11-15', ...over,
  });
  return t.db.select({ id: choreOccurrences.id }).from(choreOccurrences).where(eq(choreOccurrences.choreId, chore.id)).get()!.id;
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  return ((await p.catch((e: unknown) => e)) as AppError).code;
}

function row(id: number) {
  return getOccurrenceRow(t.db, id)!;
}

async function openTodos(userId: number) {
  return (await t.todos.list(userId)).groups.today;
}

describe('complete and skip', () => {
  it('lets a member complete their own, which completes the to-do and credits them', async () => {
    const id = await occurrence({ assigneeUserId: kid.id });
    t.clock.advance(60_000);
    const done = await completeOccurrence(t, kid, id);
    expect(done).toMatchObject({
      state: 'done', closedAt: '2026-11-15T12:01:00.000Z', credited: { id: kid.id }, closedBy: { id: kid.id },
    });
    expect((await t.todos.get(kid.id, row(id).todoId!))?.completedAt).toBe('2026-11-15T12:01:00.000Z');
    expect(await codeOf(completeOccurrence(t, kid, id))).toBe('conflict');
  });

  it("doesn't let a member complete someone else's", async () => {
    const id = await occurrence({ assigneeUserId: sib.id });
    expect(await codeOf(completeOccurrence(t, kid, id))).toBe('forbidden');
  });

  it('credits the assignee when an admin completes', async () => {
    const assigned = await occurrence({ assigneeUserId: kid.id });
    expect(await completeOccurrence(t, admin, assigned)).toMatchObject({ credited: { id: kid.id }, closedBy: { id: admin.id } });
  });

  it('lets only admins skip, which deletes the to-do', async () => {
    const id = await occurrence({ assigneeUserId: kid.id });
    expect(await codeOf(skipOccurrence(t, kid, id))).toBe('forbidden');
    const skipped = await skipOccurrence(t, admin, id);
    expect(skipped).toMatchObject({ state: 'skipped', closedBy: { id: admin.id }, credited: null });
    expect(await t.todos.get(kid.id, row(id).todoId!)).toBeNull();
  });
});

describe('history corrections', () => {
  it('changes credit on completions only', async () => {
    const id = await occurrence({ assigneeUserId: kid.id });
    expect(await codeOf(setCredit(t, admin, id, sib.id))).toBe('conflict');
    await completeOccurrence(t, kid, id);
    expect(await setCredit(t, admin, id, sib.id)).toMatchObject({ credited: { id: sib.id }, closedBy: { id: kid.id } });
    expect(await codeOf(setCredit(t, kid, id, kid.id))).toBe('forbidden');
  });

  it('reopens the most recent occurrence and reopens its to-do', async () => {
    const id = await occurrence({ assigneeUserId: kid.id });
    await completeOccurrence(t, kid, id);
    const todoId = row(id).todoId!;
    const reopened = await reopenOccurrence(t, admin, id);
    expect(reopened).toMatchObject({ state: 'open', closedAt: null, closedBy: null, credited: null });
    expect((await t.todos.get(kid.id, todoId))?.completedAt).toBeNull();
    expect(row(id).todoId).toBe(todoId);
  });

  it('recreates the to-do when reopening a skip', async () => {
    const id = await occurrence({ assigneeUserId: kid.id });
    const oldTodo = row(id).todoId!;
    await skipOccurrence(t, admin, id);
    await reopenOccurrence(t, admin, id);
    const newTodo = row(id).todoId!;
    expect(newTodo).not.toBe(oldTodo);
    expect((await t.todos.get(kid.id, newTodo))?.choreOccurrenceId).toBe(id);
  });

  it('refuses to reopen an older occurrence, an open one, or one of a paused chore', async () => {
    const first = await occurrence({ assigneeUserId: kid.id });
    expect(await codeOf(reopenOccurrence(t, admin, first))).toBe('conflict');
    await completeOccurrence(t, kid, first);
    t.clock.set(new Date('2026-11-16T12:00:00Z'));
    const [second] = await generateChores(t);
    await completeOccurrence(t, kid, second!);
    expect(await codeOf(reopenOccurrence(t, admin, first))).toBe('conflict');
    await setChoreStatus(t, row(second!).choreId, 'paused');
    expect(await codeOf(reopenOccurrence(t, admin, second!))).toBe('conflict');
    expect(await codeOf(reopenOccurrence(t, kid, second!))).toBe('forbidden');
  });
});

describe('a crash in the middle of a change', () => {
  /**
   * Runs `change` with to-do calls that never return, as if the server died during its first
   * to-do call, then "restarts" with a working backend. The database is what a restart would find.
   */
  async function crashDuring(change: () => Promise<unknown>) {
    const stalled = useFlakyTodos(t, false);
    stalled.stalled = new Set(['get', 'create', 'findByChoreOccurrence']);
    void change();
    await new Promise((resolve) => setTimeout(resolve, 0));
    useFlakyTodos(t, false);
  }

  function queued() {
    return t.db.select().from(choreTodoActions).all();
  }

  async function afterRestart() {
    t.clock.advance(5 * 60_000);
    return retryPendingTodos(t);
  }

  it('leaves the removal queued when a skip is cut short', async () => {
    const id = await occurrence({ assigneeUserId: kid.id });
    const todoId = row(id).todoId!;
    await crashDuring(() => skipOccurrence(t, admin, id));
    expect(row(id).state).toBe('skipped');
    expect(queued()).toMatchObject([{ todoId, ownerUserId: kid.id, action: 'remove', attempts: 0 }]);
    expect(await afterRestart()).toMatchObject({ actionsAttempted: 1, actionsPending: 0 });
    expect(await t.todos.get(kid.id, todoId)).toBeNull();
  });

  it('leaves the removal queued when a reassignment is cut short', async () => {
    const id = await occurrence({ assigneeUserId: kid.id });
    const todoId = row(id).todoId!;
    await crashDuring(() => assignChore(t, admin, row(id).choreId, sib.id));
    expect(row(id)).toMatchObject({ assigneeUserId: sib.id, todoId: null, todoSyncStatus: 'pending' });
    expect(queued()).toMatchObject([{ todoId, ownerUserId: kid.id, action: 'remove' }]);
    expect(await afterRestart()).toMatchObject({ actionsPending: 0, stillPending: 0 });
    expect(await t.todos.get(kid.id, todoId)).toBeNull();
    expect((await openTodos(sib.id)).map((i) => i.choreOccurrenceId)).toEqual([id]);
  });

  it('leaves the completion queued when completing is cut short', async () => {
    const id = await occurrence({ assigneeUserId: kid.id });
    const todoId = row(id).todoId!;
    await crashDuring(() => completeOccurrence(t, kid, id));
    expect(row(id).state).toBe('done');
    expect(queued()).toMatchObject([{ todoId, action: 'complete', attempts: 0 }]);
    await afterRestart();
    expect((await t.todos.get(kid.id, todoId))?.completedAt).not.toBeNull();
  });

  it.each([
    ['skip', (id: number) => skipOccurrence(t, admin, id), 'remove'],
    ['reassign', (id: number) => assignChore(t, admin, row(id).choreId, sib.id), 'remove'],
    ['complete', (id: number) => completeOccurrence(t, kid, id), 'complete'],
    ['release', () => releaseUser(t, kid.id), 'remove'],
  ] as const)('saves a %s and queues its to-do change in one transaction', async (_name, change, action) => {
    const id = await occurrence({ assigneeUserId: kid.id });
    const before = row(id);
    t.sqlite.exec(`create trigger no_queue before insert on chore_todo_actions begin select raise(abort, 'disk full'); end`);
    await expect(change(id)).rejects.toThrow('disk full');
    expect(row(id)).toEqual(before); // the occurrence change was rolled back with the queue row
    t.sqlite.exec('drop trigger no_queue');
    await change(id);
    expect(queued()).toEqual([]);
    const todo = await t.todos.get(kid.id, before.todoId!);
    if (action === 'remove') expect(todo).toBeNull();
    else expect(todo?.completedAt).not.toBeNull();
  });
});

describe('to-do failures and lost access', () => {
  it('warns when a skip or reassignment leaves an old to-do it could not remove yet', async () => {
    const skipped = await occurrence({ assigneeUserId: kid.id });
    const moved = await occurrence({ title: 'Dishes', assigneeUserId: kid.id });
    const flaky = useFlakyTodos(t, new Set(['remove']));
    expect(await skipOccurrence(t, admin, skipped)).toMatchObject({ state: 'skipped', warning: TODO_REMOVAL_WARNING });

    // The kid's to-do still holds the occurrence, so Sib's waits until the removal goes through.
    const reassigned = await assignChore(t, admin, row(moved).choreId, sib.id);
    expect(reassigned).toMatchObject({ assignee: { id: sib.id }, todoSyncStatus: 'pending', warning: TODO_REMOVAL_WARNING });
    flaky.failing = false;
    t.clock.advance(5 * 60_000);
    expect(await retryPendingTodos(t)).toMatchObject({ stillPending: 0, actionsPending: 0 });
    expect(await openTodos(kid.id)).toEqual([]);
    expect((await openTodos(sib.id)).map((i) => i.choreOccurrenceId)).toEqual([moved]);
  });

  it("queues a to-do completion that fails and retries it until it's done", async () => {
    const id = await occurrence({ assigneeUserId: kid.id });
    const todoId = row(id).todoId!;
    const flaky = useFlakyTodos(t, new Set(['complete']));
    expect(await completeOccurrence(t, kid, id)).toMatchObject({ state: 'done', credited: { id: kid.id } });
    expect(t.db.select().from(choreTodoActions).all()).toMatchObject([
      { todoId, ownerUserId: kid.id, action: 'complete', attempts: 1, retryAt: new Date('2026-11-15T12:05:00Z') },
    ]);

    t.clock.advance(5 * 60_000);
    expect(await retryPendingTodos(t)).toMatchObject({ actionsAttempted: 1, actionsPending: 1 });
    expect(t.db.select().from(choreTodoActions).get()).toMatchObject({ attempts: 2, retryAt: new Date('2026-11-15T12:15:00Z') });

    flaky.failing = false;
    t.clock.advance(10 * 60_000);
    expect(await retryPendingTodos(t)).toMatchObject({ actionsAttempted: 1, actionsPending: 0 });
    expect((await t.todos.get(kid.id, todoId))?.completedAt).not.toBeNull();
    expect(row(id)).toMatchObject({ state: 'done', todoId });
  });

  it('drops a queued completion once the occurrence is reopened, so its to-do stays open', async () => {
    const id = await occurrence({ assigneeUserId: kid.id });
    const todoId = row(id).todoId!;
    const flaky = useFlakyTodos(t, new Set(['complete']));
    await completeOccurrence(t, kid, id);
    flaky.failing = true;
    expect(await reopenOccurrence(t, admin, id)).toMatchObject({ state: 'open', todoSyncStatus: 'pending' });

    const completions: unknown[] = [];
    t.events.on('todo.completed', (e) => { completions.push(e); });
    flaky.failing = false;
    t.clock.advance(5 * 60_000);
    expect(await retryPendingTodos(t)).toMatchObject({ actionsAttempted: 1, actionsPending: 0, stillPending: 0 });
    expect(completions).toEqual([]); // never completed, only to be reopened again
    expect(row(id)).toMatchObject({ state: 'open', todoSyncStatus: 'ok', todoId });
    expect((await t.todos.get(kid.id, todoId))?.completedAt).toBeNull();
  });

  it("doesn't warn when removals work", async () => {
    const id = await occurrence({ assigneeUserId: kid.id });
    expect(await skipOccurrence(t, admin, id)).not.toHaveProperty('warning');
  });

  it('reopens without a to-do when the assignee lost the To-do panel', async () => {
    const id = await occurrence({ assigneeUserId: kid.id });
    await completeOccurrence(t, kid, id);
    const todoId = row(id).todoId!;
    setGrant(t.db, kid.id, 'todo', false);
    const reopened = await reopenOccurrence(t, admin, id);
    expect(reopened).toMatchObject({ state: 'open', todoSyncStatus: 'not_applicable' });
    expect(row(id).todoId).toBeNull();
    expect((await t.todos.get(kid.id, todoId))?.completedAt).not.toBeNull(); // left as it was
  });

  it("refuses to reopen when the assignee has been deactivated and nobody else has the chore", async () => {
    const id = await occurrence({ assigneeUserId: kid.id });
    await completeOccurrence(t, kid, id);
    updateUser(t.db, kid.id, { active: false });
    expect(await codeOf(reopenOccurrence(t, admin, id))).toBe('conflict');
    expect(row(id).state).toBe('done');
  });

  it('saves a reopen as pending when the to-do fails, and restores it on retry', async () => {
    const id = await occurrence({ assigneeUserId: kid.id });
    await completeOccurrence(t, kid, id);
    const todoId = row(id).todoId!;
    const flaky = useFlakyTodos(t);
    expect(await reopenOccurrence(t, admin, id)).toMatchObject({ state: 'open', todoSyncStatus: 'pending' });
    flaky.failing = false;
    t.clock.advance(5 * 60_000);
    await retryPendingTodos(t);
    expect(row(id)).toMatchObject({ todoSyncStatus: 'ok', todoId });
    expect((await t.todos.get(kid.id, todoId))?.completedAt).toBeNull();
  });

});

describe('a leftover to-do after a reopen whose to-do call failed', () => {
  /**
   * An open occurrence of the kid's, linked to no to-do, whose old to-do is still open on the
   * kid's list: completing it queued the to-do's completion, an admin reopened it while the backend
   * was down, and the queued completion was then dropped because the occurrence is open again.
   */
  async function unlinkedWithLeftover() {
    const id = await occurrence({ assigneeUserId: kid.id });
    const todoId = row(id).todoId!;
    const flaky = useFlakyTodos(t, new Set(['complete']));
    await completeOccurrence(t, kid, id);
    flaky.failing = true;
    await reopenOccurrence(t, admin, id);
    flaky.failing = new Set(['findByChoreOccurrence']);
    t.clock.advance(5 * 60_000);
    expect(await retryPendingTodos(t)).toMatchObject({ actionsAttempted: 1, actionsPending: 0, stillPending: 1 });
    flaky.failing = false;
    expect(row(id)).toMatchObject({ state: 'open', assigneeUserId: kid.id, todoId: null, todoSyncStatus: 'pending' });
    expect((await t.todos.get(kid.id, todoId))?.completedAt).toBeNull();
    return { id, todoId, flaky };
  }

  it.each([
    ['skipped', (id: number) => skipOccurrence(t, admin, id)],
    ['unassigned', (id: number) => assignChore(t, admin, row(id).choreId, null)],
    ['reassigned', (id: number) => assignChore(t, admin, row(id).choreId, sib.id)],
    ['released by the kid', (id: number) => releaseChore(t, kid, row(id).choreId)],
    ['paused', (id: number) => setChoreStatus(t, row(id).choreId, 'paused')],
    ['archived', (id: number) => setChoreStatus(t, row(id).choreId, 'archived')],
    ['released', () => releaseUser(t, kid.id)],
  ] as const)('removes the leftover when the occurrence is %s', async (_name, change) => {
    const { id, todoId } = await unlinkedWithLeftover();
    const result = await change(id);
    if (typeof result === 'object') expect(result).not.toHaveProperty('warning');
    expect(await t.todos.get(kid.id, todoId)).toBeNull();
    expect(t.db.select().from(choreTodoActions).all()).toEqual([]);
  });

  it('completes the leftover when the occurrence is completed', async () => {
    const { id, todoId } = await unlinkedWithLeftover();
    await completeOccurrence(t, admin, id);
    expect((await t.todos.get(kid.id, todoId))?.completedAt).not.toBeNull();
  });

  it("reuses a leftover on the new assignee's own list instead of removing it", async () => {
    const { id, todoId } = await unlinkedWithLeftover();
    // Move the chore and its occurrence to Sib directly, as if Sib's create were still in flight.
    t.db.update(choreOccurrences).set({ assigneeUserId: sib.id }).where(eq(choreOccurrences.id, id)).run();
    t.db.update(chores).set({ assigneeUserId: sib.id }).where(eq(chores.id, row(id).choreId)).run();
    const back = await assignChore(t, admin, row(id).choreId, kid.id);
    expect(back).toMatchObject({ todoSyncStatus: 'ok' });
    expect(row(id).todoId).toBe(todoId);
  });

  it('queues the removal of the leftover, with a warning, when it fails', async () => {
    const { id, todoId, flaky } = await unlinkedWithLeftover();
    flaky.failing = new Set(['remove']);
    expect(await skipOccurrence(t, admin, id)).toMatchObject({ state: 'skipped', warning: TODO_REMOVAL_WARNING });
    expect(t.db.select().from(choreTodoActions).all()).toMatchObject([{ todoId, ownerUserId: kid.id, action: 'remove', attempts: 1 }]);
    flaky.failing = false;
    t.clock.advance(5 * 60_000);
    expect(await retryPendingTodos(t)).toMatchObject({ actionsPending: 0 });
    expect(await t.todos.get(kid.id, todoId)).toBeNull();
  });

  it('leaves a completed leftover alone', async () => {
    const { id, todoId } = await unlinkedWithLeftover();
    await t.todos.complete({ type: 'system' }, kid.id, todoId);
    await skipOccurrence(t, admin, id);
    expect((await t.todos.get(kid.id, todoId))?.completedAt).not.toBeNull();
  });
});
