import { z } from 'zod';
import { LocalDateSchema, LocalTimeSchema } from './dates.js';
import { ConnectionStatusSchema } from './integrations.js';
import { RepeatRuleSchema } from './rrule.js';

/**
 * The Calendar panel's shared shapes (spec §9). Every date and time here is family-local: the
 * server converts Google's values into the family time zone, so the web only formats them.
 */

/** Spec §9.2: each window's result is good for 5 minutes. */
export const CALENDAR_CACHE_MS = 5 * 60_000;
/** `calendar.refreshSummary` runs every 5 minutes (spec §3.5). */
export const CALENDAR_REFRESH_INTERVAL_MS = 5 * 60_000;
/** Spec §8: data is stale when it's older than twice its source's normal refresh interval. */
export const CALENDAR_STALE_AFTER_MS = 2 * CALENDAR_REFRESH_INTERVAL_MS;
/** The summary window: today and the 6 days after it (spec §9.2). */
export const SUMMARY_DAYS = 7;
/** The longest window a request may ask for: a month view's six weeks. */
export const MAX_WINDOW_DAYS = 42;

/**
 * Why an event can't be changed from the dashboard:
 * - `event_type`: a birthday, out-of-office, focus-time, or other non-default event (`eventType`)
 * - `locked`: Google marks it `locked`, so its main fields can't change
 * - `private`: its visibility is private or confidential, so the dashboard shows only its time
 * - `not_organizer`: an invitation from someone else's calendar; only its organizer can change it
 */
export const READ_ONLY_REASONS = ['event_type', 'locked', 'private', 'not_organizer'] as const;
export type ReadOnlyReason = (typeof READ_ONLY_REASONS)[number];

const PersonSchema = z.object({ id: z.number(), name: z.string() });

export const CalendarEventSchema = z.object({
  /** Google's event id: an instance's own id for an instance of a repeating event. */
  id: z.string(),
  etag: z.string(),
  /** For an instance of a repeating event, the series' id (Google's `recurringEventId`). */
  seriesId: z.string().nullable(),
  title: z.string(),
  location: z.string().nullable(),
  /** Plain text. A description Google keeps as HTML arrives with its tags taken out (`descriptionIsHtml`). */
  description: z.string().nullable(),
  /** The description is HTML in Google: the dashboard shows it as text and doesn't edit it. */
  descriptionIsHtml: z.boolean(),
  allDay: z.boolean(),
  /** YYYY-MM-DD. */
  startDate: z.string(),
  /** YYYY-MM-DD, inclusive: the last day an all-day event covers, or the day a timed event ends. */
  endDate: z.string(),
  /** HH:MM, null for all-day events. */
  startTime: z.string().nullable(),
  endTime: z.string().nullable(),
  /** The last day the event shows on. A timed event that ends at midnight doesn't show on the next day. */
  lastDate: z.string(),
  /** UTC ISO start, for ordering timed events. Null for all-day events. */
  startsAt: z.string().nullable(),
  readOnly: z.enum(READ_ONLY_REASONS).nullable(),
  /** Google's `eventType`: `default`, `birthday`, `outOfOffice`, `focusTime`, `fromGmail`, ... */
  eventType: z.string(),
  /** The event in Google Calendar's web UI, if Google gave one on a google.com host. */
  htmlLink: z.string().nullable(),
  /** Spec §9.5, from the event's private extended properties. Null when unknown. */
  createdBy: PersonSchema.nullable(),
  updatedBy: PersonSchema.nullable(),
});
export type CalendarEvent = z.infer<typeof CalendarEventSchema>;

/**
 * An event as the cache keeps it (`calendar_cache.events`): attribution as user ids, so names are
 * looked up when it's served and a renamed person shows their new name.
 */
export type StoredEvent = Omit<CalendarEvent, 'createdBy' | 'updatedBy'> & { createdById: number | null; updatedById: number | null };

export const CalendarReadOnlyStateSchema = z.enum(['needs_reconnect', 'key_mismatch', 'unreachable', 'api_disabled']);
export type CalendarReadOnlyState = z.infer<typeof CalendarReadOnlyStateSchema>;

