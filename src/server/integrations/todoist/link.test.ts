import { and, eq, isNull } from 'drizzle-orm';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import { createApp } from '../../app.js';
import { decryptSecret, revocationAad, singleKeyring } from '../../core/crypto.js';
import { connections, panelGrants, pendingRevocations, todoistState, todos } from '../../db/schema.js';
import type { FakeAccount } from '../../test/fakeTodoist.js';
import { addUser, call, cookieFor, makeTestApp, TEST_ENCRYPTION_KEY, type TestApp } from '../../test/helpers.js';
import { TODOIST_LINK_ERRORS } from '../../../shared/integrations.js';
import { checkTokenKey, keyMismatchWarning } from '../keyCheck.js';
import { Todoist } from './todoist.js';

function cookieHeader(res: Response): string {
  return res.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
}

/** POST /connect/todoist/start, as the settings page sends it (with the CSRF headers). */
async function start(t: TestApp, session: string) {
  const res = await call(t.app, 'POST', '/connect/todoist/start', { cookie: session });
  expect(res.status).toBe(200);
  return { res, url: new URL(((await res.json()) as { url: string }).url) };
}

/** Runs the whole flow: start, Todoist's consent page (the fake approves at once), callback. */
async function connect(t: TestApp, session: string, opts: { tamper?: (u: URL) => void; account?: FakeAccount } = {}) {
  const started = await start(t, session);
  if (opts.account) t.fakeTodoist.nextAccounts.push(opts.account.id);
  const back = t.fakeTodoist.authorize(started.url.searchParams);
  opts.tamper?.(back);
  return t.app.request(back.pathname + back.search, { headers: { cookie: `${session}; ${cookieHeader(started.res)}` } });
}

function setup() {
  const t = makeTestApp({ todoist: true });
  const kid = addUser(t.db, t.clock, { email: 'kid@example.com', panels: ['todo', 'chores'] });
  return { t, kid, session: cookieFor(t.db, t.clock, kid) };
}

function addInternal(t: TestApp, owner: number, fields: Partial<typeof todos.$inferInsert> = {}): number {
  const now = t.clock.now();
  return t.db.insert(todos).values({ ownerUserId: owner, backend: 'internal', title: 'Item', createdAt: now, updatedAt: now, ...fields }).returning({ id: todos.id }).get().id;
}

function liveRows(t: TestApp, owner: number) {
  return t.db.select().from(todos).where(and(eq(todos.ownerUserId, owner), isNull(todos.deletedAt))).all();
}

