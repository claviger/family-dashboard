import { z } from 'zod';
import type { TodoistConfig } from '../../config.js';
import type { TodoistCommandError } from './mapping.js';

/**
 * Todoist API v1 over HTTP, written against docs/research/todoist-api-v1.md and its "Verified live
 * (2026-11-16)" section (which override the spec where they differ). It knows nothing about the database; `Todoist` (todoist.ts) does the
 * bookkeeping. Nothing here logs, and no error message contains a token or a response body.
 */

/** Spec §10.6. `data:read_write` includes `data:read`; `data:delete` covers deleting tasks. */
export const TODOIST_SCOPES = 'data:read_write,data:delete';
/** Every sync asks for these (research notes §2). */
export const RESOURCE_TYPES = ['items', 'projects', 'user'] as const;
/** Todoist's own processing limit is 15 seconds (research notes §2, "Rate limits"). */
const TIMEOUT_MS = 20_000;
/**
 * The token endpoint gets longer. If a refresh times out here after Todoist has already rotated
 * the refresh token, the new one is lost, and the next refresh sends a used one: after 60
 * seconds that revokes everything (research notes §1). Waiting longer makes that rarer.
 */
const TOKEN_TIMEOUT_MS = 60_000;

export type FetchFn = typeof fetch;

/**
 * A failed HTTP call:
 * - `auth`: 401 or 403. The token is expired, revoked, or lacks a scope. (Not for `getTask`, where
 *   a 403 is about the one task.)
 * - `rate_limited`: 429. `retryAfterSec` comes from `error_extra.retry_after` (verified live: error
 *   bodies carry it, and there are no rate-limit headers), or a Retry-After header if one appears.
 * - `server`: 5xx. `rejected`: any other 4xx. `network`: no response, or it timed out.
 * - `bad_response`: a 200 whose body isn't what the docs describe.
 */
export class TodoistHttpError extends Error {
  constructor(
    readonly kind: 'auth' | 'rate_limited' | 'server' | 'rejected' | 'network' | 'bad_response',
    readonly status: number | null,
    message: string,
    readonly retryAfterSec: number | null = null,
  ) {
    super(message);
    this.name = 'TodoistHttpError';
  }
}

/** The token endpoint answered with an OAuth error, e.g. `invalid_grant` or `bad_authorization_code`. */
export class TodoistOAuthError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(`Todoist refused the token request (${code}).`);
    this.name = 'TodoistOAuthError';
  }
}

export interface TokenSet {
  accessToken: string;
  /** Null when the response had none: legacy apps, and the 60-second replay grace (research notes §1). */
  refreshToken: string | null;
  /** Null when Todoist sent no `expires_in`. */
  expiresAt: Date | null;
}

/** One `/sync` command (research notes §3). `uuid` makes it safe to send again. */
export interface SyncCommand {
  type: 'item_add' | 'item_update' | 'item_close' | 'item_uncomplete' | 'item_delete';
  uuid: string;
  temp_id?: string;
  args: Record<string, unknown>;
}

const Id = z.union([z.string(), z.number()]).transform(String);
const Flag = z.boolean().nullish().transform((v) => v === true);

export const TodoistItemSchema = z.object({
  id: Id,
  project_id: Id,
  content: z.string(),
  description: z.string().nullish().transform((v) => v ?? ''),
  checked: Flag,
  is_deleted: Flag,
  completed_at: z.string().nullish(),
  /** When the task was created (research notes §2, the item object). Only used to tell a lost create's task apart. */
  added_at: z.string().nullish(),
  due: z
    .object({ date: z.string(), timezone: z.string().nullish(), is_recurring: z.boolean().nullish(), string: z.string().nullish() })
    .nullish(),
});
export type TodoistItem = z.infer<typeof TodoistItemSchema>;

export const TodoistProjectSchema = z.object({
  id: Id,
  name: z.string(),
  is_deleted: Flag,
  is_archived: Flag,
  inbox_project: Flag,
});
export type TodoistProject = z.infer<typeof TodoistProjectSchema>;

const UserSchema = z.object({ id: Id, email: z.string().nullish(), inbox_project_id: Id.nullish() });

