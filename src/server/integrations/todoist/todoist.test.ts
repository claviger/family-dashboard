import { and, eq, isNull } from 'drizzle-orm';
import pino from 'pino';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { singleKeyring } from '../../core/crypto.js';
import { connections, todoistState, todos, users } from '../../db/schema.js';
import { addUser, linkTodoistForTest, makeTestApp, TEST_ENCRYPTION_KEY, type TestApp } from '../../test/helpers.js';
import { decryptCredentials } from '../connections.js';
import { getFamilySettings } from '../../settings.js';
import { applyConfirmation, applyRelinkLookup, type RemoteChange } from './mirror.js';
import { CONFIRM_DEADLINE_MS, CONFIRM_PER_SYNC, FULL_SYNC_EVERY_MS, LIST_SYNC_WAIT_MS, Todoist } from './todoist.js';

function setup() {
  const t = makeTestApp({ todoist: true });
  const userId = addUser(t.db, t.clock, { email: 'kid@example.com', panels: ['todo'] });
  const account = linkTodoistForTest(t, userId);
  const changes: RemoteChange[] = [];
  t.todoist!.onRemoteChanges(async (c) => { changes.push(...c); });
  return { t, todoist: t.todoist!, userId, account, changes };
}

function rows(t: TestApp, userId: number) {
  return t.db.select().from(todos).where(and(eq(todos.ownerUserId, userId), isNull(todos.deletedAt))).all();
}

function conn(t: TestApp, userId: number) {
  return t.db.select().from(connections).where(eq(connections.ownerUserId, userId)).get()!;
}