/** What the card and the drill-down say about where the events came from (spec §7, §8, §9.2). */
export const CalendarFreshnessSchema = z.object({
  connected: z.boolean(),
  calendarName: z.string().nullable(),
  status: ConnectionStatusSchema.nullable(),
  /**
   * Changes can't be made right now, and why: the link needs reconnecting, the server's key
   * doesn't match, Google couldn't be reached and these are the events last fetched, or Google
   * says the Calendar API isn't turned on for the Cloud project (C-M2).
   */
  readOnly: CalendarReadOnlyStateSchema.nullable(),
  /** When these events were fetched from Google, ISO. Null when nothing has been. */
  fetchedAt: z.string().nullable(),
  /** The server's clock when it answered, as in TodoistFreshness. */
  serverNow: z.string(),
});
export type CalendarFreshness = z.infer<typeof CalendarFreshnessSchema>;

/** GET /api/panels/calendar/summary and /events: one window, [start, end) in family-local dates. */
export const CalendarWindowSchema = z.object({
  start: z.string(),
  end: z.string(),
  today: z.string(),
  timeZone: z.string(),
  events: z.array(CalendarEventSchema),
  freshness: CalendarFreshnessSchema,
});
export type CalendarWindow = z.infer<typeof CalendarWindowSchema>;

/** A calendar the linking admin can pick (spec §9.1): one they own or can make changes to. */
export const PendingCalendarSchema = z.object({
  id: z.string(),
  name: z.string(),
  timeZone: z.string().nullable(),
  primary: z.boolean(),
  accessRole: z.enum(['owner', 'writer']),
});
export type PendingCalendar = z.infer<typeof PendingCalendarSchema>;

/** Spec §9.6: what the person sees when Google says the event changed since they loaded it. */
export const CALENDAR_CONFLICT_MESSAGE = 'This event changed. Review and save again.';

/** The link needs reconnecting (the server's `CALENDAR_MESSAGES.reconnect`); the page tells it apart by this text (C-M3). */
export const CALENDAR_RECONNECT_MESSAGE = 'Google Calendar needs to be reconnected. An admin can reconnect it on the Admin page.';

/** Google sent an event the dashboard can't read (the server's `CALENDAR_WRITE_MESSAGES.unreadable`, C-M3). */
export const CALENDAR_UNREADABLE_MESSAGE = "Google Calendar sent this event in a form the dashboard can't read. Open it in Google Calendar.";

/** Google says the Calendar API isn't enabled for the dashboard's Google Cloud project (C-M2). Only an admin of that project can fix it. */
export const CALENDAR_API_DISABLED_MESSAGE = "The Google Calendar API isn't turned on for this Google Cloud project. Turn it on in the Google Cloud console.";
/** The event is gone from Google. */
export const CALENDAR_EVENT_GONE = 'This event was deleted in Google Calendar.';

/**
 * A new event's id: chosen before it's sent, so a create sent again after a lost answer is a 409
 * instead of a second event (research notes §5). Google takes 5 to 1024 characters of base32hex
 * (0-9 and a-v); 16 random bytes make 26.
 */
export const EVENT_ID_PATTERN = /^[0-9a-v]{26}$/;

/** 16 random bytes as an event id. The browser passes `crypto.getRandomValues`, the server `randomBytes`. */
export function eventIdFromBytes(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return n.toString(32).padStart(26, '0');
}

const EventFieldsSchema = z.object({
  title: z.string({ error: 'Enter a title' }).trim().min(1, 'Enter a title').max(1024, 'Keep the title to 1,024 characters or fewer'),
  allDay: z.boolean({ error: 'All day must be true or false' }),
  startDate: LocalDateSchema,
  endDate: LocalDateSchema,
  startTime: LocalTimeSchema.nullable(),
  endTime: LocalTimeSchema.nullable(),
  location: z.string({ error: 'Enter a location, or leave it blank' }).max(1024, 'Keep the location to 1,024 characters or fewer').nullable(),
  description: z.string({ error: 'Enter a description, or leave it blank' }).max(8192, 'Keep the description to 8,192 characters or fewer').nullable(),
  /** Left out: the repeat stays as it is. Null: it doesn't repeat. */
  repeat: RepeatRuleSchema.nullable().optional(),
});