const CommandErrorSchema = z.object({
  error_tag: z.string().optional(),
  error_code: z.number().optional(),
  error: z.string().optional(),
  http_code: z.number().optional(),
  error_extra: z.record(z.string(), z.unknown()).optional(),
});

const SyncResponseSchema = z.object({
  sync_token: z.string(),
  full_sync: z.boolean().optional(),
  full_sync_date_utc: z.string().nullish(),
  items: z.array(z.unknown()).optional(),
  projects: z.array(z.unknown()).optional(),
  user: UserSchema.optional(),
  sync_status: z.record(z.string(), z.union([z.literal('ok'), CommandErrorSchema])).optional(),
  temp_id_mapping: z.record(z.string(), Id).optional(),
});

export interface SyncResponse {
  syncToken: string;
  fullSync: boolean;
  /** When Todoist took a full sync's snapshot; it can lag on big accounts (research notes §2). */
  fullSyncDateUtc: string | null;
  items: TodoistItem[];
  projects: TodoistProject[];
  user: { id: string; email: string | null; inboxProjectId: string | null } | null;
  /** By command uuid: 'ok' or the error. */
  syncStatus: Record<string, 'ok' | TodoistCommandError>;
  tempIdMapping: Record<string, string>;
  /** Items or projects that didn't match the documented shape and were left out. */
  skipped: number;
}

/** One page of `GET /api/v1/tasks` (research notes §4). */
const TaskPageSchema = z.object({ results: z.array(z.unknown()), next_cursor: z.string().nullish() });

/** `listTasks` reads at most this many pages of 200 (4,000 tasks) before giving up on the rest. */
export const MAX_TASK_PAGES = 20;

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).nullish(),
  expires_in: z.number().nullish(),
});

function retryAfter(res: Response, body: unknown): number | null {
  const header = Number(res.headers.get('retry-after'));
  if (Number.isFinite(header) && header > 0) return header;
  const extra = (body as { error_extra?: { retry_after?: unknown } } | null)?.error_extra?.retry_after;
  return typeof extra === 'number' ? extra : null;
}

export class TodoistClient {
  constructor(
    private readonly cfg: TodoistConfig,
    private readonly fetchFn: FetchFn,
  ) {}

  /** The consent page (research notes §1, "Authorize"), with PKCE S256 as defense in depth. */
  authorizeUrl(p: { state: string; codeChallenge: string; redirectUri: string }): string {
    const url = new URL('/oauth/authorize', this.cfg.oauthBaseUrl);
    url.search = new URLSearchParams({
      client_id: this.cfg.clientId,
      scope: TODOIST_SCOPES,
      state: p.state,
      redirect_uri: p.redirectUri,
      response_type: 'code',
      code_challenge: p.codeChallenge,
      code_challenge_method: 'S256',
    }).toString();
    return url.href;
  }

  /** Exchanges the callback's code. Throws TodoistOAuthError or TodoistHttpError. */
  exchangeCode(p: { code: string; codeVerifier: string; redirectUri: string }, now: Date): Promise<TokenSet> {
    return this.token(
      { client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, code: p.code, redirect_uri: p.redirectUri, code_verifier: p.codeVerifier },
      now,
    );
  }

  /**
   * Trades a refresh token for new tokens. Refresh tokens rotate: the old one is used up. Sending a
   * used one again more than 60 seconds later revokes every token the user has for this app
   * (research notes §1), so callers run this single-flight per user and store the result at once.
   */
  refresh(refreshToken: string, now: Date): Promise<TokenSet> {
    return this.token(
      { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret },
      now,
    );
  }

