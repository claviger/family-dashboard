import { z } from 'zod';
import type { FetchFn } from './oauth.js';

/**
 * Google Calendar API v3 over plain `fetch`, written against docs/research/google-calendar-v3.md
 * (§3 to §5, §8) only. HTTP and nothing else: it knows nothing about the database, doesn't log,
 * and no error message contains a token, an event's content, or a response body.
 */

/** Each attempt waits at most this long for an answer: these calls are made while someone waits. */
export const ATTEMPT_TIMEOUT_MS = 10_000;
/**
 * One call, retries and their waits included, takes at most this long, so a request that makes a
 * few calls (an edit reads the event and its series first) still answers well inside nginx's 60
 * seconds. A caller can pass an earlier `deadline` for a whole operation.
 */
export const CALL_DEADLINE_MS = 25_000;
/** Paging stops here: a family's six-week window is a few hundred events at most. */
export const MAX_PAGES = 20;
/** Retries after a rate limit (and, for reads, a 5xx or no answer). Bounded, never forever. */
export const MAX_RETRIES = 2;
/** A Retry-After longer than this isn't waited for. */
const MAX_RETRY_AFTER_SEC = 10;

/**
 * A failed call (research notes §8):
 * - `auth`: 401. The access token expired or was revoked; refresh once, then reconnect.
 * - `scope`: a 403 for a missing scope (`insufficientPermissions`, or the newer
 *   `ACCESS_TOKEN_SCOPE_INSUFFICIENT`). Neither reason is in the Calendar errors guide
 *   (UNVERIFIED): they're what the research remembers Google sending.
 * - `api_disabled`: a 403 saying the Calendar API isn't enabled for the Google Cloud project
 *   (`accessNotConfigured`, a `SERVICE_DISABLED` detail, or a message saying so; C-M2). Not in
 *   the research notes (UNVERIFIED): it's what Google's APIs send generally. Never retried, and
 *   not a rate limit, though it comes in the `usageLimits` domain.
 * - `rate_limited`: 429, or a 403 `rateLimitExceeded`, `userRateLimitExceeded`, or `quotaExceeded`.
 * - `forbidden`: any other 403, e.g. `forbiddenForNonOrganizer` or no write access.
 * - `not_found` 404, `gone` 410, `duplicate` 409, `precondition` 412 (a stale `If-Match`).
 * - `rejected`: any other 4xx. `server`: 5xx. `network`: no answer, or it timed out.
 * - `bad_response`: a 2xx whose body isn't what the docs describe, or too many pages.
 */
export type GoogleErrorKind =
  | 'auth' | 'scope' | 'api_disabled' | 'rate_limited' | 'forbidden' | 'not_found' | 'gone' | 'duplicate' | 'precondition'
  | 'rejected' | 'server' | 'network' | 'bad_response';

export class GoogleApiError extends Error {
  constructor(
    readonly kind: GoogleErrorKind,
    readonly status: number | null,
    /** The first of Google's reasons in `errors[]` (or `details[]`, or `status`), safe to log. */
    readonly reason: string | null,
    readonly retryAfterSec: number | null = null,
  ) {
    super(`Google Calendar request failed (${kind}${status ? `, HTTP ${status}` : ''}${reason ? `, ${reason}` : ''}).`);
    this.name = 'GoogleApiError';
  }
}

const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded']);
const SCOPE_REASONS = new Set(['insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT']);
const API_DISABLED_REASONS = new Set(['accessNotConfigured', 'SERVICE_DISABLED']);
/** "Google Calendar API has not been used in project … before or it is disabled", and the like. */
const API_DISABLED_TEXT = /\bAPI\b[^.]*\b(has not been used|is disabled|not (been )?enabled)\b/i;
/** The errors guide puts every rate and quota limit in this domain. */
const RATE_DOMAIN = 'usageLimits';

interface ErrorFacts {
  /** Every `reason` in `errors[]` and then `details[]`, in order. */
  reasons: string[];
  domains: string[];
  /** The top-level `message` and every one in `errors[]`. Matched, never logged or shown. */
  messages: string[];
  /** The newer format's `status` (e.g. `PERMISSION_DENIED`). */
  status: string | null;
}

