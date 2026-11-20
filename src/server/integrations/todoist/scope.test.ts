import { and, eq, isNull } from 'drizzle-orm';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { singleKeyring } from '../../core/crypto.js';
import type { EventName, TodoEvent } from '../../core/events.js';
import { choreTodoActions, todoistState, todos, type TodoRow } from '../../db/schema.js';
import type { FakeAccount } from '../../test/fakeTodoist.js';
import { addUser, call, cookieFor, linkTodoistForTest, makeTestApp, TEST_ENCRYPTION_KEY, type TestApp } from '../../test/helpers.js';
import type { RemoteChange } from './mirror.js';
import { FULL_SYNC_EVERY_MS, Todoist } from './todoist.js';

/**
 * The owner's change request of 2026-11-16: only the person's Todoist Inbox syncs, plus chore
 * to-dos wherever they are. A task leaving that scope is dropped from the mirror quietly: it's
 * still in Todoist, so it's never a deletion, and nothing is reported or emitted for it.
 */
async function setup() {
  const t = makeTestApp({ todoist: true, listen: false });
  const kid = addUser(t.db, t.clock, { email: 'kid@example.com', panels: ['todo'] });
  const account = linkTodoistForTest(t, kid);
  const work = t.fakeTodoist.addProject(account, 'Work');
  const changes: RemoteChange[] = [];
  // Still hands every change to TodoService, so events behave as they do in the app.
  t.todoist!.onRemoteChanges(async (cs) => {
    changes.push(...cs);
    for (const c of cs) await t.todos.applyRemoteChange(c.before, c.after, { type: 'todoist' });
  });
  const events: { name: EventName; e: TodoEvent }[] = [];
  for (const name of ['todo.completed', 'todo.uncompleted', 'todo.deleted'] as const) t.events.on(name, (e) => { events.push({ name, e }); });
  const actor = { type: 'user', userId: kid, role: 'member' } as const;
  return { t, kid, account, work, changes, events, actor };
}

/** Every row the person owns, deleted or not. */
function allRows(t: TestApp, owner: number): TodoRow[] {
  return t.db.select().from(todos).where(eq(todos.ownerUserId, owner)).all();
}

function liveTitles(t: TestApp, owner: number): string[] {
  return t.db.select().from(todos).where(and(eq(todos.ownerUserId, owner), isNull(todos.deletedAt))).all().map((r) => r.title).sort();
}

function rowFor(t: TestApp, owner: number, title: string): TodoRow | undefined {
  return allRows(t, owner).find((r) => r.title === title);
}

async function later(t: TestApp, kid: number) {
  t.clock.advance(60_000);
  await t.todoist!.requestSync(kid);
}

function task(account: FakeAccount, content: string) {
  return [...account.items.values()].find((i) => i.content === content && !i.is_deleted)!;
}

/** A mirror row as an older version left it: from any project, possibly chore-linked. */
function legacyRow(t: TestApp, owner: number, account: FakeAccount, v: { title: string; projectId: string; completed?: boolean; deleted?: boolean; chore?: number }): number {
  const now = t.clock.now();
  const item = t.fakeTodoist.addTask(account, { content: v.title, project_id: v.projectId });
  return t.db.insert(todos).values({
    ownerUserId: owner, backend: 'todoist', title: v.title, todoistTaskId: item.id, todoistAccountId: account.id, todoistProjectId: v.projectId,
    completedAt: v.completed ? now : null, deletedAt: v.deleted ? now : null, choreOccurrenceId: v.chore ?? null, createdAt: now, updatedAt: now,
  }).returning({ id: todos.id }).get().id;
}

