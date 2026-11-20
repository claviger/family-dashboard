import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { TODO_REMOVAL_WARNING, type NewChoreInput } from '../../../shared/chores.js';
import { updateUser } from '../../admin/users.js';
import { AppError } from '../../core/errors.js';
import { choreOccurrences, choreTodoActions } from '../../db/schema.js';
import { addUser, makeTestApp, useFlakyTodos, type TestApp } from '../../test/helpers.js';
import { createChore, listChores, setChoreStatus, updateChore } from './definitions.js';
import { getChoreRow } from './store.js';
import { retryPendingTodos } from './todoLink.js';

let t: TestApp;
let kid: number;
let other: number;

beforeEach(() => {
  t = makeTestApp();
  kid = addUser(t.db, t.clock, { email: 'kid@example.com', displayName: 'Kid', panels: ['todo', 'chores'] });
  other = addUser(t.db, t.clock, { email: 'other@example.com', displayName: 'Other', panels: ['todo', 'chores'] });
});

function input(over: Partial<NewChoreInput> = {}): NewChoreInput {
  return { title: 'Feed the cat', notes: null, assigneeUserId: kid, schedule: { kind: 'daily' }, startDate: '2026-11-15', ...over };
}

function occurrencesOf(choreId: number) {
  return t.db.select().from(choreOccurrences).where(eq(choreOccurrences.choreId, choreId)).all();
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  return ((await p.catch((e: unknown) => e)) as AppError).code;
}