/**
 * The reasons and domains in an error body: `errors[]` (the v3 format), then the newer `details[]`
 * (research notes §8: parse defensively). Anything that isn't the documented shape is skipped.
 */
function factsOf(body: unknown): ErrorFacts {
  const facts: ErrorFacts = { reasons: [], domains: [], messages: [], status: null };
  const error = body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as { error?: unknown }).error : undefined;
  if (error === null || typeof error !== 'object' || Array.isArray(error)) return facts;
  const e = error as { errors?: unknown; details?: unknown; status?: unknown; message?: unknown };
  if (typeof e.message === 'string') facts.messages.push(e.message);
  for (const list of [e.errors, e.details]) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (item === null || typeof item !== 'object') continue;
      const { reason, domain, message } = item as { reason?: unknown; domain?: unknown; message?: unknown };
      if (typeof reason === 'string') facts.reasons.push(reason);
      if (typeof domain === 'string') facts.domains.push(domain);
      if (typeof message === 'string') facts.messages.push(message);
    }
  }
  if (typeof e.status === 'string') facts.status = e.status;
  return facts;
}

function retryAfterOf(res: Response): number | null {
  const header = Number(res.headers.get('retry-after'));
  return Number.isFinite(header) && header > 0 ? header : null;
}

/** The error for a status and body. Never throws, whatever the body is (R2-M10). */
export function classify(status: number, body: unknown, retryAfterSec: number | null = null): GoogleApiError {
  let facts: ErrorFacts;
  try {
    facts = factsOf(body);
  } catch {
    facts = { reasons: [], domains: [], messages: [], status: null };
  }
  const reason = facts.reasons[0] ?? facts.status;
  if (status === 401) return new GoogleApiError('auth', status, reason);
  if (status === 403) {
    // Every reason counts, not only the first. The API being off is checked first, since it comes
    // in the usage limits domain but waiting won't fix it (C-M2). Then a rate limit: backing off
    // is harmless, while a scope problem asks for a reconnect.
    const disabled = facts.reasons.find((r) => API_DISABLED_REASONS.has(r));
    if (disabled || facts.messages.some((m) => API_DISABLED_TEXT.test(m))) return new GoogleApiError('api_disabled', status, disabled ?? reason);
    if (facts.reasons.some((r) => RATE_REASONS.has(r)) || facts.domains.includes(RATE_DOMAIN)) {
      return new GoogleApiError('rate_limited', status, facts.reasons.find((r) => RATE_REASONS.has(r)) ?? reason, retryAfterSec);
    }
    const scope = facts.reasons.find((r) => SCOPE_REASONS.has(r));
    if (scope) return new GoogleApiError('scope', status, scope);
    return new GoogleApiError('forbidden', status, reason);
  }
  if (status === 404) return new GoogleApiError('not_found', status, reason);
  if (status === 409) return new GoogleApiError('duplicate', status, reason);
  if (status === 410) return new GoogleApiError('gone', status, reason);
  if (status === 412) return new GoogleApiError('precondition', status, reason);
  if (status === 429) return new GoogleApiError('rate_limited', status, reason, retryAfterSec);
  if (status >= 500) return new GoogleApiError('server', status, reason, retryAfterSec);
  return new GoogleApiError('rejected', status, reason);
}

/**
 * Every object schema here is loose, nested ones included, so the parsed view keeps fields it
 * doesn't read (R2-I2). The PUT fallback doesn't rely on that: it's built from the raw JSON
 * (`EventRead.raw`).
 */
const EventTimeSchema = z.looseObject({ date: z.string().optional(), dateTime: z.string().optional(), timeZone: z.string().optional() });

/**
 * The Events resource fields the panel reads (research notes §4). The rest are kept (`loose`):
 * attendees, reminders, conference data, and fields Google adds later.
 */
