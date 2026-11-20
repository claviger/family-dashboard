import { createHash, createHmac, randomBytes } from 'node:crypto';

/**
 * An in-memory model of the slice of Todoist API v1 the app uses, for tests:
 * - `POST /api/v1/sync`: commands (with uuid replay and `temp_id_mapping`), full and incremental
 *   sync tokens, and the `items`, `projects`, and `user` resources;
 * - `GET /api/v1/tasks/{id}`, which tells a completed task from a deleted one, and
 *   `GET /api/v1/tasks?project_id=` with cursor pagination (documented, not live-checked);
 * - `GET /oauth/authorize`, `POST /oauth/access_token` (code exchange with PKCE, refresh with
 *   rotation and the 60-second replay rule), and `POST /api/v1/revoke`;
 * - shared projects: a project can have several member accounts, and its tasks show up in every
 *   member's sync, with the same ids;
 * - projects deleted or archived in Todoist, and subtasks closed with their parent;
 * - an incremental request answered with `full_sync: true`, and a full sync whose
 *   `full_sync_date_utc` lags behind (or that leaves given active tasks out, `omitFromFullSync`);
 * - injectable failures: HTTP status codes on the next calls (any path), HTTP 403s for given
 *   tasks' lookups, and per-command errors.
 *
 * Use it as `fetch` in Vitest (`fake.fetch`), or behind an HTTP server for Playwright
 * (fakeTodoistServer.ts), which also exposes the `/__fake/*` control routes below.
 *
 * It follows docs/research/todoist-api-v1.md, "Verified live (2026-11-16)" and "Telling
 * completed from deleted": ids are opaque 16-character strings and malformed ones are rejected;
 * a full sync leaves out completed tasks; a deleted item comes back in incremental syncs with
 * `is_deleted: true` and its fields blanked; `GET /api/v1/tasks/{id}` answers 200 with `checked`
 * for open and completed tasks and 404 NOT_FOUND for deleted ones; closing a closed task is "ok"
 * and changes nothing; closing a repeating task moves its date and leaves it open; a command on a
 * missing task gets ITEM_NOT_FOUND (error_code 22); a bad token gets 401 AUTH_INVALID_TOKEN; JSON
 * and form bodies both work. One thing is still UNVERIFIED, and the fake does the likely thing:
 * replaying a command uuid returns the first result, including its `temp_id_mapping`
 * (`omitReplayMappings` turns that off, to exercise the app's fallback).
 */

export interface FakeItem {
  id: string;
  user_id: string;
  project_id: string;
  parent_id: string | null;
  content: string;
  description: string;
  checked: boolean;
  is_deleted: boolean;
  completed_at: string | null;
  added_at: string;
  due: { date: string; timezone: string | null; is_recurring: boolean; string: string } | null;
  priority: number;
  labels: string[];
  /** Fake bookkeeping: the change counter when this item last changed. Not sent. */
  seq: number;
}

export interface FakeProject {
  id: string;
  name: string;
  is_deleted: boolean;
  is_archived: boolean;
  inbox_project?: true;
  /** Fake bookkeeping, not sent: the change counter, and the accounts that can see the project. */
  seq: number;
  members: Set<string>;
}

/** One Todoist account. `items` and `projects` are what it can see, including shared projects. */
export interface FakeAccount {
  id: string;
  email: string;
  inboxId: string;
  readonly items: ReadonlyMap<string, FakeItem>;
  readonly projects: ReadonlyMap<string, FakeProject>;
}

interface CommandResult {
  status: 'ok' | Record<string, unknown>;
  mapping?: [string, string];
}

type Path = 'sync' | 'token' | 'revoke' | 'task' | 'tasks';

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** Opaque 16-character ids, like Todoist's `6j2qXvH9v8wQ2gQr`. */
const ID_FORMAT = /^[0-9A-Za-z]{16}$/;

