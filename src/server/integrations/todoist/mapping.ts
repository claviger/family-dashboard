import { createHash } from 'node:crypto';
import { wallToUtcMs } from '../../../shared/zonedTime.js';
import { localDate } from '../../core/clock.js';

/**
 * Pure conversions between Todoist's shapes and the mirror's. Written against
 * docs/research/todoist-api-v1.md (including its "Verified live (2026-11-16)" section), which
 * overrides the spec where they differ:
 * - There is no `due.datetime`. `due.date` is a full day (`YYYY-MM-DD`), a floating time
 *   (`YYYY-MM-DDTHH:MM:SS`, no zone), or a fixed time in UTC (`...Z`, with `due.timezone` set).
 * - Every id is an opaque string.
 */

/** The `due` object on a Todoist item (research notes §2, "due object"). */
export interface TodoistDue {
  date: string;
  timezone?: string | null;
  is_recurring?: boolean | null;
  string?: string | null;
}

export interface MirrorDue {
  /** Family-local date, YYYY-MM-DD. */
  dueDate: string | null;
  /** Family-local time, HH:MM. */
  dueTime: string | null;
  recurring: boolean;
  /** For a fixed time, Todoist's `due.timezone`, so editing the time here can keep it. Else null. */
  timezone: string | null;
}

const DATE_ONLY = /^(\d{4}-\d{2}-\d{2})$/;
const FLOATING = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/;
const FIXED = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})$/;

/** HH:MM of `instant` in `timeZone`, on a 24-hour clock. */
function localTime(instant: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone }).format(instant);
}

/**
 * Todoist's due date as the mirror stores it, in the family time zone (spec §10.6):
 * - a full day stays that day, with no time;
 * - a floating time is shown as written (it's "whatever time it is where you are");
 * - a fixed UTC time is converted to the family time zone, which can move it to another day.
 * Anything unrecognized is treated as no due date, rather than failing the sync.
 */
export function dueFromTodoist(due: TodoistDue | null | undefined, familyTimeZone: string): MirrorDue {
  const none = { dueDate: null, dueTime: null, recurring: false, timezone: null };
  if (!due || typeof due.date !== 'string') return none;
  const recurring = due.is_recurring === true;
  const day = DATE_ONLY.exec(due.date);
  if (day) return { dueDate: day[1]!, dueTime: null, recurring, timezone: null };
  if (FIXED.test(due.date)) {
    const instant = new Date(due.date);
    if (!Number.isNaN(instant.getTime())) {
      return {
        dueDate: localDate(instant, familyTimeZone),
        dueTime: localTime(instant, familyTimeZone),
        recurring,
        timezone: due.timezone ?? 'UTC',
      };
    }
  }
  const floating = FLOATING.exec(due.date);
  if (floating) return { dueDate: floating[1]!, dueTime: `${floating[2]}:${floating[3]}`, recurring, timezone: null };
  return { ...none, recurring };
}

/**
 * A family-local date and time as a UTC instant, `YYYY-MM-DDTHH:MM:00Z`, resolved the way
 * Temporal's `disambiguation: 'compatible'` does (see `wallToUtcMs` in src/shared/zonedTime.ts):
 * an overlap takes the earlier time, and a time in a gap moves forward by the gap's length.
 */
export function familyLocalToUtc(date: string, time: string, timeZone: string): string {
  return `${new Date(wallToUtcMs(date, time, timeZone)).toISOString().slice(0, 16)}:00Z`;
}

/**
 * The `due` argument for `item_add` and `item_update`: a full day, a floating time (Todoist's
 * default for times, research notes §3), or `null` to clear it. With `fixed` (the task already has
 * a fixed-timezone time), a time is sent as UTC with that `timezone`, so the task keeps its zone:
 * the time entered here is family-local, like the time shown.
 */
export function dueToTodoist(
  dueDate: string | null,
  dueTime: string | null,
  fixed?: { timeZone: string; familyTimeZone: string },
): { date: string; timezone?: string } | null {
  if (!dueDate) return null;
  if (dueTime && fixed) return { date: familyLocalToUtc(dueDate, dueTime, fixed.familyTimeZone), timezone: fixed.timeZone };
  return { date: dueTime ? `${dueDate}T${dueTime}:00` : dueDate };
}

/**
 * A command `uuid` derived from its parts, formatted like a UUID (version nibble 8, "custom").
 * Todoist won't run a command twice with the same uuid (research notes §3): it answers `ok` and
 * does nothing. So a step retried after a crash sends the same uuid and can't create a second task.
 *
 * The flip side is that two different commands must never share a uuid, or the second silently
 * does nothing. Database ids alone aren't enough: they're small integers that start over in
 * another install, a reinstall, or a second instance linked to the same Todoist account, and a
 * restored backup hands them out again. So callers pass:
 * - the link's random `todoist_state.uuid_seed`, unique per install and link;
 * - the connection id and the row (or occurrence) id;
 * - the row's (or occurrence's) `createdAt`, which differs when an id is reused after a restore.
 */
export function stableUuid(...parts: (string | number)[]): string {
  const h = createHash('sha256').update(parts.join('\u0000')).digest('hex');
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

/** A failed command's entry in `sync_status` (research notes §3, "Response"). */
export interface TodoistCommandError {
  error_tag?: string;
  error_code?: number;
  error?: string;
  http_code?: number;
  error_extra?: Record<string, unknown>;
}

/**
 * What a failed command means for the app:
 * - `auth`: the token is no good (401, `AUTH_INVALID_TOKEN`, verified live). The connection needs reconnecting.
 * - `not_found`: the task the command names is gone. Only `ITEM_NOT_FOUND` means that. Verified
 *   live: a command on a deleted task gets HTTP 200 with
 *   `{"error_tag":"ITEM_NOT_FOUND","error_code":22,"http_code":400}` in its `sync_status`. Any
 *   other "not found" (a bare 404, a REST-style `NOT_FOUND`) isn't verified for commands and could
 *   be about something else, like a project, so it doesn't remove the row.
 * - `rejected`: anything else, including 403 (e.g. no permission in a shared project), which
 *   reconnecting can't fix.
 *
 * An `item_add` names no existing task, so for it every non-auth failure is `rejected`; callers
 * handle that themselves.
 */
export function classifyCommandError(err: TodoistCommandError): 'auth' | 'not_found' | 'rejected' {
  if (err.http_code === 401 || err.error_tag === 'AUTH_INVALID_TOKEN' || err.error_tag === 'UNAUTHORIZED') return 'auth';
  if (err.error_tag === 'ITEM_NOT_FOUND') return 'not_found';
  return 'rejected';
}