describe('Todoist sync mirrors only the Inbox', () => {
  it('mirrors the Inbox and nothing from other projects, and still knows every project name', async () => {
    const { t, kid, account, work } = await setup();
    t.fakeTodoist.addTask(account, { content: 'Milk' });
    t.fakeTodoist.addTask(account, { content: 'Quarterly report', project_id: work.id });
    await t.todoist!.requestSync(kid);
    expect(allRows(t, kid).map((r) => [r.title, r.todoistProjectId])).toEqual([['Milk', account.inboxId]]);
    expect(t.todoist!.state(kid)!.projects).toEqual({ [account.inboxId]: 'Inbox', [work.id]: 'Work' });
  });

  it('never mirrors a task in another project as it is added, changed, or completed there', async () => {
    const { t, kid, account, work, changes } = await setup();
    const report = t.fakeTodoist.addTask(account, { content: 'Report', project_id: work.id });
    await t.todoist!.requestSync(kid);
    t.fakeTodoist.addTask(account, { content: 'Slides', project_id: work.id });
    t.fakeTodoist.change(account, report.id, { content: 'Report v2' });
    t.fakeTodoist.close(account, t.fakeTodoist.addTask(account, { content: 'Expenses', project_id: work.id }).id);
    await later(t, kid);
    t.clock.advance(FULL_SYNC_EVERY_MS);
    await t.todoist!.requestSync(kid);
    expect(allRows(t, kid)).toEqual([]);
    expect(changes).toEqual([]);
  });

  it('drops a task moved out of the Inbox from the mirror, quietly: no change, no event, no deletion', async () => {
    const { t, kid, account, work, changes, events } = await setup();
    const milk = t.fakeTodoist.addTask(account, { content: 'Milk' });
    await t.todoist!.requestSync(kid);
    const id = rowFor(t, kid, 'Milk')!.id;
    t.fakeTodoist.change(account, milk.id, { project_id: work.id });
    await later(t, kid);
    // Hard-deleted: there's no row left that could pass for a to-do deleted on purpose.
    expect(t.db.select().from(todos).where(eq(todos.id, id)).get()).toBeUndefined();
    expect(changes).toEqual([]);
    expect(events).toEqual([]);
    expect(task(account, 'Milk')).toMatchObject({ project_id: work.id, is_deleted: false });
  });

  it('drops a completed Inbox task moved to another project, so it leaves the completed group too', async () => {
    const { t, kid, account, work, actor, events } = await setup();
    t.fakeTodoist.addTask(account, { content: 'Milk' });
    await t.todoist!.requestSync(kid);
    await t.todos.complete(actor, kid, rowFor(t, kid, 'Milk')!.id);
    t.fakeTodoist.change(account, task(account, 'Milk').id, { project_id: work.id });
    await later(t, kid);
    expect((await t.todos.list(kid)).completed).toEqual([]);
    expect(allRows(t, kid)).toEqual([]);
    expect(events).toEqual([]);
  });

  it('shows a task again when it moves back into the Inbox', async () => {
    const { t, kid, account, work } = await setup();
    const milk = t.fakeTodoist.addTask(account, { content: 'Milk' });
    await t.todoist!.requestSync(kid);
    t.fakeTodoist.change(account, milk.id, { project_id: work.id });
    await later(t, kid);
    t.fakeTodoist.change(account, milk.id, { project_id: account.inboxId, content: 'Oat milk' });
    await later(t, kid);
    expect(allRows(t, kid).map((r) => [r.title, r.backend, r.todoistTaskId, r.completedAt, r.deletedAt])).toEqual([['Oat milk', 'todoist', milk.id, null, null]]);
  });

  it('keeps a chore-linked row whatever project its task is in', async () => {
    const { t, kid, account, work, changes } = await setup();
    await t.todoist!.requestSync(kid);
    const id = legacyRow(t, kid, account, { title: 'Feed the cat', projectId: account.inboxId, chore: 41 });
    t.fakeTodoist.change(account, task(account, 'Feed the cat').id, { project_id: work.id, content: 'Feed the cat (Work)' });
    await later(t, kid);
    expect(t.db.select().from(todos).where(eq(todos.id, id)).get()).toMatchObject({ title: 'Feed the cat (Work)', todoistProjectId: work.id, choreOccurrenceId: 41, deletedAt: null });
    expect(changes).toHaveLength(1);
  });
});