function id(): string {
  return [...randomBytes(16)].map((b) => ID_ALPHABET[b % ID_ALPHABET.length]).join('');
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

const NOT_FOUND = { error: 'Item not found', error_code: 22, error_tag: 'ITEM_NOT_FOUND', http_code: 400, error_extra: {} };
const BAD_ID = { error: 'Invalid argument value', error_code: 20, error_tag: 'INVALID_ARGUMENT_VALUE', http_code: 400, error_extra: { argument: 'id' } };
/** Verified live: `GET /api/v1/tasks/{id}` for a deleted task. */
const TASK_NOT_FOUND = { error: 'Task not found', error_code: 478, error_tag: 'NOT_FOUND', http_code: 404 };
/** Verified live: what a deleted item's fields look like. */
const DELETED_PROJECT_PLACEHOLDER = '2222222222222222';
/** An HTTP 403 in the documented v1 error format (research notes §4). Not seen live. */
const FORBIDDEN = { error: 'Forbidden', error_code: 403, error_tag: 'FORBIDDEN', http_code: 403 };

export class FakeTodoist {
  readonly accounts = new Map<string, FakeAccount>();
  /** Every request, for assertions: path, form or JSON fields, and the Authorization header. */
  readonly requests: { path: string; fields: Record<string, string>; authorization: string | null }[] = [];
  /** The next calls to these endpoints fail with this status (and body), in order. */
  readonly failures: { path: Path; status: number; body?: unknown; headers?: Record<string, string> }[] = [];
  /** The next command of each type fails with this sync_status error, once. */
  readonly commandErrors = new Map<string, Record<string, unknown>>();
  /** Accounts the next authorizations use, in order; otherwise each authorization creates a new account. */
  readonly nextAccounts: string[] = [];
  /** Every revocation that named a known token: whose, and which kind. */
  readonly revocations: { accountId: string; kind: 'access' | 'refresh' }[] = [];
  /** Answer the next authorization with `?error=access_denied`. */
  denyNext = false;
  /** Run the next request's commands, then answer 502, as if the response was lost on the way back. */
  loseNextResponse = false;
  /** Leave `temp_id_mapping` out when a command uuid is replayed (the UNVERIFIED case). */
  omitReplayMappings = false;
  /**
   * Answer the next incremental sync as a full one (`full_sync: true`), as Todoist does when a
   * sync token is too old (research notes §2).
   */
  answerNextAsFull = false;
  /**
   * How far behind `now` a full sync's `full_sync_date_utc` is: big accounts' full syncs "may be
   * returned with some delay" (research notes §2).
   */
  fullSyncLagMs = 0;
  /**
   * Task ids `GET /api/v1/tasks/{id}` answers with an HTTP 403, e.g. a task in a shared project the
   * account lost access to. The body follows the documented v1 error format; a real 403 for this
   * case hasn't been seen (UNVERIFIED).
   */
  readonly forbiddenTasks = new Set<string>();
  /**
   * Task ids a full sync leaves out even though they're active, as a lagging snapshot would (research
   * notes §2). Lets a test reach the full-sync lookup for a task that's open, in another project.
   */
  readonly omitFromFullSync = new Set<string>();
  /**
   * `GET /api/v1/tasks` answers at most this many tasks a page, whatever `limit` asks for, so a
   * test can make it page. Todoist's own cap is `limit` (default 50, at most 200).
   */
  tasksPageSize = 200;
  /** Lifetime of access tokens, in seconds (Todoist's is 3600). */
  accessTokenTtlSec = 3600;
  /**
   * When set, each endpoint answers only on its own origin, as Todoist's hosts do (research notes
   * §1): the consent page (`/oauth/authorize`) on `oauth`, and everything else, the token endpoint
   * and the `/__fake/*` controls included, on `api`. Anything on the wrong origin is a 404, so a
   * mix-up between `apiBaseUrl` and `oauthBaseUrl` fails loudly.
   */
  origins: { api: string; oauth: string } | null = null;
  /** Where to deliver webhooks (the server sets it; Vitest tests usually don't). */
  webhookUrl: string | null = null;
  now: () => number = () => Date.now();

  /** Every task and project, whoever can see them. */
  private readonly allItems = new Map<string, FakeItem>();
  private readonly allProjects = new Map<string, FakeProject>();
  /** One change counter for everything; a sync token is `<account>.<counter>`. */
  private seq = 1;
  private readonly access = new Map<string, { accountId: string; expiresAt: number; revoked: boolean }>();
  private readonly refresh = new Map<string, { accountId: string; consumedAt: number | null; next: { access: string } | null; revoked: boolean }>();
  private readonly codes = new Map<string, { accountId: string; redirectUri: string; challenge: string | null; used: boolean }>();
  private readonly executed = new Map<string, CommandResult>();

  constructor(
    readonly clientId = 'fake-client-id',
    readonly clientSecret = 'fake-client-secret',
  ) {}

  /** Drop-in `fetch` for TodoistClient. */
  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
    this.handle(new Request(input, init));

  createAccount(opts: { id?: string; email?: string } = {}): FakeAccount {
    const accountId = opts.id ?? id();
    const inbox: FakeProject = { id: id(), name: 'Inbox', is_deleted: false, is_archived: false, inbox_project: true, seq: ++this.seq, members: new Set([accountId]) };
    this.allProjects.set(inbox.id, inbox);
    const fake = this;
    const account: FakeAccount = {
      id: accountId,
      email: opts.email ?? `todoist-${accountId}@example.com`,
      inboxId: inbox.id,
      get items() {
        return new Map([...fake.allItems].filter(([, i]) => fake.visible(accountId, i)));
      },
      get projects() {
        return new Map([...fake.allProjects].filter(([, p]) => p.members.has(accountId)));
      },
    };
    this.accounts.set(accountId, account);
    return account;
  }

  addProject(account: FakeAccount, name: string): FakeProject {
    const project: FakeProject = { id: id(), name, is_deleted: false, is_archived: false, seq: ++this.seq, members: new Set([account.id]) };
    this.allProjects.set(project.id, project);
    return project;
  }

  /**
   * Deletes a project, as if someone did it in Todoist. Its tasks are deleted with it, the way
   * deleting a project works in Todoist's own apps; what a sync reports for them isn't verified,
   * so the fake reports them like any deleted task.
   */
  deleteProject(project: FakeProject): void {
    project.is_deleted = true;
    project.seq = ++this.seq;
    for (const item of this.allItems.values()) if (item.project_id === project.id) Object.assign(item, { is_deleted: true, seq: ++this.seq });
  }

  /** Archives a project (`is_archived`, research notes §2). The fake leaves its tasks as they are. */
  archiveProject(project: FakeProject): void {
    project.is_archived = true;
    project.seq = ++this.seq;
  }

  /** Shares a project with another account, whose syncs then include its tasks. */
  share(project: FakeProject, account: FakeAccount): void {
    project.members.add(account.id);
    project.seq = ++this.seq;
    for (const item of this.allItems.values()) if (item.project_id === project.id) item.seq = ++this.seq;
  }

  /** A task created in Todoist itself (not through the app). */
  addTask(account: FakeAccount, fields: Partial<Pick<FakeItem, 'content' | 'description' | 'project_id' | 'due' | 'parent_id'>> = {}): FakeItem {
    const item: FakeItem = {
      id: id(),
      user_id: account.id,
      project_id: fields.project_id ?? account.inboxId,
      parent_id: fields.parent_id ?? null,
      content: fields.content ?? 'Task',
      description: fields.description ?? '',
      checked: false,
      is_deleted: false,
      completed_at: null,
      added_at: new Date(this.now()).toISOString(),
      due: fields.due ?? null,
      priority: 1,
      labels: [],
      seq: ++this.seq,
    };
    this.allItems.set(item.id, item);
    return item;
  }

  /** Changes a task as if someone edited it in Todoist. */
  change(_account: FakeAccount, itemId: string, patch: Partial<Omit<FakeItem, 'id' | 'seq'>>): FakeItem {
    const item = this.allItems.get(itemId)!;
    Object.assign(item, patch, { seq: ++this.seq });
    return item;
  }

  /** Checks a task off as Todoist's own clients do (`item_close`). */
  close(_account: FakeAccount, itemId: string): FakeItem {
    const item = this.allItems.get(itemId)!;
    this.closeItem(item);
    return item;
  }

  /** Removes a task without any sync ever reporting it, for testing the full-sync reconcile. */
  vanish(itemId: string): void {
    this.allItems.delete(itemId);
  }

  findTask(content: string): { account: FakeAccount; item: FakeItem } | null {
    for (const item of this.allItems.values()) {
      if (item.content !== content || item.is_deleted) continue;
      const owner = [...this.accounts.values()].find((a) => this.visible(a.id, item));
      if (owner) return { account: owner, item };
    }
    return null;
  }

  /** Revokes every token for an account, like Todoist's replay protection or a user removing the app. */
  revokeAll(accountId: string): void {
    for (const t of this.access.values()) if (t.accountId === accountId) t.revoked = true;
    for (const t of this.refresh.values()) if (t.accountId === accountId) t.revoked = true;
  }

  /** Tokens for an account, as if its owner had just finished the OAuth flow. */
  grant(account: FakeAccount): { access_token: string; refresh_token: string; expires_in: number } {
    return this.issue(account.id);
  }

  /** Expires every access token, so the next call needs a refresh. */
  expireAccessTokens(): void {
    for (const t of this.access.values()) t.expiresAt = 0;
  }

  /**
   * The code for an authorization, as the consent page would issue it. Used by the route and by
   * tests. `asAccount` signs in as that existing account, like a person who is already signed in
   * to Todoist in that browser (the HTTP route takes it from a `fake_account` cookie, so parallel
   * e2e tests can't take each other's accounts).
   */
  authorize(params: URLSearchParams, asAccount?: string): URL {
    const redirect = new URL(params.get('redirect_uri') ?? 'http://invalid/');
    redirect.searchParams.set('state', params.get('state') ?? '');
    if (params.get('client_id') !== this.clientId) {
      redirect.searchParams.set('error', 'invalid_application_status');
      return redirect;
    }
    if (this.denyNext) {
      this.denyNext = false;
      redirect.searchParams.set('error', 'access_denied');
      return redirect;
    }
    const accountId = (asAccount && this.accounts.has(asAccount) ? asAccount : null) ?? this.nextAccounts.shift() ?? this.createAccount().id;
    const code = id();
    const challenge = params.get('code_challenge_method') === 'S256' ? params.get('code_challenge') : null;
    this.codes.set(code, { accountId, redirectUri: redirect.origin + redirect.pathname, challenge, used: false });
    redirect.searchParams.set('code', code);
    return redirect;
  }

  /** Signs a webhook body as Todoist does: base64 HMAC-SHA256 with the client secret. */
  sign(body: string): string {
    return createHmac('sha256', this.clientSecret).update(body).digest('base64');
  }

  /** Delivers a webhook to every account that can see the task, one delivery each, as Todoist does. */
  async deliverWebhook(eventName: string, item: FakeItem): Promise<void> {
    if (!this.webhookUrl) return;
    for (const account of this.accounts.values()) {
      if (!this.visible(account.id, item)) continue;
      const body = JSON.stringify({
        event_name: eventName,
        user_id: account.id,
        event_data: this.wire(item),
        initiator: { id: account.id, email: account.email, full_name: 'Fake', image_id: null, is_premium: false },
        triggered_at: new Date(this.now()).toISOString(),
        version: '10',
      });
      const res = await fetch(this.webhookUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Todoist-Webhooks',
          'x-todoist-hmac-sha256': this.sign(body),
          'x-todoist-delivery-id': id(),
        },
        body,
      });
      // Todoist treats anything but a 200 as a failed delivery; so does the fake, loudly.
      if (res.status !== 200) throw new Error(`The app answered a webhook with ${res.status}`);
    }
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const fields = await this.fields(req);
    this.requests.push({ path: url.pathname, fields, authorization: req.headers.get('authorization') });
    if (this.origins) {
      const expected = url.pathname === '/oauth/authorize' ? this.origins.oauth : this.origins.api;
      if (url.origin !== expected) return json({ error: `The fake serves ${url.pathname} on ${expected}, not ${url.origin}`, http_code: 404 }, 404);
    }
    if (url.pathname.startsWith('/__fake/')) return this.control(url, req, fields);
    if (req.method === 'GET' && url.pathname === '/oauth/authorize') {
      const asAccount = /(?:^|;\s*)fake_account=([^;]+)/.exec(req.headers.get('cookie') ?? '')?.[1];
      return new Response(null, { status: 302, headers: { location: this.authorize(url.searchParams, asAccount).href } });
    }
    const task = req.method === 'GET' ? /^\/api\/v1\/tasks\/([^/]+)$/.exec(url.pathname) : null;
    const list = req.method === 'GET' && url.pathname === '/api/v1/tasks';
    const path: Path | null = task
      ? 'task'
      : list
        ? 'tasks'
        : req.method !== 'POST'
        ? null
        : url.pathname === '/api/v1/sync' ? 'sync' : url.pathname === '/oauth/access_token' ? 'token' : url.pathname === '/api/v1/revoke' ? 'revoke' : null;
    if (!path) return json({ error: 'Not found', error_tag: 'NOT_FOUND', http_code: 404 }, 404);
    const failure = this.failures.findIndex((f) => f.path === path);
    if (failure >= 0) {
      const f = this.failures.splice(failure, 1)[0]!;
      return json(f.body ?? { error: 'Injected failure', http_code: f.status }, f.status, f.headers);
    }
    if (path === 'token') return this.token(fields);
    if (path === 'revoke') return this.revoke(req, fields);
    const account = this.authenticate(req);
    if (!account) {
      return json(
        { error: 'Invalid token', error_code: 401, error_tag: 'AUTH_INVALID_TOKEN', http_code: 401, error_extra: { access_type: 'access_token', retry_after: 4 } },
        401,
      );
    }
    if (path === 'task') return this.getTask(account, decodeURIComponent(task![1]!));
    if (path === 'tasks') return this.listTasks(account, url.searchParams);
    return this.sync(account, fields);
  }

  /**
   * `GET /api/v1/tasks` (research notes §4, documented, not live-checked): the account's active
   * tasks, filtered by `project_id`, in pages of `limit` (default 50, more than 200 is a 400), as
   * `{ results, next_cursor }`. The cursor is opaque; the fake's is an offset.
   */
  private listTasks(account: FakeAccount, q: URLSearchParams): Response {
    const limit = q.has('limit') ? Number(q.get('limit')) : 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) return json({ ...BAD_ID, error_extra: { argument: 'limit' } }, 400);
    const projectId = q.get('project_id');
    const all = [...account.items.values()].filter((i) => !i.is_deleted && !i.checked && (projectId === null || i.project_id === projectId));
    const offset = q.has('cursor') ? Number(Buffer.from(q.get('cursor')!, 'base64url').toString()) : 0;
    const size = Math.min(limit, this.tasksPageSize);
    const page = all.slice(offset, offset + size);
    const next = offset + size < all.length ? Buffer.from(String(offset + size)).toString('base64url') : null;
    return json({ results: page.map((i) => this.wire(i)), next_cursor: next });
  }

  private visible(accountId: string, item: FakeItem): boolean {
    return this.allProjects.get(item.project_id)?.members.has(accountId) ?? false;
  }

  private authenticate(req: Request): FakeAccount | null {
    const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '');
    const token = this.access.get(bearer);
    if (!token || token.revoked || token.expiresAt <= this.now()) return null;
    return this.accounts.get(token.accountId) ?? null;
  }

  private async fields(req: Request): Promise<Record<string, string>> {
    // The task list's query, so tests can see its filter and paging; other GETs record nothing.
    if (req.method === 'GET') return new URL(req.url).pathname === '/api/v1/tasks' ? Object.fromEntries(new URL(req.url).searchParams) : {};
    const text = await req.clone().text();
    if ((req.headers.get('content-type') ?? '').includes('application/json')) {
      try {
        // Nested values stay JSON text, the way a form body carries them.
        return Object.fromEntries(
          Object.entries(JSON.parse(text) as Record<string, unknown>).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]),
        );
      } catch {
        return {};
      }
    }
    return Object.fromEntries(new URLSearchParams(text));
  }

  private issue(accountId: string): { access_token: string; refresh_token: string; expires_in: number; token_type: string; scope: string } {
    const access = `at-${id()}`;
    const refresh = `rt-${id()}`;
    this.access.set(access, { accountId, expiresAt: this.now() + this.accessTokenTtlSec * 1000, revoked: false });
    this.refresh.set(refresh, { accountId, consumedAt: null, next: null, revoked: false });
    return { access_token: access, refresh_token: refresh, expires_in: this.accessTokenTtlSec, token_type: 'Bearer', scope: 'data:read_write,data:delete' };
  }

  private token(f: Record<string, string>): Response {
    if (f.client_id !== this.clientId || f.client_secret !== this.clientSecret) return json({ error: 'incorrect_application_credentials' }, 400);
    if (f.grant_type === 'refresh_token') {
      const rt = this.refresh.get(f.refresh_token ?? '');
      if (!rt || rt.revoked) return json({ error: 'invalid_grant' }, 400);
      if (rt.consumedAt !== null) {
        // Research notes §1: a replay within 60 seconds gets the same new access token and no
        // refresh token; later, it's treated as theft and every token for the user is revoked.
        if (this.now() - rt.consumedAt <= 60_000 && rt.next) {
          return json({ access_token: rt.next.access, token_type: 'Bearer', expires_in: this.accessTokenTtlSec });
        }
        this.revokeAll(rt.accountId);
        return json({ error: 'invalid_grant' }, 400);
      }
      const issued = this.issue(rt.accountId);
      rt.consumedAt = this.now();
      rt.next = { access: issued.access_token };
      return json(issued);
    }
    const code = this.codes.get(f.code ?? '');
    if (!code || code.used) return json({ error: 'bad_authorization_code' }, 400);
    if (f.redirect_uri !== undefined && f.redirect_uri !== code.redirectUri) return json({ error: 'bad_authorization_code' }, 400);
    if (code.challenge !== null) {
      const expected = createHash('sha256').update(f.code_verifier ?? '').digest('base64url');
      if (expected !== code.challenge) return json({ error: 'invalid_grant' }, 400);
    }
    code.used = true;
    return json(this.issue(code.accountId));
  }

  private revoke(req: Request, f: Record<string, string>): Response {
    const expected = `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`;
    if (req.headers.get('authorization') !== expected) return json({ error: 'invalid_client' }, 401);
    const token = f.token ?? '';
    const a = this.access.get(token);
    if (a) {
      a.revoked = true;
      this.revocations.push({ accountId: a.accountId, kind: 'access' });
    }
    const r = this.refresh.get(token);
    if (r) {
      r.revoked = true;
      this.revocations.push({ accountId: r.accountId, kind: 'refresh' });
    }
    return new Response(null, { status: 200 });
  }

  /** Verified live: open and completed tasks are 200 with `checked`; deleted ones are 404; a malformed id is 400. */
  private getTask(account: FakeAccount, taskId: string): Response {
    if (!ID_FORMAT.test(taskId)) return json({ ...BAD_ID, error_extra: { argument: 'task_id' } }, 400);
    if (this.forbiddenTasks.has(taskId)) return json(FORBIDDEN, 403);
    const item = this.allItems.get(taskId);
    if (!item || item.is_deleted || !this.visible(account.id, item)) return json(TASK_NOT_FOUND, 404);
    return json(this.wire(item));
  }

  private sync(account: FakeAccount, f: Record<string, string>): Response {
    const syncStatus: Record<string, unknown> = {};
    const tempIdMapping: Record<string, string> = {};
    const commands = f.commands ? (JSON.parse(f.commands) as { type: string; uuid: string; temp_id?: string; args: Record<string, unknown> }[]) : [];
    const temp = new Map<string, string>();
    for (const cmd of commands) {
      const key = `${account.id}:${cmd.uuid}`;
      let result = this.executed.get(key);
      const replay = result !== undefined;
      if (!result) {
        result = this.run(account, cmd, temp);
        this.executed.set(key, result);
      }
      syncStatus[cmd.uuid] = result.status;
      if (result.mapping && !(replay && this.omitReplayMappings)) {
        tempIdMapping[result.mapping[0]] = result.mapping[1];
        temp.set(result.mapping[0], result.mapping[1]);
      }
    }
    if (this.loseNextResponse && commands.length > 0) {
      this.loseNextResponse = false;
      return json({ error: 'Bad gateway', http_code: 502 }, 502);
    }
    const [tokenAccount, tokenSeq] = (f.sync_token ?? '*').split('.');
    let full = f.sync_token === '*' || tokenAccount !== account.id || !Number.isFinite(Number(tokenSeq));
    if (this.answerNextAsFull && !full) {
      this.answerNextAsFull = false;
      full = true;
    }
    const since = full ? 0 : Number(tokenSeq);
    const types = JSON.parse(f.resource_types ?? '[]') as string[];
    const body: Record<string, unknown> = { sync_token: `${account.id}.${this.seq}`, full_sync: full };
    if (full) body.full_sync_date_utc = new Date(this.now() - this.fullSyncLagMs).toISOString();
    if (types.includes('items')) {
      // Verified live: a full sync leaves out completed (and deleted) tasks.
      body.items = [...account.items.values()]
        .filter((i) => (full ? !i.is_deleted && !i.checked && !this.omitFromFullSync.has(i.id) : i.seq > since))
        .map((i) => this.wire(i));
    }
    if (types.includes('projects')) {
      body.projects = [...account.projects.values()]
        .filter((p) => (full ? !p.is_deleted : p.seq > since))
        .map(({ seq: _seq, members: _members, ...p }) => p);
    }
    if (types.includes('user') && full) body.user = { id: account.id, email: account.email, inbox_project_id: account.inboxId };
    if (commands.length > 0) {
      body.sync_status = syncStatus;
      body.temp_id_mapping = tempIdMapping;
    }
    return json(body);
  }

  private run(
    account: FakeAccount,
    cmd: { type: string; temp_id?: string; args: Record<string, unknown> },
    temp: Map<string, string>,
  ): CommandResult {
    const injected = this.commandErrors.get(cmd.type);
    if (injected) {
      this.commandErrors.delete(cmd.type);
      return { status: injected };
    }
    const a = cmd.args;
    const raw = String(a.id ?? '');
    const target = temp.get(raw) ?? raw;
    if (cmd.type !== 'item_add' && !ID_FORMAT.test(target)) return { status: BAD_ID };
    const lookup = () => {
      const item = this.allItems.get(target);
      return item && !item.is_deleted && this.visible(account.id, item) ? item : null;
    };
    const due = (value: unknown): FakeItem['due'] =>
      value && typeof value === 'object' && typeof (value as { date?: unknown }).date === 'string'
        ? {
            date: (value as { date: string }).date,
            timezone: typeof (value as { timezone?: unknown }).timezone === 'string' ? (value as { timezone: string }).timezone : null,
            is_recurring: false,
            string: (value as { date: string }).date,
          }
        : null;
    switch (cmd.type) {
      case 'item_add': {
        const projects = account.projects;
        if (typeof a.project_id === 'string' && !projects.has(a.project_id)) {
          return { status: { ...BAD_ID, error_extra: { argument: 'project_id' } } };
        }
        const item = this.addTask(account, {
          content: String(a.content ?? ''),
          description: typeof a.description === 'string' ? a.description : '',
          project_id: typeof a.project_id === 'string' ? a.project_id : account.inboxId,
          due: due(a.due),
        });
        return { status: 'ok', mapping: cmd.temp_id ? [cmd.temp_id, item.id] : undefined };
      }
      case 'item_update': {
        const item = lookup();
        if (!item) return { status: NOT_FOUND };
        if (typeof a.content === 'string') item.content = a.content;
        if (typeof a.description === 'string') item.description = a.description;
        if ('due' in a) item.due = due(a.due);
        item.seq = ++this.seq;
        return { status: 'ok' };
      }
      case 'item_close': {
        const item = lookup();
        if (!item) return { status: NOT_FOUND };
        // Verified live: closing a closed task is "ok" and changes nothing.
        if (!item.checked) this.closeItem(item);
        return { status: 'ok' };
      }
      case 'item_uncomplete': {
        const item = lookup();
        if (!item) return { status: NOT_FOUND };
        if (item.checked) Object.assign(item, { checked: false, completed_at: null, seq: ++this.seq });
        return { status: 'ok' };
      }
      case 'item_delete': {
        const item = lookup();
        if (!item) return { status: NOT_FOUND };
        for (const i of this.allItems.values()) {
          if (i.id === item.id || i.parent_id === item.id) Object.assign(i, { is_deleted: true, seq: ++this.seq });
        }
        return { status: 'ok' };
      }
      default:
        return { status: { error_tag: 'INVALID_COMMAND', error: 'Unknown command', http_code: 400 } };
    }
  }

  /**
   * `item_close`: a recurring task moves to its next date (daily, in the fake); others are checked,
   * and so are their open subtasks, as Todoist's own clients do when a parent is checked off
   * (research notes §3: `item_close` "does exactly what official clients do", and `item_complete`
   * completes sub-tasks; that `item_close` does too isn't verified live).
   */
  private closeItem(item: FakeItem): void {
    if (item.due?.is_recurring) {
      const next = new Date(`${item.due.date.slice(0, 10)}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      item.due = { ...item.due, date: next.toISOString().slice(0, 10) + item.due.date.slice(10) };
    } else {
      this.check(item);
    }
    item.seq = ++this.seq;
  }

  /** Checks a task and, recursively, its open subtasks (a subtask's own repeat rule is ignored). */
  private check(item: FakeItem): void {
    Object.assign(item, { checked: true, completed_at: new Date(this.now()).toISOString(), seq: ++this.seq });
    for (const child of this.allItems.values()) {
      if (child.parent_id === item.id && !child.checked && !child.is_deleted) this.check(child);
    }
  }

  private wire(item: FakeItem): Record<string, unknown> {
    const { seq: _seq, ...rest } = item;
    const wire = { ...rest, updated_at: new Date(this.now()).toISOString(), section_id: null, child_order: 1 };
    // Verified live: a deleted item's fields are blanked.
    return item.is_deleted ? { ...wire, content: '', description: '', due: null, project_id: DELETED_PROJECT_PLACEHOLDER } : wire;
  }

  /** Test controls for the Playwright server. Not part of Todoist. */
  private async control(url: URL, req: Request, f: Record<string, string>): Promise<Response> {
    if (url.pathname === '/__fake/health') return json({ ok: true });
    // The kinds of token revoked for an account: `access`, `refresh`.
    if (req.method === 'GET' && url.pathname === '/__fake/revocations') {
      return json(this.revocations.filter((r) => r.accountId === url.searchParams.get('account')).map((r) => r.kind));
    }
    // `all=1`: every live task with that content, from any account (a list, possibly empty).
    if (req.method === 'GET' && url.pathname === '/__fake/tasks' && url.searchParams.get('all') === '1') {
      const content = url.searchParams.get('content') ?? '';
      return json([...this.allItems.values()].flatMap((item) => {
        if (item.content !== content || item.is_deleted) return [];
        const owner = [...this.accounts.values()].find((a) => this.visible(a.id, item));
        return owner ? [{ ...this.wire(item), account_id: owner.id }] : [];
      }));
    }
    if (req.method === 'GET' && url.pathname === '/__fake/tasks') {
      const found = this.findTask(url.searchParams.get('content') ?? '');
      if (!found) return json({ error: 'No such task' }, 404);
      const project = this.allProjects.get(found.item.project_id);
      return json({ ...this.wire(found.item), project_name: project?.name ?? null, account_id: found.account.id });
    }
    // Adds a task as if someone did it in Todoist: in the account's Inbox, or in the project with
    // that name (made if there's none), then delivers a signed item:added webhook.
    if (req.method === 'POST' && url.pathname === '/__fake/tasks/add') {
      const account = this.accounts.get(f.account ?? '');
      if (!account) return json({ error: 'No such account' }, 404);
      const named = f.project ? [...account.projects.values()].find((p) => p.name === f.project && !p.is_deleted && !p.is_archived) : null;
      const projectId = f.project ? (named ?? this.addProject(account, f.project)).id : account.inboxId;
      const item = this.addTask(account, { content: f.content ?? 'Task', project_id: projectId });
      await this.deliverWebhook('item:added', item);
      return json({ id: item.id, project_id: projectId });
    }
    const found = this.findTask(f.content ?? '');
    if (!found) return json({ error: 'No such task' }, 404);
    if (url.pathname === '/__fake/tasks/complete') {
      this.close(found.account, found.item.id);
      await this.deliverWebhook('item:completed', found.item);
      return json({ ok: true });
    }
    if (url.pathname === '/__fake/accounts/revoke') {
      this.revokeAll(found.account.id);
      return json({ ok: true });
    }
    return json({ error: 'Unknown control' }, 404);
  }
}
