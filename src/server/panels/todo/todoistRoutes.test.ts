import { describe, expect, it } from 'vitest';
import type { TodoListResponse, TodoSummaryResponse } from '../../../shared/todo.js';
import { and, eq } from 'drizzle-orm';
import { choreOccurrences, choreTodoActions, chores, panelGrants, todos } from '../../db/schema.js';
import { generateChores } from '../chores/generator.js';
import { panelJobs } from '../registry.js';
import { keyMismatchWarning } from '../../integrations/keyCheck.js';
import { finishDeactivation, STILL_DISCONNECTING } from '../../admin/deactivate.js';
import { AppError } from '../../core/errors.js';
import { addUser, call, cookieFor, linkTodoistForTest, makeTestApp, type TestApp } from '../../test/helpers.js';

async function setup() {
  const t = makeTestApp({ todoist: true });
  const admin = addUser(t.db, t.clock, { email: 'admin@example.com', role: 'admin', panels: ['todo'] });
  const kid = addUser(t.db, t.clock, { email: 'kid@example.com', displayName: 'Kid', panels: ['todo'] });
  const account = linkTodoistForTest(t, kid);
  const chores = t.fakeTodoist.addProject(account, 'Chores');
  t.fakeTodoist.addTask(account, { content: 'Milk' });
  return { t, admin, kid, account, chores, kidCookie: cookieFor(t.db, t.clock, kid), adminCookie: cookieFor(t.db, t.clock, admin) };
}

describe('the To-do API for someone linked to Todoist', () => {
  it('syncs before serving the list, and says how fresh it is', async () => {
    const { t, account, chores, kidCookie } = await setup();
    const res = await call(t.app, 'GET', '/api/panels/todo/items', { cookie: kidCookie });
    const body = (await res.json()) as TodoListResponse;
    expect(body.groups.none.map((i) => i.title)).toEqual(['Milk']);
    expect(body.groups.none[0]!.todoistProjectId).toBe(account.inboxId);
    // Only the projects the list needs: Inbox here (chores go there too, and nothing is in Chores).
    expect(body.todoist).toEqual({
      status: 'ok',
      lastSyncAt: t.clock.now().toISOString(),
      projects: [{ id: account.inboxId, name: 'Inbox' }],
      serverNow: t.clock.now().toISOString(),
    });
    expect(chores.id).not.toBe(account.inboxId);
    const summary = (await (await call(t.app, 'GET', '/api/panels/todo/summary', { cookie: kidCookie })).json()) as TodoSummaryResponse;
    expect(summary.todoist).toMatchObject({ status: 'ok' });
  });

  it("never shows an admin the names of another person's projects the list doesn't use", async () => {
    const { t, admin, kid, account, chores, adminCookie, kidCookie } = await setup();
    const garden = t.fakeTodoist.addProject(account, 'Garden');
    t.fakeTodoist.addProject(account, 'Job hunt 2027');
    t.fakeTodoist.addTask(account, { content: 'Interview prep', project_id: garden.id });
    await t.todoist!.requestSync(kid);
    t.todoist!.setChoresProject(kid, chores.id);
    // A chore to-do the kid moved to Garden in Todoist, so a live row refers to Garden.
    const item = await t.todos.create({ type: 'system' }, kid, { title: 'Water the beans' }, { choreOccurrenceId: 31 });
    const task = [...account.items.values()].find((i) => i.content === 'Water the beans')!;
    t.fakeTodoist.change(account, task.id, { project_id: garden.id });
    t.clock.advance(60_000);
    await t.todoist!.requestSync(kid);
    expect(t.db.select().from(todos).where(eq(todos.id, item.id)).get()).toMatchObject({ todoistProjectId: garden.id });

    const expected = [{ id: account.inboxId, name: 'Inbox' }, { id: chores.id, name: 'Chores' }, { id: garden.id, name: 'Garden' }];
    // The admin's view of the kid's list, and the kid's own home card (summary is self-only).
    for (const [path, cookie] of [[`/api/panels/todo/items?userId=${kid}`, adminCookie], ['/api/panels/todo/summary', kidCookie]] as const) {
      const res = await call(t.app, 'GET', path, { cookie });
      expect(res.status).toBe(200);
      const text = await res.text();
      expect((JSON.parse(text) as { todoist: { projects: unknown } }).todoist.projects).toEqual(expected);
      expect(text).not.toContain('Job hunt');
    }
    // The person's own link still lists every project, for the chores project picker.
    const own = (await (await call(t.app, 'GET', '/api/todoist', { cookie: kidCookie })).json()) as { projects: { name: string }[] };
    expect(own.projects.map((p) => p.name)).toEqual(['Inbox', 'Chores', 'Garden', 'Job hunt 2027']);
    expect(admin).not.toBe(kid);
  });

  it("doesn't sync again within 15 seconds of the last sync", async () => {
    const { t, kidCookie } = await setup();
    await call(t.app, 'GET', '/api/panels/todo/items', { cookie: kidCookie });
    const syncs = () => t.fakeTodoist.requests.filter((r) => r.path === '/api/v1/sync').length;
    const before = syncs();
    t.clock.advance(10_000);
    await call(t.app, 'GET', '/api/panels/todo/items', { cookie: kidCookie });
    expect(syncs()).toBe(before);
    t.clock.advance(10_000);
    await call(t.app, 'GET', '/api/panels/todo/items', { cookie: kidCookie });
    expect(syncs()).toBe(before + 1);
  });

  it('serves the mirror with the status when Todoist is down', async () => {
    const { t, kidCookie } = await setup();
    await call(t.app, 'GET', '/api/panels/todo/items', { cookie: kidCookie });
    t.clock.advance(60_000);
    t.fakeTodoist.failures.push({ path: 'sync', status: 500 });
    const res = await call(t.app, 'GET', '/api/panels/todo/items', { cookie: kidCookie });
    expect(res.status).toBe(200);
    expect(((await res.json()) as TodoListResponse).groups.none).toHaveLength(1);
  });

  it('maps a Todoist failure on a write to integration_unavailable (503) with a plain message', async () => {
    const { t, kidCookie } = await setup();
    t.fakeTodoist.failures.push({ path: 'sync', status: 502 });
    const res = await call(t.app, 'POST', '/api/panels/todo/items', { cookie: kidCookie, body: { title: 'Bread' } });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: 'integration_unavailable', message: "Couldn't reach Todoist. Try again in a few minutes." } });
  });
});