describe('the full-sync lookups', () => {
  it('drops a row whose lookup finds the task open in another project, instead of deleting it', async () => {
    const { t, kid, account, work, changes, events } = await setup();
    const milk = t.fakeTodoist.addTask(account, { content: 'Milk' });
    await t.todoist!.requestSync(kid);
    const id = rowFor(t, kid, 'Milk')!.id;
    // Moved in Todoist without any incremental sync reporting it, and left out of the next full sync.
    Object.assign(account.items.get(milk.id)!, { project_id: work.id });
    t.fakeTodoist.omitFromFullSync.add(milk.id);
    t.clock.advance(FULL_SYNC_EVERY_MS);
    await t.todoist!.requestSync(kid);
    expect(t.fakeTodoist.requests.filter((r) => r.path === `/api/v1/tasks/${milk.id}`)).toHaveLength(1);
    expect(t.db.select().from(todos).where(eq(todos.id, id)).get()).toBeUndefined();
    expect(changes).toEqual([]);
    expect(events).toEqual([]);
    expect(t.todoist!.state(kid)).toMatchObject({ pendingLookups: [], lookupsSnapshotAt: null, lastFullSyncAt: t.clock.now() });
  });

  it('drops a row whose task was completed in another project, with no completion', async () => {
    const { t, kid, account, work, changes } = await setup();
    const milk = t.fakeTodoist.addTask(account, { content: 'Milk' });
    await t.todoist!.requestSync(kid);
    Object.assign(account.items.get(milk.id)!, { project_id: work.id, checked: true, completed_at: '2026-11-15T13:00:00.000Z' });
    t.clock.advance(FULL_SYNC_EVERY_MS);
    await t.todoist!.requestSync(kid);
    expect(allRows(t, kid)).toEqual([]);
    expect(changes).toEqual([]);
  });

  it('still completes a chore-linked row whose task was completed in another project', async () => {
    const { t, kid, account, work, changes } = await setup();
    await t.todoist!.requestSync(kid);
    const id = legacyRow(t, kid, account, { title: 'Feed the cat', projectId: account.inboxId, chore: 41 });
    await later(t, kid);
    // Completed in another project without any incremental sync reporting it: only the lookup finds out.
    Object.assign(task(account, 'Feed the cat'), { project_id: work.id, checked: true, completed_at: '2026-11-15T13:00:00.000Z' });
    t.clock.advance(FULL_SYNC_EVERY_MS);
    await t.todoist!.requestSync(kid);
    expect(t.db.select().from(todos).where(eq(todos.id, id)).get()).toMatchObject({ completedAt: new Date('2026-11-15T13:00:00.000Z'), deletedAt: null });
    expect(changes.map((c) => [c.before?.completedAt, c.after?.completedAt !== null])).toEqual([[null, true]]);
  });
});