/** The person's stored tokens, decrypted. */
function storedCreds(t: TestApp, userId: number) {
  return decryptCredentials(singleKeyring(TEST_ENCRYPTION_KEY), conn(t, userId)) as { accessToken: string; refreshToken: string | null; expiresAt: number | null };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('Todoist sync', () => {
  it('mirrors every active Inbox task on the first (full) sync, with due dates in the family time zone', async () => {
    const { t, todoist, userId, account } = setup();
    const chores = t.fakeTodoist.addProject(account, 'Chores');
    t.fakeTodoist.addTask(account, { content: 'Milk', description: 'Oat', due: { date: '2026-11-20T15:00:00Z', timezone: 'UTC', is_recurring: false, string: '' } });
    t.fakeTodoist.addTask(account, { content: 'Water plants', due: { date: '2026-11-16', timezone: null, is_recurring: true, string: 'every day' } });
    t.fakeTodoist.addTask(account, { content: 'Not in the Inbox', project_id: chores.id });
    t.fakeTodoist.close(account, t.fakeTodoist.addTask(account, { content: 'Already done' }).id);

    await todoist.requestSync(userId);

    const mirror = rows(t, userId).sort((a, b) => a.title.localeCompare(b.title));
    expect(mirror.map((r) => [r.title, r.backend, r.notes, r.dueDate, r.dueTime, r.todoistRecurring])).toEqual([
      ['Milk', 'todoist', 'Oat', '2026-11-20', '15:00', false], // the test family's time zone is UTC
      ['Water plants', 'todoist', null, '2026-11-16', null, true],
    ]);
    expect(mirror[1]!.todoistProjectId).toBe(account.inboxId);
    const state = todoist.state(userId)!;
    expect(state.syncToken).toBeTruthy();
    expect(state.inboxProjectId).toBe(account.inboxId);
    expect(state.projects).toEqual({ [account.inboxId]: 'Inbox', [chores.id]: 'Chores' });
    expect(state.lastFullSyncAt).toEqual(t.clock.now());
    expect(conn(t, userId)).toMatchObject({ status: 'ok', lastSuccessAt: t.clock.now() });
    // The list names only the projects it uses; the person's own link gets them all.
    expect(todoist.freshness(userId)).toEqual({
      status: 'ok',
      lastSyncAt: t.clock.now().toISOString(),
      projects: [{ id: account.inboxId, name: 'Inbox' }],
      serverNow: t.clock.now().toISOString(),
    });
    expect(todoist.allProjects(userId)).toEqual([{ id: account.inboxId, name: 'Inbox' }, { id: chores.id, name: 'Chores' }]);
  });

  it('applies incremental changes, keeps completed rows, and reports each change', async () => {
    const { t, todoist, userId, account, changes } = setup();
    const milk = t.fakeTodoist.addTask(account, { content: 'Milk' });
    const bread = t.fakeTodoist.addTask(account, { content: 'Bread' });
    const eggs = t.fakeTodoist.addTask(account, { content: 'Eggs' });
    await todoist.requestSync(userId);
    const before = new Map(rows(t, userId).map((r) => [r.title, r.id]));

    t.clock.advance(60_000);
    t.fakeTodoist.change(account, milk.id, { content: 'Oat milk' });
    t.fakeTodoist.close(account, bread.id);
    t.fakeTodoist.change(account, eggs.id, { is_deleted: true });
    t.fakeTodoist.addTask(account, { content: 'Jam' });
    await todoist.requestSync(userId);

    const after = new Map(rows(t, userId).map((r) => [r.title, r]));
    expect(after.get('Oat milk')!.id).toBe(before.get('Milk'));
    expect(after.get('Bread')!.completedAt).toEqual(t.clock.now());
    expect(after.has('Eggs')).toBe(false);
    expect(after.has('Jam')).toBe(true);
    expect(todoist.state(userId)!.lastFullSyncAt).toEqual(new Date('2026-11-15T12:00:00Z')); // still the first one
    expect(changes.map((c) => [c.before?.title ?? null, c.after?.title ?? null, c.after ? c.after.completedAt !== null : null])).toEqual([
      ['Milk', 'Oat milk', false],
      ['Bread', 'Bread', true],
      ['Eggs', null, null],
    ]);
  });

  it('converts an open internal row that kept its task id in place, instead of copying it (relink)', async () => {
    const { t, todoist, userId, account, changes } = setup();
    const task = t.fakeTodoist.addTask(account, { content: 'From before' });
    const now = t.clock.now();
    const { id } = t.db.insert(todos)
      .values({ ownerUserId: userId, backend: 'internal', title: 'From before (local)', todoistTaskId: task.id, todoistAccountId: account.id, choreOccurrenceId: 77, createdAt: now, updatedAt: now })
      .returning({ id: todos.id }).get();

    await todoist.requestSync(userId);

    expect(rows(t, userId)).toEqual([expect.objectContaining({ id, backend: 'todoist', title: 'From before', todoistTaskId: task.id, todoistAccountId: account.id, choreOccurrenceId: 77 })]);
    expect(changes).toEqual([]);
  });

  it("doesn't match or delete a row by a task id kept from another Todoist account", async () => {
    const { t, userId, account } = setup();
    const task = t.fakeTodoist.addTask(account, { content: 'Same id' });
    const now = t.clock.now();
    const { id } = t.db.insert(todos)
      .values({ ownerUserId: userId, backend: 'internal', title: 'Elsewhere', todoistTaskId: task.id, todoistAccountId: 'another-account', createdAt: now, updatedAt: now })
      .returning({ id: todos.id }).get();
    // The relink lookup's 404 says nothing about a task in another account.
    const ctx = { userId, accountId: account.id, timeZone: 'America/Los_Angeles', now };
    expect(t.db.transaction((tx) => applyRelinkLookup(tx, ctx, id, { state: 'deleted' }))).toBeNull();
    expect(t.db.select().from(todos).where(eq(todos.id, id)).get()).toMatchObject({ backend: 'internal', deletedAt: null });
  });

  it('applies completions incrementally before a full sync, so none is taken for a deletion', async () => {
    const { t, todoist, userId, account, changes } = setup();
    const milk = t.fakeTodoist.addTask(account, { content: 'Milk' });
    await todoist.requestSync(userId);
    t.fakeTodoist.close(account, milk.id);
    t.clock.advance(FULL_SYNC_EVERY_MS);
    const before = t.fakeTodoist.requests.length;
    await todoist.requestSync(userId);
    const sent = t.fakeTodoist.requests.slice(before).filter((r) => r.path !== '/oauth/access_token'); // a day later, the token needs a refresh
    expect(sent.map((r) => [r.path, r.fields.sync_token === '*'])).toEqual([['/api/v1/sync', false], ['/api/v1/sync', true]]);
    expect(rows(t, userId)[0]!.completedAt).not.toBeNull();
    expect(changes.map((c) => c.after?.completedAt !== null)).toEqual([true]);
    expect(todoist.state(userId)!.lastFullSyncAt).toEqual(t.clock.now());
  });

  it('looks up each open row a full sync no longer lists: completed stays, deleted goes', async () => {
    const { t, todoist, userId, account, changes } = setup();
    const done = t.fakeTodoist.addTask(account, { content: 'Done quietly' });
    const lost = t.fakeTodoist.addTask(account, { content: 'Lost' });
    await todoist.requestSync(userId);
    // Changed in Todoist without any incremental sync reporting it.
    Object.assign(account.items.get(done.id)!, { checked: true, completed_at: '2026-11-15T13:00:00.000Z' });
    t.fakeTodoist.vanish(lost.id);
    t.clock.advance(FULL_SYNC_EVERY_MS);
    await todoist.requestSync(userId);
    const after = new Map(t.db.select().from(todos).where(eq(todos.ownerUserId, userId)).all().map((r) => [r.title, r]));
    expect(after.get('Done quietly')).toMatchObject({ completedAt: new Date('2026-11-15T13:00:00.000Z'), deletedAt: null });
    expect(after.get('Lost')!.deletedAt).not.toBeNull();
    expect(changes.map((c) => [c.before?.title, c.after ? 'completed' : 'deleted'])).toEqual([['Done quietly', 'completed'], ['Lost', 'deleted']]);
    expect(t.fakeTodoist.requests.filter((r) => r.path.startsWith('/api/v1/tasks/'))).toHaveLength(2);
  });

  it('leaves a row alone when the lookup fails, and looks it up again on the next run', async () => {
    const { t, todoist, userId, account } = setup();
    const lost = t.fakeTodoist.addTask(account, { content: 'Lost' });
    await todoist.requestSync(userId);
    const firstFull = todoist.state(userId)!.lastFullSyncAt;
    t.fakeTodoist.vanish(lost.id);
    t.clock.advance(FULL_SYNC_EVERY_MS);
    t.fakeTodoist.failures.push({ path: 'task', status: 503 });
    await todoist.requestSync(userId);
    expect(rows(t, userId)).toHaveLength(1);
    expect(todoist.state(userId)!.lastFullSyncAt).toEqual(firstFull);
    t.clock.advance(10 * 60_000);
    await todoist.requestSync(userId);
    expect(rows(t, userId)).toHaveLength(0);
  });

  it("leaves a row alone when its lookup is a 403, without refreshing or breaking the link", async () => {
    const { t, todoist, userId, account } = setup();
    const lost = t.fakeTodoist.addTask(account, { content: 'Lost' });
    await todoist.requestSync(userId);
    t.fakeTodoist.vanish(lost.id);
    t.clock.advance(FULL_SYNC_EVERY_MS);
    const before = t.fakeTodoist.requests.length;
    t.fakeTodoist.failures.push({ path: 'task', status: 403, body: { error: 'Forbidden', error_tag: 'FORBIDDEN', http_code: 403 } });
    await todoist.requestSync(userId);
    const sent = t.fakeTodoist.requests.slice(before).map((r) => r.path);
    // The day-old access token is refreshed ahead of expiry once; the 403 doesn't cause another.
    expect(sent.filter((p) => p === '/oauth/access_token')).toHaveLength(1);
    expect(sent.filter((p) => p.startsWith('/api/v1/tasks/'))).toHaveLength(1);
    expect(rows(t, userId)).toEqual([expect.objectContaining({ title: 'Lost' })]);
    expect(conn(t, userId).status).toBe('ok');
  });

  it('looks up at most CONFIRM_PER_SYNC rows per sync', async () => {
    const { t, todoist, userId, account } = setup();
    const tasks = Array.from({ length: CONFIRM_PER_SYNC + 5 }, (_, i) => t.fakeTodoist.addTask(account, { content: `Task ${i}` }));
    await todoist.requestSync(userId);
    for (const task of tasks) t.fakeTodoist.vanish(task.id);
    t.clock.advance(FULL_SYNC_EVERY_MS);
    await todoist.requestSync(userId);
    expect(rows(t, userId)).toHaveLength(5);
    t.clock.advance(10 * 60_000);
    await todoist.requestSync(userId);
    expect(rows(t, userId)).toHaveLength(0);
  });

  it('finishes the full sync once every missing row has been tried, unknown answers included, rotating through the cap', async () => {
    const { t, todoist, userId, account } = setup();
    const tasks = Array.from({ length: CONFIRM_PER_SYNC + 5 }, (_, i) => t.fakeTodoist.addTask(account, { content: `Task ${i}` }));
    await todoist.requestSync(userId);
    for (const task of tasks) t.fakeTodoist.vanish(task.id);
    t.clock.advance(FULL_SYNC_EVERY_MS);
    // The first CONFIRM_PER_SYNC lookups get a 403: unknown, so those rows stay as they are.
    for (let i = 0; i < CONFIRM_PER_SYNC; i++) t.fakeTodoist.failures.push({ path: 'task', status: 403 });
    await todoist.requestSync(userId);
    expect(rows(t, userId)).toHaveLength(CONFIRM_PER_SYNC + 5);
    const firstFull = todoist.state(userId)!.lastFullSyncAt;
    t.clock.advance(10 * 60_000);
    const before = t.fakeTodoist.requests.length;
    await todoist.requestSync(userId);
    // The next run looks up the rows not tried yet, instead of the same ones again, and doesn't
    // repeat the full sync to do it.
    const sent = t.fakeTodoist.requests.slice(before);
    expect(sent.filter((r) => r.path === '/api/v1/sync').map((r) => r.fields.sync_token === '*')).toEqual([false]);
    expect(sent.filter((r) => r.path.startsWith('/api/v1/tasks/'))).toHaveLength(5);
    expect(rows(t, userId).map((r) => r.title).sort()).toEqual(tasks.slice(0, CONFIRM_PER_SYNC).map((task) => task.content).sort());
    expect(todoist.state(userId)!.lastFullSyncAt).not.toEqual(firstFull);
    expect(todoist.state(userId)!.lastFullSyncAt).toEqual(t.clock.now());
  });

  it("doesn't count a mirror row with no task id as missing", async () => {
    const { t, todoist, userId } = setup();
    await todoist.requestSync(userId);
    const now = t.clock.now();
    t.db.insert(todos).values({ ownerUserId: userId, backend: 'todoist', title: 'No id', createdAt: now, updatedAt: now }).run();
    t.clock.advance(FULL_SYNC_EVERY_MS);
    await todoist.requestSync(userId);
    expect(todoist.state(userId)!.lastFullSyncAt).toEqual(t.clock.now());
    expect(t.fakeTodoist.requests.filter((r) => r.path.startsWith('/api/v1/tasks/'))).toEqual([]);
  });

  it('stops looking up missing rows after CONFIRM_DEADLINE_MS, and carries on next time', async () => {
    const { t, userId, account } = setup();
    // Every lookup takes 2 seconds.
    const slow: typeof fetch = async (url, init) => {
      if (String(url).includes('/api/v1/tasks/')) t.clock.advance(2_000);
      return t.fakeTodoist.fetch(url, init);
    };
    const todoist = new Todoist({ db: t.db, clock: t.clock, logger: t.logger, config: t.config.todoist!, keyring: singleKeyring(Buffer.alloc(32, 9)), fetch: slow });
    const tasks = Array.from({ length: CONFIRM_PER_SYNC }, (_, i) => t.fakeTodoist.addTask(account, { content: `Task ${i}` }));
    await todoist.requestSync(userId);
    for (const task of tasks) t.fakeTodoist.vanish(task.id);
    t.clock.advance(FULL_SYNC_EVERY_MS);
    const before = t.fakeTodoist.requests.length;
    await todoist.requestSync(userId);
    const lookups = (from: number) => t.fakeTodoist.requests.slice(from).filter((r) => r.path.startsWith('/api/v1/tasks/')).length;
    expect(lookups(before)).toBe(CONFIRM_DEADLINE_MS / 2_000);
    expect(rows(t, userId)).toHaveLength(CONFIRM_PER_SYNC - CONFIRM_DEADLINE_MS / 2_000);
    t.clock.advance(10 * 60_000);
    await todoist.requestSync(userId);
    expect(rows(t, userId)).toHaveLength(0);
  });

  it('records a lookup result that fails to apply as a failure, and keeps the row queued', async () => {
    const { t, todoist, userId, account } = setup();
    const lost = t.fakeTodoist.addTask(account, { content: 'Lost' });
    await todoist.requestSync(userId);
    t.fakeTodoist.vanish(lost.id);
    t.clock.advance(FULL_SYNC_EVERY_MS);
    t.sqlite.exec("create trigger refuse before update of deleted_at on todos when new.deleted_at is not null begin select raise(abort, 'refused'); end");
    await expect(todoist.requestSync(userId)).rejects.toMatchObject({ code: 'integration_unavailable' });
    expect(conn(t, userId)).toMatchObject({ consecutiveFailures: 1, lastError: "Couldn't save what Todoist sent. It will be tried again." });
    expect(todoist.state(userId)!.pendingLookups).toHaveLength(1);
    t.sqlite.exec('drop trigger refuse');
    t.clock.advance(10 * 60_000);
    await todoist.requestSync(userId);
    expect(rows(t, userId)).toEqual([]);
    expect(todoist.state(userId)!.lastFullSyncAt).toEqual(t.clock.now());
  });

  it("doesn't report a row whose lookup finds it open and unchanged, but does when something changed", async () => {
    const { t, todoist, userId, account } = setup();
    const milk = t.fakeTodoist.addTask(account, { content: 'Milk' });
    await todoist.requestSync(userId);
    const row = rows(t, userId)[0]!;
    const ctx = { timeZone: getFamilySettings(t.db).timeZone, now: t.clock.now() };
    const lookup = async () => (await todoist.client.getTask(storedCreds(t, userId).accessToken, milk.id))!;
    const same = await lookup();
    expect(same).toMatchObject({ state: 'open' });
    expect(t.db.transaction((tx) => applyConfirmation(tx, ctx, row.id, same))).toEqual({ change: null });
    t.fakeTodoist.change(account, milk.id, { content: 'Oat milk' });
    const edited = await lookup();
    expect(t.db.transaction((tx) => applyConfirmation(tx, ctx, row.id, edited))).toEqual({
      change: { before: expect.objectContaining({ title: 'Milk' }), after: expect.objectContaining({ title: 'Oat milk' }) },
    });
  });

  it('forgets chore-create attempts older than 7 days on each sync', async () => {
    const { t, todoist, userId } = setup();
    await todoist.requestSync(userId);
    const now = t.clock.now().getTime();
    const day = 24 * 60 * 60_000;
    t.db.update(todoistState).set({ createAttempts: { old: now - 7 * day - 1, recent: now - 6 * day } }).where(eq(todoistState.userId, userId)).run();
    t.clock.advance(60_000);
    await todoist.requestSync(userId);
    expect(todoist.state(userId)!.createAttempts).toEqual({ recent: now - 6 * day });
  });

  it('re-reads the row when a lookup comes back, and skips it if it changed meanwhile', async () => {
    const { t, userId, account, changes } = setup();
    const lost = t.fakeTodoist.addTask(account, { content: 'Lost' });
    let rowId = 0;
    const meanwhile: typeof fetch = async (url, init) => {
      // Something else completes the row while its lookup is out.
      if (String(url).includes('/api/v1/tasks/')) t.db.update(todos).set({ completedAt: t.clock.now() }).where(eq(todos.id, rowId)).run();
      return t.fakeTodoist.fetch(url, init);
    };
    const todoist = new Todoist({ db: t.db, clock: t.clock, logger: t.logger, config: t.config.todoist!, keyring: singleKeyring(Buffer.alloc(32, 9)), fetch: meanwhile });
    todoist.onRemoteChanges(async (c) => { changes.push(...c); });
    await todoist.requestSync(userId);
    rowId = rows(t, userId)[0]!.id;
    t.fakeTodoist.vanish(lost.id);
    t.clock.advance(FULL_SYNC_EVERY_MS);
    await todoist.requestSync(userId);
    expect(rows(t, userId)).toEqual([expect.objectContaining({ id: rowId, completedAt: expect.any(Date) })]);
    expect(changes).toEqual([]);
  });

  it('follows a lagging full sync with an incremental one, also when an incremental request was answered as full', async () => {
    const { t, todoist, userId } = setup();
    await todoist.requestSync(userId);
    t.fakeTodoist.fullSyncLagMs = 5 * 60_000;
    const kinds = (from: number) => t.fakeTodoist.requests.slice(from).filter((r) => r.path === '/api/v1/sync').map((r) => (r.fields.sync_token === '*' ? 'full' : 'incremental'));
    let before = t.fakeTodoist.requests.length;
    t.fakeTodoist.answerNextAsFull = true;
    t.clock.advance(60_000);
    await todoist.requestSync(userId);
    expect(kinds(before)).toEqual(['incremental', 'incremental']);
    before = t.fakeTodoist.requests.length;
    t.clock.advance(FULL_SYNC_EVERY_MS);
    await todoist.requestSync(userId);
    expect(kinds(before)).toEqual(['incremental', 'full', 'incremental']);
  });

  it("doesn't report rows a full sync lists unchanged", async () => {
    const { t, todoist, userId, account, changes } = setup();
    t.fakeTodoist.addTask(account, { content: 'Milk' });
    await todoist.requestSync(userId);
    t.clock.advance(FULL_SYNC_EVERY_MS);
    await todoist.requestSync(userId);
    expect(changes).toEqual([]);
  });

  it('falls back to Inbox for chores when the chores project is deleted in Todoist', async () => {
    const { t, todoist, userId, account } = setup();
    const chores = t.fakeTodoist.addProject(account, 'Chores');
    t.fakeTodoist.addTask(account, { content: 'Feed cat', project_id: chores.id });
    await todoist.requestSync(userId);
    todoist.setChoresProject(userId, chores.id);
    t.fakeTodoist.deleteProject(chores);
    t.clock.advance(60_000);
    await todoist.requestSync(userId);
    expect(todoist.state(userId)).toMatchObject({ choresProjectId: null, choresProjectLost: 'Chores', projects: { [account.inboxId]: 'Inbox' } });
    expect(rows(t, userId)).toEqual([]);
  });

  it('treats an archived chores project like a deleted one: Inbox, with a note until another project is picked', async () => {
    const { t, todoist, userId, account } = setup();
    const chores = t.fakeTodoist.addProject(account, 'Chores');
    const garden = t.fakeTodoist.addProject(account, 'Garden');
    await todoist.requestSync(userId);
    todoist.setChoresProject(userId, chores.id);
    t.fakeTodoist.archiveProject(chores);
    t.clock.advance(60_000);
    await todoist.requestSync(userId);
    // An archived project isn't offered for chore to-dos any more.
    expect(todoist.state(userId)).toMatchObject({
      choresProjectId: null, choresProjectLost: 'Chores', projects: { [account.inboxId]: 'Inbox', [garden.id]: 'Garden' },
    });
    expect(() => todoist.setChoresProject(userId, chores.id)).toThrow(/isn't in your Todoist/);
    // The next full sync doesn't bring it back, and the note stays until the person picks a project.
    t.clock.advance(FULL_SYNC_EVERY_MS);
    await todoist.requestSync(userId);
    expect(todoist.state(userId)).toMatchObject({ choresProjectId: null, choresProjectLost: 'Chores' });
    todoist.setChoresProject(userId, null);
    expect(todoist.state(userId)).toMatchObject({ choresProjectId: null, choresProjectLost: null });
  });

  it("logs only the error's name and SQLite code when applying fails, never the query's values", async () => {
    const { t, userId, account } = setup();
    const lines: string[] = [];
    const logger = pino({ level: 'debug' }, { write: (line: string) => { lines.push(line); } });
    const todoist = new Todoist({ db: t.db, clock: t.clock, logger, config: t.config.todoist!, keyring: singleKeyring(Buffer.alloc(32, 9)), fetch: t.fakeTodoist.fetch });
    t.fakeTodoist.addTask(account, { content: 'Surprise party for Sam' });
    t.sqlite.exec("create trigger refuse before insert on todos when new.backend = 'todoist' begin select raise(abort, 'refused'); end");
    await expect(todoist.requestSync(userId)).rejects.toMatchObject({ code: 'integration_unavailable' });
    const failure = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === "couldn't apply a todoist sync response")!;
    expect(failure).toMatchObject({ userId, error: expect.any(String), sqliteCode: 'SQLITE_CONSTRAINT_TRIGGER' });
    expect(lines.join('\n')).not.toContain('Surprise party');
  });

  it("logs only the error's name when reporting remote changes fails, never the query's values", async () => {
    const { t, userId, account } = setup();
    const lines: string[] = [];
    const logger = pino({ level: 'debug' }, { write: (line: string) => { lines.push(line); } });
    const todoist = new Todoist({ db: t.db, clock: t.clock, logger, config: t.config.todoist!, keyring: singleKeyring(Buffer.alloc(32, 9)), fetch: t.fakeTodoist.fetch });
    const task = t.fakeTodoist.addTask(account, { content: 'Surprise party for Sam' });
    await todoist.requestSync(userId);
    todoist.onRemoteChanges(async () => {
      // Like a Drizzle error, whose message quotes the query's values.
      throw Object.assign(new Error('Failed query: update "todos" set "title" = ? params: Surprise party for Sam'), { cause: Object.assign(new Error('x'), { code: 'SQLITE_BUSY' }) });
    });
    t.fakeTodoist.close(account, task.id);
    await todoist.requestSync(userId);
    const failure = lines.map((l) => JSON.parse(l) as Record<string, unknown>).find((l) => l.msg === 'reporting todoist changes failed')!;
    expect(failure).toMatchObject({ userId, error: 'Error', code: 'SQLITE_BUSY' });
    expect(lines.join(' ')).not.toContain('Surprise party');
  });

  it("records an apply that throws as a failure, and doesn't move the sync token", async () => {
    const { t, todoist, userId, account } = setup();
    t.fakeTodoist.addTask(account, { content: 'Milk' });
    t.sqlite.exec("create trigger refuse before insert on todos when new.backend = 'todoist' begin select raise(abort, 'refused'); end");
    await expect(todoist.requestSync(userId)).rejects.toMatchObject({ code: 'integration_unavailable' });
    expect(todoist.state(userId)!.syncToken).toBeNull();
    expect(conn(t, userId)).toMatchObject({ consecutiveFailures: 1, lastError: "Couldn't save what Todoist sent. It will be tried again.", lastSuccessAt: null });
    t.sqlite.exec('drop trigger refuse');
    await todoist.requestSync(userId);
    expect(rows(t, userId)).toHaveLength(1);
    expect(conn(t, userId)).toMatchObject({ status: 'ok', consecutiveFailures: 0 });
  });
});

describe('Todoist tokens and connection status', () => {
  it('refreshes ahead of expiry, storing the rotated tokens encrypted', async () => {
    const { t, todoist, userId } = setup();
    const before = storedCreds(t, userId);
    t.clock.advance(56 * 60_000); // 4 minutes before the hour is up
    await todoist.requestSync(userId);
    const refreshes = t.fakeTodoist.requests.filter((r) => r.path === '/oauth/access_token');
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]!.fields).toMatchObject({ grant_type: 'refresh_token', refresh_token: before.refreshToken });
    const after = storedCreds(t, userId);
    // New tokens from the response, a new expiry, and the sync after it used the new access token.
    expect(after.refreshToken).toMatch(/^rt-/);
    expect(after.refreshToken).not.toBe(before.refreshToken);
    expect(after.accessToken).not.toBe(before.accessToken);
    expect(after.expiresAt).toBe(t.clock.now().getTime() + 3600_000);
    expect(t.fakeTodoist.requests.at(-1)!.authorization).toBe(`Bearer ${after.accessToken}`);
    const stored = conn(t, userId).credentialsEnc;
    expect(stored).not.toContain(after.accessToken);
    expect(stored).not.toContain(after.refreshToken!);
  });

  it('refreshes once when two operations find the token expiring at the same time (single-flight)', async () => {
    const { t, todoist, userId } = setup();
    t.clock.advance(56 * 60_000);
    await Promise.all([
      todoist.requestSync(userId),
      t.todos.create({ type: 'system' }, userId, { title: 'Milk' }),
      todoist.syncBeforeRead(userId),
    ]);
    expect(t.fakeTodoist.requests.filter((r) => r.path === '/oauth/access_token')).toHaveLength(1);
    // And when Todoist expires the token early, both find out with a 401.
    t.fakeTodoist.expireAccessTokens();
    t.clock.advance(60_000);
    await Promise.all([todoist.requestSync(userId), t.todos.create({ type: 'system' }, userId, { title: 'Bread' })]);
    expect(t.fakeTodoist.requests.filter((r) => r.path === '/oauth/access_token')).toHaveLength(2);
    expect(conn(t, userId).status).toBe('ok');
  });

  it('refreshes once after a 401 and retries', async () => {
    const { t, todoist, userId } = setup();
    t.fakeTodoist.expireAccessTokens();
    await todoist.requestSync(userId);
    expect(t.fakeTodoist.requests.map((r) => r.path)).toEqual(['/api/v1/sync', '/oauth/access_token', '/api/v1/sync']);
    expect(conn(t, userId).status).toBe('ok');
  });

  it('drops the used refresh token when a refresh response has none, so the link ends in needs_reconnect', async () => {
    const { t, todoist, userId } = setup();
    // The 60-second replay grace: a new access token, no refresh token.
    t.fakeTodoist.failures.push({ path: 'token', status: 200, body: { access_token: 'at-new', token_type: 'Bearer', expires_in: 3600 } });
    t.clock.advance(56 * 60_000);
    // The fake doesn't know at-new, so the sync gets a 401. With no refresh token left, that's
    // needs_reconnect, not a second refresh with the used token.
    await expect(todoist.requestSync(userId)).rejects.toMatchObject({ code: 'integration_unavailable' });
    expect(t.fakeTodoist.requests.filter((r) => r.path === '/oauth/access_token')).toHaveLength(1);
    expect(conn(t, userId).status).toBe('needs_reconnect');
  });

  it('refreshes only on a 401: a 403 on the sync itself sets needs_reconnect without a refresh', async () => {
    const { t, todoist, userId } = setup();
    t.fakeTodoist.failures.push({ path: 'sync', status: 403, body: { error: 'Forbidden', error_tag: 'FORBIDDEN', http_code: 403 } });
    await expect(todoist.requestSync(userId)).rejects.toMatchObject({ code: 'integration_unavailable', message: expect.stringMatching(/reconnect/i) });
    expect(t.fakeTodoist.requests.map((r) => r.path)).toEqual(['/api/v1/sync']);
    expect(conn(t, userId).status).toBe('needs_reconnect');
  });

  it('sets needs_reconnect on invalid_grant, then stops calling Todoist', async () => {
    const { t, todoist, userId, account } = setup();
    t.fakeTodoist.revokeAll(account.id);
    await expect(todoist.requestSync(userId)).rejects.toMatchObject({ code: 'integration_unavailable', message: expect.stringMatching(/reconnect/i) });
    expect(conn(t, userId)).toMatchObject({ status: 'needs_reconnect', lastError: 'Todoist stopped accepting the saved sign-in.' });
    const calls = t.fakeTodoist.requests.length;
    await expect(todoist.requestSync(userId)).rejects.toMatchObject({ code: 'integration_unavailable' });
    expect(t.fakeTodoist.requests.length).toBe(calls);
    expect(todoist.needsReconnect(userId)).toBe(true);
  });

  it('sets error after 3 failures in a row, and ok again after a success', async () => {
    const { t, todoist, userId } = setup();
    for (let i = 0; i < 3; i++) {
      t.fakeTodoist.failures.push({ path: 'sync', status: 503 });
      await expect(todoist.requestSync(userId)).rejects.toMatchObject({ code: 'integration_unavailable' });
      expect(conn(t, userId).status).toBe(i < 2 ? 'ok' : 'error');
    }
    await todoist.requestSync(userId);
    expect(conn(t, userId)).toMatchObject({ status: 'ok', consecutiveFailures: 0 });
  });

  it('with a key that failed the key check, calls nothing and writes nothing', async () => {
    const { t, userId } = setup();
    const other = new Todoist({
      db: t.db, clock: t.clock, logger: t.logger, config: t.config.todoist!, keyring: singleKeyring(Buffer.alloc(32, 1)), fetch: t.fakeTodoist.fetch, keyMismatch: true,
    });
    await expect(other.requestSync(userId)).rejects.toMatchObject({ code: 'integration_unavailable', message: expect.stringMatching(/TOKEN_ENCRYPTION_KEY/) });
    expect(conn(t, userId)).toMatchObject({ status: 'ok', consecutiveFailures: 0, lastError: null });
    expect(await other.syncAll()).toEqual({ total: 0, failed: 0 });
    expect(t.fakeTodoist.requests).toEqual([]);
  });

  it("sets needs_reconnect when one row can't be decrypted with the key that passed the check", async () => {
    const { t, userId } = setup();
    const other = new Todoist({ db: t.db, clock: t.clock, logger: t.logger, config: t.config.todoist!, keyring: singleKeyring(Buffer.alloc(32, 1)), fetch: t.fakeTodoist.fetch });
    await expect(other.requestSync(userId)).rejects.toMatchObject({ code: 'integration_unavailable' });
    expect(conn(t, userId).status).toBe('needs_reconnect');
  });

  it('never logs tokens', async () => {
    const { t, userId, account } = setup();
    const lines: string[] = [];
    const logger = pino({ level: 'debug' }, { write: (line: string) => { lines.push(line); } });
    const todoist = new Todoist({ db: t.db, clock: t.clock, logger, config: t.config.todoist!, keyring: singleKeyring(Buffer.alloc(32, 9)), fetch: t.fakeTodoist.fetch });
    t.fakeTodoist.expireAccessTokens();
    await todoist.requestSync(userId);
    // The tokens that refresh left stored: the last rotated refresh token was never sent anywhere.
    const last = storedCreds(t, userId);
    t.fakeTodoist.revokeAll(account.id);
    await todoist.requestSync(userId).catch(() => {});
    const sent = t.fakeTodoist.requests.flatMap((r) => [r.fields.refresh_token, r.authorization?.replace('Bearer ', '')]).filter((v): v is string => !!v);
    expect(lines.length).toBeGreaterThan(0);
    for (const token of [...sent, last.accessToken, last.refreshToken!]) expect(lines.join('\n')).not.toContain(token);
  });
});