describe('/api/todoist', () => {
  it("reports the signed-in person's own link", async () => {
    const { t, kid, account, chores, kidCookie, adminCookie } = await setup();
    await t.todoist!.requestSync(kid);
    expect(await (await call(t.app, 'GET', '/api/todoist', { cookie: adminCookie })).json()).toEqual({ linked: false });
    expect(await (await call(t.app, 'GET', '/api/todoist', { cookie: kidCookie })).json()).toEqual({
      linked: true,
      account: null, // linkTodoistForTest doesn't go through link(), which stores the email

      status: 'ok',
      lastSyncAt: t.clock.now().toISOString(),
      lastError: null,
      projects: [{ id: account.inboxId, name: 'Inbox' }, { id: chores.id, name: 'Chores' }],
      inboxProjectId: account.inboxId,
      choresProjectId: null,
      choresProjectLost: null,
      waitingToMove: 0,
      serverNow: t.clock.now().toISOString(),
    });
  });

  it('sets the chores project to one of their projects, or back to Inbox', async () => {
    const { t, kid, chores, kidCookie } = await setup();
    await t.todoist!.requestSync(kid);
    expect((await call(t.app, 'PUT', '/api/todoist/chores-project', { cookie: kidCookie, body: { projectId: chores.id } })).status).toBe(204);
    expect(t.todoist!.state(kid)!.choresProjectId).toBe(chores.id);
    const bad = await call(t.app, 'PUT', '/api/todoist/chores-project', { cookie: kidCookie, body: { projectId: 'someone-elses' } });
    expect(bad.status).toBe(400);
    expect((await call(t.app, 'PUT', '/api/todoist/chores-project', { cookie: kidCookie, body: { projectId: null } })).status).toBe(204);
    expect(t.todoist!.state(kid)!.choresProjectId).toBeNull();
  });

  it('disconnects only the signed-in person, and needs the CSRF header', async () => {
    const { t, kid, kidCookie, adminCookie } = await setup();
    expect((await call(t.app, 'POST', '/api/todoist/disconnect', { cookie: kidCookie, csrf: false })).status).toBe(403);
    expect((await call(t.app, 'POST', '/api/todoist/disconnect', { cookie: adminCookie })).status).toBe(204);
    expect(t.todoist!.isLinked(kid)).toBe(true); // the admin's own (missing) link, not the kid's
    expect((await call(t.app, 'POST', '/api/todoist/disconnect', { cookie: kidCookie })).status).toBe(204);
    expect(t.todoist!.isLinked(kid)).toBe(false);
  });

  it('works without the To-do panel for someone who still has a link: they can see it and disconnect it', async () => {
    const { t, kid, kidCookie } = await setup();
    t.db.delete(panelGrants).where(and(eq(panelGrants.userId, kid), eq(panelGrants.panelId, 'todo'))).run();
    expect(await (await call(t.app, 'GET', '/api/todoist', { cookie: kidCookie })).json()).toMatchObject({ linked: true });
    // Where chore to-dos go is a To-do setting, so that still needs the panel.
    expect((await call(t.app, 'PUT', '/api/todoist/chores-project', { cookie: kidCookie, body: { projectId: null } })).status).toBe(403);
    expect((await call(t.app, 'POST', '/api/todoist/disconnect', { cookie: kidCookie })).status).toBe(204);
    expect(t.todoist!.isLinked(kid)).toBe(false);
    expect(t.fakeTodoist.requests.filter((r) => r.path === '/api/v1/revoke')).toHaveLength(2);
  });

  it('needs a session, and limits disconnecting to 10 a minute per person', async () => {
    const { t, kidCookie } = await setup();
    expect((await call(t.app, 'GET', '/api/todoist')).status).toBe(401);
    expect((await call(t.app, 'POST', '/api/todoist/disconnect')).status).toBe(401);
    for (let i = 0; i < 10; i++) expect((await call(t.app, 'POST', '/api/todoist/disconnect', { cookie: kidCookie })).status).toBe(204);
    expect((await call(t.app, 'POST', '/api/todoist/disconnect', { cookie: kidCookie })).status).toBe(429);
  });

  it("is a 404 when Todoist isn't configured", async () => {
    const t = makeTestApp();
    const kid = addUser(t.db, t.clock, { panels: ['todo'] });
    expect((await call(t.app, 'GET', '/api/todoist', { cookie: cookieFor(t.db, t.clock, kid) })).status).toBe(404);
    expect((await call(t.app, 'GET', '/api/panels/todo/todoist', { cookie: cookieFor(t.db, t.clock, kid) })).status).toBe(404);
  });
});