describe('cleaning up rows an older version mirrored from other projects', () => {
  it('drops them once, keeps the Inbox and chore-linked rows, and logs only counts', async () => {
    const { t, kid, account, work, changes, events } = await setup();
    await t.todoist!.requestSync(kid);
    const kept = [
      legacyRow(t, kid, account, { title: 'Milk', projectId: account.inboxId }),
      legacyRow(t, kid, account, { title: 'Feed the cat', projectId: work.id, chore: 41 }),
      legacyRow(t, kid, account, { title: 'Old deleted', projectId: work.id, deleted: true }),
    ];
    const queued = legacyRow(t, kid, account, { title: 'Queued elsewhere', projectId: work.id });
    t.db.insert(choreTodoActions).values({ todoId: queued, ownerUserId: kid, action: 'remove', retryAt: t.clock.now(), createdAt: t.clock.now() }).run();
    legacyRow(t, kid, account, { title: 'Secret project plan', projectId: work.id });
    legacyRow(t, kid, account, { title: 'Done at work', projectId: work.id, completed: true });
    const lines: string[] = [];
    const logger = pino({ level: 'debug' }, { write: (line: string) => { lines.push(line); } });
    const fresh = () => new Todoist({ db: t.db, clock: t.clock, logger, config: t.config.todoist!, keyring: singleKeyring(TEST_ENCRYPTION_KEY), fetch: t.fakeTodoist.fetch });

    expect(fresh().cleanUpOutOfScopeRows()).toEqual({ people: 1, skipped: 0, dropped: 2, keptChores: 2 });
    expect(allRows(t, kid).map((r) => r.id).sort((a, b) => a - b)).toEqual([...kept, queued].sort((a, b) => a - b));
    expect(changes).toEqual([]);
    expect(events).toEqual([]);
    const logged = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === 'todoist: dropped rows from outside the Inbox')!;
    expect(logged).toMatchObject({ people: 1, skipped: 0, dropped: 2, keptChores: 2 });
    expect(lines.join('\n')).not.toContain('Secret project');
  });

  it('runs on every start, so rows left by a rollback and redeploy go too, and is a no-op when nothing is left', async () => {
    const { t, kid, account, work } = await setup();
    await t.todoist!.requestSync(kid);
    expect(t.todoist!.cleanUpOutOfScopeRows()).toEqual({ people: 1, skipped: 0, dropped: 0, keptChores: 0 });
    // As if an older version ran in between and mirrored another project again.
    legacyRow(t, kid, account, { title: 'Later', projectId: work.id });
    expect(t.todoist!.cleanUpOutOfScopeRows()).toMatchObject({ dropped: 1 });
    expect(rowFor(t, kid, 'Later')).toBeUndefined();
    expect(t.todoist!.cleanUpOutOfScopeRows()).toMatchObject({ dropped: 0 });
  });

  it('is a no-op with nobody linked', () => {
    const t = makeTestApp({ todoist: true });
    expect(t.todoist!.cleanUpOutOfScopeRows()).toEqual({ people: 0, skipped: 0, dropped: 0, keptChores: 0 });
  });

  it("leaves a person alone while their Inbox isn't known, and drops their rows once it is", async () => {
    const { t, kid, account, work } = await setup();
    // Linked, but no sync has run, so the Inbox id isn't known.
    legacyRow(t, kid, account, { title: 'Report', projectId: work.id });
    expect(t.todoist!.cleanUpOutOfScopeRows()).toEqual({ people: 0, skipped: 1, dropped: 0, keptChores: 0 });
    expect(rowFor(t, kid, 'Report')).toBeDefined();
    // The next start, once a sync has stored the Inbox (set directly, so the sync itself doesn't drop the row).
    t.db.update(todoistState).set({ inboxProjectId: account.inboxId, projects: { [account.inboxId]: 'Inbox', [work.id]: 'Work' } }).where(eq(todoistState.userId, kid)).run();
    expect(t.todoist!.cleanUpOutOfScopeRows()).toMatchObject({ people: 1, dropped: 1 });
    expect(rowFor(t, kid, 'Report')).toBeUndefined();
  });

  it("leaves a person alone when their stored Inbox id isn't one of their projects", async () => {
    const { t, kid, account, work } = await setup();
    await t.todoist!.requestSync(kid);
    legacyRow(t, kid, account, { title: 'Report', projectId: work.id });
    // A stale or damaged Inbox id: dropping by it could take the whole list.
    t.db.update(todoistState).set({ inboxProjectId: 'AAAAAAAAAAAAAAAA' }).where(eq(todoistState.userId, kid)).run();
    expect(t.todoist!.cleanUpOutOfScopeRows()).toEqual({ people: 0, skipped: 1, dropped: 0, keptChores: 0 });
    expect(rowFor(t, kid, 'Report')).toBeDefined();
  });
});