  /**
   * RFC 7009 revocation with Basic client auth (research notes §1, "Revocation"). The docs disagree
   * on the encoding, so this sends JSON (what the OpenAPI spec and the SDK use) and, if that's
   * refused with a 4xx, form encoding (what the prose says). Throws if neither works. `timeoutMs`
   * applies to each of the two requests.
   */
  async revoke(token: string, hint?: 'access_token', timeoutMs = TIMEOUT_MS): Promise<void> {
    const url = new URL('/api/v1/revoke', this.cfg.apiBaseUrl).href;
    const auth = `Basic ${Buffer.from(`${this.cfg.clientId}:${this.cfg.clientSecret}`).toString('base64')}`;
    const fields: Record<string, string> = hint ? { token, token_type_hint: hint } : { token };
    const asJson = await this.send(url, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(fields) }, timeoutMs);
    if (asJson.ok) return;
    if (asJson.status >= 400 && asJson.status < 500) {
      const asForm = await this.send(url, { method: 'POST', headers: { authorization: auth }, body: new URLSearchParams(fields) }, timeoutMs);
      if (asForm.ok) return;
      throw new TodoistHttpError('rejected', asForm.status, `Todoist refused the revocation (HTTP ${asForm.status}).`);
    }
    throw new TodoistHttpError(asJson.status >= 500 ? 'server' : 'rejected', asJson.status, `Todoist refused the revocation (HTTP ${asJson.status}).`);
  }

  /**
   * One task by id, to tell a task that's missing from a full sync apart: verified live
   * ("Telling completed from deleted"), an open task is 200 with `checked: false`, a completed one
   * 200 with `checked: true`, and a deleted one 404 NOT_FOUND. Anything else throws, and the
   * caller leaves the row alone.
   *
   * Only a 401 is `auth` here. A 403 is about this one task (say, a shared project the person
   * lost access to), not the token, so it's `rejected` like any other 4xx: one task mustn't break
   * the whole link. (What Todoist sends for such a task isn't verified; this is the safe reading.)
   */
  async getTask(accessToken: string, taskId: string): Promise<{ state: 'open' | 'completed'; item: TodoistItem } | { state: 'deleted' }> {
    const res = await this.send(new URL(`/api/v1/tasks/${encodeURIComponent(taskId)}`, this.cfg.apiBaseUrl).href, {
      method: 'GET',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const json: unknown = await res.json().catch(() => null);
    if (res.status === 404 && (json as { error_tag?: unknown } | null)?.error_tag === 'NOT_FOUND') return { state: 'deleted' };
    if (res.status === 403) throw new TodoistHttpError('rejected', 403, 'Todoist refused access to that task (HTTP 403).');
    if (!res.ok) throw this.httpError(res, json);
    const item = TodoistItemSchema.safeParse(json);
    if (!item.success) throw new TodoistHttpError('bad_response', res.status, "Todoist's task response wasn't in the expected format.");
    return { state: item.data.checked ? 'completed' : 'open', item: item.data };
  }

  /**
   * A project's active tasks: `GET /api/v1/tasks?project_id=…&limit=200`, following `next_cursor`
   * (research notes §4, "Endpoints" and "Pagination": `{ results, next_cursor }`, `limit` at most
   * 200, cursors not to be kept). Documented but not live-checked, so the results are parsed as
   * the sync item shape, and any that don't parse are left out. Stops after MAX_TASK_PAGES pages
   * and says so (`complete: false`), so a huge project can't hold the caller's lock for long.
   * Concurrent edits can skip or repeat a task between pages (research notes §4); callers treat
   * the list as a best effort.
   */
  async listTasks(accessToken: string, p: { projectId: string }): Promise<{ items: TodoistItem[]; complete: boolean }> {
    const items: TodoistItem[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_TASK_PAGES; page++) {
      const url = new URL('/api/v1/tasks', this.cfg.apiBaseUrl);
      url.searchParams.set('project_id', p.projectId);
      url.searchParams.set('limit', '200');
      if (cursor) url.searchParams.set('cursor', cursor);
      const res = await this.send(url.href, { method: 'GET', headers: { authorization: `Bearer ${accessToken}` } });
      const json: unknown = await res.json().catch(() => null);
      if (!res.ok) throw this.httpError(res, json);
      const parsed = TaskPageSchema.safeParse(json);
      if (!parsed.success) throw new TodoistHttpError('bad_response', res.status, "Todoist's task list wasn't in the expected format.");
      for (const raw of parsed.data.results) {
        const item = TodoistItemSchema.safeParse(raw);
        if (item.success) items.push(item.data);
      }
      cursor = parsed.data.next_cursor ?? null;
      if (!cursor) return { items, complete: true };
    }
    return { items, complete: false };
  }

  /**
   * POST /api/v1/sync with a JSON body (verified live: JSON and form both work; the SDK uses JSON).
   * Reads and writes go in one request: `commands` run first, and the response carries everything
   * that changed since `syncToken`, including the item a command just wrote (verified live), plus
   * a new token. `resourceTypes` narrows what's returned (linking asks for just `user` first).
   */
  async sync(accessToken: string, req: { syncToken: string; commands?: SyncCommand[]; resourceTypes?: readonly string[] }): Promise<SyncResponse> {
    const body: Record<string, unknown> = { sync_token: req.syncToken, resource_types: req.resourceTypes ?? RESOURCE_TYPES };
    if (req.commands && req.commands.length > 0) body.commands = req.commands;
    const res = await this.send(new URL('/api/v1/sync', this.cfg.apiBaseUrl).href, {
      method: 'POST',
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) throw this.httpError(res, json);
    const parsed = SyncResponseSchema.safeParse(json);
    if (!parsed.success) throw new TodoistHttpError('bad_response', res.status, "Todoist's sync response wasn't in the expected format.");
    let skipped = 0;
    const keep = <T>(schema: z.ZodType<T>, list: unknown[] | undefined): T[] =>
      (list ?? []).flatMap((raw) => {
        const r = schema.safeParse(raw);
        if (r.success) return [r.data];
        skipped++;
        return [];
      });
    const d = parsed.data;
    return {
      syncToken: d.sync_token,
      fullSync: d.full_sync === true,
      fullSyncDateUtc: d.full_sync_date_utc ?? null,
      items: keep(TodoistItemSchema, d.items),
      projects: keep(TodoistProjectSchema, d.projects),
      user: d.user ? { id: d.user.id, email: d.user.email ?? null, inboxProjectId: d.user.inbox_project_id ?? null } : null,
      syncStatus: d.sync_status ?? {},
      tempIdMapping: d.temp_id_mapping ?? {},
      skipped,
    };
  }

  private async token(fields: Record<string, string>, now: Date): Promise<TokenSet> {
    const res = await this.send(
      new URL('/oauth/access_token', this.cfg.apiBaseUrl).href,
      { method: 'POST', body: new URLSearchParams(fields) },
      TOKEN_TIMEOUT_MS,
    );
    const json: unknown = await res.json().catch(() => null);
    const oauthError = (json as { error?: unknown } | null)?.error;
    if (typeof oauthError === 'string' && (!res.ok || !(json as { access_token?: unknown }).access_token)) {
      throw new TodoistOAuthError(oauthError, res.status);
    }
    if (!res.ok) throw this.httpError(res, json);
    const parsed = TokenResponseSchema.safeParse(json);
    if (!parsed.success) throw new TodoistHttpError('bad_response', res.status, "Todoist's token response wasn't in the expected format.");
    const { access_token, refresh_token, expires_in } = parsed.data;
    return {
      accessToken: access_token,
      refreshToken: refresh_token ?? null,
      expiresAt: typeof expires_in === 'number' ? new Date(now.getTime() + expires_in * 1000) : null,
    };
  }

  private async send(url: string, init: RequestInit, timeoutMs = TIMEOUT_MS): Promise<Response> {
    try {
      return await this.fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new TodoistHttpError('network', null, "Couldn't reach Todoist.");
    }
  }

  private httpError(res: Response, body: unknown): TodoistHttpError {
    if (res.status === 401 || res.status === 403) return new TodoistHttpError('auth', res.status, `Todoist refused the token (HTTP ${res.status}).`);
    if (res.status === 429) return new TodoistHttpError('rate_limited', 429, 'Todoist is rate-limiting requests.', retryAfter(res, body));
    if (res.status >= 500) return new TodoistHttpError('server', res.status, `Todoist had a server error (HTTP ${res.status}).`, retryAfter(res, body));
    return new TodoistHttpError('rejected', res.status, `Todoist rejected the request (HTTP ${res.status}).`);
  }
}