describe('GET /api/admin/connections', () => {
  it("lists every connection's status for admins, without credentials", async () => {
    const { t, kid, kidCookie, adminCookie } = await setup();
    expect((await call(t.app, 'GET', '/api/admin/connections', { cookie: kidCookie })).status).toBe(403);
    const list = await (await call(t.app, 'GET', '/api/admin/connections', { cookie: adminCookie })).json();
    expect(list).toEqual([
      {
        id: expect.any(Number), kind: 'todoist', scope: 'user', ownerUserId: kid, ownerName: 'Kid', account: null, status: 'ok',
        lastSuccessAt: null, lastError: null, lastErrorAt: null,
      },
    ]);
    expect(JSON.stringify(list)).not.toMatch(/credentials|v1\./);
  });
});

describe('people who leave or lose the panel', () => {
  it('deactivating someone removes their chore to-dos through Todoist first, then unlinks and revokes', async () => {
    const { t, kid, account, adminCookie } = await setup();
    t.db.insert(panelGrants).values({ userId: kid, panelId: 'chores' }).run();
    await t.todoist!.requestSync(kid);
    const choreId = t.db.insert(chores).values({
      title: 'Feed the cat', notes: null, assigneeUserId: kid, scheduleType: 'fixed', schedule: { kind: 'daily' },
      startDate: '2026-11-01', status: 'active', createdAt: t.clock.now(), updatedAt: t.clock.now(),
    }).returning({ id: chores.id }).get().id;
    await generateChores(t, { choreId });
    expect([...account.items.values()].some((i) => i.content === 'Feed the cat' && !i.is_deleted)).toBe(true);

    expect((await call(t.app, 'PATCH', `/api/admin/users/${kid}`, { cookie: adminCookie, body: { active: false } })).status).toBe(204);
    expect([...account.items.values()].find((i) => i.content === 'Feed the cat')!.is_deleted).toBe(true);
    expect(t.todoist!.isLinked(kid)).toBe(false);
    expect(t.fakeTodoist.requests.filter((r) => r.path === '/api/v1/revoke')).toHaveLength(2);
    expect(t.db.select().from(todos).where(eq(todos.ownerUserId, kid)).all().every((r) => r.backend === 'internal')).toBe(true);
  });

  /** Kid with a chore to-do in Todoist whose occurrence was skipped, and whose removal is queued and backing off. */
  async function withQueuedRemoval() {
    const s = await setup();
    const { t, kid } = s;
    t.db.insert(panelGrants).values({ userId: kid, panelId: 'chores' }).run();
    await t.todoist!.requestSync(kid);
    const choreId = t.db.insert(chores).values({
      title: 'Feed the cat', notes: null, assigneeUserId: kid, scheduleType: 'fixed', schedule: { kind: 'daily' },
      startDate: '2026-11-01', status: 'active', createdAt: t.clock.now(), updatedAt: t.clock.now(),
    }).returning({ id: chores.id }).get().id;
    const [occId] = await generateChores(t, { choreId });
    const occ = t.db.select().from(choreOccurrences).where(eq(choreOccurrences.id, occId!)).get()!;
    t.db.update(choreOccurrences).set({ state: 'skipped', completedAt: t.clock.now() }).where(eq(choreOccurrences.id, occId!)).run();
    t.db.insert(choreTodoActions).values({
      todoId: occ.todoId!, ownerUserId: kid, action: 'remove', evenIfCompleted: false, attempts: 3, retryAt: new Date(t.clock.now().getTime() + 40 * 60_000), createdAt: t.clock.now(),
    }).run();
    return s;
  }

  it('runs their queued chore to-do changes once before unlinking, even ones not due yet', async () => {
    const { t, kid, account, adminCookie } = await withQueuedRemoval();
    expect((await call(t.app, 'PATCH', `/api/admin/users/${kid}`, { cookie: adminCookie, body: { active: false } })).status).toBe(204);
    expect([...account.items.values()].find((i) => i.content === 'Feed the cat')!.is_deleted).toBe(true);
    expect(t.db.select().from(choreTodoActions).all()).toEqual([]);
    expect(t.todoist!.isLinked(kid)).toBe(false);
  });

  it("warns the admin about chore to-dos that couldn't be removed first: they stay in that person's Todoist", async () => {
    const { t, kid, account, adminCookie } = await withQueuedRemoval();
    t.fakeTodoist.failures.push({ path: 'sync', status: 503 }, { path: 'sync', status: 503 });
    const res = await call(t.app, 'PATCH', `/api/admin/users/${kid}`, { cookie: adminCookie, body: { active: false } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      warnings: ["1 chore to-do couldn't be removed from Kid's Todoist before it was disconnected. It stays in their Todoist, and they can delete it there."],
    });
    expect([...account.items.values()].find((i) => i.content === 'Feed the cat')!.is_deleted).toBe(false);
    expect(t.todoist!.isLinked(kid)).toBe(false);
  });

  it("warns the admin when the link couldn't be disconnected, instead of a silent 204", async () => {
    const t = makeTestApp({ todoist: true, keyMismatch: true });
    const admin = addUser(t.db, t.clock, { email: 'admin@example.com', role: 'admin', panels: ['todo'] });
    const kid = addUser(t.db, t.clock, { email: 'kid@example.com', displayName: 'Kid', panels: ['todo'] });
    linkTodoistForTest(t, kid);
    const res = await call(t.app, 'PATCH', `/api/admin/users/${kid}`, { cookie: cookieFor(t.db, t.clock, admin), body: { active: false } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ warnings: [expect.stringMatching(/^Kid is deactivated, but their Todoist couldn't be disconnected: Todoist is unavailable/)] });
    expect(t.todoist!.isLinked(kid)).toBe(true);
  });

  /** Kid's unlink waits until `release` is called, then does what `then` says. */
  function slowUnlink(t: TestApp, then: () => Promise<void>) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const unlink = t.todoist!.unlink.bind(t.todoist!);
    t.todoist!.unlink = (userId) => gate.then(then).then(() => unlink(userId));
    return { release };
  }

  it('lets a slow disconnect finish in the background after the deadline, and says so', async () => {
    const { t, kid } = await setup();
    const { release } = slowUnlink(t, async () => {});
    const { warnings, done } = await finishDeactivation(t, kid, 20);
    expect(warnings).toEqual([STILL_DISCONNECTING]);
    expect(t.todoist!.isLinked(kid)).toBe(true);
    release();
    await done;
    expect(t.todoist!.isLinked(kid)).toBe(false);
    expect(t.systemWarnings).toEqual([]);
  });

  it('puts a background disconnect that fails on the System page', async () => {
    const { t, kid, adminCookie } = await setup();
    const { release } = slowUnlink(t, async () => { throw new AppError('integration_unavailable', "Couldn't reach Todoist."); });
    const { warnings, done } = await finishDeactivation(t, kid, 20);
    expect(warnings).toEqual([STILL_DISCONNECTING]);
    release();
    await done;
    const info = (await (await call(t.app, 'GET', '/api/admin/system', { cookie: adminCookie })).json()) as { warnings: string[] };
    expect(info.warnings).toEqual([expect.stringMatching(/^Kid is deactivated, but their Todoist couldn't be disconnected: Couldn't reach Todoist\./)]);
    expect(t.todoist!.isLinked(kid)).toBe(true);
  });

  it("doesn't sync someone whose To-do panel was turned off, and resumes when it's back", async () => {
    const { t, kid } = await setup();
    t.db.delete(panelGrants).where(and(eq(panelGrants.userId, kid), eq(panelGrants.panelId, 'todo'))).run();
    expect(await t.todoist!.syncAll()).toEqual({ total: 0, failed: 0 });
    expect(t.todoist!.isLinked(kid)).toBe(true);
    t.db.insert(panelGrants).values({ userId: kid, panelId: 'todo' }).run();
    expect(await t.todoist!.syncAll()).toEqual({ total: 1, failed: 0 });
  });
});

describe('GET /api/admin/system', () => {
  it('shows a TOKEN_ENCRYPTION_KEY mismatch as a warning', async () => {
    const t = makeTestApp({ todoist: true, keyMismatch: true });
    const admin = addUser(t.db, t.clock, { email: 'admin@example.com', role: 'admin' });
    const info = (await (await call(t.app, 'GET', '/api/admin/system', { cookie: cookieFor(t.db, t.clock, admin) })).json()) as { warnings: string[] };
    expect(info.warnings).toEqual([keyMismatchWarning({ todoist: true })]);
  });
});

describe('todo.todoistRevocations', () => {
  it('retries revocations that failed on unlink, every hour, and the System page warns until they succeed', async () => {
    const { t, kid, adminCookie } = await setup();
    const warnings = async () => ((await (await call(t.app, 'GET', '/api/admin/system', { cookie: adminCookie })).json()) as { warnings: string[] }).warnings;
    t.fakeTodoist.failures.push({ path: 'revoke', status: 503 }, { path: 'revoke', status: 503 });
    await t.todoist!.unlink(kid);
    expect(await warnings()).toEqual([expect.stringMatching(/couldn't revoke/i)]);
    const job = panelJobs(t).find((j) => j.name === 'todo.todoistRevocations')!;
    expect(job.cron).toBe('0 * * * *');
    await job.run();
    expect(await warnings()).toEqual([]);
  });
});

describe('todo.todoistSync', () => {
  it('is registered only with Todoist configured, and fails the run when a sync fails', async () => {
    const { t } = await setup();
    expect(panelJobs(makeTestApp()).map((j) => j.name)).not.toContain('todo.todoistSync');
    const job = panelJobs(t).find((j) => j.name === 'todo.todoistSync')!;
    expect(job.cron).toBe('*/10 * * * *');
    await job.run();
    t.fakeTodoist.failures.push({ path: 'sync', status: 500 });
    await expect(job.run()).rejects.toThrow(/failed for 1 of 1/);
  });
});
