import { and, eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { TODO_REMOVAL_WARNING } from '../../../shared/chores.js';
import { updateUser } from '../../admin/users.js';
import { AppError } from '../../core/errors.js';
import { choreOccurrences, choreTodoActions, chores } from '../../db/schema.js';
import { addUser, makeTestApp, useFlakyTodos, type TestApp } from '../../test/helpers.js';
import { completeOccurrence, type ChoreUser } from './actions.js';
import { assignChore, claimChore, releaseChore, releaseUser } from './assignment.js';
import { createChore, setChoreStatus } from './definitions.js';
import { getChoreRow } from './store.js';
import { retryPendingTodos } from './todoLink.js';

let t: TestApp;
let admin: ChoreUser;
let kid: ChoreUser;
let sib: ChoreUser;
let noTodo: number;

beforeEach(() => {
  t = makeTestApp(); // 2026-11-15T12:00:00Z, a Sunday, family time zone UTC
  admin = { id: addUser(t.db, t.clock, { email: 'admin@example.com', displayName: 'Admin', role: 'admin', panels: ['todo', 'chores'] }), role: 'admin' };
  kid = { id: addUser(t.db, t.clock, { email: 'kid@example.com', displayName: 'Kid', panels: ['todo', 'chores'] }), role: 'member' };
  sib = { id: addUser(t.db, t.clock, { email: 'sib@example.com', displayName: 'Sib', panels: ['todo', 'chores'] }), role: 'member' };
  noTodo = addUser(t.db, t.clock, { email: 'nt@example.com', displayName: 'No todo', panels: [] });
});

/** What createChore takes (Task 8 renames it NewChoreInput). */
type NewChore = Parameters<typeof createChore>[1];

async function addChore(over: Partial<NewChore> = {}): Promise<number> {
  const chore = await createChore(t, { title: 'Feed the cat', notes: null, assigneeUserId: null, schedule: { kind: 'daily' }, startDate: '2026-11-15', ...over });
  return chore.id;
}

function occurrencesOf(choreId: number) {
  return t.db.select().from(choreOccurrences).where(eq(choreOccurrences.choreId, choreId)).all();
}

function openOf(choreId: number) {
  return t.db.select().from(choreOccurrences).where(and(eq(choreOccurrences.choreId, choreId), eq(choreOccurrences.state, 'open'))).all();
}

async function openTodos(userId: number) {
  return Object.values((await t.todos.list(userId)).groups).flat();
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  return ((await p.catch((e: unknown) => e)) as AppError).code;
}

describe('claim and take over', () => {
  it('gives an unassigned chore to whoever claims it, with an occurrence and a to-do due on its next date', async () => {
    const id = await addChore({ schedule: { kind: 'weekly', interval: 1, weekdays: [5] } });
    expect(occurrencesOf(id)).toEqual([]);
    const row = await claimChore(t, kid, id);
    expect(row).toMatchObject({ choreId: id, assignee: { id: kid.id }, state: 'due', date: '2026-11-20', todoSyncStatus: 'ok' });
    expect(openOf(id)).toMatchObject([{ id: row.occurrenceId, assigneeUserId: kid.id, assignmentSource: 'claimed', dueDate: '2026-11-20' }]);
    expect((await openTodos(kid.id)).map((i) => [i.choreOccurrenceId, i.dueDate])).toEqual([[row.occurrenceId, '2026-11-20']]);
    expect(getChoreRow(t.db, id)?.assigneeUserId).toBe(kid.id);
    // Claiming your own chore again changes nothing.
    expect(await claimChore(t, kid, id)).toEqual(row);
    expect(openOf(id)).toHaveLength(1);
  });

  it('takes a chore over: its open occurrence moves with the same due date, overdue or not, and so does its to-do', async () => {
    const id = await addChore({ assigneeUserId: kid.id });
    const [occ] = openOf(id);
    t.clock.set(new Date('2026-11-17T12:00:00Z'));
    const row = await claimChore(t, sib, id);
    expect(row).toMatchObject({ assignee: { id: sib.id }, state: 'overdue', date: '2026-11-15', occurrenceId: occ!.id, todoSyncStatus: 'ok' });
    expect(openOf(id)).toMatchObject([{ id: occ!.id, assigneeUserId: sib.id, assignmentSource: 'claimed', dueDate: '2026-11-15' }]);
    expect(await openTodos(kid.id)).toEqual([]);
    expect((await openTodos(sib.id)).map((i) => [i.choreOccurrenceId, i.dueDate])).toEqual([[occ!.id, '2026-11-15']]);
  });

  it('gives an as-needed chore an occurrence with no due date: on their list', async () => {
    const id = await addChore({ schedule: { kind: 'none' } });
    const row = await claimChore(t, kid, id);
    expect(row).toMatchObject({ state: 'on_list', date: null });
    expect((await openTodos(kid.id)).map((i) => i.dueDate)).toEqual([null]);
  });

  it("doesn't repeat a due date that was already done, when a chore done early changes hands", async () => {
    const id = await addChore({ assigneeUserId: kid.id, schedule: { kind: 'weekly', interval: 1, weekdays: [5] } });
    await completeOccurrence(t, kid, openOf(id)[0]!.id); // Friday 11-20's, done on Sunday
    expect(await claimChore(t, sib, id)).toMatchObject({ state: 'due', date: '2026-11-27' });
  });

  it('refuses paused and archived chores, and chores that are gone', async () => {
    const paused = await addChore();
    await setChoreStatus(t, paused, 'paused');
    expect(await claimChore(t, kid, paused).catch((e: AppError) => e.message)).toBe('Resume the chore first.');
    const archived = await addChore({ title: 'Old' });
    await setChoreStatus(t, archived, 'archived');
    expect(await codeOf(claimChore(t, kid, archived))).toBe('conflict');
    expect(await codeOf(claimChore(t, kid, 999))).toBe('not_found');
  });

  it("refuses a claim on a chore that changed hands while it was being read", async () => {
    const id = await addChore({ assigneeUserId: kid.id });
    // Sib takes it over while the kid's request is waiting on its to-do lookup.
    const lookup = t.todos.findAnyByChoreOccurrence.bind(t.todos);
    t.todos.findAnyByChoreOccurrence = async (occurrenceId: number) => {
      t.db.update(chores).set({ assigneeUserId: sib.id }).where(eq(chores.id, id)).run();
      return lookup(occurrenceId);
    };
    expect(await claimChore(t, admin, id).catch((e: AppError) => e.message)).toBe('That chore just changed. Refresh and try again.');
    expect(getChoreRow(t.db, id)?.assigneeUserId).toBe(sib.id);
  });
});

describe('release', () => {
  it('puts the chore back on the board: its open occurrence and to-do are deleted, not kept as history', async () => {
    const id = await addChore({ assigneeUserId: kid.id });
    expect(await codeOf(releaseChore(t, sib, id))).toBe('forbidden');
    expect(await releaseChore(t, sib, id).catch((e: AppError) => e.message)).toBe('You can only release chores you have.');
    const row = await releaseChore(t, kid, id);
    expect(row).toMatchObject({ assignee: null, state: 'unassigned', occurrenceId: null, date: null });
    expect(occurrencesOf(id)).toEqual([]);
    expect(await openTodos(kid.id)).toEqual([]);
  });

  it('just unassigns a chore with nothing due, keeping its history', async () => {
    const id = await addChore({ assigneeUserId: kid.id, schedule: { kind: 'weekly', interval: 1, weekdays: [5] } });
    await completeOccurrence(t, kid, openOf(id)[0]!.id);
    expect(await releaseChore(t, kid, id)).toMatchObject({ state: 'unassigned' });
    expect(occurrencesOf(id).map((o) => o.state)).toEqual(['done']);
  });
});

describe('admin assign', () => {
  it('assigns, reassigns, and unassigns, moving the to-do each time', async () => {
    const id = await addChore();
    const assigned = await assignChore(t, admin, id, kid.id);
    expect(assigned).toMatchObject({ assignee: { id: kid.id }, state: 'due', date: '2026-11-15' });
    expect(openOf(id)).toMatchObject([{ assigneeUserId: kid.id, assignmentSource: 'admin' }]);

    await assignChore(t, admin, id, sib.id);
    expect(openOf(id)).toMatchObject([{ id: assigned.occurrenceId, assigneeUserId: sib.id, assignmentSource: 'admin' }]);
    expect(await openTodos(kid.id)).toEqual([]);
    expect((await openTodos(sib.id)).map((i) => i.choreOccurrenceId)).toEqual([assigned.occurrenceId]);

    expect(await assignChore(t, admin, id, null)).toMatchObject({ state: 'unassigned' });
    expect(occurrencesOf(id)).toEqual([]);
    expect(await openTodos(sib.id)).toEqual([]);
  });

  it('makes no to-do for someone without the To-do panel', async () => {
    const id = await addChore();
    expect(await assignChore(t, admin, id, noTodo)).toMatchObject({ assignee: { id: noTodo }, todoSyncStatus: 'not_applicable' });
  });

  it('is for admins, and only to active people', async () => {
    const id = await addChore();
    expect(await codeOf(assignChore(t, kid, id, kid.id))).toBe('forbidden');
    expect(await assignChore(t, admin, id, 999).catch((e: AppError) => e.message)).toBe('Pick an active person, or Unassigned.');
    expect(await codeOf(assignChore(t, admin, 999, kid.id))).toBe('not_found');
  });
});

describe('to-do failures and crashes', () => {
  it('saves a claim as pending, with a retry time, when the to-do fails, and retries it', async () => {
    const id = await addChore();
    const flaky = useFlakyTodos(t);
    expect(await claimChore(t, kid, id)).toMatchObject({ assignee: { id: kid.id }, todoSyncStatus: 'pending' });
    expect(openOf(id)).toMatchObject([{ todoAttempts: 1, todoRetryAt: new Date('2026-11-15T12:05:00Z') }]);
    flaky.failing = false;
    t.clock.advance(5 * 60_000);
    expect(await retryPendingTodos(t)).toMatchObject({ stillPending: 0 });
    expect(await openTodos(kid.id)).toHaveLength(1);
  });

  it("warns when the old to-do couldn't be removed yet, and finishes the move on retry", async () => {
    const id = await addChore({ assigneeUserId: kid.id });
    const flaky = useFlakyTodos(t, new Set(['remove']));
    // The kid's to-do still holds the occurrence, so Sib's waits until the removal goes through.
    expect(await claimChore(t, sib, id)).toMatchObject({ assignee: { id: sib.id }, todoSyncStatus: 'pending', warning: TODO_REMOVAL_WARNING });
    flaky.failing = false;
    t.clock.advance(5 * 60_000);
    expect(await retryPendingTodos(t)).toMatchObject({ stillPending: 0, actionsPending: 0 });
    expect(await openTodos(kid.id)).toEqual([]);
    expect(await openTodos(sib.id)).toHaveLength(1);
  });

  it.each([
    ['take over', (id: number) => claimChore(t, sib, id)],
    ['release', (id: number) => releaseChore(t, kid, id)],
    ['unassign', (id: number) => assignChore(t, admin, id, null)],
  ] as const)('saves a %s and queues the old to-do removal in one transaction', async (_name, change) => {
    const id = await addChore({ assigneeUserId: kid.id });
    const chore = getChoreRow(t.db, id);
    const before = openOf(id);
    t.sqlite.exec(`create trigger no_queue before insert on chore_todo_actions begin select raise(abort, 'disk full'); end`);
    await expect(change(id)).rejects.toThrow('disk full');
    expect(getChoreRow(t.db, id)).toEqual(chore); // the chore and its occurrence were rolled back with the queue row
    expect(openOf(id)).toEqual(before);
    t.sqlite.exec('drop trigger no_queue');
    await change(id);
    expect(t.db.select().from(choreTodoActions).all()).toEqual([]);
    expect(await openTodos(kid.id)).toEqual([]);
  });
});

describe('a deactivated assignee', () => {
  it("puts their chores back on the board, paused ones too, and removes their open occurrences and to-dos", async () => {
    const daily = await addChore({ assigneeUserId: kid.id });
    const paused = await addChore({ title: 'Paused', assigneeUserId: kid.id });
    await setChoreStatus(t, paused, 'paused');
    const theirs = await addChore({ title: 'Sib’s', assigneeUserId: sib.id });
    updateUser(t.db, kid.id, { active: false });
    expect(await releaseUser(t, kid.id)).toBe(2);
    expect([getChoreRow(t.db, daily)?.assigneeUserId, getChoreRow(t.db, paused)?.assigneeUserId, getChoreRow(t.db, theirs)?.assigneeUserId]).toEqual([
      null, null, sib.id,
    ]);
    expect(occurrencesOf(daily)).toEqual([]);
    expect(await openTodos(kid.id)).toEqual([]);
    expect(await releaseUser(t, kid.id)).toBe(0);
  });

  it('unassigns a chore that was paused while it was being released', async () => {
    const first = await addChore({ assigneeUserId: kid.id });
    const second = await addChore({ title: 'Dishes', assigneeUserId: kid.id });
    // An admin pauses Dishes while the first chore's to-do lookup is in flight.
    const lookup = t.todos.findAnyByChoreOccurrence.bind(t.todos);
    t.todos.findAnyByChoreOccurrence = async (occurrenceId: number) => {
      t.db.update(chores).set({ status: 'paused' }).where(eq(chores.id, second)).run();
      return lookup(occurrenceId);
    };
    updateUser(t.db, kid.id, { active: false });
    expect(await releaseUser(t, kid.id)).toBe(2);
    expect([getChoreRow(t.db, first)?.assigneeUserId, getChoreRow(t.db, second)?.assigneeUserId]).toEqual([null, null]);
  });
});

describe.each([
  ['claim', (id: number) => claimChore(t, sib, id)],
  ['release', (id: number) => releaseChore(t, kid, id)],
  ['assign', (id: number) => assignChore(t, admin, id, sib.id)],
] as const)('%s refusals', (_name, change) => {
  it('refuses paused and archived chores', async () => {
    const paused = await addChore({ assigneeUserId: kid.id });
    await setChoreStatus(t, paused, 'paused');
    expect(await change(paused).catch((e: AppError) => e.message)).toBe('Resume the chore first.');
    const archived = await addChore({ title: 'Old', assigneeUserId: kid.id });
    await setChoreStatus(t, archived, 'archived');
    expect(await change(archived).catch((e: AppError) => e.message)).toBe("Archived chores can't be changed.");
  });

  it('refuses a chore that changed hands while it was being read', async () => {
    const id = await addChore({ assigneeUserId: kid.id });
    const lookup = t.todos.findAnyByChoreOccurrence.bind(t.todos);
    t.todos.findAnyByChoreOccurrence = async (occurrenceId: number) => {
      t.db.update(chores).set({ assigneeUserId: admin.id }).where(eq(chores.id, id)).run();
      return lookup(occurrenceId);
    };
    expect(await change(id).catch((e: AppError) => e.message)).toBe('That chore just changed. Refresh and try again.');
    expect(getChoreRow(t.db, id)?.assigneeUserId).toBe(admin.id);
    expect(openOf(id)).toMatchObject([{ assigneeUserId: kid.id }]);
  });
});
