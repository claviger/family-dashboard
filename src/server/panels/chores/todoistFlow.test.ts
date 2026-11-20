import { and, eq, isNull } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { chores, todoistState, todos } from '../../db/schema.js';
import type { RemoteChange } from '../../integrations/todoist/mirror.js';
import type { FakeAccount } from '../../test/fakeTodoist.js';
import { addUser, linkTodoistForTest, makeTestApp, type TestApp } from '../../test/helpers.js';
import { completeOccurrence, skipOccurrence } from './actions.js';
import { claimChore } from './assignment.js';
import { generateChores } from './generator.js';
import { getOccurrenceRow } from './store.js';
import { retryPendingTodos } from './todoLink.js';

/** Spec §16: the two-way chore and to-do flows, through the Todoist backend and sync. */
async function setup() {
  const t = makeTestApp({ todoist: true });
  const kid = addUser(t.db, t.clock, { email: 'kid@example.com', displayName: 'Kid', panels: ['todo', 'chores'] });
  const account = linkTodoistForTest(t, kid);
  const choresProject = t.fakeTodoist.addProject(account, 'Chores');
  await t.todoist!.requestSync(kid);
  t.db.update(todoistState).set({ choresProjectId: choresProject.id }).run();
  const choreId = t.db
    .insert(chores)
    .values({
      title: 'Feed the cat', notes: 'Half a can', assigneeUserId: kid, scheduleType: 'fixed', schedule: { kind: 'daily' },
      startDate: '2026-11-01', status: 'active', createdAt: t.clock.now(), updatedAt: t.clock.now(),
    })
    .returning({ id: chores.id })
    .get().id;
  const [occId] = await generateChores(t, { choreId });
  return { t, kid, account, choresProject, occId: occId! };
}

function choreTask(account: FakeAccount) {
  return [...account.items.values()].find((i) => i.content === 'Feed the cat')!;
}

async function laterSync(t: TestApp, kid: number) {
  t.clock.advance(60_000);
  await t.todoist!.requestSync(kid);
}

