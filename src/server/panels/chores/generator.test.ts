import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { scheduleType, type ChoreSchedule } from '../../../shared/chores.js';
import { updateUser } from '../../admin/users.js';
import { choreOccurrences, choreTodoActions, chores } from '../../db/schema.js';
import { setFamilySettings } from '../../settings.js';
import { addUser, makeTestApp, useFlakyTodos, type TestApp } from '../../test/helpers.js';
import type { NewTodo } from '../todo/backend.js';
import { InternalTodoBackend } from '../todo/internalBackend.js';
import { generateChores } from './generator.js';
import { getOccurrenceRow } from './store.js';
import { completeTodo, detachTodo, queueTodoAction, retryPendingTodos, todoRetryDelayMs } from './todoLink.js';

let t: TestApp;
let kid: number;
let choresOnly: number;

beforeEach(() => {
  t = makeTestApp(); // the clock starts at 2026-11-15T12:00:00Z, a Sunday; the family time zone is UTC
  kid = addUser(t.db, t.clock, { email: 'kid@example.com', displayName: 'Kid', panels: ['todo', 'chores'] });
  choresOnly = addUser(t.db, t.clock, { email: 'c@example.com', displayName: 'Chores only', panels: ['chores'] });
});

function addChore(over: { schedule?: ChoreSchedule; startDate?: string; assignee?: number | null; status?: 'active' | 'paused' | 'archived' } = {}) {
  const schedule = over.schedule ?? { kind: 'daily' };
  return t.db
    .insert(chores)
    .values({
      title: 'Feed the cat',
      notes: 'Half a can',
      assigneeUserId: over.assignee === undefined ? kid : over.assignee,
      scheduleType: scheduleType(schedule),
      schedule,
      startDate: over.startDate ?? '2026-11-01',
      status: over.status ?? 'active',
      createdAt: t.clock.now(),
      updatedAt: t.clock.now(),
    })
    .returning({ id: chores.id })
    .get().id;
}

function occurrences(choreId: number) {
  return t.db.select().from(choreOccurrences).where(eq(choreOccurrences.choreId, choreId)).all();
}

/** Closes an occurrence directly, as if it had been completed at `at`. */
function close(id: number, at: string, state: 'done' | 'skipped' = 'done') {
  t.db.update(choreOccurrences).set({ state, completedAt: new Date(at) }).where(eq(choreOccurrences.id, id)).run();
}