type EventFields = z.infer<typeof EventFieldsSchema>;

/** An all-day event has no times, and a timed one has both. Checked on every create and edit. */
function checkShape(v: EventFields, ctx: z.RefinementCtx): void {
  if (v.allDay && (v.startTime !== null || v.endTime !== null)) ctx.addIssue({ code: 'custom', message: "An all-day event doesn't have times" });
  if (!v.allDay && (v.startTime === null || v.endTime === null)) ctx.addIssue({ code: 'custom', message: 'Enter a start time and an end time' });
}

/**
 * The end comes after the start, or null. Checked on a create, and on an edit only when the times
 * changed: an event made in Google that ends when it starts can still get a new title here.
 */
export function timesOutOfOrder(v: Pick<EventFields, 'allDay' | 'startDate' | 'endDate' | 'startTime' | 'endTime'>): string | null {
  if (v.allDay) return v.endDate < v.startDate ? 'The end date has to be on or after the start date' : null;
  return `${v.endDate}T${v.endTime}` <= `${v.startDate}T${v.startTime}` ? 'The end has to be after the start' : null;
}

/** The repeat ends on or after the series' first day, or null. For "All events" that's the series' own start. */
export function repeatEndsTooEarly(repeat: EventFields['repeat'], firstDay: string): string | null {
  return repeat?.end.type === 'on' && repeat.end.date < firstDay ? 'The repeat has to end on or after the first day' : null;
}

/**
 * An edit's form (spec §9.4), in the family time zone. For an all-day event the end date is
 * inclusive and there are no times; Google's exclusive end date is the server's business. The
 * order of the times and the repeat's end are checked by the server against what changed.
 */
export const CalendarEventInputSchema = EventFieldsSchema.superRefine(checkShape);
export type CalendarEventInput = z.infer<typeof CalendarEventInputSchema>;

/** POST /api/panels/calendar/events: the form, with the id the browser chose when the form opened. */
export const CreateEventInputSchema = EventFieldsSchema.extend({
  id: z.string({ error: 'The new event is missing its id' }).regex(EVENT_ID_PATTERN, 'The new event is missing its id'),
}).superRefine((v, ctx) => {
  checkShape(v, ctx);
  const order = !v.allDay && (v.startTime === null || v.endTime === null) ? null : timesOutOfOrder(v);
  if (order) ctx.addIssue({ code: 'custom', message: order });
  const repeat = repeatEndsTooEarly(v.repeat, v.startDate);
  if (repeat) ctx.addIssue({ code: 'custom', message: repeat });
});
export type CreateEventInput = z.infer<typeof CreateEventInputSchema>;

/** Spec §9.4: a repeating event's edit or delete asks which. "This and following" isn't offered. */
export const EditScopeSchema = z.enum(['this', 'all'], { error: 'Pick this event or all events' });
export type EditScope = z.infer<typeof EditScopeSchema>;

const EtagSchema = z.string({ error: 'The event is missing its version' }).min(1).max(256);

/** PATCH /api/panels/calendar/events/:id. The etags are the ones the person's form was loaded with (spec §9.6). */
export const UpdateEventInputSchema = z.object({
  scope: EditScopeSchema,
  etag: EtagSchema,
  /** The series' etag, for `scope: 'all'`. */
  seriesEtag: EtagSchema.nullable(),
  event: CalendarEventInputSchema,
});
export type UpdateEventInput = z.infer<typeof UpdateEventInputSchema>;

/** DELETE /api/panels/calendar/events/:id?scope=&etag=&seriesEtag= */
export const DeleteEventQuerySchema = z.object({ scope: EditScopeSchema, etag: EtagSchema, seriesEtag: EtagSchema.optional() });