describe('/connect/todoist', () => {
  it("is a 404 when Todoist isn't configured", async () => {
    const t = makeTestApp();
    const kid = addUser(t.db, t.clock, { panels: ['todo'] });
    expect((await call(t.app, 'POST', '/connect/todoist/start', { cookie: cookieFor(t.db, t.clock, kid) })).status).toBe(404);
    expect((await call(t.app, 'GET', '/connect/todoist/callback')).status).toBe(404);
  });

  it('starts only for a signed-in user with the To-do panel, with state and PKCE S256', async () => {
    const { t, session } = setup();
    expect((await call(t.app, 'POST', '/connect/todoist/start')).status).toBe(401);
    const noPanel = addUser(t.db, t.clock, { email: 'nopanel@example.com' });
    const refused = await call(t.app, 'POST', '/connect/todoist/start', { cookie: cookieFor(t.db, t.clock, noPanel) });
    expect(refused.status).toBe(403);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toMatch(/To-do panel/);
    const { res: started, url } = await start(t, session);
    expect(url.origin + url.pathname).toBe('https://app.todoist.test/oauth/authorize');
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3000/connect/todoist/callback');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('scope')).toBe('data:read_write,data:delete');
    const flow = started.headers.getSetCookie().find((c) => c.startsWith('__Host-todoist-flow='))!;
    expect(flow).toMatch(/HttpOnly/);
    expect(flow).toMatch(/Secure/);
    expect(flow).toMatch(/Max-Age=600/);
  });

  it('allows 10 requests a minute per signed-in user', async () => {
    const { t, session } = setup();
    for (let i = 0; i < 10; i++) expect((await call(t.app, 'POST', '/connect/todoist/start', { cookie: session })).status).toBe(200);
    expect((await call(t.app, 'POST', '/connect/todoist/start', { cookie: session })).status).toBe(429);
    const sib = addUser(t.db, t.clock, { email: 'sib@example.com', panels: ['todo'] });
    expect((await call(t.app, 'POST', '/connect/todoist/start', { cookie: cookieFor(t.db, t.clock, sib) })).status).toBe(200);
  });

  it("can't be started by another site: no CSRF header or a foreign Origin is refused, and GET isn't a route", async () => {
    const { t, session } = setup();
    const noHeader = await call(t.app, 'POST', '/connect/todoist/start', { cookie: session, csrf: false });
    expect(noHeader.status).toBe(403);
    expect(noHeader.headers.getSetCookie().some((c) => c.startsWith('__Host-todoist-flow='))).toBe(false);
    const foreign = await t.app.request('/connect/todoist/start', {
      method: 'POST',
      headers: { cookie: session, 'x-requested-with': 'dashboard', origin: 'https://evil.example' },
    });
    expect(foreign.status).toBe(403);
    expect((await call(t.app, 'GET', '/connect/todoist/start', { cookie: session })).status).toBe(404);
  });

  it('links: stores encrypted tokens, mirrors Todoist, and moves open to-dos in place', async () => {
    const { t, kid, session } = setup();
    const account = t.fakeTodoist.createAccount();
    t.fakeTodoist.addTask(account, { content: 'Already in Todoist' });
    const chore = addInternal(t, kid, { title: 'Feed cat', choreOccurrenceId: 12 });
    const plain = addInternal(t, kid, { title: 'Buy milk' });
    const done = addInternal(t, kid, { title: 'Old', completedAt: t.clock.now() });

    const res = await connect(t, session, { account });
    expect(res.headers.get('location')).toBe('/settings?todoist=connected');
    await t.todoist!.migrate(kid); // waits behind the migration the callback started

    const conn = t.db.select().from(connections).get()!;
    expect(conn).toMatchObject({ kind: 'todoist', scope: 'user', ownerUserId: kid, status: 'ok', meta: { account: account.email } });
    for (const r of t.fakeTodoist.requests) {
      const bearer = r.authorization?.replace('Bearer ', '');
      if (bearer?.startsWith('at-')) expect(conn.credentialsEnc).not.toContain(bearer);
    }
    expect(t.db.select().from(todoistState).get()).toMatchObject({ userId: kid, todoistUserId: account.id, inboxProjectId: account.inboxId });
    const rows = new Map(liveRows(t, kid).map((r) => [r.title, r]));
    expect(rows.get('Feed cat')).toMatchObject({ id: chore, backend: 'todoist', choreOccurrenceId: 12, todoistProjectId: account.inboxId });
    expect(rows.get('Buy milk')).toMatchObject({ id: plain, backend: 'todoist' });
    expect(rows.get('Old')).toMatchObject({ id: done, backend: 'internal' });
    expect(rows.get('Already in Todoist')).toMatchObject({ backend: 'todoist' });
    expect([...account.items.values()].map((i) => i.content).sort()).toEqual(['Already in Todoist', 'Buy milk', 'Feed cat']);
    expect(t.todoist!.waitingToMove(kid)).toBe(0);
  });

  it('refuses a callback from another session, with a wrong state, or without the flow cookie', async () => {
    const { t, kid, session } = setup();
    const otherSession = cookieFor(t.db, t.clock, kid);
    const started = await start(t, session);
    const back = t.fakeTodoist.authorize(started.url.searchParams);
    const path = back.pathname + back.search;
    const flow = cookieHeader(started.res);
    expect((await t.app.request(path, { headers: { cookie: `${otherSession}; ${flow}` } })).headers.get('location')).toBe('/settings?todoist_error=expired');
    expect((await t.app.request(path, { headers: { cookie: session } })).headers.get('location')).toBe('/settings?todoist_error=expired');
    const wrong = new URL(back);
    wrong.searchParams.set('state', 'forged');
    expect((await t.app.request(wrong.pathname + wrong.search, { headers: { cookie: `${session}; ${flow}` } })).headers.get('location'))
      .toBe('/settings?todoist_error=expired');
    expect(t.db.select().from(connections).all()).toEqual([]);
  });

  it('shows a plain error when access is denied or the exchange fails, and logs no secrets', async () => {
    const { t, session } = setup();
    t.fakeTodoist.denyNext = true;
    expect((await connect(t, session)).headers.get('location')).toBe('/settings?todoist_error=denied');
    const lines: string[] = [];
    t.logger = pino({ level: 'debug' }, { write: (l: string) => { lines.push(l); } });
    t.app = createApp(t);
    let code = '';
    const res = await connect(t, session, { tamper: (u) => { code = u.searchParams.get('code')!; u.searchParams.set('code', 'not-a-real-code'); } });
    expect(res.headers.get('location')).toBe('/settings?todoist_error=failed');
    expect(lines.join('\n')).toContain('bad_authorization_code');
    expect(lines.join('\n')).not.toContain(code);
    expect(lines.join('\n')).not.toContain(t.fakeTodoist.clientSecret);
  });

  it("refuses a Todoist account that's linked to someone else, and a different account on reconnect", async () => {
    const { t, kid, session } = setup();
    const account = t.fakeTodoist.createAccount();
    await connect(t, session, { account });
    const sibling = addUser(t.db, t.clock, { email: 'sib@example.com', panels: ['todo'] });
    const res = await connect(t, cookieFor(t.db, t.clock, sibling), { account });
    expect(res.headers.get('location')).toBe('/settings?todoist_error=in_use');
    expect(t.todoist!.isLinked(sibling)).toBe(false);
    // Not revoked: that could end the kid's link to the same account.
    expect(t.fakeTodoist.requests.filter((r) => r.path === '/api/v1/revoke')).toEqual([]);
    t.db.update(connections).set({ status: 'needs_reconnect' }).run();
    expect((await connect(t, session)).headers.get('location')).toBe('/settings?todoist_error=other_account');
    expect(t.todoist!.state(kid)!.todoistUserId).toBe(account.id);
    // Nobody will use the other account's new tokens: both are revoked.
    expect(t.fakeTodoist.requests.filter((r) => r.path === '/api/v1/revoke').map((r) => r.fields.token_type_hint ?? null)).toEqual(['access_token', null]);
  });

  it('answers in_use when someone else links the same account at the same moment', async () => {
    const { t, kid } = setup();
    const sibling = addUser(t.db, t.clock, { email: 'sib@example.com', panels: ['todo'] });
    const account = t.fakeTodoist.createAccount();
    const tokens = t.fakeTodoist.grant(account);
    let syncs = 0;
    // The sibling's link to the same account commits while the kid's first sync is out.
    const racing: typeof fetch = async (url, init) => {
      if (String(url).endsWith('/api/v1/sync') && ++syncs === 2) {
        const now = t.clock.now();
        t.db.insert(todoistState).values({ userId: sibling, todoistUserId: account.id, createdAt: now, updatedAt: now }).run();
      }
      return t.fakeTodoist.fetch(url, init);
    };
    const todoist = new Todoist({ db: t.db, clock: t.clock, logger: t.logger, config: t.config.todoist!, keyring: singleKeyring(TEST_ENCRYPTION_KEY), fetch: racing });
    const link = todoist.link(kid, { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: null });
    await expect(link).resolves.toBe('in_use');
    expect(todoist.isLinked(kid)).toBe(false);
  });

  it("won't start a link while TOKEN_ENCRYPTION_KEY doesn't match, with a plain error", async () => {
    const t = makeTestApp({ todoist: true, keyMismatch: true });
    const kid = addUser(t.db, t.clock, { email: 'kid@example.com', panels: ['todo'] });
    const res = await call(t.app, 'POST', '/connect/todoist/start', { cookie: cookieFor(t.db, t.clock, kid) });
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { message: string } }).error.message).toBe(TODOIST_LINK_ERRORS.key_mismatch);
    expect(res.headers.getSetCookie().some((c) => c.startsWith('__Host-todoist-flow='))).toBe(false);
  });

  it('sends a rate-limited callback back to /settings with a plain error, not JSON', async () => {
    const { t, session } = setup();
    const started = await start(t, session);
    for (let i = 0; i < 9; i++) await call(t.app, 'POST', '/connect/todoist/start', { cookie: session });
    const back = t.fakeTodoist.authorize(started.url.searchParams);
    const res = await t.app.request(back.pathname + back.search, { headers: { cookie: `${session}; ${cookieHeader(started.res)}` } });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/settings?todoist_error=rate_limited');
    expect(t.db.select().from(connections).all()).toEqual([]);
  });

  it("refuses the callback for someone who lost the To-do panel since starting", async () => {
    const { t, kid, session } = setup();
    const started = await start(t, session);
    t.db.delete(panelGrants).where(and(eq(panelGrants.userId, kid), eq(panelGrants.panelId, 'todo'))).run();
    const back = t.fakeTodoist.authorize(started.url.searchParams);
    const res = await t.app.request(back.pathname + back.search, { headers: { cookie: `${session}; ${cookieHeader(started.res)}` } });
    expect(res.headers.get('location')).toBe('/settings?todoist_error=no_panel');
    expect(t.db.select().from(connections).all()).toEqual([]);
    expect(t.fakeTodoist.requests.filter((r) => r.path === '/oauth/access_token')).toEqual([]);
  });

  it('stores nothing if the first sync after the consent page fails to apply', async () => {
    const { t, kid, session } = setup();
    const account = t.fakeTodoist.createAccount();
    t.fakeTodoist.addTask(account, { content: 'Milk' });
    t.sqlite.exec("create trigger refuse before insert on todos when new.backend = 'todoist' begin select raise(abort, 'refused'); end");
    expect((await connect(t, session, { account })).headers.get('location')).toBe('/settings?todoist_error=failed');
    expect(t.db.select().from(connections).all()).toEqual([]);
    expect(t.db.select().from(todoistState).all()).toEqual([]);
    t.sqlite.exec('drop trigger refuse');
    expect((await connect(t, cookieFor(t.db, t.clock, kid), { account })).headers.get('location')).toBe('/settings?todoist=connected');
  });

  it('a reconnect picks up from the stored sync token, so a completion while it was broken is a completion', async () => {
    const { t, kid, session } = setup();
    const account = t.fakeTodoist.createAccount();
    const milk = t.fakeTodoist.addTask(account, { content: 'Milk' });
    await connect(t, session, { account });
    const changes: { title?: string; completed: boolean | null }[] = [];
    t.todoist!.onRemoteChanges(async (cs) => { for (const c of cs) changes.push({ title: c.before?.title, completed: c.after ? c.after.completedAt !== null : null }); });
    t.fakeTodoist.revokeAll(account.id);
    await expect(t.todoist!.requestSync(kid)).rejects.toMatchObject({ code: 'integration_unavailable' });
    t.fakeTodoist.close(account, milk.id);
    const stored = t.todoist!.state(kid)!.syncToken;
    expect((await connect(t, cookieFor(t.db, t.clock, kid), { account })).headers.get('location')).toBe('/settings?todoist=connected');
    const syncs = t.fakeTodoist.requests.filter((r) => r.path === '/api/v1/sync');
    expect(syncs.at(-1)!.fields.sync_token).toBe(stored);
    expect(changes).toEqual([{ title: 'Milk', completed: true }]);
  });

  it('reconnects the same account: new tokens, status ok, the mirror kept', async () => {
    const { t, kid, session } = setup();
    const account = t.fakeTodoist.createAccount();
    t.fakeTodoist.addTask(account, { content: 'Milk' });
    await connect(t, session, { account });
    const before = liveRows(t, kid);
    t.fakeTodoist.revokeAll(account.id);
    await expect(t.todoist!.requestSync(kid)).rejects.toMatchObject({ code: 'integration_unavailable' });
    expect(t.todoist!.needsReconnect(kid)).toBe(true);
    expect((await connect(t, session, { account })).headers.get('location')).toBe('/settings?todoist=connected');
    expect(t.todoist!.connection(kid)!.status).toBe('ok');
    expect(liveRows(t, kid).map((r) => r.id)).toEqual(before.map((r) => r.id));
  });
});