describe('Todoist sync scheduling', () => {
  it('joins a sync that is queued but not started, and starts a new one after a running one', async () => {
    const { t, todoist, userId } = setup();
    const first = todoist.requestSync(userId);
    const second = todoist.requestSync(userId);
    expect(second).toBe(first);
    await first;
    await todoist.requestSync(userId);
    expect(t.fakeTodoist.requests.filter((r) => r.path === '/api/v1/sync')).toHaveLength(2);
  });

  it('syncs every active linked person, skipping deactivated ones and links that need reconnecting', async () => {
    const { t, todoist, userId } = setup();
    const gone = addUser(t.db, t.clock, { email: 'gone@example.com' });
    linkTodoistForTest(t, gone);
    t.db.update(users).set({ active: false }).where(eq(users.id, gone)).run();
    const stale = addUser(t.db, t.clock, { email: 'stale@example.com' });
    linkTodoistForTest(t, stale);
    t.db.update(connections).set({ status: 'needs_reconnect' }).where(eq(connections.ownerUserId, stale)).run();

    expect(await todoist.syncAll()).toEqual({ total: 1, failed: 0 });
    expect(todoist.state(userId)!.lastSyncAt).not.toBeNull();
    expect(todoist.state(gone)!.lastSyncAt).toBeNull();
  });

  it("waits a bounded time for the drill-down's sync, then serves the mirror", async () => {
    const { t, userId } = setup();
    let release!: () => void;
    const hanging: typeof fetch = (url, init) => new Promise((resolve) => { release = () => resolve(t.fakeTodoist.fetch(url, init)); });
    const todoist = new Todoist({ db: t.db, clock: t.clock, logger: t.logger, config: t.config.todoist!, keyring: singleKeyring(Buffer.alloc(32, 9)), fetch: hanging });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let done = false;
    const read = todoist.syncBeforeRead(userId).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(LIST_SYNC_WAIT_MS - 1);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await read;
    expect(done).toBe(true);
    release();
  });

  it('maps a webhook user id to the linked person', () => {
    const { t, todoist, userId, account } = setup();
    expect(todoist.userForTodoistId(account.id)).toBe(userId);
    expect(todoist.userForTodoistId('nobody')).toBeNull();
    t.db.delete(todoistState).run();
    expect(todoist.userForTodoistId(account.id)).toBeNull();
  });
});