/** A repeating event's series (its first instance's start, and its repeat rule as the editor sees it). */
export const CalendarSeriesSchema = z.object({
  id: z.string(),
  etag: z.string(),
  allDay: z.boolean(),
  /** The series' first day and time, in the zone it repeats in (`timeZone`). */
  startDate: z.string(),
  startTime: z.string().nullable(),
  /** The zone the series repeats in: its start's own zone, else the calendar's. Its weekdays and dates mean days there. */
  timeZone: z.string(),
  /** The rule, when it's one the editor offers. Null for a custom rule. */
  repeat: RepeatRuleSchema.nullable(),
  /** False for a custom rule, or one with dates skipped or added: shown, not edited ("Edit the repeat in Google Calendar"). */
  repeatEditable: z.boolean(),
  /** The repeat in plain English, e.g. "Every week on Tuesday". */
  repeatText: z.string().nullable(),
  /**
   * Null when "All events" can move the series to another day or time; otherwise why it can't
   * (shown by the form, which locks the dates and times): a repeat the editor can't represent,
   * dates skipped or added, instances changed or cancelled on their own, or a series too long to check.
   */
  moveBlocked: z.string().nullable(),
});
export type CalendarSeries = z.infer<typeof CalendarSeriesSchema>;

/** GET /api/panels/calendar/events/:id: fresh from Google, with its series for an instance (or a series). */
export const CalendarEventDetailSchema = z.object({ event: CalendarEventSchema, series: CalendarSeriesSchema.nullable() });
export type CalendarEventDetail = z.infer<typeof CalendarEventDetailSchema>;

/** GET /api/admin/panels/calendar/link: the Integrations section's view of the family calendar (spec §5, §9.1). */
export const CalendarLinkInfoSchema = z.object({
  connection: z
    .object({
      /** The Google account's email, from its ID token. */
      account: z.string().nullable(),
      calendarId: z.string(),
      calendarName: z.string(),
      calendarTimeZone: z.string().nullable(),
      status: ConnectionStatusSchema,
      lastSuccessAt: z.string().nullable(),
      lastError: z.string().nullable(),
      /** The last call failed because the Calendar API isn't turned on, and none has worked since (C-M2). */
      apiDisabled: z.boolean(),
      /** Who linked it last (spec §8: any admin can reconnect it). */
      linkedBy: z.string().nullable(),
    })
    .nullable(),
  /** This admin's pick, waiting, if they started one in this session. */
  pending: z.object({ account: z.string().nullable(), calendars: z.array(PendingCalendarSchema), expiresAt: z.string() }).nullable(),
  /** TOKEN_ENCRYPTION_KEY doesn't match: nothing can be linked or changed until it's fixed. */
  keyMismatch: z.boolean(),
});
export type CalendarLinkInfo = z.infer<typeof CalendarLinkInfoSchema>;

/** POST /api/admin/panels/calendar/link/choose */
export const ChooseCalendarInputSchema = z.object({ calendarId: z.string({ error: 'Pick a calendar' }).min(1, 'Pick a calendar').max(1024, 'Pick a calendar') });

/** `?calendar_error=` on /admin after a failed link, and what to tell the admin. */
export const CALENDAR_LINK_ERRORS = {
  denied: "Google Calendar wasn't connected, because access wasn't allowed. Try again and allow access.",
  expired: 'That connection attempt expired or came from another session. Try connecting again.',
  failed: "Couldn't finish connecting to Google Calendar. Try again in a few minutes.",
  scopes: "Google Calendar wasn't connected, because one of the calendar permissions wasn't allowed. Try again and allow both.",
  no_refresh: "Google didn't give the dashboard lasting access. Try connecting again.",
  no_calendars: "That Google account can't make changes to any calendar. Connect an account that can edit the family calendar.",
  not_admin: 'Only admins can connect Google Calendar.',
  rate_limited: 'Too many connection attempts. Wait a minute and try again.',
  key_mismatch: "Google Calendar can't be connected right now because the server's encryption key changed. Fix the key first.",
  api_disabled: `Google Calendar wasn't connected. ${CALENDAR_API_DISABLED_MESSAGE} Then connect again.`,
} as const;
export type CalendarLinkError = keyof typeof CALENDAR_LINK_ERRORS;
