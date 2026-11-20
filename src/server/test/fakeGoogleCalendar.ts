import { createHash, randomBytes } from 'node:crypto';
import { addDays, daysBetween, weekdayOf } from '../../shared/dates.js';
import { utcToWall, wallToUtcMs, zoneOffsetMs } from '../../shared/zonedTime.js';

/**
 * An in-memory model of the slice of Google's OAuth and Calendar API v3 the app uses, for tests,
 * written from docs/research/google-calendar-v3.md:
 * - OAuth: the consent page (`GET /o/oauth2/v2/auth`, which approves at once), the token
 *   endpoint (code exchange with PKCE S256 and `client_secret_post`, and refresh, which doesn't
 *   rotate the refresh token), and revocation (`POST /revoke`, which ends every grant the account
 *   gave this client, as Google's "Key Point" says). The token response has `scope` (granular
 *   consent: `grantOnly` grants fewer scopes than asked) and an ID token when `openid` was asked.
 * - Calendar: `calendarList.list` (with `minAccessRole`), and `events.list` (`singleEvents=true`
 *   and `orderBy=startTime` only, `timeMin`/`timeMax` overlap, `timeZone`, paging with short and
 *   empty pages), `get`, `insert` (client-supplied ids, 409 `duplicate`), `patch` (merge, `null`
 *   clears, arrays replace), `update` (PUT, replaces), `delete` (410 once deleted), and
 *   `instances` (a series' instances, cancelled ones too with `showDeleted=true`).
 * - Repeating events: a series' RRULE (DAILY, WEEKLY with BYDAY, MONTHLY, YEARLY; INTERVAL, COUNT,
 *   UNTIL) and EXDATE are expanded here independently of the app's rrule.ts, into instances with
 *   `recurringEventId`, `originalStartTime`, and ids like `<series>_<UTC start>`. Patching an
 *   instance makes an exception; patching it to `status: 'cancelled'` drops it from lists.
 * - etags that change on every write, quoted the way Google's look, `If-Match` with the documented
 *   412 body (`ignoreIfMatch` models Google not honoring it on patch, which is UNVERIFIED).
 * - Injectable failures (`failures`): any status and body on the next calls to an endpoint, with
 *   the documented error bodies in `GOOGLE_ERRORS`; a lost answer (`loseNextResponse`); and two
 *   UNVERIFIED behaviors behind switches: Google refusing PATCH on an instance id
 *   (`instancePatchUnsupported`), and refusing `If-Match` with an instance's etag
 *   (`instanceEtagsRejected`).
 *
 * Use it as `fetch` in Vitest (`fake.fetch`), or behind an HTTP server for Playwright
 * (fakeGoogleCalendarServer.ts), which also uses the `/__fake/*` controls below. Each endpoint
 * answers only on its own origin when `origins` is set: the consent page on `oauth`, everything
 * else on `api`.
 *
 * Bodies marked "documented" are copied from the research notes' quotes of Google's docs; the
 * others are the likely shape and say so.
 */

export const SCOPES = {
  events: 'https://www.googleapis.com/auth/calendar.events',
  calendarList: 'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
} as const;

export type AccessRole = 'owner' | 'writer' | 'writerWithoutPrivateAccess' | 'reader' | 'freeBusyReader';
const ROLE_RANK: Record<AccessRole, number> = { freeBusyReader: 0, reader: 1, writerWithoutPrivateAccess: 2, writer: 3, owner: 4 };

export interface FakeGoogleAccount {
  sub: string;
  email: string;
}

type Resource = Record<string, unknown>;

interface StoredEvent {
  resource: Resource;
  /**
   * For a series: instances changed or cancelled, by their original start key, each as the whole
   * instance it now is. They keep their own fields when the series changes later; what Google
   * does then is UNVERIFIED (research notes §6).
   */
  exceptions: Map<string, Resource>;
  deleted: boolean;
}

export interface FakeCalendar {
  id: string;
  summary: string;
  timeZone: string;
  roles: Map<string, AccessRole>;
  primaryOf: string | null;
  readonly events: Map<string, StoredEvent>;
}

type Path = 'authorize' | 'token' | 'revoke' | 'calendarList' | 'list' | 'get' | 'insert' | 'patch' | 'update' | 'delete' | 'instances';

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function b64url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

/** Google's v3 error body: `{"error":{"errors":[...],"code":N,"message":...}}` (research notes §8). */
export function googleError(code: number, reason: string, message: string, domain = 'global', extra: Resource = {}): Resource {
  return { error: { errors: [{ domain, reason, message, ...extra }], code, message } };
}