describe('generateChores', () => {
  it("creates an assigned chore's occurrence with a to-do, once", async () => {
    const chore = addChore();
    const [id] = await generateChores(t);
    expect(await generateChores(t)).toEqual([]);
    const occ = getOccurrenceRow(t.db, id!)!;
    expect(occ).toMatchObject({
      choreId: chore, titleSnapshot: 'Feed the cat', dueDate: '2026-11-15', assigneeUserId: kid,
      assignmentSource: 'admin', state: 'open', todoSyncStatus: 'ok',
    });
    const todo = await t.todos.get(kid, occ.todoId!);
    expect(todo).toMatchObject({
      title: 'Feed the cat', notes: 'Half a can', dueDate: '2026-11-15', createdByUserId: null, choreOccurrenceId: id,
    });
  });

  it('creates nothing for an unassigned chore, so it can never be late', async () => {
    const chore = addChore({ assignee: null });
    expect(await generateChores(t)).toEqual([]);
    t.clock.set(new Date('2026-11-30T12:00:00Z'));
    expect(await generateChores(t)).toEqual([]);
    expect(occurrences(chore)).toEqual([]);
  });

  it('makes no to-do when the assignee lacks the To-do panel', async () => {
    const chore = addChore({ assignee: choresOnly });
    await generateChores(t);
    expect(occurrences(chore)).toMatchObject([{ assigneeUserId: choresOnly, todoSyncStatus: 'not_applicable', todoId: null }]);
  });

  it('creates nothing for a deactivated assignee (deactivating them unassigns their chores)', async () => {
    const chore = addChore();
    updateUser(t.db, kid, { active: false });
    expect(await generateChores(t)).toEqual([]);
    expect(occurrences(chore)).toEqual([]);
  });

  it('skips paused and archived chores, and can run for one chore', async () => {
    addChore({ status: 'paused' });
    addChore({ status: 'archived' });
    const a = addChore();
    const b = addChore();
    expect(await generateChores(t, { choreId: b })).toHaveLength(1);
    expect(occurrences(a)).toEqual([]);
    expect(await generateChores(t)).toHaveLength(1);
  });

  it('leaves an open occurrence alone, so it shows as overdue', async () => {
    const chore = addChore();
    await generateChores(t);
    t.clock.set(new Date('2026-11-18T12:00:00Z'));
    expect(await generateChores(t)).toEqual([]);
    expect(occurrences(chore).map((o) => o.dueDate)).toEqual(['2026-11-15']);
  });

  it('creates the first occurrence right away, even when it is due later', async () => {
    const fridays = addChore({ schedule: { kind: 'weekly', interval: 1, weekdays: [5] } });
    const later = addChore({ startDate: '2026-11-20' });
    await generateChores(t);
    expect(occurrences(fridays).map((o) => o.dueDate)).toEqual(['2026-11-20']);
    expect(occurrences(later).map((o) => o.dueDate)).toEqual(['2026-11-20']);
  });

  it('after an early finish, waits for the due date to pass, then creates the next', async () => {
    // Due Fri 11-20, done Wed 11-18: nothing through Fri, then on Sat the one due Fri 11-27.
    const chore = addChore({ schedule: { kind: 'weekly', interval: 1, weekdays: [5] } });
    const [id] = await generateChores(t);
    close(id!, '2026-11-18T12:00:00Z');
    for (const day of ['2026-11-18', '2026-11-19', '2026-11-20']) {
      t.clock.set(new Date(`${day}T23:00:00Z`));
      expect(await generateChores(t), day).toEqual([]);
    }
    t.clock.set(new Date('2026-11-21T00:00:00Z'));
    expect(await generateChores(t)).toHaveLength(1);
    expect(occurrences(chore).map((o) => o.dueDate)).toEqual(['2026-11-20', '2026-11-27']);
  });

  it('after a late finish, creates the next right away, due on the next scheduled date', async () => {
    // A Monday chore: Mon 11-16 is finished late on Wed 11-18, so Mon 11-23's appears on Wed.
    const chore = addChore({ schedule: { kind: 'weekly', interval: 1, weekdays: [1] } });
    t.clock.set(new Date('2026-11-16T12:00:00Z'));
    const [id] = await generateChores(t);
    close(id!, '2026-11-18T12:00:00Z');
    t.clock.set(new Date('2026-11-18T12:15:00Z'));
    expect(await generateChores(t)).toHaveLength(1);
    expect(occurrences(chore).map((o) => o.dueDate)).toEqual(['2026-11-16', '2026-11-23']);
  });

  it('catches up after downtime with one occurrence per chore, due from today', async () => {
    const daily = addChore();
    const weekly = addChore({ schedule: { kind: 'weekly', interval: 1, weekdays: [1, 4] } });
    const [first] = await generateChores(t, { choreId: daily });
    close(first!, '2026-11-15T13:00:00Z');
    t.clock.set(new Date('2026-11-21T12:00:00Z')); // down for six days; Sat 11-21
    expect(await generateChores(t)).toHaveLength(2);
    expect(occurrences(daily).map((o) => o.dueDate)).toEqual(['2026-11-15', '2026-11-21']);
    expect(occurrences(weekly).map((o) => o.dueDate)).toEqual(['2026-11-23']);
  });

  it('counts a skip as closing, like a completion', async () => {
    const chore = addChore();
    const [id] = await generateChores(t);
    close(id!, '2026-11-15T13:00:00Z', 'skipped');
    expect(await generateChores(t)).toEqual([]);
    t.clock.set(new Date('2026-11-16T00:00:00Z'));
    expect(await generateChores(t)).toHaveLength(1);
    expect(occurrences(chore).map((o) => [o.dueDate, o.state])).toEqual([['2026-11-15', 'skipped'], ['2026-11-16', 'open']]);
  });

  it('after completion: first on the start date, then the interval after the last close', async () => {
    const chore = addChore({ schedule: { kind: 'after', every: 3, unit: 'days' }, startDate: '2026-11-16' });
    const [id] = await generateChores(t); // due on the start date, created now
    close(id!, '2026-11-17T09:00:00Z'); // a day late, so the next comes right away
    t.clock.set(new Date('2026-11-17T09:15:00Z'));
    expect(await generateChores(t)).toHaveLength(1);
    expect(occurrences(chore).map((o) => o.dueDate)).toEqual(['2026-11-16', '2026-11-20']);
  });

  it('uses family-local dates across the spring daylight-saving change in Los Angeles', async () => {
    setFamilySettings(t.db, { name: 'Smiths', timeZone: 'America/Los_Angeles' });
    const chore = addChore({ startDate: '2026-03-07' });
    t.clock.set(new Date('2026-03-08T07:30:00Z')); // 23:30 PST on Sat 3-07
    const [a] = await generateChores(t);
    close(a!, '2026-03-08T07:45:00Z');
    t.clock.set(new Date('2026-03-08T08:30:00Z')); // 00:30 PST on Sun 3-08; clocks spring forward at 02:00
    const [b] = await generateChores(t);
    close(b!, '2026-03-08T09:00:00Z');
    t.clock.set(new Date('2026-03-09T06:30:00Z')); // 23:30 PDT, still Sun 3-08
    expect(await generateChores(t)).toEqual([]);
    t.clock.set(new Date('2026-03-09T07:30:00Z')); // 00:30 PDT on Mon 3-09
    await generateChores(t);
    expect(occurrences(chore).map((o) => o.dueDate)).toEqual(['2026-03-07', '2026-03-08', '2026-03-09']);
  });

  it('uses family-local dates across the fall daylight-saving change in Los Angeles', async () => {
    setFamilySettings(t.db, { name: 'Smiths', timeZone: 'America/Los_Angeles' });
    const chore = addChore({ schedule: { kind: 'after', every: 1, unit: 'days' }, startDate: '2026-10-31' });
    t.clock.set(new Date('2026-10-31T16:00:00Z')); // 09:00 PDT on Sat 10-31
    const [a] = await generateChores(t);
    close(a!, '2026-11-01T06:30:00Z'); // 23:30 PDT on Sat 10-31
    t.clock.set(new Date('2026-11-01T07:30:00Z')); // 00:30 PDT on Sun 11-01; clocks fall back at 02:00
    const [b] = await generateChores(t);
    close(b!, '2026-11-02T07:30:00Z'); // 23:30 PST, still Sun 11-01 after the 25-hour day
    t.clock.set(new Date('2026-11-02T07:45:00Z'));
    expect(await generateChores(t)).toEqual([]);
    t.clock.set(new Date('2026-11-02T08:15:00Z')); // 00:15 PST on Mon 11-02
    await generateChores(t);
    expect(occurrences(chore).map((o) => o.dueDate)).toEqual(['2026-10-31', '2026-11-01', '2026-11-02']);
  });

  it('keeps an after-completion chore going after the family time zone changes', async () => {
    // Closed at 01:00 UTC on 11-16, the 11-16 occurrence counts as closed on 11-15 in Los Angeles,
    // so close + 1 day is 11-16 again, which is taken. F is the day after the latest due date instead.
    const chore = addChore({ schedule: { kind: 'after', every: 1, unit: 'days' }, startDate: '2026-11-15' });
    const [a] = await generateChores(t);
    close(a!, '2026-11-15T13:00:00Z');
    t.clock.set(new Date('2026-11-16T00:30:00Z'));
    const [b] = await generateChores(t);
    close(b!, '2026-11-16T01:00:00Z');
    setFamilySettings(t.db, { name: 'Smiths', timeZone: 'America/Los_Angeles' });
    t.clock.set(new Date('2026-11-17T09:00:00Z')); // 01:00 PST on 11-17
    expect(await generateChores(t)).toHaveLength(1);
    expect(occurrences(chore).map((o) => o.dueDate)).toEqual(['2026-11-15', '2026-11-16', '2026-11-17']);
  });

  it('gives an assigned as-needed chore its occurrence, with no due date, and never a second', async () => {
    const chore = addChore({ schedule: { kind: 'none' } });
    const [id] = await generateChores(t);
    expect(getOccurrenceRow(t.db, id!)).toMatchObject({ dueDate: null, assigneeUserId: kid, todoSyncStatus: 'ok' });
    expect((await t.todos.get(kid, getOccurrenceRow(t.db, id!)!.todoId!))?.dueDate).toBeNull();
    t.clock.set(new Date('2026-11-20T12:00:00Z'));
    expect(await generateChores(t)).toEqual([]);
    expect(occurrences(chore)).toHaveLength(1);
  });

  it("marks a new occurrence like the chore's last one when that was the same person's (Decision 5)", async () => {
    const chore = addChore();
    const [first] = await generateChores(t);
    t.db.update(choreOccurrences).set({ assignmentSource: 'claimed' }).where(eq(choreOccurrences.id, first!)).run();
    close(first!, '2026-11-15T13:00:00Z');
    t.clock.set(new Date('2026-11-16T12:00:00Z'));
    const [second] = await generateChores(t);
    expect(getOccurrenceRow(t.db, second!)?.assignmentSource).toBe('claimed');

    // Someone else's last occurrence doesn't carry over.
    const sib = addUser(t.db, t.clock, { email: 'sib@example.com', displayName: 'Sib', panels: ['todo', 'chores'] });
    close(second!, '2026-11-16T13:00:00Z');
    t.db.update(chores).set({ assigneeUserId: sib }).where(eq(chores.id, chore)).run();
    t.clock.set(new Date('2026-11-17T12:00:00Z'));
    const [third] = await generateChores(t);
    expect(getOccurrenceRow(t.db, third!)).toMatchObject({ assigneeUserId: sib, assignmentSource: 'admin' });
  });

  it("never copies a pre-board 'default' source onto a new occurrence, even for the same person", async () => {
    const chore = addChore();
    const [first] = await generateChores(t);
    t.db.update(choreOccurrences).set({ assignmentSource: 'default' }).where(eq(choreOccurrences.id, first!)).run();
    close(first!, '2026-11-15T13:00:00Z');
    t.clock.set(new Date('2026-11-16T12:00:00Z'));
    const [second] = await generateChores(t);
    expect(getOccurrenceRow(t.db, second!)).toMatchObject({ choreId: chore, assigneeUserId: kid, assignmentSource: 'admin' });
  });

  it('leaves the to-do to todo.retryPending with attach: false', async () => {
    addChore();
    const [id] = await generateChores(t, { attach: false });
    expect(getOccurrenceRow(t.db, id!)).toMatchObject({ todoSyncStatus: 'pending', todoId: null, todoRetryAt: new Date('2026-11-15T12:05:00Z') });
    t.clock.advance(5 * 60_000);
    expect(await retryPendingTodos(t)).toMatchObject({ attempted: 1, stillPending: 0 });
    expect(getOccurrenceRow(t.db, id!)).toMatchObject({ todoSyncStatus: 'ok' });
  });
});