export const GoogleEventSchema = z.looseObject({
  id: z.string().min(1),
  etag: z.string().min(1),
  status: z.string().optional(),
  summary: z.string().optional(),
  description: z.string().optional(),
  location: z.string().optional(),
  start: EventTimeSchema.optional(),
  end: EventTimeSchema.optional(),
  recurringEventId: z.string().optional(),
  originalStartTime: EventTimeSchema.optional(),
  recurrence: z.array(z.string()).optional(),
  extendedProperties: z.looseObject({ private: z.record(z.string(), z.string()).optional() }).optional(),
  htmlLink: z.string().optional(),
  eventType: z.string().optional(),
  visibility: z.string().optional(),
  locked: z.boolean().optional(),
  organizer: z.looseObject({ self: z.boolean().optional() }).optional(),
});
export type GoogleEvent = z.infer<typeof GoogleEventSchema>;
export type GoogleEventTime = z.infer<typeof EventTimeSchema>;
/** An event's JSON exactly as Google sent it. */
export type RawEvent = Record<string, unknown>;

/**
 * An event read from Google: the parsed view the panel uses, and the untouched JSON beside it,
 * which is what a PUT sends back with the dashboard's changes merged in (R2-I2, R3-C1), and what
 * an instance is compared with its series by (R3-I4).
 */
export interface EventRead {
  event: GoogleEvent;
  raw: RawEvent;
}

const CalendarListEntrySchema = z.object({
  id: z.string().min(1),
  summary: z.string().optional(),
  summaryOverride: z.string().optional(),
  timeZone: z.string().optional(),
  primary: z.boolean().optional(),
  accessRole: z.string(),
  deleted: z.boolean().optional(),
});
export interface CalendarListEntry {
  id: string;
  /** `summaryOverride` (the person's own name for it) when set, else `summary`. */
  name: string;
  timeZone: string | null;
  primary: boolean;
  accessRole: string;
}

const PageSchema = z.looseObject({ items: z.array(z.unknown()).optional(), nextPageToken: z.string().optional(), timeZone: z.string().optional() });

/** What a write sends. Only the dashboard's own fields ever go in a patch (spec §9.4). */
export type EventBody = Record<string, unknown>;

/** `deadline`: epoch ms (the real clock) by which the call, retries included, gives up. */
export interface CallOptions {
  deadline?: number;
}

/** When it's safe to send a request again after a failure. */
type RetryPolicy = 'read' | 'insert' | 'delete' | 'patch';

function retryable(err: GoogleApiError, policy: RetryPolicy): boolean {
  if (err.kind === 'rate_limited') return true; // nothing happened
  // A PATCH whose answer was lost may have been applied: sent again, its If-Match would 412.
  if (policy === 'patch') return false;
  // A read is safe to repeat; an insert carries its own id (a repeat is a 409), and a delete
  // that already happened answers 410.
  return err.kind === 'server' || err.kind === 'network';
}

export interface CalendarClientOptions {
  /** Waits between retries. Tests pass one that doesn't wait. */
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  attemptTimeoutMs?: number;
  callDeadlineMs?: number;
}

export class GoogleCalendarClient {
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly attemptTimeoutMs: number;
  private readonly callDeadlineMs: number;

