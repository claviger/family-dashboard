import type { CalendarState } from '../../integrations/google/calendar.js';
import type { CallOptions, EventBody, EventRead, GoogleEvent } from '../../integrations/google/calendarClient.js';

/**
 * What the Calendar panel needs from a calendar service (spec §3.3: panels never call external
 * APIs directly). `GoogleCalendar` (src/server/integrations/google/calendar.ts) is the real one;
 * tests run it against FakeGoogleCalendar, an in-memory Google, as its `fetch`.
 *
 * Calls fail with `AppError('integration_unavailable')` for anything about the connection (not
 * linked, needs reconnecting, Google down or busy, the key doesn't match), and with a
 * `GoogleApiError` for answers about one event (`not_found`, `gone`, `precondition`, `duplicate`,
 * `forbidden`, `rejected`, and `bad_response` with reason `event_shape` for an event that won't
 * parse), which the panel turns into its own errors. `opts.deadline` (epoch ms) bounds a call,
 * retries included. A null etag sends no `If-Match`. Reads return the raw JSON beside the parsed
 * view; writes return null when the change was made but Google's answer isn't an event.
 */
export interface CalendarProvider {
  state(): CalendarState;
  listEvents(q: { timeMin: string; timeMax: string; timeZone: string }, opts?: CallOptions): Promise<{ events: GoogleEvent[]; calendarTimeZone: string | null; skipped: number }>;
  getEvent(eventId: string, opts?: CallOptions): Promise<EventRead>;
  /** Null when the series has more instances than the client pages through. */
  listInstances(seriesId: string, q: { timeMin: string; timeMax: string }, opts?: CallOptions): Promise<EventRead[] | null>;
  insertEvent(body: EventBody, opts?: CallOptions): Promise<GoogleEvent | null>;
  patchEvent(eventId: string, body: EventBody, etag: string | null, opts?: CallOptions): Promise<GoogleEvent | null>;
  updateEvent(eventId: string, body: EventBody, etag: string | null, opts?: CallOptions): Promise<GoogleEvent | null>;
  deleteEvent(eventId: string, etag: string | null, opts?: CallOptions): Promise<void>;
}