/** Error bodies for injected failures and the fake's own answers. */
export const GOOGLE_ERRORS = {
  /** Documented (errors guide, 401). */
  authError: googleError(401, 'authError', 'Invalid Credentials', 'global', { locationType: 'header', location: 'Authorization' }),
  /** Documented (errors guide, 412). */
  conditionNotMet: googleError(412, 'conditionNotMet', 'Precondition Failed', 'global', { locationType: 'header', location: 'If-Match' }),
  /** Documented reasons (errors guide, 403 and 429). */
  rateLimitExceeded: googleError(403, 'rateLimitExceeded', 'Rate Limit Exceeded', 'usageLimits'),
  userRateLimitExceeded: googleError(403, 'userRateLimitExceeded', 'User Rate Limit Exceeded', 'usageLimits'),
  quotaExceeded: googleError(403, 'quotaExceeded', 'Calendar usage limits exceeded.', 'usageLimits'),
  tooManyRequests: googleError(429, 'rateLimitExceeded', 'Rate Limit Exceeded', 'usageLimits'),
  forbiddenForNonOrganizer: googleError(403, 'forbiddenForNonOrganizer', 'Shared properties can only be changed by the organizer of the event.', 'calendar'),
  /** Documented (errors guide, 404 and 410). */
  notFound: googleError(404, 'notFound', 'Not Found'),
  deleted: googleError(410, 'deleted', 'Resource has been deleted'),
  duplicate: googleError(409, 'duplicate', 'The requested identifier already exists.'),
  backendError: googleError(500, 'backendError', 'Backend Error'),
  /** UNVERIFIED (research notes §8: "from memory"): a token without the scope. */
  insufficientPermissions: googleError(403, 'insufficientPermissions', 'Request had insufficient authentication scopes.'),
  /** The likely shape, not documented for Calendar: a method the resource doesn't support. */
  methodNotAllowed: googleError(405, 'methodNotAllowed', 'Method not allowed.'),
  /** UNVERIFIED: no write access to the calendar. */
  requiredAccessLevel: googleError(403, 'requiredAccessLevel', 'You need to have writer access to this calendar.'),
  /**
   * UNVERIFIED, not in the research notes (C-M2): the Calendar API isn't enabled for the Cloud
   * project. The shape is from memory of Google's APIs generally: `accessNotConfigured` in the
   * `usageLimits` domain, a `SERVICE_DISABLED` ErrorInfo in `details`, and a message naming the API.
   */
  accessNotConfigured: {
    error: {
      code: 403,
      message: 'Google Calendar API has not been used in project 123456789 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=123456789 then retry.',
      errors: [{ domain: 'usageLimits', reason: 'accessNotConfigured', message: 'Google Calendar API has not been used in project 123456789 before or it is disabled.', extendedHelp: 'https://console.developers.google.com' }],
      status: 'PERMISSION_DENIED',
      details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED', domain: 'googleapis.com', metadata: { service: 'calendar-json.googleapis.com', consumer: 'projects/123456789' } }],
    },
  },
  /** RFC 6749 §5.2 shape; Google's description text is UNVERIFIED. */
  invalidGrant: { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' },
} as const;

/** `"<digits>"`, like Google's etags. */
function etag(seq: number): string {
  return `"${3181160000000000 + seq}"`;
}

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuv'; // base32hex, what event ids allow (research notes §5)

function eventId(): string {
  return [...randomBytes(20)].map((b) => ID_ALPHABET[b % 32]).join('');
}

/** Deep merge for `events.patch` (research notes §5): objects merge, `null` deletes, arrays and scalars replace. */
function merge(target: Resource, patch: Resource): Resource {
  const out: Resource = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete out[k];
    else if (typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object' && out[k] !== null && !Array.isArray(out[k])) out[k] = merge(out[k] as Resource, v as Resource);
    else out[k] = v;
  }
  return out;
}

interface Time {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

/** An instant for a timed value, using `fallbackZone` when it has no offset. */
function instantOf(t: Time, fallbackZone: string): number {
  const dt = t.dateTime!;
  if (/(Z|[+-]\d{2}:\d{2})$/.test(dt)) return Date.parse(dt);
  const [date, time] = dt.split('T') as [string, string];
  return wallToUtcMs(date, time.slice(0, 5), t.timeZone ?? fallbackZone);
}

/** RFC 3339 for `instant` in `zone`, as Google writes times in the response's time zone. */
function rfc3339(instant: number, zone: string): string {
  const wall = utcToWall(instant, zone);
  const off = zoneOffsetMs(instant, zone);
  const sign = off < 0 ? '-' : '+';
  const mins = Math.abs(off) / 60_000;
  return `${wall.date}T${wall.time}:00${sign}${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

function compactUtc(instant: number): string {
  return new Date(instant).toISOString().slice(0, 19).replace(/[-:]/g, '') + 'Z';
}

interface Rule {
  freq: string;
  interval: number;
  count: number | null;
  until: string | null;
  byDay: string[] | null;
  byMonthDay: number | null;
}

const DAY_CODES = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];

function parseRule(line: string): Rule {
  const f = Object.fromEntries(line.replace(/^RRULE:/i, '').split(';').filter(Boolean).map((p) => p.split('=') as [string, string]));
  return {
    freq: (f.FREQ ?? '').toUpperCase(),
    interval: f.INTERVAL ? Number(f.INTERVAL) : 1,
    count: f.COUNT ? Number(f.COUNT) : null,
    until: f.UNTIL ?? null,
    byDay: f.BYDAY ? f.BYDAY.split(',') : null,
    byMonthDay: f.BYMONTHDAY ? Number(f.BYMONTHDAY) : null,
  };
}

/** Monday of the week `date` is in (RFC 5545's default WKST). */
function weekStart(date: string): string {
  return addDays(date, -((weekdayOf(date) + 6) % 7));
}

/** Does `d` fall on the rule, counting from the series' first date `d0`? */
function onRule(rule: Rule, d0: string, d: string): boolean {
  const [y0, m0, dd0] = d0.split('-').map(Number);
  const [y, m, dd] = d.split('-').map(Number);
  switch (rule.freq) {
    case 'DAILY':
      return daysBetween(d0, d) % rule.interval === 0;
    case 'WEEKLY': {
      const days = rule.byDay ?? [DAY_CODES[weekdayOf(d0)]!];
      return days.includes(DAY_CODES[weekdayOf(d)]!) && (daysBetween(weekStart(d0), weekStart(d)) / 7) % rule.interval === 0;
    }
    case 'MONTHLY':
      return dd === (rule.byMonthDay ?? dd0) && ((y! - y0!) * 12 + (m! - m0!)) % rule.interval === 0;
    case 'YEARLY':
      return m === m0 && dd === dd0 && (y! - y0!) % rule.interval === 0;
    default:
      return false;
  }
}

/**
 * The instance keys an EXDATE line excludes (RFC 5545 §3.8.5.1): `VALUE=DATE` dates, UTC times,
 * and local times in its `TZID` (or, with none, the series' zone), as the UTC key instances use.
 */
function exdateKeys(line: string, allDay: boolean, seriesZone: string): string[] {
  const colon = line.indexOf(':');
  const params = line.slice(0, colon);
  const tzid = /;TZID=([^;:]+)/i.exec(params)?.[1] ?? seriesZone;
  return line.slice(colon + 1).split(',').map((v) => v.trim()).filter(Boolean).map((v) => {
    const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(v);
    if (!m) return v;
    const date = `${m[1]}-${m[2]}-${m[3]}`;
    if (allDay || m[4] === undefined) return allDay ? `${m[1]}${m[2]}${m[3]}` : compactUtc(wallToUtcMs(date, '00:00', tzid));
    if (m[7] === 'Z') return `${m[1]}${m[2]}${m[3]}T${m[4]}${m[5]}${m[6]}Z`;
    return compactUtc(wallToUtcMs(date, `${m[4]}:${m[5]}`, tzid));
  });
}

export class FakeGoogleCalendar {
  readonly accounts = new Map<string, FakeGoogleAccount>();
  readonly calendars = new Map<string, FakeCalendar>();
  /** Every request, for assertions. */
  readonly requests: { method: string; path: string; query: Record<string, string>; body: unknown; ifMatch: string | null; authorization: string | null }[] = [];
  /** The next calls to these endpoints fail with this status and body, in order. */
  readonly failures: { path: Path; status: number; body?: unknown; headers?: Record<string, string> }[] = [];
  /** Every revocation that named a known token. */
  readonly revocations: { sub: string; kind: 'access' | 'refresh' }[] = [];
  /** The consent page signs in as this account (default: the first one). */
  nextAccount: FakeGoogleAccount | null = null;
  /** Answer the next authorization with `?error=access_denied`. */
  denyNext = false;
  /** The next consent grants only these scopes (granular consent: the admin unticked some). */
  grantOnly: string[] | null = null;
  /** Leave `scope` out of token responses. RFC 6749 allows that only when it's what was asked. */
  omitScope = false;
  /** Leave the refresh token out of the next code exchange. */
  omitRefreshToken = false;
  /** Apply a patch even when `If-Match` is stale (Google ignoring it, UNVERIFIED either way). */
  ignoreIfMatch = false;
  /** Do the next call to this endpoint, then answer 502, as if the answer was lost on the way back. */
  loseNextResponse: Path | null = null;
  /** Answer PATCH on an instance id with 405, as if Google only took PUT there (research notes §6, UNVERIFIED). */
  instancePatchUnsupported = false;
  /** Answer any `If-Match` on an instance that exists with 412, even a current etag (research notes §5, UNVERIFIED). */
  instanceEtagsRejected = false;
  /**
   * Cancelled instances carry only `id`, `recurringEventId`, `originalStartTime`, and `status`, with
   * no etag or times, as research notes §4 says Google may send them.
   */
  minimalCancelled = false;
  /**
   * DELETE checks `If-Match` before saying the event is gone: an event already deleted answers 412
   * to an `If-Match`, not 410 (its etag changed when it was deleted). UNVERIFIED either way.
   */
  deleteChecksIfMatchFirst = false;
  /**
   * `events.get` on a deleted event answers it with `status: 'cancelled'` and a new etag, as the
   * Events resource describes deletions (research notes §4), rather than 404. On by default; the
   * app handles both. Which one Google does is UNVERIFIED.
   */
  getDeletedAsCancelled = true;
  /** A code exchange with `prompt=consent` revokes the account's older refresh tokens (UNVERIFIED, research notes §1). */
  relinkInvalidatesOldRefresh = false;
  /** Revocation refuses requests without client credentials (401 `invalid_client`). The docs send none (UNVERIFIED item 5). */
  revokeNeedsClientCredentials = false;
  /** Revocation answers 400 `invalid_request`, a 4xx that doesn't mean the token is already gone. */
  revokeInvalidRequest = false;
  /** At most this many events per page (Google may send fewer than `maxResults`). */
  pageSize = 250;
  /** Answer the first page of each list with no items and a `nextPageToken`, as Google may. */
  emptyFirstPage = false;
  /**
   * Whether `minAccessRole=writer` lets `writerWithoutPrivateAccess` through. How Google orders it
   * is UNVERIFIED (research notes §3); the default lets it through, so the app's own filter is tested.
   */
  writerFilterLeaksWithoutPrivate = true;
  /** Claims to put in ID tokens over the real ones (a wrong `iss`, `aud`, or `exp`), for the app's checks. */
  idTokenClaims: Resource | null = null;
  /** Lifetime of access tokens, in seconds (Google's are about an hour). */
  accessTokenTtlSec = 3599;
  /** Each endpoint only on its own origin, as Google's hosts (see the class comment). */
  origins: { oauth: string; api: string } = { oauth: 'https://accounts.google.test', api: 'https://api.google.test' };
  /** The fake's clock, for token expiry and `updated`. ID tokens use the real clock, as openid-client checks them against it. */
  now: () => number = () => Date.now();

  private seq = 1;
  private readonly access = new Map<string, { sub: string; scopes: Set<string>; expiresAt: number; revoked: boolean }>();
  private readonly refresh = new Map<string, { sub: string; scopes: Set<string>; revoked: boolean }>();
  private readonly codes = new Map<string, { sub: string; redirectUri: string; challenge: string; scopes: string[]; nonce: string | null; offline: boolean; used: boolean }>();
  private readonly granted = new Set<string>();

  constructor(
    readonly clientId = 'client-id',
    readonly clientSecret = 'client-secret',
  ) {}

  /** Drop-in `fetch` for the app's Google clients. */
  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => this.handle(new Request(input, init));

  createAccount(opts: { email?: string; sub?: string } = {}): FakeGoogleAccount {
    const n = this.accounts.size + 1;
    const account = { sub: opts.sub ?? `1000000000000000000${n}`, email: opts.email ?? `person${n}@example.com` };
    this.accounts.set(account.sub, account);
    return account;
  }

  addCalendar(owner: FakeGoogleAccount, opts: { summary: string; timeZone?: string; role?: AccessRole; primary?: boolean; id?: string }): FakeCalendar {
    const id = opts.id ?? (opts.primary ? owner.email : `${eventId().slice(0, 26)}@group.calendar.google.com`);
    const cal: FakeCalendar = {
      id, summary: opts.summary, timeZone: opts.timeZone ?? 'America/Los_Angeles', roles: new Map([[owner.sub, opts.role ?? 'owner']]),
      primaryOf: opts.primary ? owner.sub : null, events: new Map(),
    };
    this.calendars.set(id, cal);
    return cal;
  }

  share(cal: FakeCalendar, account: FakeGoogleAccount, role: AccessRole): void {
    cal.roles.set(account.sub, role);
  }

  /** An event made in Google itself (no dashboard attribution unless given). Returns its resource. */
  addEvent(cal: FakeCalendar, fields: Resource): Resource {
    const id = typeof fields.id === 'string' ? fields.id : eventId();
    const resource = this.fresh(cal, { ...fields, id });
    cal.events.set(id, { resource, exceptions: new Map(), deleted: false });
    return this.present(cal, resource, cal.timeZone);
  }

  /** Someone changes an event in Google: merged like a patch, with a new etag. Works on instances too. */
  editEvent(cal: FakeCalendar, id: string, patch: Resource): Resource {
    const res = this.applyPatch(cal, id, patch);
    if (!res) throw new Error(`no event ${id}`);
    return res;
  }

  /** Someone deletes a single event or a series in Google. */
  removeEvent(cal: FakeCalendar, id: string): void {
    const stored = cal.events.get(id);
    if (!stored || stored.deleted) throw new Error(`no event ${id}`);
    this.markDeleted(stored);
  }

  private markDeleted(stored: StoredEvent): void {
    stored.deleted = true;
    stored.resource = { ...stored.resource, status: 'cancelled', etag: etag(++this.seq), updated: new Date(this.now()).toISOString() };
  }

  /** The event, series, or instance as `events.get` would return it, or null. */
  event(cal: FakeCalendar, id: string): Resource | null {
    return this.lookup(cal, id, cal.timeZone);
  }

  /** Series and single events, not deleted, for assertions. */
  storedEvents(cal: FakeCalendar): Resource[] {
    return [...cal.events.values()].filter((e) => !e.deleted).map((e) => ({ ...e.resource, exceptions: Object.fromEntries(e.exceptions) }));
  }

  /** Tokens as if the account had just finished the consent page. */
  grant(account: FakeGoogleAccount, scopes: string[] = ['openid', 'email', SCOPES.events, SCOPES.calendarList]): { access_token: string; refresh_token: string; expires_in: number; scope: string } {
    const issued = this.issue(account.sub, scopes, true);
    return { access_token: issued.access_token, refresh_token: issued.refresh_token!, expires_in: issued.expires_in, scope: issued.scope };
  }

  expireAccessTokens(): void {
    for (const t of this.access.values()) t.expiresAt = 0;
  }

  /** The account removes the app's access in their Google settings: every token stops working. */
  revokeAccount(account: FakeGoogleAccount): void {
    for (const t of this.access.values()) if (t.sub === account.sub) t.revoked = true;
    for (const t of this.refresh.values()) if (t.sub === account.sub) t.revoked = true;
  }

  liveRefreshTokens(account: FakeGoogleAccount): number {
    return [...this.refresh.values()].filter((t) => t.sub === account.sub && !t.revoked).length;
  }

  /**
   * The consent page's answer: where the browser goes next. Approves at once as `nextAccount`
   * (or the first account), granting what was asked or `grantOnly`.
   */
  authorize(params: URLSearchParams): URL {
    const redirect = new URL(params.get('redirect_uri') ?? 'http://invalid/');
    const state = params.get('state');
    if (state) redirect.searchParams.set('state', state);
    if (params.get('client_id') !== this.clientId || params.get('response_type') !== 'code') {
      redirect.searchParams.set('error', 'invalid_request');
      return redirect;
    }
    if (this.denyNext) {
      this.denyNext = false;
      redirect.searchParams.set('error', 'access_denied');
      return redirect;
    }
    const account = this.nextAccount ?? [...this.accounts.values()][0] ?? this.createAccount();
    const asked = (params.get('scope') ?? '').split(' ').filter(Boolean);
    const scopes = this.grantOnly ?? asked;
    this.grantOnly = null;
    const code = `4/${eventId()}`;
    this.codes.set(code, {
      sub: account.sub,
      redirectUri: redirect.origin + redirect.pathname,
      challenge: params.get('code_challenge_method') === 'S256' ? params.get('code_challenge') ?? '' : '',
      scopes,
      nonce: params.get('nonce'),
      // Research notes §1: offline access, and a refresh token only the first time unless prompt=consent.
      offline: params.get('access_type') === 'offline' && ((params.get('prompt') ?? '').split(' ').includes('consent') || !this.granted.has(account.sub)),
      used: false,
    });
    redirect.searchParams.set('code', code);
    return redirect;
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const text = req.method === 'GET' ? '' : await req.clone().text();
    let body: unknown = null;
    if (text) {
      if ((req.headers.get('content-type') ?? '').includes('application/json')) {
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
      } else {
        body = Object.fromEntries(new URLSearchParams(text));
      }
    }
    this.requests.push({
      method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), body,
      ifMatch: req.headers.get('if-match'), authorization: req.headers.get('authorization'),
    });
    const expected = url.pathname === '/o/oauth2/v2/auth' ? this.origins.oauth : this.origins.api;
    if (url.origin !== expected) return json({ error: `The fake serves ${url.pathname} on ${expected}, not ${url.origin}` }, 404);
    if (url.pathname.startsWith('/__fake/')) return this.control(url, req.method, body as Resource | null);

    const route = this.route(req.method, url.pathname);
    if (!route) return json(GOOGLE_ERRORS.notFound, 404);
    const failure = this.failures.findIndex((f) => f.path === route.path);
    if (failure >= 0) {
      const f = this.failures.splice(failure, 1)[0]!;
      return json(f.body ?? googleError(f.status, 'injected', 'Injected failure'), f.status, f.headers);
    }
    switch (route.path) {
      case 'authorize':
        return new Response(null, { status: 302, headers: { location: this.authorize(url.searchParams).href } });
      case 'token':
        return this.token(req, (body ?? {}) as Record<string, string>);
      case 'revoke':
        return this.revoke((body ?? {}) as Record<string, string>, url.searchParams);
      default:
        break;
    }
    const token = this.authenticate(req);
    if (!token) return json(GOOGLE_ERRORS.authError, 401);
    if (route.path === 'calendarList') {
      if (!token.scopes.has(SCOPES.calendarList)) return json(GOOGLE_ERRORS.insufficientPermissions, 403);
      return this.calendarList(token.sub, url.searchParams);
    }
    if (!token.scopes.has(SCOPES.events)) return json(GOOGLE_ERRORS.insufficientPermissions, 403);
    const cal = this.calendars.get(route.calendarId!);
    const role = cal?.roles.get(token.sub);
    if (!cal || !role || ROLE_RANK[role] < ROLE_RANK.reader) return json(GOOGLE_ERRORS.notFound, 404);
    const writing = route.path === 'insert' || route.path === 'patch' || route.path === 'update' || route.path === 'delete';
    if (writing && ROLE_RANK[role] < ROLE_RANK.writer) return json(GOOGLE_ERRORS.requiredAccessLevel, 403);
    const zone = url.searchParams.get('timeZone') ?? cal.timeZone;
    const ifMatch = req.headers.get('if-match');
    if (this.instanceEtagsRejected && ifMatch && route.eventId && !cal.events.has(route.eventId)) {
      if (!this.lookup(cal, route.eventId, cal.timeZone)) return json(GOOGLE_ERRORS.notFound, 404);
      return json(GOOGLE_ERRORS.conditionNotMet, 412);
    }
    if (this.instancePatchUnsupported && route.path === 'patch' && route.eventId && !cal.events.has(route.eventId)) return json(GOOGLE_ERRORS.methodNotAllowed, 405);
    if (this.loseNextResponse === route.path) {
      this.loseNextResponse = null;
      await this.answer(route, cal, url, body, ifMatch, zone);
      return json(googleError(502, 'badGateway', 'Bad Gateway'), 502);
    }
    return this.answer(route, cal, url, body, ifMatch, zone);
  }

  private async answer(route: { path: Path; eventId?: string }, cal: FakeCalendar, url: URL, body: unknown, ifMatch: string | null, zone: string): Promise<Response> {
    switch (route.path) {
      case 'list':
        return this.list(cal, url.searchParams);
      case 'instances':
        return this.instancesOf(cal, route.eventId!, url.searchParams, zone);
      case 'get': {
        const found = this.lookup(cal, route.eventId!, zone);
        if (found) return json(found);
        const deleted = cal.events.get(route.eventId!);
        if (deleted?.deleted && this.getDeletedAsCancelled) return json(this.present(cal, deleted.resource, zone));
        return json(GOOGLE_ERRORS.notFound, 404);
      }
      case 'insert':
        return this.insert(cal, (body ?? {}) as Resource);
      case 'patch':
        return this.patch(cal, route.eventId!, (body ?? {}) as Resource, ifMatch);
      case 'update':
        return this.update(cal, route.eventId!, (body ?? {}) as Resource, ifMatch);
      case 'delete':
        return this.remove(cal, route.eventId!, ifMatch);
      default:
        return json(GOOGLE_ERRORS.notFound, 404);
    }
  }

  private route(method: string, path: string): { path: Path; calendarId?: string; eventId?: string } | null {
    if (method === 'GET' && path === '/o/oauth2/v2/auth') return { path: 'authorize' };
    if (method === 'POST' && path === '/token') return { path: 'token' };
    if (method === 'POST' && path === '/revoke') return { path: 'revoke' };
    if (method === 'GET' && path === '/calendar/v3/users/me/calendarList') return { path: 'calendarList' };
    const m = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?(\/instances)?$/.exec(path);
    if (!m) return null;
    const calendarId = decodeURIComponent(m[1]!);
    const eventId = m[2] === undefined ? undefined : decodeURIComponent(m[2]);
    if (m[3]) return method === 'GET' && eventId !== undefined ? { path: 'instances', calendarId, eventId } : null;
    if (eventId === undefined) {
      if (method === 'GET') return { path: 'list', calendarId };
      if (method === 'POST') return { path: 'insert', calendarId };
      return null;
    }
    if (method === 'GET') return { path: 'get', calendarId, eventId };
    if (method === 'PATCH') return { path: 'patch', calendarId, eventId };
    if (method === 'PUT') return { path: 'update', calendarId, eventId };
    if (method === 'DELETE') return { path: 'delete', calendarId, eventId };
    return null;
  }

  private authenticate(req: Request): { sub: string; scopes: Set<string> } | null {
    const bearer = (req.headers.get('authorization') ?? '').replace(/^Bearer /, '');
    const t = this.access.get(bearer);
    if (!t || t.revoked || t.expiresAt <= this.now()) return null;
    return t;
  }

  private idToken(sub: string, nonce: string | null): string {
    const account = this.accounts.get(sub)!;
    const now = Math.floor(Date.now() / 1000);
    const claims: Resource = { iss: this.origins.oauth, azp: this.clientId, aud: this.clientId, sub, email: account.email, email_verified: true, iat: now, exp: now + 3600 };
    if (nonce) claims.nonce = nonce;
    Object.assign(claims, this.idTokenClaims ?? {});
    // Not signed for real: openid-client doesn't check the signature of an ID token that comes
    // straight from the token endpoint over TLS (OIDC Core 3.1.3.7), only its claims and `alg`.
    return `${b64url(JSON.stringify({ alg: 'RS256', kid: 'fake', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}.${b64url('fake-signature')}`;
  }

  private issue(sub: string, scopes: string[], withRefresh: boolean, nonce: string | null = null) {
    const accessToken = `ya29.${eventId()}`;
    this.access.set(accessToken, { sub, scopes: new Set(scopes), expiresAt: this.now() + this.accessTokenTtlSec * 1000, revoked: false });
    let refreshToken: string | undefined;
    if (withRefresh) {
      refreshToken = `1//${eventId()}`;
      this.refresh.set(refreshToken, { sub, scopes: new Set(scopes), revoked: false });
      this.granted.add(sub);
    }
    return {
      access_token: accessToken,
      expires_in: this.accessTokenTtlSec,
      token_type: 'Bearer',
      // Google answers `email` with its full scope URL.
      scope: scopes.map((x) => (x === 'email' ? 'https://www.googleapis.com/auth/userinfo.email' : x)).join(' '),
      ...(refreshToken ? { refresh_token: refreshToken } : {}),
      ...(scopes.includes('openid') ? { id_token: this.idToken(sub, nonce) } : {}),
    };
  }

  private token(req: Request, f: Record<string, string>): Response {
    const basic = (req.headers.get('authorization') ?? '').replace(/^Basic /, '');
    const [basicId, basicSecret] = basic ? Buffer.from(basic, 'base64').toString().split(':').map(decodeURIComponent) : [];
    const clientId = f.client_id ?? basicId;
    const secret = f.client_secret ?? basicSecret;
    if (clientId !== this.clientId || secret !== this.clientSecret) return json({ error: 'invalid_client', error_description: 'Unauthorized' }, 401);
    if (f.grant_type === 'refresh_token') {
      const rt = this.refresh.get(f.refresh_token ?? '');
      if (!rt || rt.revoked) return json(GOOGLE_ERRORS.invalidGrant, 400);
      const issued = this.issue(rt.sub, [...rt.scopes], false);
      if (this.omitScope) delete (issued as { scope?: string }).scope;
      return json(issued);
    }
    if (f.grant_type !== 'authorization_code') return json({ error: 'unsupported_grant_type' }, 400);
    const code = this.codes.get(f.code ?? '');
    if (!code || code.used) return json({ error: 'invalid_grant', error_description: 'Malformed auth code.' }, 400);
    if (f.redirect_uri !== code.redirectUri) return json({ error: 'redirect_uri_mismatch', error_description: 'Bad Request' }, 400);
    if (code.challenge && createHash('sha256').update(f.code_verifier ?? '').digest('base64url') !== code.challenge) {
      return json({ error: 'invalid_grant', error_description: 'Invalid code verifier.' }, 400);
    }
    code.used = true;
    const withRefresh = code.offline && !this.omitRefreshToken;
    if (withRefresh && this.relinkInvalidatesOldRefresh) {
      for (const t of this.refresh.values()) if (t.sub === code.sub) t.revoked = true;
    }
    this.omitRefreshToken = false;
    const issued = this.issue(code.sub, code.scopes, withRefresh, code.nonce);
    if (this.omitScope) delete (issued as { scope?: string }).scope;
    return json(issued);
  }

  /** Research notes §1: either token can be sent; revoking ends every grant the account gave this client. */
  private revoke(f: Record<string, string>, query: URLSearchParams): Response {
    if (this.revokeInvalidRequest) return json({ error: 'invalid_request', error_description: 'Bad Request' }, 400);
    if (this.revokeNeedsClientCredentials && (f.client_id !== this.clientId || f.client_secret !== this.clientSecret)) {
      return json({ error: 'invalid_client', error_description: 'Unauthorized' }, 401);
    }
    const token = f.token ?? query.get('token') ?? '';
    const a = this.access.get(token);
    const r = this.refresh.get(token);
    const sub = a?.sub ?? r?.sub;
    if (!sub || (a?.revoked ?? r?.revoked)) return json({ error: 'invalid_token', error_description: 'Token expired or revoked' }, 400);
    this.revocations.push({ sub, kind: a ? 'access' : 'refresh' });
    for (const t of this.access.values()) if (t.sub === sub) t.revoked = true;
    for (const t of this.refresh.values()) if (t.sub === sub) t.revoked = true;
    this.granted.delete(sub);
    return new Response(null, { status: 200 });
  }

  private calendarList(sub: string, q: URLSearchParams): Response {
    const min = (q.get('minAccessRole') ?? 'freeBusyReader') as AccessRole;
    const items = [...this.calendars.values()]
      .filter((c) => {
        const role = c.roles.get(sub);
        if (!role) return false;
        if (role === 'writerWithoutPrivateAccess' && min === 'writer') return this.writerFilterLeaksWithoutPrivate;
        return ROLE_RANK[role] >= ROLE_RANK[min];
      })
      .map((c) => ({
        kind: 'calendar#calendarListEntry', etag: etag(this.seq), id: c.id, summary: c.summary, timeZone: c.timeZone,
        accessRole: c.roles.get(sub), ...(c.primaryOf === sub ? { primary: true } : {}),
      }));
    return json(this.page(items, q, { kind: 'calendar#calendarList', etag: etag(this.seq) }));
  }

  private page(items: Resource[], q: URLSearchParams, extra: Resource): Resource {
    const max = Math.min(Number(q.get('maxResults') ?? 250), this.pageSize);
    const token = q.get('pageToken');
    if (this.emptyFirstPage && token === null && items.length > 0) return { ...extra, items: [], nextPageToken: b64url('0') };
    const offset = token ? Number(Buffer.from(token, 'base64url').toString()) : 0;
    const slice = items.slice(offset, offset + max);
    const next = offset + max < items.length ? { nextPageToken: b64url(String(offset + max)) } : {};
    return { ...extra, items: slice, ...next };
  }

  /** A stored resource with the fields Google adds. */
  private fresh(cal: FakeCalendar, fields: Resource): Resource {
    const now = new Date(this.now()).toISOString();
    return {
      kind: 'calendar#event', status: 'confirmed', eventType: 'default', created: now, sequence: 0,
      htmlLink: `https://www.google.com/calendar/event?eid=${b64url(`${String(fields.id)} ${cal.id}`)}`,
      organizer: { email: cal.id, self: true },
      ...fields,
      etag: etag(++this.seq), updated: now,
    };
  }

  /** A resource with its times written in `zone`, as Google answers with `timeZone`. */
  private present(cal: FakeCalendar, resource: Resource, zone: string): Resource {
    if (this.minimalCancelled && resource.status === 'cancelled' && resource.recurringEventId !== undefined) {
      const t = resource.originalStartTime as Time;
      const original = t.dateTime ? { ...t, dateTime: rfc3339(instantOf(t, cal.timeZone), zone) } : t;
      return { id: resource.id, recurringEventId: resource.recurringEventId, originalStartTime: original, status: 'cancelled' };
    }
    const out: Resource = { ...resource };
    for (const k of ['start', 'end', 'originalStartTime'] as const) {
      const t = resource[k] as Time | undefined;
      if (t?.dateTime) out[k] = { ...t, dateTime: rfc3339(instantOf(t, cal.timeZone), zone) };
    }
    return out;
  }

  /** Start and end as instants; an all-day date is midnight in the calendar's zone (research notes §7). */
  private span(cal: FakeCalendar, r: Resource): [number, number] {
    const at = (t: Time) => (t.date ? wallToUtcMs(t.date, '00:00', cal.timeZone) : instantOf(t, cal.timeZone));
    return [at(r.start as Time), at(r.end as Time)];
  }

  /**
   * A series' instances that start before `until`, with their exceptions applied, and exceptions
   * moved there from a later original start (`withMoved`). Cancelled ones are included.
   */
  private instances(cal: FakeCalendar, stored: StoredEvent, until: number, withMoved = true): Resource[] {
    const master = stored.resource;
    const lines = (master.recurrence as string[] | undefined) ?? [];
    const ruleLine = lines.find((l) => /^RRULE:/i.test(l));
    if (!ruleLine) return [];
    const rule = parseRule(ruleLine);
    const start = master.start as Time;
    const end = master.end as Time;
    const allDay = start.date !== undefined;
    const zone = start.timeZone ?? cal.timeZone;
    const excluded = new Set(lines.filter((l) => /^EXDATE/i.test(l)).flatMap((l) => exdateKeys(l, allDay, zone)));
    const d0 = allDay ? start.date! : utcToWall(instantOf(start, cal.timeZone), zone).date;
    const t0 = allDay ? '00:00' : utcToWall(instantOf(start, cal.timeZone), zone).time;
    const durationDays = allDay ? daysBetween(start.date!, end.date!) : 0;
    const durationMs = allDay ? 0 : instantOf(end, cal.timeZone) - instantOf(start, cal.timeZone);
    const untilMs = rule.until && /T/.test(rule.until)
      ? Date.UTC(Number(rule.until.slice(0, 4)), Number(rule.until.slice(4, 6)) - 1, Number(rule.until.slice(6, 8)), Number(rule.until.slice(9, 11)), Number(rule.until.slice(11, 13)), Number(rule.until.slice(13, 15)))
      : null;
    const untilDate = rule.until && !/T/.test(rule.until) ? `${rule.until.slice(0, 4)}-${rule.until.slice(4, 6)}-${rule.until.slice(6, 8)}` : null;
    const out: Resource[] = [];
    const seen = new Set<string>();
    let count = 0;
    for (let i = 0, d = d0; i < 20_000; i++, d = addDays(d, 1)) {
      if (d !== d0 && !onRule(rule, d0, d)) continue;
      const startMs = allDay ? wallToUtcMs(d, '00:00', cal.timeZone) : wallToUtcMs(d, t0, zone);
      if (startMs >= until) break;
      if (untilMs !== null && startMs > untilMs) break;
      if (untilDate !== null && d > untilDate) break;
      if (rule.count !== null && count >= rule.count) break;
      count++;
      const key = allDay ? d.replaceAll('-', '') : compactUtc(startMs);
      if (excluded.has(key)) continue;
      const base: Resource = { ...master, id: `${String(master.id)}_${key}`, recurringEventId: master.id };
      delete base.recurrence;
      if (allDay) {
        base.start = { date: d };
        base.end = { date: addDays(d, durationDays) };
        base.originalStartTime = { date: d };
      } else {
        base.start = { dateTime: new Date(startMs).toISOString(), timeZone: zone };
        base.end = { dateTime: new Date(startMs + durationMs).toISOString(), timeZone: zone };
        base.originalStartTime = { dateTime: new Date(startMs).toISOString(), timeZone: zone };
      }
      base.etag = `"${createHash('sha256').update(`${String(master.etag)}|${key}`).digest('hex').slice(0, 16)}"`;
      out.push(stored.exceptions.get(key) ?? base);
      seen.add(key);
    }
    // An exception moved from an original start past `until` to a time before it is still an
    // instance (callers filter by the times it has now).
    // Only keys that are still occurrences of the rule: one left over from before the series changed isn't.
    const unseen = [...stored.exceptions.keys()].filter((k) => !seen.has(k) && !excluded.has(k));
    if (withMoved && unseen.length > 0) {
      const valid = new Set(this.instances(cal, stored, Number.MAX_SAFE_INTEGER, false).map((r) => String(r.id).slice(String(master.id).length + 1)));
      for (const key of unseen) if (valid.has(key)) out.push(stored.exceptions.get(key)!);
    }
    return out;
  }

  private lookup(cal: FakeCalendar, id: string, zone: string): Resource | null {
    const stored = cal.events.get(id);
    if (stored) return stored.deleted ? null : this.present(cal, stored.resource, zone);
    const sep = id.lastIndexOf('_');
    const series = sep > 0 ? cal.events.get(id.slice(0, sep)) : undefined;
    if (!series || series.deleted) return null;
    const instance = this.instances(cal, series, Number.MAX_SAFE_INTEGER).find((r) => r.id === id);
    return instance ? this.present(cal, instance, zone) : null;
  }

  private list(cal: FakeCalendar, q: URLSearchParams): Response {
    // The app always asks for expanded instances in start order; anything else is a bug there.
    if (q.get('singleEvents') !== 'true' || q.get('orderBy') !== 'startTime') return json(googleError(400, 'badRequest', 'The fake only lists singleEvents=true&orderBy=startTime.'), 400);
    const min = Date.parse(q.get('timeMin') ?? '');
    const max = Date.parse(q.get('timeMax') ?? '');
    if (Number.isNaN(min) || Number.isNaN(max)) return json(googleError(400, 'badRequest', 'Bad timeMin or timeMax.'), 400);
    if (max <= min) return json(googleError(400, 'timeRangeEmpty', 'The specified time range is empty.', 'calendar'), 400);
    const zone = q.get('timeZone') ?? cal.timeZone;
    const items: { start: number; r: Resource }[] = [];
    for (const stored of cal.events.values()) {
      if (stored.deleted) continue;
      const rs = stored.resource.recurrence ? this.instances(cal, stored, max) : [stored.resource];
      for (const r of rs) {
        if (r.status === 'cancelled') continue; // showDeleted=false (research notes §4)
        const [s, e] = this.span(cal, r);
        if (e > min && s < max) items.push({ start: s, r });
      }
    }
    items.sort((a, b) => a.start - b.start);
    return json(this.page(items.map((i) => this.present(cal, i.r, zone)), q, { kind: 'calendar#events', etag: etag(this.seq), summary: cal.summary, timeZone: cal.timeZone }));
  }

  private insert(cal: FakeCalendar, body: Resource): Response {
    const id = body.id === undefined ? eventId() : body.id;
    if (typeof id !== 'string' || !/^[a-v0-9]{5,1024}$/.test(id)) return json(googleError(400, 'invalid', 'Invalid resource id value.'), 400);
    if (cal.events.has(id)) return json(GOOGLE_ERRORS.duplicate, 409);
    const invalid = this.invalid(body);
    if (invalid) return json(googleError(400, 'invalid', invalid), 400);
    const resource = this.fresh(cal, { ...body, id });
    cal.events.set(id, { resource, exceptions: new Map(), deleted: false });
    return json(this.present(cal, resource, cal.timeZone));
  }

  /** What Google refuses about an event's times (research notes §4, §7), or null. */
  private invalid(r: Resource): string | null {
    const start = r.start as Time | undefined;
    const end = r.end as Time | undefined;
    if (!start || !end) return 'Missing end time.';
    for (const t of [start, end]) if ((t.date !== undefined) === (t.dateTime !== undefined)) return 'Exactly one of date and dateTime.';
    if ((start.date !== undefined) !== (end.date !== undefined)) return 'The start and end must both be timed or both be all-day.';
    if (r.recurrence && start.dateTime && !start.timeZone) return 'Missing time zone definition for start time.';
    if (start.date && end.date && end.date <= start.date) return 'The specified time range is empty.';
    if (start.dateTime && end.dateTime && Date.parse(end.dateTime) < Date.parse(start.dateTime)) return 'The specified time range is empty.';
    return null;
  }

  /** A patch, or an edit made in Google. Null when there's no such event. */
  private applyPatch(cal: FakeCalendar, id: string, patch: Resource): Resource | null {
    const stored = cal.events.get(id);
    if (stored && !stored.deleted) {
      const next = merge(stored.resource, patch);
      const invalid = this.invalid(next);
      if (invalid) throw new BadPatch(invalid);
      stored.resource = { ...next, etag: etag(++this.seq), updated: new Date(this.now()).toISOString(), sequence: Number(next.sequence ?? 0) + 1 };
      return this.present(cal, stored.resource, cal.timeZone);
    }
    const sep = id.lastIndexOf('_');
    const series = sep > 0 ? cal.events.get(id.slice(0, sep)) : undefined;
    if (!series || series.deleted) return null;
    const key = id.slice(sep + 1);
    const current = this.instances(cal, series, Number.MAX_SAFE_INTEGER).find((r) => r.id === id);
    if (!current) return null;
    const merged = merge(current, patch);
    const invalid = this.invalid(merged);
    if (invalid) throw new BadPatch(invalid);
    series.exceptions.set(key, { ...merged, etag: etag(++this.seq), updated: new Date(this.now()).toISOString() });
    return this.lookup(cal, id, cal.timeZone);
  }

  private currentEtag(cal: FakeCalendar, id: string): string | null {
    const r = this.lookup(cal, id, cal.timeZone);
    return r ? String(r.etag) : null;
  }

  private patch(cal: FakeCalendar, id: string, body: Resource, ifMatch: string | null): Response {
    const current = this.currentEtag(cal, id);
    if (current === null) return json(GOOGLE_ERRORS.notFound, 404);
    if (ifMatch && ifMatch !== '*' && ifMatch !== current && !this.ignoreIfMatch) return json(GOOGLE_ERRORS.conditionNotMet, 412);
    try {
      return json(this.applyPatch(cal, id, body));
    } catch (err) {
      if (err instanceof BadPatch) return json(googleError(400, 'invalid', err.message), 400);
      throw err;
    }
  }

  /**
   * `events.update` (PUT): the body replaces the event. An instance stays an instance of its series
   * (its id, `recurringEventId`, and `originalStartTime` are kept), as an exception.
   */
  private update(cal: FakeCalendar, id: string, body: Resource, ifMatch: string | null): Response {
    const current = this.lookup(cal, id, cal.timeZone);
    if (!current) return json(GOOGLE_ERRORS.notFound, 404);
    if (ifMatch && ifMatch !== '*' && ifMatch !== current.etag) return json(GOOGLE_ERRORS.conditionNotMet, 412);
    const invalid = this.invalid(body);
    if (invalid) return json(googleError(400, 'invalid', invalid), 400);
    const now = new Date(this.now()).toISOString();
    const stored = cal.events.get(id);
    if (stored) {
      stored.resource = { ...body, id, created: stored.resource.created, organizer: stored.resource.organizer, htmlLink: stored.resource.htmlLink, etag: etag(++this.seq), updated: now };
      return json(this.present(cal, stored.resource, cal.timeZone));
    }
    const sep = id.lastIndexOf('_');
    const series = cal.events.get(id.slice(0, sep))!;
    series.exceptions.set(id.slice(sep + 1), {
      ...body, id, recurringEventId: current.recurringEventId, originalStartTime: current.originalStartTime, etag: etag(++this.seq), updated: now,
    });
    return json(this.lookup(cal, id, cal.timeZone));
  }

  /** `events.instances`: a series' instances overlapping `timeMin`..`timeMax`, cancelled ones only with `showDeleted=true`. */
  private instancesOf(cal: FakeCalendar, id: string, q: URLSearchParams, zone: string): Response {
    const stored = cal.events.get(id);
    if (!stored || stored.deleted || !stored.resource.recurrence) return json(GOOGLE_ERRORS.notFound, 404);
    const min = Date.parse(q.get('timeMin') ?? '1970-01-01T00:00:00Z');
    const max = Date.parse(q.get('timeMax') ?? '9999-12-31T00:00:00Z');
    const showDeleted = q.get('showDeleted') === 'true';
    const items = this.instances(cal, stored, max)
      .filter((r) => showDeleted || r.status !== 'cancelled')
      .filter((r) => {
        const [s, e] = this.span(cal, r);
        return e > min && s < max;
      })
      .map((r) => this.present(cal, r, zone));
    return json(this.page(items, q, { kind: 'calendar#events', etag: etag(this.seq), summary: cal.summary, timeZone: cal.timeZone }));
  }

  private remove(cal: FakeCalendar, id: string, ifMatch: string | null): Response {
    const stored = cal.events.get(id);
    // Deleting changed its etag, so an If-Match from before can't match (`deleteChecksIfMatchFirst`).
    if (stored?.deleted && this.deleteChecksIfMatchFirst && ifMatch && ifMatch !== '*') return json(GOOGLE_ERRORS.conditionNotMet, 412);
    if (stored?.deleted) return json(GOOGLE_ERRORS.deleted, 410);
    const current = this.currentEtag(cal, id);
    if (current === null) return json(GOOGLE_ERRORS.notFound, 404);
    if (ifMatch && ifMatch !== '*' && ifMatch !== current) return json(GOOGLE_ERRORS.conditionNotMet, 412);
    if (stored) {
      this.markDeleted(stored);
    } else {
      // An instance: the 2011 blog says DELETE on its id cancels it (UNVERIFIED; the app patches instead).
      this.applyPatch(cal, id, { status: 'cancelled' });
    }
    return new Response(null, { status: 204 });
  }

  /** `/__fake/*`, for Playwright (fakeGoogleCalendarServer.ts). Calendars are named by `summary`. */
  private control(url: URL, method: string, body: Resource | null): Response {
    const byName = (name: unknown) => [...this.calendars.values()].find((c) => c.summary === name);
    if (url.pathname === '/__fake/health') return json({ ok: true });
    if (method === 'GET' && url.pathname === '/__fake/revocations') return json(this.revocations);
    if (method === 'GET' && url.pathname === '/__fake/events') {
      const cal = byName(url.searchParams.get('calendar'));
      if (!cal) return json({ error: 'no such calendar' }, 404);
      const summary = url.searchParams.get('summary');
      return json(this.storedEvents(cal).filter((e) => summary === null || e.summary === summary));
    }
    if (method === 'POST' && url.pathname === '/__fake/events' && body) {
      const cal = byName(body.calendar);
      if (!cal) return json({ error: 'no such calendar' }, 404);
      const { calendar: _calendar, ...fields } = body;
      return json(this.addEvent(cal, fields));
    }
    if (method === 'POST' && url.pathname === '/__fake/events/edit' && body) {
      const cal = byName(body.calendar);
      if (!cal) return json({ error: 'no such calendar' }, 404);
      // Edit the first live event with this summary, as someone would in Google's UI.
      const target = this.storedEvents(cal).find((e) => e.summary === body.summary);
      if (!target) return json({ error: 'no such event' }, 404);
      return json(this.editEvent(cal, String(target.id), body.patch as Resource));
    }
    if (method === 'POST' && url.pathname === '/__fake/revoke-account' && body) {
      // The account removes the app's access in its Google settings.
      const account = [...this.accounts.values()].find((a) => a.email === body.email);
      if (!account) return json({ error: 'no such account' }, 404);
      this.revokeAccount(account);
      return json({ ok: true });
    }
    return json({ error: 'unknown control' }, 404);
  }
}

class BadPatch extends Error {}