describe('writes', () => {
  it("editing a task never sends a project, and a task moved out of the Inbox meanwhile is dropped quietly", async () => {
    const { t, kid, account, work, actor, events } = await setup();
    const milk = t.fakeTodoist.addTask(account, { content: 'Milk' });
    await t.todoist!.requestSync(kid);
    const id = rowFor(t, kid, 'Milk')!.id;
    t.fakeTodoist.change(account, milk.id, { project_id: work.id });
    const sent = t.fakeTodoist.requests.length;
    const updated = await t.todos.update(actor, kid, id, { title: 'Oat milk' });
    expect(updated).toMatchObject({ id, title: 'Oat milk' });
    const commands = t.fakeTodoist.requests.slice(sent).flatMap((r) => (r.fields.commands ? (JSON.parse(r.fields.commands) as { type: string; args: Record<string, unknown> }[]) : []));
    expect(commands).toEqual([{ type: 'item_update', uuid: expect.any(String), args: { id: milk.id, content: 'Oat milk' } }]);
    expect(task(account, 'Oat milk')).toMatchObject({ project_id: work.id });
    expect(allRows(t, kid)).toEqual([]);
    expect(events).toEqual([]);
  });

  it('checking off a task that was moved out of the Inbox meanwhile completes it in Todoist and drops it here', async () => {
    const { t, kid, account, work, actor, events } = await setup();
    const milk = t.fakeTodoist.addTask(account, { content: 'Milk' });
    await t.todoist!.requestSync(kid);
    t.fakeTodoist.change(account, milk.id, { project_id: work.id });
    const done = await t.todos.complete(actor, kid, rowFor(t, kid, 'Milk')!.id);
    expect(done.completedAt).not.toBeNull();
    expect(account.items.get(milk.id)).toMatchObject({ checked: true, project_id: work.id });
    expect(allRows(t, kid)).toEqual([]);
    expect(events).toEqual([]);
  });

  it('checking off a repeating task moved out of the Inbox meanwhile answers with the to-do, not a 404', async () => {
    const { t, kid, account, work, events } = await setup();
    const water = t.fakeTodoist.addTask(account, { content: 'Water plants', due: { date: '2026-11-16', timezone: null, is_recurring: true, string: 'every day' } });
    await t.todoist!.requestSync(kid);
    const id = rowFor(t, kid, 'Water plants')!.id;
    t.fakeTodoist.change(account, water.id, { project_id: work.id });
    const res = await call(t.app, 'POST', `/api/panels/todo/items/${id}/complete`, { cookie: cookieFor(t.db, t.clock, kid) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, title: 'Water plants', completedAt: null });
    expect(account.items.get(water.id)).toMatchObject({ checked: false, due: expect.objectContaining({ date: '2026-11-17' }) });
    expect(allRows(t, kid)).toEqual([]);
    expect(events).toEqual([]);
  });

  it('reopening a task moved out of the Inbox meanwhile answers with the to-do, not a 404', async () => {
    const { t, kid, account, work, actor, events } = await setup();
    const milk = t.fakeTodoist.addTask(account, { content: 'Milk' });
    await t.todoist!.requestSync(kid);
    const id = rowFor(t, kid, 'Milk')!.id;
    await t.todos.complete(actor, kid, id);
    t.fakeTodoist.change(account, milk.id, { project_id: work.id });
    const res = await call(t.app, 'POST', `/api/panels/todo/items/${id}/uncomplete`, { cookie: cookieFor(t.db, t.clock, kid) });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id, title: 'Milk', completedAt: null });
    expect(account.items.get(milk.id)).toMatchObject({ checked: false, project_id: work.id });
    expect(allRows(t, kid)).toEqual([]);
    expect(events).toEqual([]);
  });

  it('keeps a chore-linked row a write finds in another project', async () => {
    const { t, kid, account, work, actor } = await setup();
    await t.todoist!.requestSync(kid);
    const id = legacyRow(t, kid, account, { title: 'Feed the cat', projectId: account.inboxId, chore: 41 });
    t.fakeTodoist.change(account, task(account, 'Feed the cat').id, { project_id: work.id });
    await t.todos.update(actor, kid, id, { title: 'Feed the cats' });
    expect(t.db.select().from(todos).where(eq(todos.id, id)).get()).toMatchObject({ title: 'Feed the cats', todoistProjectId: work.id, deletedAt: null });
  });

  it('adds new to-dos to the Inbox', async () => {
    const { t, kid, account, actor } = await setup();
    await t.todoist!.requestSync(kid);
    await t.todos.create(actor, kid, { title: 'Bread' });
    expect(task(account, 'Bread')).toMatchObject({ project_id: account.inboxId });
    expect(liveTitles(t, kid)).toEqual(['Bread']);
  });
});

