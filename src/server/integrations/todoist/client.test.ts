import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { TodoistConfig } from '../../config.js';
import { FakeTodoist } from '../../test/fakeTodoist.js';
import {
  COMMAND_ERROR, COMMAND_RESPONSE, INBOX_PROJECT, ITEM, LIVE_DELETED_ITEM, LIVE_INVALID_TOKEN, LIVE_ITEM_NOT_FOUND, LIVE_TASK_BAD_ID,
  LIVE_TASK_COMPLETED, LIVE_TASK_NOT_FOUND, TOKEN_ERROR_BAD_CODE, TOKEN_RESPONSE,
} from '../../test/todoistFixtures.js';
import { MAX_TASK_PAGES, TodoistClient, TodoistHttpError, TodoistOAuthError } from './client.js';

const NOW = new Date('2026-11-15T12:00:00Z');
const cfg: TodoistConfig = {
  clientId: 'fake-client-id',
  clientSecret: 'fake-client-secret',
  apiBaseUrl: 'https://api.todoist.test',
  oauthBaseUrl: 'https://app.todoist.test',
};

/** A fetch that answers every request with one canned response, and records what was sent. */
function canned(body: unknown, status = 200, headers: Record<string, string> = {}) {
  const sent: { url: string; init: RequestInit }[] = [];
  const fetchFn: typeof fetch = async (url, init) => {
    sent.push({ url: String(url), init: init ?? {} });
    return new Response(body === null ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  };
  return { sent, client: new TodoistClient(cfg, fetchFn) };
}

describe('TodoistClient against recorded responses', () => {
  it('builds the consent URL with the scopes, state, redirect, and PKCE S256', () => {
    const url = new URL(new TodoistClient(cfg, fetch).authorizeUrl({ state: 's1', codeChallenge: 'c1', redirectUri: 'https://d.example/connect/todoist/callback' }));
    expect(url.origin + url.pathname).toBe('https://app.todoist.test/oauth/authorize');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'fake-client-id',
      scope: 'data:read_write,data:delete',
      state: 's1',
      redirect_uri: 'https://d.example/connect/todoist/callback',
      response_type: 'code',
      code_challenge: 'c1',
      code_challenge_method: 'S256',
    });
  });

  it('reads the documented token response, and sends a form-encoded exchange', async () => {
    const { client, sent } = canned(TOKEN_RESPONSE);
    const tokens = await client.exchangeCode({ code: 'c', codeVerifier: 'v', redirectUri: 'https://d.example/cb' }, NOW);
    expect(tokens).toEqual({ accessToken: 'doc-access-token', refreshToken: 'doc-refresh-token', expiresAt: new Date('2026-11-15T13:00:00Z') });
    expect(sent[0]!.url).toBe('https://api.todoist.test/oauth/access_token');
    expect(Object.fromEntries(new URLSearchParams(String(sent[0]!.init.body)))).toEqual({
      client_id: 'fake-client-id', client_secret: 'fake-client-secret', code: 'c', redirect_uri: 'https://d.example/cb', code_verifier: 'v',
    });
  });

  it('turns OAuth errors into TodoistOAuthError without the response in the message', async () => {
    const err = await canned(TOKEN_ERROR_BAD_CODE, 400).client.refresh('rt', NOW).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TodoistOAuthError);
    expect((err as TodoistOAuthError).code).toBe('bad_authorization_code');
  });

  it('reads a command response, keeping sync_status errors and temp ids', async () => {
    const { client, sent } = canned({ ...COMMAND_RESPONSE, sync_status: { 'cmd-uuid-1': 'ok', 'cmd-uuid-2': COMMAND_ERROR }, items: [ITEM], projects: [INBOX_PROJECT] });
    const res = await client.sync('tok', { syncToken: 'doc-sync-token-1', commands: [{ type: 'item_close', uuid: 'cmd-uuid-1', args: { id: '1' } }] });
    expect(res.syncToken).toBe('doc-sync-token-2');
    expect(res.syncStatus['cmd-uuid-1']).toBe('ok');
    expect(res.syncStatus['cmd-uuid-2']).toMatchObject({ error_tag: 'INVALID_ARGUMENT_VALUE', http_code: 400 });
    expect(res.tempIdMapping).toEqual({ 'temp-1': '6X7rM8997g3RQmvh' });
    expect(res.items).toEqual([expect.objectContaining({ id: '6X7rM8997g3RQmvh', content: 'Buy milk', checked: false, is_deleted: false })]);
    expect(res.projects[0]).toMatchObject({ id: INBOX_PROJECT.id, inbox_project: true });
    const body = JSON.parse(String(sent[0]!.init.body)) as Record<string, unknown>;
    expect(body).toEqual({
      sync_token: 'doc-sync-token-1',
      resource_types: ['items', 'projects', 'user'],
      commands: [{ type: 'item_close', uuid: 'cmd-uuid-1', args: { id: '1' } }],
    });
    expect(sent[0]!.init.headers).toMatchObject({ authorization: 'Bearer tok', 'content-type': 'application/json' });
  });

  it('reads the live-verified ITEM_NOT_FOUND status and a blanked deleted item', async () => {
    const res = await canned({ sync_token: 't', sync_status: { u: LIVE_ITEM_NOT_FOUND }, items: [LIVE_DELETED_ITEM] }).client.sync('tok', { syncToken: 's' });
    expect(res.syncStatus.u).toMatchObject({ error_tag: 'ITEM_NOT_FOUND', error_code: 22 });
    expect(res.items).toEqual([expect.objectContaining({ id: LIVE_DELETED_ITEM.id, is_deleted: true, content: '', due: null })]);
  });

  it('tells open, completed, and deleted tasks apart with GET /api/v1/tasks/{id}', async () => {
    const open = await canned(ITEM).client.getTask('tok', ITEM.id);
    expect(open).toMatchObject({ state: 'open', item: { id: ITEM.id } });
    const completed = canned(LIVE_TASK_COMPLETED);
    expect(await completed.client.getTask('tok', LIVE_TASK_COMPLETED.id)).toMatchObject({ state: 'completed' });
    expect(completed.sent[0]!.url).toBe(`https://api.todoist.test/api/v1/tasks/${LIVE_TASK_COMPLETED.id}`);
    expect(await canned(LIVE_TASK_NOT_FOUND, 404).client.getTask('tok', 'x')).toEqual({ state: 'deleted' });
    // A malformed id is a 400, not "deleted": the caller leaves the row alone.
    await expect(canned(LIVE_TASK_BAD_ID, 400).client.getTask('tok', 'x')).rejects.toMatchObject({ kind: 'rejected' });
    await expect(canned(LIVE_INVALID_TOKEN, 401).client.getTask('tok', 'x')).rejects.toMatchObject({ kind: 'auth' });
    // A 403 about one task (e.g. someone else's shared project) says nothing about the token.
    await expect(canned({ error: 'Forbidden', error_tag: 'FORBIDDEN', http_code: 403 }, 403).client.getTask('tok', 'x')).rejects.toMatchObject({ kind: 'rejected', status: 403 });
  });

  it('skips items that are not in the documented shape instead of failing the sync', async () => {
    const res = await canned({ sync_token: 't', items: [ITEM, { id: 'x' }] }).client.sync('tok', { syncToken: '*' });
    expect(res.items).toHaveLength(1);
    expect(res.skipped).toBe(1);
  });

  it('maps HTTP failures: 401 auth, 429 with retry_after, 5xx, network', async () => {
    const kind = async (c: ReturnType<typeof canned>) => ((await c.client.sync('t', { syncToken: '*' }).catch((e: unknown) => e)) as TodoistHttpError);
    const auth = await kind(canned(LIVE_INVALID_TOKEN, 401));
    expect([auth.kind, auth.retryAfterSec]).toEqual(['auth', null]);
    const limited = await kind(canned({ error: 'Too many', error_extra: { retry_after: 7 }, http_code: 429 }, 429));
    expect([limited.kind, limited.retryAfterSec]).toEqual(['rate_limited', 7]);
    expect((await kind(canned({ error: 'x' }, 429, { 'retry-after': '12' }))).retryAfterSec).toBe(12);
    expect((await kind(canned({ error: 'x' }, 503))).kind).toBe('server');
    expect((await kind(canned('not a sync response'))).kind).toBe('bad_response');
    const offline = new TodoistClient(cfg, async () => { throw new TypeError('fetch failed'); });
    expect(((await offline.sync('t', { syncToken: '*' }).catch((e: unknown) => e)) as TodoistHttpError).kind).toBe('network');
  });
});

