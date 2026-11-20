import { Hono, type Context } from 'hono';
import { z } from 'zod';
import {
  CALENDAR_EVENT_GONE, ChooseCalendarInputSchema, CreateEventInputSchema, DeleteEventQuerySchema, MAX_WINDOW_DAYS, UpdateEventInputSchema,
  type CalendarLinkInfo,
} from '../../../shared/calendar.js';
import { daysBetween, LocalDateSchema } from '../../../shared/dates.js';
import type { AppDeps, AppEnv } from '../../app.js';
import { getUser } from '../../admin/users.js';
import { AppError, parseJson } from '../../core/errors.js';
import { rateLimit } from '../../core/rateLimit.js';
import { CALENDAR_MESSAGES } from '../../integrations/google/calendar.js';
import { sessionHash } from '../../integrations/google/routes.js';

/**
 * Google's ids are opaque; this only keeps out what can't be one: slashes, spaces, nothing at all,
 * and dots alone (`.` and `..` would change the path to Google once encoded into it).
 */
function eventId(raw: string): string {
  if (!/^(?!\.+$)[\w.@-]{1,1024}$/.test(raw)) throw new AppError('not_found', CALENDAR_EVENT_GONE);
  return raw;
}

/**
 * Windows within 1970 to 2100 (R4-M4): far wider than anyone browses, and every date in it is one
 * Google, `Date`, and the zone database agree on. The end is exclusive, so 2101-01-01 ends one.
 */
const FIRST_DAY = '1970-01-01';
const END_DAY = '2101-01-01';

const WindowQuerySchema = z
  .object({ start: LocalDateSchema, end: LocalDateSchema, refresh: z.enum(['1']).optional() })
  .refine((q) => q.start >= FIRST_DAY && q.end <= END_DAY, 'Pick dates from 1970 to 2100')
  .refine((q) => q.end > q.start, 'The end of the window has to be after its start')
  .refine((q) => daysBetween(q.start, q.end) <= MAX_WINDOW_DAYS, `Ask for at most ${MAX_WINDOW_DAYS} days at a time`);

function query<T>(c: Context, schema: z.ZodType<T>): T {
  const result = schema.safeParse(c.req.query());
  if (!result.success) throw new AppError('validation', [...new Set(result.error.issues.map((i) => i.message))].join('; '));
  return result.data;
}

/**
 * /api/panels/calendar/* (requirePanel has checked the Calendar grant). Spec §9.7: anyone with the
 * panel can view, create, edit, and delete events.
 *
 *   GET    /summary                                  home card: today and 6 days  → CalendarWindow
 *   GET    /events?start=&end=&refresh=1             one window, up to 42 days    → CalendarWindow
 *                                                     (1970 to 2100; refresh=1 is 20 a minute per person)
 *   (/summary and /events together are 120 a minute per person, C-M7)
 *   GET    /events/:id                               fresh from Google            → CalendarEventDetail
 *   POST   /events                                   CreateEventInput             → 201 CalendarEvent
 *   PATCH  /events/:id                               UpdateEventInput             → 204
 *   DELETE /events/:id?scope=&etag=&seriesEtag=                                   → 204
 *
 * A stale etag is 409 `conflict` with "This event changed. Review and save again." (spec §9.6);
 * Google refusing or unreachable is 503 `integration_unavailable` with a plain message, or 503
 * `outcome_unknown` for a write that was sent and may have been made (C-M4).
 */