  constructor(
    private readonly apiBase: string,
    private readonly fetchFn: FetchFn,
    opts: CalendarClientOptions = {},
  ) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.random = opts.random ?? Math.random;
    this.attemptTimeoutMs = opts.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS;
    this.callDeadlineMs = opts.callDeadlineMs ?? CALL_DEADLINE_MS;
  }

  /**
   * The calendars the account can make changes to (research notes §3), for the admin's pick
   * (spec §9.1). `minAccessRole=writer` narrows the list, but whether it leaves out
   * `writerWithoutPrivateAccess` is UNVERIFIED, so only `owner` and `writer` are kept here: with
   * `writerWithoutPrivateAccess`, private events can't be seen or changed. Follows every page.
   */
  async listCalendars(accessToken: string, opts: CallOptions = {}): Promise<{ calendars: CalendarListEntry[]; skipped: number }> {
    const deadline = this.deadlineOf(opts);
    const calendars: CalendarListEntry[] = [];
    let skipped = 0;
    let pageToken: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES) throw new GoogleApiError('bad_response', 200, 'too_many_pages');
      const url = new URL(`${this.apiBase}/users/me/calendarList`);
      url.searchParams.set('minAccessRole', 'writer');
      url.searchParams.set('maxResults', '250');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const body = PageSchema.safeParse(await this.json(accessToken, 'GET', url, undefined, null, 'read', deadline));
      if (!body.success) throw new GoogleApiError('bad_response', 200, 'calendar_list_shape');
      for (const raw of body.data.items ?? []) {
        const entry = CalendarListEntrySchema.safeParse(raw);
        if (!entry.success) {
          skipped++;
          continue;
        }
        const e = entry.data;
        if (e.deleted || (e.accessRole !== 'owner' && e.accessRole !== 'writer')) continue;
        calendars.push({ id: e.id, name: e.summaryOverride || e.summary || e.id, timeZone: e.timeZone ?? null, primary: e.primary === true, accessRole: e.accessRole });
      }
      pageToken = body.data.nextPageToken;
      if (!pageToken) return { calendars, skipped };
    }
  }

  /**
   * One window's events (research notes §4): `singleEvents=true` (repeating events expanded into
   * instances) with `orderBy=startTime`, times in `timeZone`, every page followed (a page can be
   * short, or empty, while `nextPageToken` says there's more). Google's overlap rule is
   * `end > timeMin` and `start < timeMax`. Returns the calendar's own time zone too, which every
   * response carries. Events that don't match the documented shape are left out and counted.
   */
  async listEvents(
    accessToken: string,
    calendarId: string,
    q: { timeMin: string; timeMax: string; timeZone: string },
    opts: CallOptions = {},
  ): Promise<{ events: GoogleEvent[]; timeZone: string | null; skipped: number }> {
    const deadline = this.deadlineOf(opts);
    const events: GoogleEvent[] = [];
    let skipped = 0;
    let timeZone: string | null = null;
    let pageToken: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES) throw new GoogleApiError('bad_response', 200, 'too_many_pages');
      const url = this.eventsUrl(calendarId);
      url.searchParams.set('singleEvents', 'true');
      url.searchParams.set('orderBy', 'startTime');
      url.searchParams.set('timeMin', q.timeMin);
      url.searchParams.set('timeMax', q.timeMax);
      url.searchParams.set('timeZone', q.timeZone);
      url.searchParams.set('maxResults', '250');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const body = PageSchema.safeParse(await this.json(accessToken, 'GET', url, undefined, null, 'read', deadline));
      if (!body.success) throw new GoogleApiError('bad_response', 200, 'events_shape');
      timeZone ??= body.data.timeZone ?? null;
      for (const raw of body.data.items ?? []) {
        const event = GoogleEventSchema.safeParse(raw);
        if (event.success) events.push(event.data);
        else skipped++;
      }
      pageToken = body.data.nextPageToken;
      if (!pageToken) return { events, timeZone, skipped };
    }
  }

  /**
   * A series' instances between two times (`events.instances`, research notes §6; its `timeMin` is
   * inclusive), cancelled ones included (`showDeleted=true`), every page followed, each with its
   * raw JSON. Used to tell whether a series has instances changed or cancelled on their own before
   * the whole series is moved.
   */
  async listInstances(accessToken: string, calendarId: string, eventId: string, q: { timeMin: string; timeMax: string }, opts: CallOptions = {}): Promise<EventRead[]> {
    const deadline = this.deadlineOf(opts);
    const events: EventRead[] = [];
    let pageToken: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= MAX_PAGES) throw new GoogleApiError('bad_response', 200, 'too_many_pages');
      const url = new URL(`${this.eventsUrl(calendarId, eventId).href}/instances`);
      url.searchParams.set('timeMin', q.timeMin);
      url.searchParams.set('timeMax', q.timeMax);
      url.searchParams.set('showDeleted', 'true');
      url.searchParams.set('maxResults', '250');
      if (pageToken) url.searchParams.set('pageToken', pageToken);
      const body = PageSchema.safeParse(await this.json(accessToken, 'GET', url, undefined, null, 'read', deadline));
      if (!body.success) throw new GoogleApiError('bad_response', 200, 'instances_shape');
      for (const item of body.data.items ?? []) {
        const raw = item !== null && typeof item === 'object' && !Array.isArray(item) ? (item as RawEvent) : {};
        const event = GoogleEventSchema.safeParse(raw);
        // A cancelled instance may carry only its id, its series, and its original start (research
        // notes §4), with no etag: it still counts, as cancelled. So does anything else that won't
        // parse: it can't be shown to match its series.
        if (event.success) events.push({ event: event.data, raw });
        else events.push({ event: { id: typeof raw.id === 'string' ? raw.id : '', etag: '', status: 'cancelled' }, raw });
      }
      pageToken = body.data.nextPageToken;
      if (!pageToken) return events;
    }
  }

  /**
   * One event, an instance, or a series (research notes §4, §6), parsed and raw. An answer that
   * isn't an event is `bad_response` with reason `event_shape`: a problem with that one event, not
   * with the connection (R2-M12).
   */
  async getEvent(accessToken: string, calendarId: string, eventId: string, opts: CallOptions = {}): Promise<EventRead> {
    const raw = await this.json(accessToken, 'GET', this.eventsUrl(calendarId, eventId), undefined, null, 'read', this.deadlineOf(opts));
    const event = this.event(raw);
    if (!event) throw new GoogleApiError('bad_response', 200, 'event_shape');
    return { event, raw: raw as RawEvent };
  }

  /**
   * `events.insert` (research notes §5). A body with the dashboard's own `id` can be sent again
   * after a lost answer without making a second event (Google answers 409 `duplicate`), so only
   * then is it retried after a 5xx or no answer (R2-M11). Null when Google's answer isn't an
   * event: the event was made, and the caller reads it back.
   */
  async insertEvent(accessToken: string, calendarId: string, body: EventBody, opts: CallOptions = {}): Promise<GoogleEvent | null> {
    const policy: RetryPolicy = typeof body.id === 'string' && body.id !== '' ? 'insert' : 'patch';
    return this.event(await this.json(accessToken, 'POST', this.writeUrl(calendarId), body, null, policy, this.deadlineOf(opts)));
  }

  /**
   * `events.patch`, with `If-Match` unless `etag` is null (research notes §5): fields left out stay
   * as they are, nested objects merge, and arrays replace. A stale etag is a 412 `precondition`.
   * Null when the change was made but Google's answer isn't an event.
   */
  async patchEvent(accessToken: string, calendarId: string, eventId: string, body: EventBody, etag: string | null, opts: CallOptions = {}): Promise<GoogleEvent | null> {
    return this.event(await this.json(accessToken, 'PATCH', this.writeUrl(calendarId, eventId), body, etag, 'patch', this.deadlineOf(opts)));
  }

  /**
   * `events.update` (PUT), with `If-Match`: the whole event, which replaces what's there (research
   * notes §5). Only the fallback for an instance Google won't patch (research notes §6: its guide
   * changes instances with PUT); the body is the event's raw JSON as read, with the dashboard's
   * changes merged in. `conferenceDataVersion=1` and `supportsAttachments=true` ask Google to keep
   * the Meet link and attachments the body carries (R3-C1; UNVERIFIED that they'd go otherwise).
   * Null when the change was made but Google's answer isn't an event.
   */
  async updateEvent(accessToken: string, calendarId: string, eventId: string, body: EventBody, etag: string | null, opts: CallOptions = {}): Promise<GoogleEvent | null> {
    const url = this.writeUrl(calendarId, eventId);
    url.searchParams.set('conferenceDataVersion', '1');
    url.searchParams.set('supportsAttachments', 'true');
    return this.event(await this.json(accessToken, 'PUT', url, body, etag, 'patch', this.deadlineOf(opts)));
  }

  /** `events.delete`, with `If-Match` unless `etag` is null. Already deleted is a 410 `gone`, which callers treat as done. */
  async deleteEvent(accessToken: string, calendarId: string, eventId: string, etag: string | null, opts: CallOptions = {}): Promise<void> {
    await this.json(accessToken, 'DELETE', this.writeUrl(calendarId, eventId), undefined, etag, 'delete', this.deadlineOf(opts));
  }

  /** The earlier of the caller's deadline and this call's own. */
  private deadlineOf(opts: CallOptions): number {
    return Math.min(opts.deadline ?? Number.POSITIVE_INFINITY, Date.now() + this.callDeadlineMs);
  }

  private eventsUrl(calendarId: string, eventId?: string): URL {
    const base = `${this.apiBase}/calendars/${encodeURIComponent(calendarId)}/events`;
    return new URL(eventId === undefined ? base : `${base}/${encodeURIComponent(eventId)}`);
  }

  /**
   * A write's URL, with `sendUpdates=none` (C-M8): the dashboard never has Google email an event's
   * guests about a change made from it. Sent explicitly because Google's default isn't clearly
   * documented (research notes §5). Google warns that `none` can keep changes from reaching guests
   * on other calendar systems: that's on the "Verify on first real link" list.
   */
  private writeUrl(calendarId: string, eventId?: string): URL {
    const url = this.eventsUrl(calendarId, eventId);
    url.searchParams.set('sendUpdates', 'none');
    return url;
  }

  /** The parsed view, or null when the body isn't an event in the documented shape. */
  private event(raw: unknown): GoogleEvent | null {
    const parsed = GoogleEventSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  }

  /**
   * One request, with bounded retries: up to MAX_RETRIES more after a rate limit, and for
   * requests that are safe to repeat, after a 5xx or no answer. The wait is Google's truncated
   * exponential backoff (research notes §8: 2^n seconds plus up to a second, at most 8 here), or
   * Retry-After when it's short. Each attempt has its own timeout, and nothing goes past
   * `deadline`: a retry starts only when its wait and a second for the attempt fit before it
   * (R2-M8). A 2xx with no body (a DELETE) is null.
   */
  private async json(accessToken: string, method: string, url: URL, body: EventBody | undefined, etag: string | null, policy: RetryPolicy, deadline: number): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const left = deadline - Date.now();
      if (left <= 0) throw new GoogleApiError('network', null, 'deadline');
      try {
        return await this.once(accessToken, method, url, body, etag, Math.min(this.attemptTimeoutMs, left));
      } catch (err) {
        if (!(err instanceof GoogleApiError) || attempt >= MAX_RETRIES || !retryable(err, policy)) throw err;
        if (err.retryAfterSec !== null && err.retryAfterSec > MAX_RETRY_AFTER_SEC) throw err;
        const backoff = Math.min(2 ** attempt * 1000 + Math.floor(this.random() * 1000), 8000);
        const wait = err.retryAfterSec !== null ? err.retryAfterSec * 1000 : backoff;
        if (wait + 1000 >= deadline - Date.now()) throw err;
        await this.sleep(wait);
      }
    }
  }

  private async once(accessToken: string, method: string, url: URL, body: EventBody | undefined, etag: string | null, timeoutMs: number): Promise<unknown> {
    const headers: Record<string, string> = { authorization: `Bearer ${accessToken}`, accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    // Sent back exactly as Google gave it, quotes and all (research notes §5: UNVERIFIED that they're quoted).
    if (etag !== null) headers['if-match'] = etag;
    let res: Response;
    try {
      res = await this.fetchFn(url.href, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new GoogleApiError('network', null, null);
    }
    // A body that couldn't be read is no answer, even on a 2xx: whether the change was made is unknown (R2-M9).
    const text = await res.text().catch(() => null);
    if (text === null && res.ok) throw new GoogleApiError('network', null, 'body_unread');
    let parsed: unknown = null;
    if (text !== null && text !== '') {
      try {
        parsed = JSON.parse(text);
      } catch {
        if (res.ok) throw new GoogleApiError('bad_response', res.status, 'not_json');
      }
    }
    if (!res.ok) throw classify(res.status, parsed, retryAfterOf(res));
    return parsed;
  }
}