describe('TodoistClient against FakeTodoist', () => {
  function setup() {
    const fake = new FakeTodoist();
    fake.now = () => NOW.getTime();
    return { fake, client: new TodoistClient(cfg, fake.fetch) };
  }

  async function link(fake: FakeTodoist, client: TodoistClient) {
    const verifier = 'v'.repeat(43);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const back = fake.authorize(new URL(client.authorizeUrl({ state: 's', codeChallenge: challenge, redirectUri: 'https://d.example/cb' })).searchParams);
    return client.exchangeCode({ code: back.searchParams.get('code')!, codeVerifier: verifier, redirectUri: 'https://d.example/cb' }, NOW);
  }

  it('uses the API origin for every call and the OAuth origin only for the consent page', async () => {
    const { fake, client } = setup();
    fake.origins = { api: cfg.apiBaseUrl, oauth: cfg.oauthBaseUrl };
    const tokens = await link(fake, client);
    await expect(client.sync(tokens.accessToken, { syncToken: '*' })).resolves.toMatchObject({ fullSync: true });
    await client.revoke(tokens.accessToken, 'access_token', 1_000);
    expect(new URL(client.authorizeUrl({ state: 's', codeChallenge: 'c', redirectUri: 'https://d.example/cb' })).origin).toBe(cfg.oauthBaseUrl);
    // The fake refuses each kind of call on the other origin, so a mix-up can't pass.
    expect((await fake.fetch(`${cfg.oauthBaseUrl}/api/v1/sync`, { method: 'POST' })).status).toBe(404);
    expect((await fake.fetch(`${cfg.oauthBaseUrl}/oauth/access_token`, { method: 'POST' })).status).toBe(404);
    expect((await fake.fetch(`${cfg.apiBaseUrl}/oauth/authorize?client_id=${cfg.clientId}`)).status).toBe(404);
    const swapped = new TodoistClient({ ...cfg, apiBaseUrl: cfg.oauthBaseUrl, oauthBaseUrl: cfg.apiBaseUrl }, fake.fetch);
    await expect(swapped.sync(tokens.accessToken, { syncToken: '*' })).rejects.toBeInstanceOf(TodoistHttpError);
  });

  it('links with PKCE, then refreshes with rotation', async () => {
    const { fake, client } = setup();
    const first = await link(fake, client);
    const second = await client.refresh(first.refreshToken!, NOW);
    expect(second.refreshToken).not.toBe(first.refreshToken);
    // A replay within 60 seconds gets the same access token and no refresh token.
    const replay = await client.refresh(first.refreshToken!, NOW);
    expect(replay).toMatchObject({ accessToken: second.accessToken, refreshToken: null });
  });

  it('revokes everything when a used refresh token comes back after 60 seconds', async () => {
    const { fake, client } = setup();
    const first = await link(fake, client);
    const second = await client.refresh(first.refreshToken!, NOW);
    fake.now = () => NOW.getTime() + 61_000;
    await expect(client.refresh(first.refreshToken!, NOW)).rejects.toMatchObject({ code: 'invalid_grant' });
    await expect(client.sync(second.accessToken, { syncToken: '*' })).rejects.toMatchObject({ kind: 'auth' });
  });

  it('rejects a code exchanged with the wrong PKCE verifier', async () => {
    const { fake, client } = setup();
    const back = fake.authorize(new URL(client.authorizeUrl({ state: 's', codeChallenge: 'not-the-hash', redirectUri: 'https://d.example/cb' })).searchParams);
    await expect(client.exchangeCode({ code: back.searchParams.get('code')!, codeVerifier: 'v'.repeat(43), redirectUri: 'https://d.example/cb' }, NOW))
      .rejects.toBeInstanceOf(TodoistOAuthError);
  });

  it('runs commands, maps temp ids, and returns only changes on an incremental sync', async () => {
    const { fake, client } = setup();
    const tokens = await link(fake, client);
    const full = await client.sync(tokens.accessToken, { syncToken: '*' });
    expect(full.fullSync).toBe(true);
    expect(full.user?.inboxProjectId).toBeTruthy();
    const add = await client.sync(tokens.accessToken, {
      syncToken: full.syncToken,
      commands: [{ type: 'item_add', uuid: 'u1', temp_id: 't1', args: { content: 'Milk', due: { date: '2026-11-20' } } }],
    });
    expect(add.syncStatus).toEqual({ u1: 'ok' });
    const taskId = add.tempIdMapping.t1!;
    expect(add.items.map((i) => i.id)).toEqual([taskId]);
    const quiet = await client.sync(tokens.accessToken, { syncToken: add.syncToken });
    expect(quiet.items).toEqual([]);
    // Replaying the same uuid doesn't add a second task, and returns the same mapping.
    const replay = await client.sync(tokens.accessToken, {
      syncToken: add.syncToken,
      commands: [{ type: 'item_add', uuid: 'u1', temp_id: 't1', args: { content: 'Milk' } }],
    });
    expect(replay.tempIdMapping.t1).toBe(taskId);
    expect([...fake.accounts.values()][0]!.items.size).toBe(1);
  });

  it("shows a shared project's tasks in every member's sync, and tells completed from deleted", async () => {
    const { fake, client } = setup();
    const a = await link(fake, client);
    const b = await link(fake, client);
    const [alice, bob] = [...fake.accounts.values()];
    const shared = fake.addProject(alice!, 'Family');
    const task = fake.addTask(alice!, { content: 'Shared', project_id: shared.id });
    fake.share(shared, bob!);
    expect((await client.sync(b.accessToken, { syncToken: '*' })).items.map((i) => i.id)).toEqual([task.id]);
    fake.close(alice!, task.id);
    // A full sync leaves out the completed task; looking it up says it's completed, not gone.
    expect((await client.sync(a.accessToken, { syncToken: '*' })).items).toEqual([]);
    expect(await client.getTask(b.accessToken, task.id)).toMatchObject({ state: 'completed' });
    fake.change(alice!, task.id, { is_deleted: true });
    expect(await client.getTask(a.accessToken, task.id)).toEqual({ state: 'deleted' });
  });

  it("lists a project's open tasks with GET /api/v1/tasks, following next_cursor across pages", async () => {
    const { fake, client } = setup();
    const tokens = await link(fake, client);
    const account = [...fake.accounts.values()][0]!;
    const chores = fake.addProject(account, 'Chores');
    const tasks = ['One', 'Two', 'Three'].map((content) => fake.addTask(account, { content, project_id: chores.id }));
    fake.close(account, fake.addTask(account, { content: 'Done', project_id: chores.id }).id);
    fake.addTask(account, { content: 'In the Inbox' });
    fake.tasksPageSize = 2;
    const listed = await client.listTasks(tokens.accessToken, { projectId: chores.id });
    expect(listed).toEqual({ complete: true, items: tasks.map((t) => expect.objectContaining({ id: t.id, content: t.content, project_id: chores.id, added_at: expect.any(String) })) });
    const pages = fake.requests.filter((r) => r.path === '/api/v1/tasks');
    expect(pages.map((r) => r.fields)).toEqual([
      { project_id: chores.id, limit: '200' },
      { project_id: chores.id, limit: '200', cursor: expect.any(String) },
    ]);
  });

  it('stops listing after MAX_TASK_PAGES and says the list is incomplete', async () => {
    const { fake, client } = setup();
    const tokens = await link(fake, client);
    const account = [...fake.accounts.values()][0]!;
    const chores = fake.addProject(account, 'Chores');
    for (let i = 0; i < MAX_TASK_PAGES + 1; i++) fake.addTask(account, { content: `Task ${i}`, project_id: chores.id });
    fake.tasksPageSize = 1;
    const listed = await client.listTasks(tokens.accessToken, { projectId: chores.id });
    expect(listed.complete).toBe(false);
    expect(listed.items).toHaveLength(MAX_TASK_PAGES);
  });

  it('revokes with Basic client auth', async () => {
    const { fake, client } = setup();
    const tokens = await link(fake, client);
    await client.revoke(tokens.accessToken, 'access_token');
    const sent = fake.requests.at(-1)!;
    expect(sent.path).toBe('/api/v1/revoke');
    expect(sent.authorization).toBe(`Basic ${Buffer.from('fake-client-id:fake-client-secret').toString('base64')}`);
    await expect(client.sync(tokens.accessToken, { syncToken: '*' })).rejects.toMatchObject({ kind: 'auth' });
  });
});