describe('chore definitions', () => {
  it('creates a chore and its first occurrence right away', async () => {
    const chore = await createChore(t, input({ notes: '  ' }));
    expect(chore).toMatchObject({
      title: 'Feed the cat', notes: null, status: 'active', startDate: '2026-11-15',
      assignee: { id: kid, displayName: 'Kid', color: '#378ADD' }, schedule: { kind: 'daily' },
    });
    const [occ] = occurrencesOf(chore.id);
    expect(occ).toMatchObject({ dueDate: '2026-11-15', assigneeUserId: kid, todoSyncStatus: 'ok', assignmentSource: 'admin' });
    expect((await t.todos.get(kid, occ!.todoId!))?.title).toBe('Feed the cat');
  });

  it('gives an assigned chore with a future start date its occurrence now, due on the start date', async () => {
    const chore = await createChore(t, input({ startDate: '2026-11-20' }));
    expect(occurrencesOf(chore.id)).toMatchObject([{ dueDate: '2026-11-20', assigneeUserId: kid, state: 'open' }]);
  });

  it('refuses an assignee who is missing or deactivated', async () => {
    updateUser(t.db, other, { active: false });
    expect(await codeOf(createChore(t, input({ assigneeUserId: other })))).toBe('validation');
    expect(await codeOf(createChore(t, input({ assigneeUserId: 999 })))).toBe('validation');
  });

  it('warns when pausing leaves a to-do it could not remove yet', async () => {
    const chore = await createChore(t, input());
    const [occ] = occurrencesOf(chore.id);
    useFlakyTodos(t, new Set(['remove']));
    const paused = await setChoreStatus(t, chore.id, 'paused');
    expect(paused).toMatchObject({ status: 'paused', warning: TODO_REMOVAL_WARNING });
    expect(occurrencesOf(chore.id)).toEqual([]);
    expect(t.db.select().from(choreTodoActions).all()).toMatchObject([{ todoId: occ!.todoId }]);
  });

  it('leaves the removal queued when pausing is cut short', async () => {
    const chore = await createChore(t, input());
    const [occ] = occurrencesOf(chore.id);
    const stalled = useFlakyTodos(t, false);
    stalled.stalled = new Set(['get']); // the server dies during the removal
    void setChoreStatus(t, chore.id, 'paused');
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(occurrencesOf(chore.id)).toEqual([]);
    expect(t.db.select().from(choreTodoActions).all()).toMatchObject([{ todoId: occ!.todoId, action: 'remove', attempts: 0 }]);

    useFlakyTodos(t, false); // restarted
    t.clock.advance(5 * 60_000);
    expect(await retryPendingTodos(t)).toMatchObject({ actionsAttempted: 1, actionsPending: 0 });
    expect(await t.todos.get(kid, occ!.todoId!)).toBeNull();
  });

  it('leaves who has the chore alone on an edit, which applies to future occurrences only', async () => {
    const chore = await createChore(t, input());
    const edited = await updateChore(t, chore.id, input({ title: 'Feed the dog', assigneeUserId: other }));
    expect(edited).toMatchObject({ title: 'Feed the dog', assignee: { id: kid } });
    expect(occurrencesOf(chore.id)).toMatchObject([{ titleSnapshot: 'Feed the cat', assigneeUserId: kid }]);
  });

  it('lets a member add a chore for themselves or nobody, and an admin for anyone', async () => {
    const member = { id: kid, role: 'member' as const };
    const mine = await createChore(t, input({ title: 'Mine' }), member);
    expect(occurrencesOf(mine.id)).toMatchObject([{ assigneeUserId: kid, assignmentSource: 'claimed' }]);
    const open = await createChore(t, input({ title: 'Open', assigneeUserId: null }), member);
    expect(open.assignee).toBeNull();
    expect(occurrencesOf(open.id)).toEqual([]);
    const err = (await createChore(t, input({ assigneeUserId: other }), member).catch((e: unknown) => e)) as AppError;
    expect([err.code, err.message]).toEqual(['forbidden', 'You can add a chore for yourself or leave it unassigned.']);
    const admin = { id: addUser(t.db, t.clock, { email: 'a@example.com', role: 'admin' }), role: 'admin' as const };
    const given = await createChore(t, input({ title: 'Given', assigneeUserId: other }), admin);
    expect(occurrencesOf(given.id)).toMatchObject([{ assigneeUserId: other, assignmentSource: 'admin' }]);
  });

  it('pausing keeps who has it; resuming puts it back on their list; archiving clears it', async () => {
    const chore = await createChore(t, input());
    await setChoreStatus(t, chore.id, 'paused');
    expect(getChoreRow(t.db, chore.id)?.assigneeUserId).toBe(kid);
    t.clock.set(new Date('2026-11-16T12:00:00Z'));
    await setChoreStatus(t, chore.id, 'active');
    expect(occurrencesOf(chore.id)).toMatchObject([{ dueDate: '2026-11-16', assigneeUserId: kid, state: 'open' }]);
    expect((await setChoreStatus(t, chore.id, 'archived')).assignee).toBeNull();
    expect(occurrencesOf(chore.id)).toEqual([]);
  });

  it('puts an as-needed chore back on the list when it is resumed', async () => {
    const chore = await createChore(t, input({ schedule: { kind: 'none' } }));
    await setChoreStatus(t, chore.id, 'paused');
    expect(occurrencesOf(chore.id)).toEqual([]);
    await setChoreStatus(t, chore.id, 'active');
    expect(occurrencesOf(chore.id)).toMatchObject([{ dueDate: null, assigneeUserId: kid, state: 'open' }]);
  });

  it('pausing removes open occurrences and their to-dos; resuming generates again', async () => {
    const chore = await createChore(t, input());
    const [occ] = occurrencesOf(chore.id);
    expect((await setChoreStatus(t, chore.id, 'paused')).status).toBe('paused');
    expect(occurrencesOf(chore.id)).toEqual([]);
    expect(await t.todos.get(kid, occ!.todoId!)).toBeNull();

    t.clock.set(new Date('2026-11-16T12:00:00Z'));
    await setChoreStatus(t, chore.id, 'active');
    expect(occurrencesOf(chore.id).map((o) => [o.dueDate, o.state])).toEqual([['2026-11-16', 'open']]);
  });

  it('archiving keeps history and refuses later changes', async () => {
    const chore = await createChore(t, input());
    const [done] = occurrencesOf(chore.id);
    t.db.update(choreOccurrences).set({ state: 'done', completedAt: t.clock.now() }).where(eq(choreOccurrences.id, done!.id)).run();
    t.clock.set(new Date('2026-11-16T12:00:00Z'));
    await setChoreStatus(t, chore.id, 'active'); // generates the 16th
    await setChoreStatus(t, chore.id, 'archived');
    expect(occurrencesOf(chore.id).map((o) => [o.dueDate, o.state])).toEqual([['2026-11-15', 'done']]);
    expect(await codeOf(setChoreStatus(t, chore.id, 'active'))).toBe('conflict');
    expect(await codeOf(updateChore(t, chore.id, input()))).toBe('conflict');
    expect(await codeOf(setChoreStatus(t, 999, 'paused'))).toBe('not_found');
  });

  it('lists active, then paused, then archived chores, each by title', async () => {
    const b = await createChore(t, input({ title: 'b dishes', startDate: '2026-12-01' }));
    await createChore(t, input({ title: 'A trash', startDate: '2026-12-01' }));
    const c = await createChore(t, input({ title: 'C laundry', startDate: '2026-12-01' }));
    await createChore(t, input({ title: 'Z yard', startDate: '2026-12-01' }));
    await setChoreStatus(t, c.id, 'archived');
    await setChoreStatus(t, b.id, 'paused');
    expect(listChores(t.db).map((x) => [x.title, x.status])).toEqual([
      ['A trash', 'active'], ['Z yard', 'active'], ['b dishes', 'paused'], ['C laundry', 'archived'],
    ]);
  });
});