export function calendarRoutes(deps: AppDeps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const service = deps.calendarEvents;

  // Window reads, the card's included: 120 a minute per person, far past what the pages ask for
  // (the card refreshes every minute), so one person can't keep the server busy reading (C-M7).
  const readLimit = rateLimit({ windowMs: 60_000, max: 120, clock: deps.clock, key: (c) => `user:${(c as Context<AppEnv>).get('user')!.id}` });

  r.get('/summary', readLimit, async (c) => c.json(await service.summary()));

  // The refresh button skips the 5-minute cache, so each press is a call to Google (R4-M4).
  const refreshLimit = rateLimit({ windowMs: 60_000, max: 20, clock: deps.clock, key: (c) => `user:${(c as Context<AppEnv>).get('user')!.id}` });

  r.get('/events', readLimit, (c, next) => (c.req.query('refresh') === '1' ? refreshLimit(c, next) : next()), async (c) => {
    const q = query(c, WindowQuerySchema);
    return c.json(await service.window(q.start, q.end, { refresh: q.refresh === '1' }));
  });

  r.get('/events/:id', async (c) => c.json(await service.detail(eventId(c.req.param('id')))));

  r.post('/events', async (c) => {
    const input = await parseJson(c, CreateEventInputSchema);
    return c.json(await service.create(c.get('user')!.id, input), 201);
  });

  r.patch('/events/:id', async (c) => {
    const input = await parseJson(c, UpdateEventInputSchema);
    await service.update(c.get('user')!.id, eventId(c.req.param('id')), input);
    return c.body(null, 204);
  });

  r.delete('/events/:id', async (c) => {
    const q = query(c, DeleteEventQuerySchema);
    await service.delete(c.get('user')!.id, eventId(c.req.param('id')), q);
    return c.body(null, 204);
  });

  return r;
}

/**
 * /api/admin/panels/calendar/* (the admin routes have checked the role). The Integrations section
 * (spec §5, §9.1): any admin can see the link, pick or change the calendar, or disconnect it. A
 * pick waiting from the consent page belongs to the admin and session that started it.
 *
 *   GET  /link                         → CalendarLinkInfo
 *   POST /link/change                  → 204: offers the calendars again, with the saved token
 *   POST /link/choose  { calendarId }  → 204
 *   POST /link/cancel                  → 204: this session's pick only
 *   POST /disconnect                   → { revoked }
 *   (change, choose, cancel, and disconnect share a limit of 10 a minute per admin, like linking)
 *   POST /revocations/:id/dismiss      → 204: a System warning about access given up on (R2-I3)
 */
export function calendarAdminRoutes(deps: AppDeps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const { calendar } = deps;
  const hashOf = (c: Context<AppEnv>) => sessionHash(c.get('sessionToken') ?? '');

  r.get('/link', (c) => {
    const user = c.get('user')!;
    const state = calendar.state();
    const body: CalendarLinkInfo = {
      connection: state.connected
        ? {
            account: state.meta.account,
            calendarId: state.meta.calendarId,
            calendarName: state.meta.calendarName,
            calendarTimeZone: state.meta.calendarTimeZone,
            status: state.status,
            lastSuccessAt: state.lastSuccessAt?.toISOString() ?? null,
            lastError: state.status === 'ok' ? null : state.lastError,
            apiDisabled: state.apiDisabled,
            linkedBy: getUser(deps.db, state.ownerUserId)?.displayName ?? null,
          }
        : null,
      pending: calendar.pending(user.id, hashOf(c)),
      keyMismatch: calendar.keyMismatch,
    };
    return c.json(body);
  });

  const limited = rateLimit({ windowMs: 60_000, max: 10, clock: deps.clock, key: (c) => `user:${(c as Context<AppEnv>).get('user')!.id}` });

  r.post('/link/change', limited, async (c) => {
    if (calendar.keyMismatch) throw new AppError('integration_unavailable', CALENDAR_MESSAGES.keyMismatch);
    const result = await calendar.beginChange(c.get('user')!.id, hashOf(c));
    if (result === 'no_calendars') throw new AppError('validation', "The connected Google account can't make changes to any calendar now.");
    return c.body(null, 204);
  });

  r.post('/link/choose', limited, async (c) => {
    const { calendarId } = await parseJson(c, ChooseCalendarInputSchema);
    await calendar.choose(c.get('user')!.id, hashOf(c), calendarId);
    return c.body(null, 204);
  });

  r.post('/link/cancel', limited, (c) => {
    calendar.cancelPending(c.get('user')!.id, hashOf(c));
    return c.body(null, 204);
  });

  r.post('/disconnect', limited, async (c) => {
    const { revoked } = await calendar.disconnect(c.get('user')!.id);
    return c.json({ revoked });
  });

  r.post('/revocations/:id/dismiss', (c) => {
    const id = Number(c.req.param('id'));
    if (!Number.isSafeInteger(id) || id <= 0 || !calendar.dismissRevocation(id)) throw new AppError('not_found', 'That warning was already dismissed.');
    deps.logger.info({ userId: c.get('user')!.id }, 'google calendar revocation warning dismissed');
    return c.body(null, 204);
  });

  return r;
}