describe('relinking and unlinking', () => {
  async function relink(t: TestApp, kid: number, account: FakeAccount) {
    const tokens = t.fakeTodoist.grant(account);
    expect(await t.todoist!.link(kid, { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: null })).toBe('linked');
  }

  it('unlinking converts only the in-scope rows, in place', async () => {
    const { t, kid, account, work } = await setup();
    t.fakeTodoist.addTask(account, { content: 'Milk' });
    t.fakeTodoist.addTask(account, { content: 'Report', project_id: work.id });
    await t.todoist!.requestSync(kid);
    const before = allRows(t, kid);
    await t.todoist!.unlink(kid);
    expect(allRows(t, kid).map((r) => [r.id, r.title, r.backend, r.todoistTaskId])).toEqual(before.map((r) => [r.id, 'Milk', 'internal', r.todoistTaskId]));
  });

  it('re-attaches kept rows only when their task is in scope, and never adds the others to the Inbox again', async () => {
    const { t, kid, account, work, changes } = await setup();
    const milk = t.fakeTodoist.addTask(account, { content: 'Milk' });
    const bread = t.fakeTodoist.addTask(account, { content: 'Bread' });
    const jam = t.fakeTodoist.addTask(account, { content: 'Jam' });
    await t.todoist!.requestSync(kid);
    const chore = legacyRow(t, kid, account, { title: 'Feed the cat', projectId: account.inboxId, chore: 41 });
    const ids = Object.fromEntries(allRows(t, kid).map((r) => [r.title, r.id]));
    await t.todoist!.unlink(kid);
    // While unlinked, in Todoist: Bread and the chore move to Work, and Jam is completed there.
    t.fakeTodoist.change(account, bread.id, { project_id: work.id });
    t.fakeTodoist.change(account, task(account, 'Feed the cat').id, { project_id: work.id });
    t.fakeTodoist.change(account, jam.id, { project_id: work.id });
    t.fakeTodoist.close(account, jam.id);
    const tasksBefore = account.items.size;

    await relink(t, kid, account);
    expect(await t.todoist!.migrate(kid)).toEqual({ moved: 0, waiting: 0 });

    expect(account.items.size).toBe(tasksBefore); // nothing added to the Inbox again
    expect(allRows(t, kid).map((r) => [r.id, r.title, r.backend]).sort((a, b) => Number(a[0]) - Number(b[0]))).toEqual([
      [ids.Milk, 'Milk', 'todoist'],
      [chore, 'Feed the cat', 'todoist'],
    ].sort((a, b) => Number(a[0]) - Number(b[0])));
    expect(t.db.select().from(todos).where(eq(todos.id, chore)).get()).toMatchObject({ todoistProjectId: work.id, choreOccurrenceId: 41 });
    expect(milk.project_id).toBe(account.inboxId);
    expect(changes).toEqual([]);
  });
});