describe('moving to-dos into Todoist', () => {
  it('moves to-dos in batches: one request for several rows', async () => {
    const { t, kid, session } = setup();
    const account = t.fakeTodoist.createAccount();
    for (const title of ['One', 'Two', 'Three']) addInternal(t, kid, { title });
    await connect(t, session, { account });
    await t.todoist!.migrate(kid);
    const adds = t.fakeTodoist.requests.filter((r) => r.path === '/api/v1/sync' && r.fields.commands);
    expect(adds.map((r) => (JSON.parse(r.fields.commands!) as unknown[]).length)).toEqual([3]);
  });

  it('survives a lost response: a rerun sends the same commands and adds no duplicates', async () => {
    const { t, kid, session } = setup();
    const account = t.fakeTodoist.createAccount();
    const ids = [addInternal(t, kid, { title: 'One' }), addInternal(t, kid, { title: 'Two' }), addInternal(t, kid, { title: 'Three' })];
    // The move runs in Todoist but its response is lost; the run stops there.
    t.fakeTodoist.loseNextResponse = true;
    await connect(t, session, { account });
    await expect(t.todoist!.migrate(kid)).resolves.toMatchObject({ waiting: 0 }); // the retry run
    expect(liveRows(t, kid).map((r) => [r.id, r.backend])).toEqual(ids.map((id) => [id, 'todoist']));
    expect([...account.items.values()].map((i) => i.content).sort()).toEqual(['One', 'Three', 'Two']);
  });

  it("marks a to-do Todoist refuses, leaves it on the dashboard, and stops counting it as waiting", async () => {
    const { t, kid, session } = setup();
    const account = t.fakeTodoist.createAccount();
    const refused = addInternal(t, kid, { title: 'Refused' });
    t.fakeTodoist.commandErrors.set('item_add', { error_tag: 'INVALID_ARGUMENT_VALUE', error_code: 20, error: 'Invalid argument value', http_code: 400 });
    await connect(t, session, { account });
    await t.todoist!.migrate(kid);
    expect(liveRows(t, kid)).toEqual([expect.objectContaining({ id: refused, backend: 'internal', todoistMoveError: 'INVALID_ARGUMENT_VALUE' })]);
    expect(t.todoist!.waitingToMove(kid)).toBe(0);
    await t.todoist!.unlink(kid);
    expect(liveRows(t, kid)[0]!.todoistMoveError).toBeNull();
  });

  it('relinking matches open rows to their tasks by task id instead of creating them again', async () => {
    const { t, kid, session } = setup();
    const account = t.fakeTodoist.createAccount();
    const id = addInternal(t, kid, { title: 'Keep me', choreOccurrenceId: 3 });
    await connect(t, session, { account });
    await t.todoist!.migrate(kid);
    await t.todoist!.unlink(kid);
    expect(liveRows(t, kid)).toEqual([expect.objectContaining({ id, backend: 'internal', todoistTaskId: expect.any(String) })]);
    await connect(t, cookieFor(t.db, t.clock, kid), { account });
    await t.todoist!.migrate(kid);
    expect(liveRows(t, kid)).toEqual([expect.objectContaining({ id, backend: 'todoist', choreOccurrenceId: 3 })]);
    expect([...account.items.values()].filter((i) => !i.is_deleted)).toHaveLength(1);
  });

  it("on a relink, looks up each kept task the sync didn't list before adding it again", async () => {
    const { t, kid, session } = setup();
    const account = t.fakeTodoist.createAccount();
    const ids = Object.fromEntries(['Done there', 'Deleted there', 'Hidden there'].map((title, i) => [title, addInternal(t, kid, { title, choreOccurrenceId: 40 + i })]));
    await connect(t, session, { account });
    await t.todoist!.migrate(kid);
    await t.todoist!.unlink(kid);
    const byTitle = (title: string) => [...account.items.values()].find((i) => i.content === title)!;
    // While unlinked: one is checked off in Todoist, one deleted, and one checked off in a way this
    // account can no longer look up (a 403), so nothing can be told about it.
    t.fakeTodoist.close(account, byTitle('Done there').id);
    t.fakeTodoist.change(account, byTitle('Deleted there').id, { is_deleted: true });
    t.fakeTodoist.close(account, byTitle('Hidden there').id);
    t.fakeTodoist.forbiddenTasks.add(byTitle('Hidden there').id);
    const changes: [string | undefined, string][] = [];
    t.todoist!.onRemoteChanges(async (cs) => { for (const c of cs) changes.push([c.before?.title, c.after ? (c.after.completedAt ? 'completed' : 'open') : 'deleted']); });

    await connect(t, cookieFor(t.db, t.clock, kid), { account });
    await t.todoist!.migrate(kid);

    const all = new Map(t.db.select().from(todos).where(eq(todos.ownerUserId, kid)).all().map((r) => [r.title, r]));
    expect(all.get('Done there')).toMatchObject({ id: ids['Done there'], backend: 'todoist', completedAt: expect.any(Date), deletedAt: null, todoistTaskId: byTitle('Done there').id });
    expect(all.get('Deleted there')).toMatchObject({ id: ids['Deleted there'], deletedAt: expect.any(Date) });
    expect(all.get('Hidden there')).toMatchObject({ id: ids['Hidden there'], backend: 'todoist', completedAt: null });
    expect(all.get('Hidden there')!.todoistTaskId).not.toBe(byTitle('Hidden there').id); // added again: the only safe choice
    expect(changes.sort()).toEqual([['Deleted there', 'deleted'], ['Done there', 'completed']]);
    expect([...account.items.values()].filter((i) => i.content === 'Done there' || i.content === 'Deleted there')).toHaveLength(2);
  });
});