describe('to-do creation failures', () => {
  it('marks the occurrence pending and retries with backoff until the backend recovers', async () => {
    const flaky = useFlakyTodos(t);
    addChore();
    const [id] = await generateChores(t);
    expect(getOccurrenceRow(t.db, id!)).toMatchObject({
      todoSyncStatus: 'pending', todoId: null, todoAttempts: 1, todoRetryAt: new Date('2026-11-15T12:05:00Z'),
    });

    // Not time yet, but it has failed once, so it still counts as waiting.
    expect(await retryPendingTodos(t)).toMatchObject({ attempted: 0, stillPending: 1 });
    t.clock.advance(5 * 60_000);
    expect(await retryPendingTodos(t)).toMatchObject({ attempted: 1, stillPending: 1 });
    expect(getOccurrenceRow(t.db, id!)).toMatchObject({ todoAttempts: 2, todoRetryAt: new Date('2026-11-15T12:15:00Z') });

    flaky.failing = false;
    t.clock.advance(10 * 60_000);
    expect(await retryPendingTodos(t)).toEqual({ attempted: 1, stillPending: 0, actionsAttempted: 0, actionsPending: 0 });
    const occ = getOccurrenceRow(t.db, id!)!;
    expect(occ).toMatchObject({ todoSyncStatus: 'ok', todoAttempts: 0, todoRetryAt: null });
    expect((await t.todos.get(kid, occ.todoId!))?.choreOccurrenceId).toBe(id);
  });

  it('backs off up to an hour', () => {
    expect([1, 2, 3, 4, 5, 6, 20].map((n) => todoRetryDelayMs(n) / 60_000)).toEqual([5, 10, 20, 40, 60, 60, 60]);
  });

  it("doesn't let the retry job start a second create while the first is in flight", async () => {
    // A backend whose create waits until the test lets it finish, like a slow Todoist call.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let creates = 0;
    class SlowCreateBackend extends InternalTodoBackend {
      override async create(ownerId: number, todo: NewTodo) {
        creates++;
        await gate;
        return super.create(ownerId, todo);
      }
    }
    const slow = new SlowCreateBackend(t);
    t.todos.backendFor = () => slow;
    addChore();
    const generating = generateChores(t);
    await new Promise((resolve) => setTimeout(resolve, 0)); // let it reach create()
    expect(creates).toBe(1);
    const [occ] = t.db.select().from(choreOccurrences).all();
    expect(occ).toMatchObject({ todoSyncStatus: 'pending', todoRetryAt: new Date('2026-11-15T12:05:00Z') });

    expect(await retryPendingTodos(t)).toMatchObject({ attempted: 0 });
    t.clock.advance(4 * 60_000);
    expect(await retryPendingTodos(t)).toMatchObject({ attempted: 0 });
    release();
    await generating;
    expect(creates).toBe(1);
    expect(getOccurrenceRow(t.db, occ!.id)).toMatchObject({ todoSyncStatus: 'ok', todoRetryAt: null });
    expect((await t.todos.list(kid)).groups.today.map((i) => i.choreOccurrenceId)).toEqual([occ!.id]);
  });

  it('reuses a to-do that already exists instead of creating a second one', async () => {
    const flaky = useFlakyTodos(t);
    addChore();
    const [id] = await generateChores(t);
    flaky.failing = false;
    const existing = await t.todos.create({ type: 'system' }, kid, { title: 'Feed the cat' }, { choreOccurrenceId: id! });
    t.clock.advance(5 * 60_000);
    await retryPendingTodos(t);
    expect(getOccurrenceRow(t.db, id!)).toMatchObject({ todoSyncStatus: 'ok', todoId: existing.id });
  });

  it('stops retrying once the occurrence is closed', async () => {
    useFlakyTodos(t);
    addChore();
    const [id] = await generateChores(t);
    close(id!, '2026-11-15T12:01:00Z');
    t.clock.advance(5 * 60_000);
    expect(await retryPendingTodos(t)).toMatchObject({ attempted: 0, stillPending: 0 });
  });
});