describe('chores with a Todoist user', () => {
  it("gives an as-needed chore's task no due date", async () => {
    const { t, kid, account } = await setup();
    const choreId = t.db
      .insert(chores)
      .values({
        title: 'Clean the gutters', notes: null, assigneeUserId: null, scheduleType: 'as_needed', schedule: { kind: 'none' },
        startDate: '2026-11-01', status: 'active', createdAt: t.clock.now(), updatedAt: t.clock.now(),
      })
      .returning({ id: chores.id })
      .get().id;
    await claimChore(t, { id: kid, role: 'member' }, choreId);
    const task = [...account.items.values()].find((i) => i.content === 'Clean the gutters')!;
    expect(task.due ?? null).toBeNull();
  });

  it("puts the chore's to-do in the chores project, without a repeat rule", async () => {
    const { t, account, choresProject, occId } = await setup();
    expect(getOccurrenceRow(t.db, occId)).toMatchObject({ todoSyncStatus: 'ok' });
    expect(choreTask(account)).toMatchObject({ project_id: choresProject.id, description: 'Half a can', due: expect.objectContaining({ date: '2026-11-15', is_recurring: false }) });
  });

  it('completing it in Todoist marks the chore done, checked off by the assignee', async () => {
    const { t, kid, account, occId } = await setup();
    t.fakeTodoist.close(account, choreTask(account).id);
    await laterSync(t, kid);
    expect(getOccurrenceRow(t.db, occId)).toMatchObject({ state: 'done', actorUserId: kid, creditedUserId: kid });
  });

  it("mirrors the chore's to-do from the chores project, which isn't the Inbox", async () => {
    const { t, kid, account, choresProject, occId } = await setup();
    const todoId = getOccurrenceRow(t.db, occId)!.todoId!;
    await laterSync(t, kid);
    expect(t.db.select().from(todos).where(eq(todos.id, todoId)).get()).toMatchObject({
      backend: 'todoist', todoistTaskId: choreTask(account).id, todoistProjectId: choresProject.id, choreOccurrenceId: occId, deletedAt: null,
    });
    expect(choresProject.id).not.toBe(account.inboxId);
  });

  it('a chore to-do moved to another project in Todoist stays mirrored, and completing it there marks the chore done', async () => {
    const { t, kid, account, occId } = await setup();
    const garden = t.fakeTodoist.addProject(account, 'Garden');
    const todoId = getOccurrenceRow(t.db, occId)!.todoId!;
    t.fakeTodoist.change(account, choreTask(account).id, { project_id: garden.id });
    await laterSync(t, kid);
    expect(t.db.select().from(todos).where(eq(todos.id, todoId)).get()).toMatchObject({ todoistProjectId: garden.id, deletedAt: null });
    t.fakeTodoist.close(account, choreTask(account).id);
    await laterSync(t, kid);
    expect(getOccurrenceRow(t.db, occId)).toMatchObject({ state: 'done', actorUserId: kid, todoId });
  });

  it('deleting it in Todoist skips the chore', async () => {
    const { t, kid, account, occId } = await setup();
    t.fakeTodoist.change(account, choreTask(account).id, { is_deleted: true });
    await laterSync(t, kid);
    expect(getOccurrenceRow(t.db, occId)).toMatchObject({ state: 'skipped', actorUserId: kid });
  });

  it('completing the chore on the Chores panel completes the task in Todoist', async () => {
    const { t, kid, account, occId } = await setup();
    await completeOccurrence(t, { id: kid, role: 'member' }, occId);
    expect(choreTask(account).checked).toBe(true);
  });

  it('unlinking keeps the occurrence pointing at the same to-do, which stays on the internal list', async () => {
    const { t, kid, occId } = await setup();
    const todoId = getOccurrenceRow(t.db, occId)!.todoId!;
    await t.todoist!.unlink(kid);
    expect(getOccurrenceRow(t.db, occId)!.todoId).toBe(todoId);
    expect(await t.todos.findByChoreOccurrence(kid, occId)).toMatchObject({ id: todoId });
    await t.todos.complete({ type: 'user', userId: kid, role: 'member' }, kid, todoId);
    expect(getOccurrenceRow(t.db, occId)!.state).toBe('done');
  });

  it('linking a different Todoist account after unlinking moves every open to-do there: nothing deleted, no chore skipped', async () => {
    const { t, kid, account, occId } = await setup();
    const actor = { type: 'user', userId: kid, role: 'member' } as const;
    for (const title of ['Buy milk', 'Call grandma']) await t.todos.create(actor, kid, { title });
    await t.todoist!.unlink(kid);
    const before = t.db.select().from(todos).where(and(eq(todos.ownerUserId, kid), isNull(todos.deletedAt))).all();
    expect(before.map((r) => r.backend)).toEqual(['internal', 'internal', 'internal']);
    const changes: RemoteChange[] = [];
    t.todoist!.onRemoteChanges(async (cs) => { changes.push(...cs); });

    const work = t.fakeTodoist.createAccount({ email: 'work@example.com' });
    const tokens = t.fakeTodoist.grant(work);
    expect(await t.todoist!.link(kid, { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: null })).toBe('linked');
    expect(await t.todoist!.migrate(kid)).toEqual({ moved: 3, waiting: 0 });

    const after = t.db.select().from(todos).where(eq(todos.ownerUserId, kid)).all();
    expect(after.map((r) => [r.id, r.deletedAt, r.backend, r.todoistAccountId])).toEqual(before.map((r) => [r.id, null, 'todoist', work.id]));
    expect(after.every((r) => work.items.has(r.todoistTaskId!))).toBe(true);
    expect([...work.items.values()].map((i) => i.content).sort()).toEqual(['Buy milk', 'Call grandma', 'Feed the cat']);
    expect(changes).toEqual([]);
    expect(getOccurrenceRow(t.db, occId)).toMatchObject({ state: 'open' });
    // The first account's tasks were never touched.
    expect([...account.items.values()].filter((i) => !i.is_deleted && !i.checked)).toHaveLength(3);
  });

  it("an admin's chore change during a Todoist outage is queued and lands later", async () => {
    const { t, kid, account, occId } = await setup();
    const admin = addUser(t.db, t.clock, { email: 'admin@example.com', role: 'admin' });
    t.fakeTodoist.failures.push({ path: 'sync', status: 503 });
    const res = await skipOccurrence(t, { id: admin, role: 'admin' }, occId);
    expect(res.warning).toBeTruthy();
    expect(choreTask(account).is_deleted).toBe(false);
    t.clock.advance(5 * 60_000);
    await retryPendingTodos(t);
    expect(choreTask(account).is_deleted).toBe(true);
  });
});