describe('unlinking', () => {
  it('converts every mirror row in place, deletes the state and connection, and revokes the tokens', async () => {
    const { t, kid, session } = setup();
    const account = t.fakeTodoist.createAccount();
    t.fakeTodoist.addTask(account, { content: 'Open' });
    t.fakeTodoist.close(account, t.fakeTodoist.addTask(account, { content: 'Done' }).id);
    await connect(t, session, { account });
    const before = liveRows(t, kid);
    expect(before).toHaveLength(1); // a full sync lists only active tasks
    await t.todoist!.unlink(kid);
    expect(liveRows(t, kid).map((r) => [r.id, r.backend])).toEqual(before.map((r) => [r.id, 'internal']));
    expect(t.db.select().from(todoistState).all()).toEqual([]);
    expect(t.db.select().from(connections).all()).toEqual([]);
    const revokes = t.fakeTodoist.requests.filter((r) => r.path === '/api/v1/revoke');
    expect(revokes.map((r) => r.fields.token_type_hint ?? null)).toEqual(['access_token', null]);
    expect(revokes[0]!.authorization).toMatch(/^Basic /);
    expect(liveRows(t, kid)[0]!.todoistTaskId).not.toBeNull(); // open rows keep it, for a relink
    expect(t.todos.backendFor(kid).kind).toBe('internal');
  });

  it('revokes the tokens first, and only then deletes the link', async () => {
    const { t, kid, session } = setup();
    await connect(t, session);
    const linkedWhileRevoking: boolean[] = [];
    const watching: typeof fetch = async (url, init) => {
      if (String(url).endsWith('/api/v1/revoke')) linkedWhileRevoking.push(t.db.select().from(connections).all().length === 1);
      return t.fakeTodoist.fetch(url, init);
    };
    const todoist = new Todoist({ db: t.db, clock: t.clock, logger: t.logger, config: t.config.todoist!, keyring: singleKeyring(TEST_ENCRYPTION_KEY), fetch: watching });
    await todoist.unlink(kid);
    expect(linkedWhileRevoking).toEqual([true, true]);
    expect(todoist.isLinked(kid)).toBe(false);
  });

  it("unlinks even when Todoist is unreachable for the revocation, keeps the tokens it couldn't revoke, and retries them", async () => {
    const { t, kid, session } = setup();
    const account = t.fakeTodoist.createAccount();
    await connect(t, session, { account });
    const tokens = t.fakeTodoist.requests.filter((r) => r.authorization?.startsWith('Bearer ')).at(-1)!.authorization!.slice('Bearer '.length);
    t.fakeTodoist.failures.push({ path: 'revoke', status: 503 }, { path: 'revoke', status: 503 });
    await t.todoist!.unlink(kid);
    expect(t.todoist!.isLinked(kid)).toBe(false);
    const pending = t.db.select().from(pendingRevocations).all();
    expect(pending).toEqual([expect.objectContaining({ kind: 'todoist', ownerUserId: kid, attempts: 0 })]);
    expect(pending[0]!.credentialsEnc).toMatch(/^v1\./);
    expect(pending[0]!.credentialsEnc).not.toContain(tokens);
    expect(t.todoist!.warnings()).toEqual([expect.stringMatching(/couldn't revoke/i)]);

    // The hourly retry: Todoist is down again, then back.
    t.fakeTodoist.failures.push({ path: 'revoke', status: 503 }, { path: 'revoke', status: 503 });
    expect(await t.todoist!.retryRevocations()).toEqual({ total: 1, failed: 1 });
    expect(t.db.select().from(pendingRevocations).get()).toMatchObject({ attempts: 1, lastError: expect.any(String) });
    expect(await t.todoist!.retryRevocations()).toEqual({ total: 1, failed: 0 });
    expect(t.db.select().from(pendingRevocations).all()).toEqual([]);
    expect(t.todoist!.warnings()).toEqual([]);
    await expect(t.todoist!.client.sync(tokens, { syncToken: '*' })).rejects.toMatchObject({ kind: 'auth' });
  });

  it('drops a waiting revocation instead of revoking it once the owner has linked that same account again', async () => {
    const { t, kid, session } = setup();
    const account = t.fakeTodoist.createAccount();
    await connect(t, session, { account });
    t.fakeTodoist.failures.push({ path: 'revoke', status: 503 }, { path: 'revoke', status: 503 });
    await t.todoist!.unlink(kid);
    expect(t.db.select().from(pendingRevocations).get()).toMatchObject({ ownerUserId: kid, accountId: account.id });
    await connect(t, cookieFor(t.db, t.clock, kid), { account });
    const before = t.fakeTodoist.requests.length;
    expect(await t.todoist!.retryRevocations()).toEqual({ total: 1, failed: 0 });
    expect(t.fakeTodoist.requests.slice(before).filter((r) => r.path === '/api/v1/revoke')).toEqual([]);
    expect(t.db.select().from(pendingRevocations).all()).toEqual([]);
    await expect(t.todoist!.requestSync(kid)).resolves.toBeUndefined();
  });

  it('still revokes a waiting revocation when the owner linked a different account since', async () => {
    const { t, kid, session } = setup();
    await connect(t, session, { account: t.fakeTodoist.createAccount() });
    t.fakeTodoist.failures.push({ path: 'revoke', status: 503 }, { path: 'revoke', status: 503 });
    await t.todoist!.unlink(kid);
    await connect(t, cookieFor(t.db, t.clock, kid), { account: t.fakeTodoist.createAccount() });
    const before = t.fakeTodoist.requests.length;
    expect(await t.todoist!.retryRevocations()).toEqual({ total: 1, failed: 0 });
    expect(t.fakeTodoist.requests.slice(before).filter((r) => r.path === '/api/v1/revoke')).toHaveLength(2);
    await expect(t.todoist!.requestSync(kid)).resolves.toBeUndefined();
  });

  it("keeps only the token that couldn't be revoked", async () => {
    const { t, kid, session } = setup();
    await connect(t, session);
    t.fakeTodoist.failures.push({ path: 'revoke', status: 503 }); // the access token's
    await t.todoist!.unlink(kid);
    const left = decryptSecret(singleKeyring(TEST_ENCRYPTION_KEY), t.db.select().from(pendingRevocations).get()!.credentialsEnc, revocationAad('todoist', kid));
    expect(JSON.parse(left)).toEqual({ accessToken: expect.stringMatching(/^at-/), refreshToken: null });
  });

  it("refuses to unlink while TOKEN_ENCRYPTION_KEY doesn't match", async () => {
    const { t, kid, session } = setup();
    await connect(t, session);
    const mismatched = new Todoist({
      db: t.db, clock: t.clock, logger: t.logger, config: t.config.todoist!, keyring: singleKeyring(Buffer.alloc(32, 1)), fetch: t.fakeTodoist.fetch, keyMismatch: true,
    });
    await expect(mismatched.unlink(kid)).rejects.toMatchObject({ code: 'integration_unavailable', message: expect.stringMatching(/TOKEN_ENCRYPTION_KEY/) });
    expect(t.todoist!.isLinked(kid)).toBe(true);
  });
});

describe('resetting Todoist links for a new TOKEN_ENCRYPTION_KEY (the old key is lost)', () => {
  /** Two people linked with the old key, then the app restarted with a new one. */
  async function withLostKey() {
    const { t, kid, session } = setup();
    const other = addUser(t.db, t.clock, { email: 'other@example.com', panels: ['todo'] });
    await connect(t, session);
    await connect(t, cookieFor(t.db, t.clock, other));
    checkTokenKey(t.db, singleKeyring(TEST_ENCRYPTION_KEY));
    const created = await t.todos.create({ type: 'user', userId: kid, role: 'member' }, kid, { title: 'Milk' });
    t.fakeTodoist.failures.push({ path: 'revoke', status: 503 }, { path: 'revoke', status: 503 });
    await t.todoist!.unlink(other);
    await connect(t, cookieFor(t.db, t.clock, other));
    expect(t.db.select().from(pendingRevocations).all()).toHaveLength(1);
    const newKey = singleKeyring(Buffer.alloc(32, 1));
    expect(checkTokenKey(t.db, newKey)).toBe('mismatch');
    const todoist = new Todoist({ db: t.db, clock: t.clock, logger: t.logger, config: t.config.todoist!, keyring: newKey, fetch: t.fakeTodoist.fetch, keyMismatch: true });
    return { t, kid, other, todoist, newKey, created };
  }

  it('turns every link back into dashboard lists in place, deletes the unreadable tokens, and takes the new key', async () => {
    const { t, kid, other, todoist, newKey, created } = await withLostKey();
    const requestsBefore = t.fakeTodoist.requests.length;
    expect(todoist.warnings()).toEqual([keyMismatchWarning({ todoist: true }), expect.stringMatching(/couldn't revoke/i)]);
    expect(await todoist.resetLinksForNewKey()).toEqual({ unlinked: 2 });

    expect(todoist.keyMismatch).toBe(false);
    expect(checkTokenKey(t.db, newKey)).toBe('ok');
    expect(t.db.select().from(connections).all()).toEqual([]);
    expect(t.db.select().from(todoistState).all()).toEqual([]);
    expect(t.db.select().from(pendingRevocations).all()).toEqual([]);
    expect(todoist.warnings()).toEqual([]);
    // Nothing could be revoked or synced: the tokens can't be read.
    expect(t.fakeTodoist.requests.length).toBe(requestsBefore);
    // Same row, now on the dashboard, keeping its task id so a later link matches it.
    expect(t.db.select().from(todos).where(eq(todos.id, created.id)).get()).toMatchObject({ ownerUserId: kid, backend: 'internal', todoistTaskId: expect.any(String) });
    expect(t.db.select().from(todos).where(eq(todos.ownerUserId, other)).all().every((r) => r.backend === 'internal')).toBe(true);
    // And linking works again.
    expect(todoist.isLinked(kid)).toBe(false);
  });

  it('after a reset, linking a different account moves the kept to-dos there instead of deleting them', async () => {
    const { t, kid, todoist, created } = await withLostKey();
    await todoist.resetLinksForNewKey();
    const work = t.fakeTodoist.createAccount({ email: 'work@example.com' });
    const tokens = t.fakeTodoist.grant(work);
    expect(await todoist.link(kid, { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: null })).toBe('linked');
    expect(await todoist.migrate(kid)).toEqual({ moved: 1, waiting: 0 });
    const row = t.db.select().from(todos).where(eq(todos.id, created.id)).get()!;
    expect(row).toMatchObject({ deletedAt: null, backend: 'todoist', todoistAccountId: work.id });
    expect(work.items.get(row.todoistTaskId!)).toMatchObject({ content: 'Milk' });
  });

  it('is refused while the key matches', async () => {
    const { t } = setup();
    await expect(t.todoist!.resetLinksForNewKey()).rejects.toMatchObject({ code: 'conflict' });
  });

  it('is an admin action on the System page, offered only while the key does not match', async () => {
    const t = makeTestApp({ todoist: true, keyMismatch: true });
    const admin = addUser(t.db, t.clock, { email: 'admin@example.com', role: 'admin' });
    const kid = addUser(t.db, t.clock, { email: 'kid@example.com', panels: ['todo'] });
    const adminCookie = cookieFor(t.db, t.clock, admin);
    const info = async () => (await (await call(t.app, 'GET', '/api/admin/system', { cookie: adminCookie })).json()) as { warnings: string[]; keyMismatch: boolean };
    expect(await info()).toMatchObject({ warnings: [keyMismatchWarning({ todoist: true })], keyMismatch: true });
    expect((await call(t.app, 'POST', '/api/admin/integrations/reset-links', { cookie: cookieFor(t.db, t.clock, kid) })).status).toBe(403);
    expect((await call(t.app, 'POST', '/api/admin/integrations/reset-links', { cookie: adminCookie, csrf: false })).status).toBe(403);
    const res = await call(t.app, 'POST', '/api/admin/integrations/reset-links', { cookie: adminCookie });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ calendarDisconnected: false, todoistUnlinked: 0, banksForgotten: 0 });
    expect(await info()).toMatchObject({ warnings: [], keyMismatch: false });
    expect((await call(t.app, 'POST', '/api/admin/integrations/reset-links', { cookie: adminCookie })).status).toBe(409);
  });

  it("won't start or finish a link while the key doesn't match, with the key_mismatch error", async () => {
    const { t, kid, session } = setup();
    const started = await start(t, session);
    // The key check fails while the person is on Todoist's consent page (say, after a restart).
    const mismatched = new Todoist({
      db: t.db, clock: t.clock, logger: t.logger, config: t.config.todoist!, keyring: singleKeyring(Buffer.alloc(32, 1)), fetch: t.fakeTodoist.fetch, keyMismatch: true,
    });
    const app = createApp({ ...t, todoist: mismatched });
    const back = t.fakeTodoist.authorize(started.url.searchParams);
    const res = await app.request(back.pathname + back.search, { headers: { cookie: `${session}; ${cookieHeader(started.res)}` } });
    expect(res.headers.get('location')).toBe('/settings?todoist_error=key_mismatch');
    // The code wasn't exchanged, so no token was issued and left unrevoked.
    expect(t.fakeTodoist.requests.filter((r) => r.path === '/oauth/access_token')).toEqual([]);
    expect(t.todoist!.isLinked(kid)).toBe(false);
    const refused = await call(app, 'POST', '/connect/todoist/start', { cookie: session });
    expect(refused.status).toBe(503);
    expect(((await refused.json()) as { error: { message: string } }).error.message).toBe(TODOIST_LINK_ERRORS.key_mismatch);
  });
});