describe('to-do removal failures', () => {
  let sib: number;
  beforeEach(() => {
    sib = addUser(t.db, t.clock, { email: 'sib@example.com', displayName: 'Sib', panels: ['todo', 'chores'] });
  });

  /** Today's occurrence of a daily chore for the kid, with its to-do. */
  async function kidsOccurrence() {
    addChore();
    const [id] = await generateChores(t);
    return getOccurrenceRow(t.db, id!)!;
  }

  /** Moves the occurrence to Sib as if its to-do on the kid's list had never been removed. */
  function moveToSibLeavingKidsTodo(id: number) {
    t.db
      .update(choreOccurrences)
      .set({ assigneeUserId: sib, todoId: null, todoSyncStatus: 'pending', todoRetryAt: null })
      .where(eq(choreOccurrences.id, id))
      .run();
  }

  it('queues a failed removal and retries it with backoff', async () => {
    const occ = await kidsOccurrence();
    close(occ.id, '2026-11-15T12:00:00Z', 'skipped');
    const flaky = useFlakyTodos(t, new Set(['remove']));
    expect(await detachTodo(t, occ)).toBe(false);
    expect(t.db.select().from(choreTodoActions).all()).toMatchObject([
      { todoId: occ.todoId, ownerUserId: kid, evenIfCompleted: false, attempts: 1, retryAt: new Date('2026-11-15T12:05:00Z') },
    ]);

    expect(await retryPendingTodos(t)).toMatchObject({ actionsAttempted: 0, actionsPending: 1 });
    t.clock.advance(5 * 60_000);
    expect(await retryPendingTodos(t)).toMatchObject({ actionsAttempted: 1, actionsPending: 1 });
    expect(t.db.select().from(choreTodoActions).get()).toMatchObject({ attempts: 2, retryAt: new Date('2026-11-15T12:15:00Z') });

    flaky.failing = false;
    t.clock.advance(10 * 60_000);
    expect(await retryPendingTodos(t)).toMatchObject({ actionsAttempted: 1, actionsPending: 0 });
    expect(await t.todos.get(kid, occ.todoId!)).toBeNull();
  });

  it('drops a queued removal once the to-do is completed, because completed to-dos stay', async () => {
    const occ = await kidsOccurrence();
    close(occ.id, '2026-11-15T12:00:00Z', 'skipped');
    const flaky = useFlakyTodos(t, new Set(['remove']));
    await detachTodo(t, occ);
    flaky.failing = false;
    await t.todos.complete({ type: 'system' }, kid, occ.todoId!);
    t.clock.advance(5 * 60_000);
    expect(await retryPendingTodos(t)).toMatchObject({ actionsAttempted: 1, actionsPending: 0 });
    expect((await t.todos.get(kid, occ.todoId!))?.completedAt).not.toBeNull();
  });

  it('drops a queued removal, without removing anything, once an open occurrence links the to-do again', async () => {
    const occ = await kidsOccurrence();
    close(occ.id, '2026-11-15T12:00:00Z', 'skipped');
    const flaky = useFlakyTodos(t, new Set(['remove']));
    expect(await detachTodo(t, occ)).toBe(false);
    // Linked again before the retry, e.g. by a process that restored it.
    t.db.update(choreOccurrences).set({ state: 'open', completedAt: null, todoId: occ.todoId }).where(eq(choreOccurrences.id, occ.id)).run();
    flaky.failing = false;
    t.clock.advance(5 * 60_000);
    expect(await retryPendingTodos(t)).toMatchObject({ actionsAttempted: 1, actionsPending: 0 });
    expect(await t.todos.get(kid, occ.todoId!)).not.toBeNull();
  });

  it('re-reads each queued action just before trying it, and skips one that is gone', async () => {
    addChore();
    addChore({ schedule: { kind: 'weekly', interval: 1, weekdays: [0] } });
    const [a, b] = (await generateChores(t)).map((id) => getOccurrenceRow(t.db, id)!);
    close(a!.id, '2026-11-15T12:00:00Z', 'skipped');
    close(b!.id, '2026-11-15T12:00:00Z', 'skipped');
    const flaky = useFlakyTodos(t, new Set(['remove']));
    await detachTodo(t, a!);
    await detachTodo(t, b!);
    // While the first is being retried, something else takes care of the second.
    let removes = 0;
    class RacingBackend extends InternalTodoBackend {
      override async get(ownerId: number, id: number) {
        if (id === a!.todoId) t.db.delete(choreTodoActions).where(eq(choreTodoActions.todoId, b!.todoId!)).run();
        return super.get(ownerId, id);
      }
      override async remove(ownerId: number, id: number) {
        removes++;
        return super.remove(ownerId, id);
      }
    }
    flaky.failing = false;
    const racing = new RacingBackend(t);
    t.todos.backendFor = () => racing;
    t.clock.advance(5 * 60_000);
    expect(await retryPendingTodos(t)).toMatchObject({ actionsAttempted: 2, actionsPending: 0 });
    expect(removes).toBe(1);
    expect(await t.todos.get(kid, b!.todoId!)).not.toBeNull();
  });

  it('checks again, right before deleting, that no open occurrence has linked the to-do meanwhile', async () => {
    const occ = await kidsOccurrence();
    close(occ.id, '2026-11-15T12:00:00Z', 'skipped');
    const flaky = useFlakyTodos(t, new Set(['remove']));
    expect(await detachTodo(t, occ)).toBe(false);
    // While the retry reads the to-do, it's linked again (e.g. an admin reopens and it's reused).
    let removes = 0;
    class RelinkingBackend extends InternalTodoBackend {
      override async get(ownerId: number, id: number) {
        const item = await super.get(ownerId, id);
        t.db.update(choreOccurrences).set({ state: 'open', completedAt: null, todoId: occ.todoId }).where(eq(choreOccurrences.id, occ.id)).run();
        return item;
      }
      override async remove(ownerId: number, id: number) {
        removes++;
        return super.remove(ownerId, id);
      }
    }
    flaky.failing = false;
    const relinking = new RelinkingBackend(t);
    t.todos.backendFor = () => relinking;
    t.clock.advance(5 * 60_000);
    expect(await retryPendingTodos(t)).toMatchObject({ actionsAttempted: 1, actionsPending: 0 });
    expect(removes).toBe(0);
    expect(await t.todos.get(kid, occ.todoId!)).not.toBeNull();
  });

  it("starts a removal that replaces a queued completion over, without the completion's failed attempts", async () => {
    const occ = await kidsOccurrence();
    close(occ.id, '2026-11-15T12:00:00Z');
    useFlakyTodos(t);
    expect(await completeTodo(t, occ)).toBe(false);
    t.clock.advance(5 * 60_000);
    await retryPendingTodos(t);
    expect(t.db.select().from(choreTodoActions).get()).toMatchObject({ action: 'complete', attempts: 2 });

    queueTodoAction(t.db, { todoId: occ.todoId!, ownerUserId: kid, action: 'remove' }, t.clock.now());
    expect(t.db.select().from(choreTodoActions).all()).toMatchObject([
      { action: 'remove', attempts: 0, retryAt: new Date(t.clock.now().getTime() + 5 * 60_000) },
    ]);
    // A removal queued again starts over too (review fixes B1 M5).
    t.clock.advance(5 * 60_000);
    t.db.update(choreTodoActions).set({ attempts: 3 }).run();
    queueTodoAction(t.db, { todoId: occ.todoId!, ownerUserId: kid, action: 'remove' }, t.clock.now());
    expect(t.db.select().from(choreTodoActions).get()).toMatchObject({ action: 'remove', attempts: 0 });
  });

  it("doesn't count a queued action that hasn't failed yet as waiting: its first attempt is in flight", async () => {
    const occ = await kidsOccurrence();
    close(occ.id, '2026-11-15T12:00:00Z', 'skipped');
    queueTodoAction(t.db, { todoId: occ.todoId!, ownerUserId: kid, action: 'remove' }, t.clock.now());
    expect(await retryPendingTodos(t)).toMatchObject({ actionsAttempted: 0, actionsPending: 0 });
  });

  it('collapses a queued completion and a removal of the same to-do into the removal', async () => {
    const occ = await kidsOccurrence();
    close(occ.id, '2026-11-15T12:00:00Z');
    const flaky = useFlakyTodos(t);
    const queued = () => t.db.select().from(choreTodoActions).all();
    expect(await completeTodo(t, occ)).toBe(false);
    expect(queued()).toMatchObject([{ todoId: occ.todoId, action: 'complete' }]);
    expect(await detachTodo(t, occ)).toBe(false);
    expect(queued()).toMatchObject([{ todoId: occ.todoId, action: 'remove' }]);
    expect(await completeTodo(t, occ)).toBe(false); // remove wins
    expect(queued()).toMatchObject([{ todoId: occ.todoId, action: 'remove' }]);

    flaky.failing = false;
    t.clock.advance(60 * 60_000);
    expect(await retryPendingTodos(t)).toMatchObject({ actionsAttempted: 1, actionsPending: 0 });
    expect(await t.todos.get(kid, occ.todoId!)).toBeNull();
  });

  it("removes a previous assignee's leftover to-do when it blocks the new one", async () => {
    const occ = await kidsOccurrence();
    moveToSibLeavingKidsTodo(occ.id);
    expect(await retryPendingTodos(t)).toMatchObject({ attempted: 1, stillPending: 0 });
    const after = getOccurrenceRow(t.db, occ.id)!;
    expect(after.todoSyncStatus).toBe('ok');
    expect(await t.todos.get(kid, occ.todoId!)).toBeNull();
    expect((await t.todos.get(sib, after.todoId!))?.choreOccurrenceId).toBe(occ.id);
  });

  it('queues the blocking removal when it fails, then creates the new to-do once it succeeds', async () => {
    const occ = await kidsOccurrence();
    moveToSibLeavingKidsTodo(occ.id);
    const flaky = useFlakyTodos(t, new Set(['remove']));
    expect(await retryPendingTodos(t)).toMatchObject({ attempted: 1, stillPending: 1, actionsPending: 1 });
    expect(t.db.select().from(choreTodoActions).get()).toMatchObject({ todoId: occ.todoId, evenIfCompleted: true });
    expect(getOccurrenceRow(t.db, occ.id)).toMatchObject({ todoSyncStatus: 'pending', todoAttempts: 1 });

    flaky.failing = false;
    t.clock.advance(5 * 60_000);
    expect(await retryPendingTodos(t)).toEqual({ attempted: 1, stillPending: 0, actionsAttempted: 1, actionsPending: 0 });
    expect(await t.todos.get(kid, occ.todoId!)).toBeNull();
    expect(getOccurrenceRow(t.db, occ.id)).toMatchObject({ todoSyncStatus: 'ok' });
  });
});
