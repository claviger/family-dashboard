import { and, eq, inArray, lt, lte, max, or } from 'drizzle-orm';
import type { Logger } from 'pino';
import {
  CALENDAR_CACHE_MS, CALENDAR_CONFLICT_MESSAGE, CALENDAR_EVENT_GONE, CALENDAR_UNREADABLE_MESSAGE, repeatEndsTooEarly, SUMMARY_DAYS, timesOutOfOrder, type CalendarEvent, type CalendarEventDetail,
  type CalendarFreshness, type CalendarReadOnlyState, type CalendarSeries, type CalendarWindow, type CreateEventInput, type EditScope, type StoredEvent, type UpdateEventInput,
} from '../../../shared/calendar.js';
import { addDays, weekdayOf } from '../../../shared/dates.js';
import { describeRecurrence, longDate, parseRecurrence, sameRule, serializeRule, shiftWeekdays, untilValue, WEEKDAYS, type ParsedRecurrence, type RepeatRule } from '../../../shared/rrule.js';
import { utcToWall, wallToUtcMs } from '../../../shared/zonedTime.js';
import { localDate, type Clock } from '../../core/clock.js';
import { AppError } from '../../core/errors.js';
import type { Db } from '../../db/index.js';
import { calendarCache, users, type CalendarCacheRow } from '../../db/schema.js';
import { GoogleApiError, type EventBody, type EventRead, type GoogleEvent } from '../../integrations/google/calendarClient.js';
import { CALENDAR_MESSAGES } from '../../integrations/google/calendar.js';
import { getFamilySettings, getInstallId } from '../../settings.js';
import { changedInstances, changedText, eventTimes, insertTimes, mergePatch, moveSeries, seriesStart, seriesZone, shiftSeriesDays, timesChanged } from './edits.js';
import { attributionValue, compareEvents, CREATED_BY, fetchBounds, instantOf, inWindow, toStoredEvent, UPDATED_BY } from './mapping.js';
import type { CalendarProvider } from './provider.js';

/** Cached windows nobody has fetched for this long are deleted by `calendar.refreshSummary`. */
export const CACHE_KEEP_MS = 7 * 24 * 60 * 60_000;
/**
 * A page's read waits at most this long for Google. Past it, the cached window is served, marked
 * unreachable, and the fetch carries on in the background and updates the cache when it lands.
 */
export const READ_WAIT_MS = 8_000;
/**
 * Everything one request asks of Google (an event detail, a create, an edit, a delete) finishes
 * by this long after it starts, retries included, so the answer comes back well before nginx's
 * 60 seconds. Each call is also bounded on its own (`CALL_DEADLINE_MS` in calendarClient.ts).
 */
export const REQUEST_DEADLINE_MS = 45_000;
/** How far past the later of a series' start and today its instances are checked before it's moved. */
export const SERIES_CHECK_DAYS = 400;

/** What people see when a change can't be made. Never Google's raw error text (spec §14). */
export const CALENDAR_WRITE_MESSAGES = {
  rejected: "Google Calendar didn't accept that change.",
  readOnly: "This event can't be changed here. Change it in Google Calendar.",
  repeatReadOnly: 'This repeat can only be changed in Google Calendar.',
  repeatIsSeries: 'The repeat belongs to the whole series. Choose All events to change it.',
  notRepeating: "This event doesn't repeat.",
  allDaySeries: 'To change whether a repeating event is all day, change it in Google Calendar.',
  stopSeries: 'To stop a series, set when the repeat ends, or delete all events.',
  chooseAll: 'This is the whole series. Choose All events to change it.',
  moveInGoogle: 'Move this series in Google Calendar.',
  unreadable: CALENDAR_UNREADABLE_MESSAGE,
  idTaken: 'Google Calendar already has a different event with this id. Close the form and add the event again.',
  startMissing: (date: string, time: string) => `This series starts on ${longDate(date)}, and ${time} doesn't happen that day because the clocks change. Pick another time.`,
} as const;

/** Why "All events" can't move a series (`CalendarSeries.moveBlocked`), shown by the form, which locks its dates, times, and repeat. */
export const SERIES_MOVE_BLOCKED = {
  custom: "This series repeats in a way the dashboard can't edit, so its dates, times, and repeat can only be changed in Google Calendar.",
  datesSkipped: 'This series has dates skipped or added, so its dates, times, and repeat can only be changed in Google Calendar.',
  changed: 'Some events in this series were changed or deleted on their own, so its dates, times, and repeat can only be changed in Google Calendar.',
  tooLong: 'This series is too long to check from here, so its dates, times, and repeat can only be changed in Google Calendar.',
  unchecked: "Google Calendar didn't answer when the dashboard checked this series, so its dates, times, and repeat can't be changed right now. Try again in a few minutes.",
  busy: "Google Calendar was busy when the dashboard checked this series, so its dates, times, and repeat can't be changed right now. Try again in a minute.",
  reconnect: "Google Calendar needs to be reconnected before this series' dates, times, and repeat can be changed. An admin can reconnect it on the Admin page.",
} as const;

/** Why `moveBlocked` blocked a move: the series itself, or a check that couldn't be made (which a retry may fix). */
interface MoveBlock {
  message: string;
  /** Set when the check failed: the error a write answers with instead of "Move this series in Google Calendar". */
  checkFailed: AppError | null;
}

/** How long a series' instance check is reused when its event is opened again (R3-M). Saving a move always checks again. */
export const SERIES_CHECK_CACHE_MS = 5 * 60_000;

export interface CalendarServiceDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  provider: CalendarProvider;
  /** For tests: how long a read waits (READ_WAIT_MS). */
  readWaitMs?: number;
  /** For tests: REQUEST_DEADLINE_MS. */
  requestDeadlineMs?: number;
}

type WindowKey = { calendarId: string; timeZone: string; windowStart: string; windowEnd: string };

function keyText(k: WindowKey): string {
  return JSON.stringify([k.calendarId, k.timeZone, k.windowStart, k.windowEnd]);
}

/**
 * The Calendar panel's reads (spec §9.2) and writes (spec §9.4 to §9.6). Events are fetched one window
 * at a time and cached per window in `calendar_cache`:
 * - a window fetched less than 5 minutes ago (and not marked stale by a dashboard write) is
 *   served from the cache; the drill-down's refresh button skips it;
 * - otherwise it's fetched again, one request per window at a time (callers asking at once share
 *   it), and the result replaces that window's row whole;
 * - when Google can't be reached, or the link needs reconnecting, or the key doesn't match, the
 *   last good result is served with `readOnly` saying why, so the page shows it read-only.
 * The cache is a cache: nothing here ever deletes or changes anything because a listing left it out.
 * A fetch that overlaps a dashboard write (`invalidate` bumps a generation) is saved as stale, and
 * the read that asked for it fetches once more rather than serve it as fresh (C-I1); one whose link
 * was disconnected or pointed at another calendar meanwhile isn't saved at all.
 *
 * Writes go to Google while the person waits (spec §14), and every one marks the cache stale:
 * - Each first reads the event (and, for "All events", its series) fresh from Google and checks the
 *   etag the person's form was loaded with, so a conflict is caught whether or not Google honors
 *   `If-Match` (UNVERIFIED, research notes §5). The write still sends `If-Match`, and a 412 is the
 *   same conflict (spec §9.6) unless the etag didn't change (`sendChecked`). The log says which
 *   caught it (`caughtBy`).
 * - Edits are patches with only the fields the form changed, plus `dashboardUpdatedBy` (spec §9.5).
 * - "This event" patches the instance, and deleting one instance patches it to `cancelled`; an
 *   instance Google won't patch is sent whole with PUT (`writePatch`). "All events" patches or
 *   deletes the series with the series' own etag, and moves it only when `moveBlocked` is null.
 */
export class CalendarService {
  private readonly inFlight = new Map<string, Promise<CalendarCacheRow>>();
  /** Instance checks by series id and etag, with when they were made (clock ms). */
  private readonly seriesChecks = new Map<string, { at: number; block: MoveBlock | null }>();
  /**
   * Bumped by every dashboard write (`invalidate`): a fetch that started before one is stale on
   * arrival. Saved with each cached window (`fetch_generation`), and it starts from the highest
   * saved, so after a restart a new fetch still counts as newer than the rows already there (C-I1).
   */
  private generation: number;

  constructor(private readonly deps: CalendarServiceDeps) {
    this.generation = deps.db.select({ g: max(calendarCache.fetchGeneration) }).from(calendarCache).get()?.g ?? 0;
  }

  private installId(): string {
    return getInstallId(this.deps.db);
  }

  private timeZone(): string {
    return getFamilySettings(this.deps.db).timeZone;
  }

  today(): string {
    return localDate(this.deps.clock.now(), this.timeZone());
  }

  /** The home card's window: today and the 6 days after it, in the family time zone. */
  summary(): Promise<CalendarWindow> {
    const today = this.today();
    return this.window(today, addDays(today, SUMMARY_DAYS));
  }

  /** One window, `[start, end)` as family-local dates. Never fails because of Google: see the class comment. */
  async window(start: string, end: string, opts: { refresh?: boolean } = {}): Promise<CalendarWindow> {
    const timeZone = this.timeZone();
    const state = this.deps.provider.state();
    const base = { start, end, today: localDate(this.deps.clock.now(), timeZone), timeZone };
    if (!state.connected) {
      return { ...base, events: [], freshness: this.freshness(null, null, state.keyMismatch ? 'key_mismatch' : null) };
    }
    const key: WindowKey = { calendarId: state.meta.calendarId, timeZone, windowStart: start, windowEnd: end };
    const cached = this.cached(key);
    const fresh = cached && !cached.stale && this.deps.clock.now().getTime() - cached.fetchedAt.getTime() < CALENDAR_CACHE_MS;
    const serve = (row: CalendarCacheRow | undefined, readOnly: CalendarReadOnlyState | null): CalendarWindow => ({
      ...base,
      events: this.withNames(row?.events ?? []),
      freshness: this.freshness(state.meta.calendarName, row?.fetchedAt ?? null, readOnly),
    });
    if (state.keyMismatch) return serve(cached, 'key_mismatch');
    if (state.status === 'needs_reconnect') return serve(cached, 'needs_reconnect');
    if (fresh && !opts.refresh) return serve(cached, null);
    let timer: NodeJS.Timeout | undefined;
    const waited = new Promise<'slow'>((resolve) => {
      timer = setTimeout(() => resolve('slow'), this.deps.readWaitMs ?? READ_WAIT_MS);
      timer.unref();
    });
    const fetched = () => {
      const fetching = this.fetch(key);
      // Whatever happens to it after the wait below, its failure is already recorded on the connection.
      fetching.catch(() => {});
      return Promise.race([fetching, waited]);
    };
    try {
      let row = await fetched();
      // A dashboard write landed while this was out, so what it fetched may not have the write:
      // never served as fresh (C-I1). Fetched once more, sharing a fetch that started after the write.
      if (row !== 'slow' && row.fetchGeneration < this.generation) row = await fetched();
      if (row === 'slow' || row.fetchGeneration < this.generation) {
        this.deps.logger.info({ start, end, slow: row === 'slow' }, 'calendar window slow; serving the cache while it finishes');
        return serve(this.cached(key), 'unreachable');
      }
      return serve(row, null);
    } catch (err) {
      // Google couldn't be reached or refused the read, the link changed under it, or the answer
      // was about something other than the connection: the cache, read-only (R3-M).
      const servable = err instanceof GoogleApiError || (err instanceof AppError && (err.code === 'integration_unavailable' || err.code === 'conflict'));
      if (!servable) throw err;
      if (err instanceof GoogleApiError) this.deps.logger.warn({ kind: err.kind, status: err.status, reason: err.reason }, 'calendar window refused; serving the cache');
      const now = this.deps.provider.state();
      if (now.connected && now.status === 'needs_reconnect') return serve(cached, 'needs_reconnect');
      // Google says the Calendar API is off for the project: the card says so (C-M2).
      return serve(cached, err instanceof AppError && err.message === CALENDAR_MESSAGES.apiDisabled ? 'api_disabled' : 'unreachable');
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * The `calendar.refreshSummary` job (spec §3.5): fetches the summary window again, so the card
   * loads quickly and "Updated X ago" stays current, and prunes windows nobody has looked at for
   * a week, only while the link is `ok`: otherwise the old windows are the last good results
   * there are (R3-M). Skips quietly when there's nothing to fetch (not linked, waiting for a
   * reconnect, the key doesn't match); throws, so the job records it, when Google couldn't be reached.
   */
  async refreshSummary(): Promise<'fetched' | 'skipped'> {
    const state = this.deps.provider.state();
    if (state.connected && state.status === 'ok' && !state.keyMismatch) this.pruneCache();
    if (!state.connected || state.keyMismatch || state.status === 'needs_reconnect') return 'skipped';
    const today = this.today();
    await this.fetch({ calendarId: state.meta.calendarId, timeZone: this.timeZone(), windowStart: today, windowEnd: addDays(today, SUMMARY_DAYS) });
    return 'fetched';
  }

  pruneCache(): number {
    return this.deps.db.delete(calendarCache).where(lt(calendarCache.fetchedAt, new Date(this.deps.clock.now().getTime() - CACHE_KEEP_MS))).run().changes;
  }

  /**
   * After a dashboard write: every window fetches again, but each keeps its last good result to
   * fall back on. Cached instance checks are forgotten too: changing one instance may not change
   * its series' etag (UNVERIFIED for Google; it doesn't in the fake).
   */
  invalidate(): void {
    this.generation++;
    this.seriesChecks.clear();
    this.deps.db.update(calendarCache).set({ stale: true }).run();
  }

  private cached(k: WindowKey): CalendarCacheRow | undefined {
    return this.deps.db
      .select()
      .from(calendarCache)
      .where(and(eq(calendarCache.calendarId, k.calendarId), eq(calendarCache.timeZone, k.timeZone), eq(calendarCache.windowStart, k.windowStart), eq(calendarCache.windowEnd, k.windowEnd)))
      .get();
  }

  /**
   * Fetches a window and saves it as that window's row. Callers asking for the same window at once
   * share one request, but not across a dashboard write: one that started before it can't answer
   * for the window after it.
   */
  private fetch(k: WindowKey): Promise<CalendarCacheRow> {
    const id = `${keyText(k)}#${this.generation}`;
    const running = this.inFlight.get(id);
    if (running) return running;
    const p = this.fetchNow(k).finally(() => this.inFlight.delete(id));
    this.inFlight.set(id, p);
    return p;
  }

  private async fetchNow(k: WindowKey): Promise<CalendarCacheRow> {
    const generation = this.generation;
    const startedAt = this.deps.clock.now();
    const before = this.deps.provider.state();
    const { events, calendarTimeZone, skipped } = await this.deps.provider.listEvents({ ...fetchBounds(k.windowStart, k.windowEnd, k.timeZone), timeZone: k.timeZone });
    const installId = this.installId();
    const stored = events
      .map((g) => toStoredEvent(g, { timeZone: k.timeZone, calendarTimeZone, installId }))
      .filter((e): e is StoredEvent => e !== null && inWindow(e, k.windowStart, k.windowEnd))
      .sort(compareEvents);
    // A write landed while this was out: the result may not have it, so it's kept as stale.
    const stale = generation !== this.generation;
    const row: CalendarCacheRow = { ...k, fetchedAt: this.deps.clock.now(), fetchStartedAt: startedAt, fetchGeneration: generation, stale, events: stored };
    const after = this.deps.provider.state();
    const sameLink = before.connected && after.connected && before.connectionId === after.connectionId && after.meta.calendarId === k.calendarId;
    if (!sameLink) {
      // Disconnected, or pointed at another calendar, while this was out: not this calendar's cache any more.
      this.deps.logger.info({ start: k.windowStart, end: k.windowEnd }, 'calendar window fetched for a link that changed; not cached');
      return row;
    }
    // Only over a row from a fetch that started before this one: one that started later has newer
    // events, even if it finished first, and an older fetch never replaces it (R3-M, C-I1). "Later"
    // is by the write count first, then the start time, so it holds when the clock doesn't move
    // (or moves back) between two fetches.
    const saved = this.deps.db
      .insert(calendarCache)
      .values(row)
      .onConflictDoUpdate({
        target: [calendarCache.calendarId, calendarCache.timeZone, calendarCache.windowStart, calendarCache.windowEnd],
        set: { fetchedAt: row.fetchedAt, fetchStartedAt: startedAt, fetchGeneration: generation, stale, events: stored },
        setWhere: or(
          lt(calendarCache.fetchGeneration, generation),
          and(eq(calendarCache.fetchGeneration, generation), lte(calendarCache.fetchStartedAt, startedAt)),
        ),
      })
      .run().changes === 1;
    this.deps.logger.info({ start: k.windowStart, end: k.windowEnd, events: stored.length, listed: events.length, skipped, stale, saved }, 'calendar window fetched');
    if (saved) return row;
    // A newer fetch is saved: it's the answer, as long as it's at least as new as this one's write
    // count. Otherwise this fetch's own result is (C-I1).
    const newer = this.cached(k);
    return newer && newer.fetchGeneration >= generation ? newer : row;
  }

  private freshness(calendarName: string | null, fetchedAt: Date | null, readOnly: CalendarReadOnlyState | null): CalendarFreshness {
    const state = this.deps.provider.state();
    return {
      connected: state.connected,
      calendarName,
      status: state.connected ? state.status : null,
      readOnly,
      fetchedAt: fetchedAt?.toISOString() ?? null,
      serverNow: this.deps.clock.now().toISOString(),
    };
  }

  /** Attribution ids as names (spec §9.5), looked up now, so a rename shows. Deactivated people keep their name. */
  withNames(events: StoredEvent[]): CalendarEvent[] {
    const ids = [...new Set(events.flatMap((e) => [e.createdById, e.updatedById]).filter((id): id is number => id !== null))];
    const names = new Map(
      ids.length === 0 ? [] : this.deps.db.select({ id: users.id, name: users.displayName }).from(users).where(inArray(users.id, ids)).all().map((u) => [u.id, u.name]),
    );
    const person = (id: number | null) => (id !== null && names.has(id) ? { id, name: names.get(id)! } : null);
    return events.map(({ createdById, updatedById, ...e }) => ({ ...e, createdBy: person(createdById), updatedBy: person(updatedById) }));
  }

  // ---- Writes.

  private deadline(): number {
    return Date.now() + (this.deps.requestDeadlineMs ?? REQUEST_DEADLINE_MS);
  }

  private calendarZone(): string | null {
    const state = this.deps.provider.state();
    return state.connected ? state.meta.calendarTimeZone : null;
  }

  private conflict(op: string, caughtBy: 'precheck' | 'google'): AppError {
    this.deps.logger.info({ op, caughtBy }, 'calendar edit conflict');
    return new AppError('conflict', CALENDAR_CONFLICT_MESSAGE);
  }

  /** A provider error about one event, as ours. Connection errors are already AppErrors. */
  private eventError(err: unknown, op: string): unknown {
    if (!(err instanceof GoogleApiError)) return err;
    if (err.kind === 'not_found' || err.kind === 'gone') return new AppError('not_found', CALENDAR_EVENT_GONE);
    if (err.kind === 'precondition') return this.conflict(op, 'google');
    if (err.kind === 'bad_response' && err.reason === 'event_shape') {
      // One event that won't parse: about that event, not the connection (R2-M12).
      this.deps.logger.warn({ op, kind: err.kind, reason: err.reason }, 'calendar event unreadable');
      return new AppError('integration_unavailable', CALENDAR_WRITE_MESSAGES.unreadable);
    }
    this.deps.logger.warn({ op, kind: err.kind, status: err.status, reason: err.reason }, 'calendar change refused');
    return new AppError('integration_unavailable', CALENDAR_WRITE_MESSAGES.rejected);
  }

  /** The event as Google has it now: parsed, and its raw JSON, which a PUT fallback sends back (R3-C1). */
  private async get(eventId: string, deadline: number): Promise<EventRead> {
    try {
      return await this.deps.provider.getEvent(eventId, { deadline });
    } catch (err) {
      throw this.eventError(err, 'get');
    }
  }

  private stored(g: GoogleEvent, timeZone: string): StoredEvent {
    const stored = toStoredEvent(g, { timeZone, calendarTimeZone: this.calendarZone(), installId: this.installId() });
    if (!stored) throw new AppError('not_found', CALENDAR_EVENT_GONE);
    return stored;
  }

  /**
   * Why "All events" can't move this series, or null (C1 of the plan review): only a series whose
   * repeat the editor can represent, with no dates skipped or added, and no instance changed or
   * cancelled on its own, is moved from here, since what Google does to exceptions when their
   * series moves is UNVERIFIED (research notes §6). Instances are read with `events.instances`,
   * cancelled ones included, from the series' start to 400 days past the later of that and now.
   *
   * A check that couldn't be made says why, apart from a series that has exceptions: Google was
   * busy, the link needs reconnecting, or it didn't answer (R3-M). Opening an event reuses a
   * check of the same series version for 5 minutes (`cached`), until any dashboard write; saving
   * a move never does, so an exception made meanwhile in Google is still seen.
   */
  private async moveBlocked(masterRead: EventRead, parsed: ParsedRecurrence, zone: string, deadline: number, opts: { cached?: boolean } = {}): Promise<MoveBlock | null> {
    const master = masterRead.event;
    if (parsed.kind !== 'rule') return { message: SERIES_MOVE_BLOCKED.custom, checkFailed: null };
    if (!parsed.editable) return { message: SERIES_MOVE_BLOCKED.datesSkipped, checkFailed: null };
    const key = `${master.id}|${master.etag}`;
    const now = this.deps.clock.now().getTime();
    for (const [k, v] of this.seriesChecks) if (now - v.at >= SERIES_CHECK_CACHE_MS) this.seriesChecks.delete(k);
    const hit = this.seriesChecks.get(key);
    if (opts.cached && hit) return hit.block;
    const block = await this.checkInstances(masterRead, zone, deadline);
    if (block?.checkFailed) this.seriesChecks.delete(key);
    else this.seriesChecks.set(key, { at: now, block });
    return block;
  }

  private async checkInstances(masterRead: EventRead, zone: string, deadline: number): Promise<MoveBlock | null> {
    const master = masterRead.event;
    const first = seriesStart(master, zone);
    const startMs = first.allDay ? wallToUtcMs(first.date, '00:00', zone) : instantOf(master.start!, zone);
    const timeMin = new Date(startMs).toISOString();
    const timeMax = new Date(Math.max(startMs, this.deps.clock.now().getTime()) + SERIES_CHECK_DAYS * 86_400_000).toISOString();
    let instances: EventRead[] | null;
    try {
      instances = await this.deps.provider.listInstances(master.id, { timeMin, timeMax }, { deadline });
    } catch (err) {
      const kind = err instanceof GoogleApiError ? err.kind : err instanceof AppError ? err.code : 'unknown';
      this.deps.logger.warn({ kind }, 'calendar series instances not checked');
      if (err instanceof AppError && err.message === CALENDAR_MESSAGES.reconnect) {
        return { message: SERIES_MOVE_BLOCKED.reconnect, checkFailed: new AppError('integration_unavailable', CALENDAR_MESSAGES.reconnect) };
      }
      if ((err instanceof AppError && err.message === CALENDAR_MESSAGES.busy) || (err instanceof GoogleApiError && err.kind === 'rate_limited')) {
        return { message: SERIES_MOVE_BLOCKED.busy, checkFailed: new AppError('integration_unavailable', CALENDAR_MESSAGES.busy) };
      }
      return { message: SERIES_MOVE_BLOCKED.unchecked, checkFailed: new AppError('integration_unavailable', CALENDAR_MESSAGES.unreachable) };
    }
    if (instances === null) {
      this.deps.logger.info({}, 'calendar series too long to check');
      return { message: SERIES_MOVE_BLOCKED.tooLong, checkFailed: null };
    }
    const { count: changed, fields } = changedInstances(masterRead.raw, instances.map((i) => i.raw), zone);
    if (changed === 0) return null;
    this.deps.logger.info({ changed, instances: instances.length, fields }, 'calendar series has changed instances');
    return { message: SERIES_MOVE_BLOCKED.changed, checkFailed: null };
  }

  /** The series as the editor sees it, in the zone it repeats in (research notes §7). */
  private async seriesOf(masterRead: EventRead, deadline: number): Promise<CalendarSeries> {
    const master = masterRead.event;
    const zone = seriesZone(master, this.calendarZone(), this.timeZone());
    const first = seriesStart(master, zone);
    const parsed = parseRecurrence(master.recurrence, { allDay: first.allDay, startDate: first.date, startTime: first.time, timeZone: zone });
    return {
      id: master.id,
      etag: master.etag,
      allDay: first.allDay,
      startDate: first.date,
      startTime: first.time,
      timeZone: zone,
      repeat: parsed.kind === 'rule' ? parsed.rule : null,
      repeatEditable: parsed.kind === 'rule' && parsed.editable,
      repeatText: describeRecurrence(parsed, first.date),
      moveBlocked: (await this.moveBlocked(masterRead, parsed, zone, deadline, { cached: true }))?.message ?? null,
    };
  }

  /** A series' id: an instance's `recurringEventId`, or the event's own id when it's the series itself (M-5). */
  private seriesIdOf(g: GoogleEvent): string | null {
    return g.recurringEventId ?? (g.recurrence?.length ? g.id : null);
  }

  /**
   * One event, fresh from Google (spec §9.4's event detail, and what an edit form loads), with its
   * series if it repeats. Opened by the series' own id (a link to it), the event is the series'
   * first occurrence and `seriesId` is its own id, so the page offers only "All events".
   */
  async detail(eventId: string): Promise<CalendarEventDetail> {
    const deadline = this.deadline();
    const read = await this.get(eventId, deadline);
    const g = read.event;
    const event = this.withNames([this.stored(g, this.timeZone())])[0]!;
    const seriesId = this.seriesIdOf(g);
    if (seriesId === null) return { event, series: null };
    const master = seriesId === g.id ? read : await this.get(seriesId, deadline);
    return { event: { ...event, seriesId }, series: await this.seriesOf(master, deadline) };
  }

  /**
   * `events.insert` with the id the browser chose when the form opened (research notes §5) and
   * `dashboardCreatedBy` (spec §9.5). A Save sent again after a lost answer gets 409 from Google:
   * the event the first try made is read back, as long as this install and person made it.
   */
  async create(userId: number, input: CreateEventInput): Promise<CalendarEvent> {
    const deadline = this.deadline();
    const timeZone = this.timeZone();
    const repeat = input.repeat ?? null;
    const location = input.location?.trim() || null;
    const description = input.description?.trim() || null;
    const id = input.id;
    const mine = attributionValue(this.installId(), userId);
    const body: EventBody = {
      id,
      summary: input.title.trim(),
      ...(location ? { location } : {}),
      ...(description ? { description } : {}),
      ...insertTimes(input, timeZone),
      ...(repeat ? { recurrence: [serializeRule(repeat, { allDay: input.allDay, startDate: input.startDate, startTime: input.allDay ? null : input.startTime, timeZone })] } : {}),
      extendedProperties: { private: { [CREATED_BY]: mine } },
    };
    let created: GoogleEvent;
    let retried = false;
    // Reading the event back after the insert landed (or found its id taken) fails: it may well
    // exist, so the page keeps the form as sent for a retry (C-M4).
    const readBack = async () => {
      try {
        return (await this.get(id, deadline)).event;
      } catch (err) {
        if (err instanceof AppError && err.code === 'integration_unavailable') throw new AppError('outcome_unknown', err.message);
        throw err;
      }
    };
    try {
      // Null: made, but Google's answer wasn't an event, so it's read back.
      created = (await this.deps.provider.insertEvent(body, { deadline })) ?? (await readBack());
    } catch (err) {
      // The insert was sent, so it may have landed whatever happens next (R3-M).
      this.invalidate();
      if (!(err instanceof GoogleApiError && err.kind === 'duplicate')) throw this.eventError(err, 'insert');
      // Another event has this id (it was this person's earlier try, or it isn't theirs): a 409
      // with a plain message when it isn't, never Google being unavailable (R3-M).
      const taken = new AppError('conflict', CALENDAR_WRITE_MESSAGES.idTaken);
      let existing: GoogleEvent;
      try {
        existing = await readBack();
      } catch (e) {
        if (e instanceof AppError && e.code === 'not_found') throw taken;
        throw e;
      }
      if (existing.status === 'cancelled' || existing.extendedProperties?.private?.[CREATED_BY] !== mine) {
        this.deps.logger.info({ userId }, 'calendar create refused: the id belongs to another event');
        throw taken;
      }
      created = existing;
      retried = true;
    }
    if (!retried) this.invalidate();
    this.deps.logger.info({ userId, allDay: input.allDay, repeats: repeat !== null, retried }, 'calendar event created');
    return this.withNames([this.stored(created, timeZone)])[0]!;
  }

  /**
   * Sends a write with `If-Match`. A 412 right after the precheck passed is read again: an event
   * that's gone is the caller's not-found, and an etag that really changed is a conflict. If it
   * didn't change, Google refused an etag it just gave out, which is UNVERIFIED for instances only
   * (research notes §5): so only a PATCH or the PUT fallback on an instance (`instanceWrite`) is
   * logged as `etagRejected` and sent once more without `If-Match`, the precheck still guarding
   * it. For a single event, a series, or a delete, it's a conflict (R3-I5).
   *
   * Read again as `cancelled` (deleted, research notes §4), the event is gone: for a delete that's
   * done (a retry of a delete that already went through, C-M1), and for anything else it's the
   * caller's not-found. A 404 on the read means the same.
   */
  private async sendChecked(op: string, target: GoogleEvent, deadline: number, opts: { instanceWrite: boolean; deleting: boolean }, send: (etag: string | null) => Promise<unknown>): Promise<void> {
    try {
      await send(target.etag);
    } catch (err) {
      if (!(err instanceof GoogleApiError && err.kind === 'precondition')) throw err;
      const again = (await this.get(target.id, deadline)).event;
      if (again.status === 'cancelled') {
        this.deps.logger.info({ op, deleting: opts.deleting }, 'calendar event read back cancelled after a 412');
        if (opts.deleting) return;
        throw new AppError('not_found', CALENDAR_EVENT_GONE);
      }
      if (again.etag !== target.etag || !opts.instanceWrite) throw this.conflict(op, 'google');
      this.deps.logger.warn({ op, etagRejected: true, instance: true }, 'calendar etagRejected: sending once without If-Match');
      await send(null);
    }
  }

  /**
   * A patch (research notes §5). An instance Google won't patch (405, or a 400 or 404 on an
   * instance just read; UNVERIFIED, research notes §6) is sent whole with PUT instead: the raw JSON
   * Google sends for it now, untouched, with the patch merged in the way Google would
   * (`mergePatch`), so nested fields the dashboard doesn't read (shared properties, the organizer,
   * guests, reminders, conference data) go back as they were (R3-C1).
   */
  private async writePatch(op: string, read: EventRead, body: EventBody, deadline: number): Promise<void> {
    const target = read.event;
    // Cancelling an instance is how one is deleted: already cancelled is done (C-M1).
    const deleting = op === 'delete';
    try {
      await this.sendChecked(op, target, deadline, { instanceWrite: target.recurringEventId !== undefined, deleting }, (etag) => this.deps.provider.patchEvent(target.id, body, etag, { deadline }));
      return;
    } catch (err) {
      const unsupported = target.recurringEventId !== undefined && err instanceof GoogleApiError
        && ((err.kind === 'rejected' && (err.status === 405 || err.status === 400)) || err.kind === 'not_found');
      if (!unsupported) throw this.eventError(err, op);
      this.deps.logger.warn({ op, instancePatchUnsupported: true, status: err.status, reason: err.reason }, 'calendar instancePatchUnsupported: sending the whole instance with PUT');
    }
    const fresh = await this.get(target.id, deadline);
    if (fresh.event.status === 'cancelled') {
      if (deleting) return;
      throw new AppError('not_found', CALENDAR_EVENT_GONE);
    }
    if (fresh.event.etag !== target.etag) throw this.conflict(op, 'google');
    try {
      await this.sendChecked(op, fresh.event, deadline, { instanceWrite: fresh.event.recurringEventId !== undefined, deleting }, (etag) => this.deps.provider.updateEvent(fresh.event.id, mergePatch(fresh.raw, body), etag, { deadline }));
    } catch (err) {
      throw this.eventError(err, op);
    }
  }

  /** A delete. Already deleted counts as done. */
  private async writeDelete(op: string, target: GoogleEvent, deadline: number): Promise<void> {
    try {
      await this.sendChecked(op, target, deadline, { instanceWrite: false, deleting: true }, (etag) => this.deps.provider.deleteEvent(target.id, etag, { deadline }));
    } catch (err) {
      if (err instanceof GoogleApiError && (err.kind === 'gone' || err.kind === 'not_found')) return;
      if (err instanceof AppError && err.code === 'not_found') return;
      throw this.eventError(err, op);
    }
  }

  /**
   * An edit (spec §9.4). Only what changed is checked and sent (M-6): the times' order when the
   * times changed, the repeat's end when the repeat changed.
   *
   * `scope: 'this'` changes this event, or this one instance of a series. A series itself (opened
   * by its own id) is changed only with "All events".
   *
   * `scope: 'all'` changes the series through one of its instances (C1 of the plan review): text
   * the person changed goes to the series. A move becomes a move of the whole series by however
   * far this instance moved, worked out in the zone the series repeats in (`moveSeries`), and only
   * when nothing blocks it (`moveBlocked`); otherwise it's refused with "Move this series in Google
   * Calendar". When the series' first day moves, or a timed series that ends on a date starts at
   * another time, its repeat is written again from the parsed rule: a weekly rule's weekdays move
   * with it when the person left them as they were, a BYMONTHDAY or BYMONTH Google wrote is dropped
   * so the rule follows the new start, and an end date the person left as it was moves by the same
   * days, so the last occurrence stays the last (R3-I3). A timed UNTIL is written as the end of
   * that day in the series' zone (R1-I1). Nothing changed means nothing is sent.
   */
  async update(userId: number, eventId: string, u: UpdateEventInput): Promise<void> {
    const deadline = this.deadline();
    const timeZone = this.timeZone();
    const read = await this.get(eventId, deadline);
    const current = read.event;
    // Deleted in Google meanwhile (read back cancelled, C-M1): gone, not changed.
    if (current.status === 'cancelled') throw new AppError('not_found', CALENDAR_EVENT_GONE);
    if (current.etag !== u.etag) throw this.conflict('update', 'precheck');
    const cur = this.stored(current, timeZone);
    if (cur.readOnly) throw new AppError('validation', CALENDAR_WRITE_MESSAGES.readOnly);
    const input = u.event;
    const invalid = (message: string | null) => {
      if (message) throw new AppError('validation', message);
    };
    const moving = timesChanged(cur, input);
    if (moving) invalid(timesOutOfOrder(input));
    let body: EventBody = changedText(cur, input);
    let target: EventRead;

    if (u.scope === 'this') {
      if (current.recurrence?.length) invalid(CALENDAR_WRITE_MESSAGES.chooseAll);
      if (moving) Object.assign(body, eventTimes(input, timeZone, current.start?.timeZone ?? timeZone));
      if (input.repeat !== undefined && input.repeat !== null) {
        if (current.recurringEventId) invalid(CALENDAR_WRITE_MESSAGES.repeatIsSeries);
        invalid(repeatEndsTooEarly(input.repeat, input.startDate));
        // A series made here repeats in the family's zone, like one created here (research notes §4).
        body.recurrence = [serializeRule(input.repeat, { allDay: input.allDay, startDate: input.startDate, startTime: input.allDay ? null : input.startTime, timeZone })];
        Object.assign(body, eventTimes(input, timeZone, timeZone));
      }
      target = read;
    } else {
      const seriesId = this.seriesIdOf(current);
      if (seriesId === null) throw new AppError('validation', CALENDAR_WRITE_MESSAGES.notRepeating);
      const masterRead = seriesId === current.id ? read : await this.get(seriesId, deadline);
      const master = masterRead.event;
      if (u.seriesEtag === null || master.etag !== u.seriesEtag) throw this.conflict('update', 'precheck');
      const series = this.stored(master, timeZone);
      if (series.readOnly) invalid(CALENDAR_WRITE_MESSAGES.readOnly);
      // Compared with the series, not this instance, which may have been changed on its own (M1).
      if (input.allDay !== series.allDay) invalid(CALENDAR_WRITE_MESSAGES.allDaySeries);
      const zone = seriesZone(master, this.calendarZone(), timeZone);
      const first = seriesStart(master, zone);
      const parsed = parseRecurrence(master.recurrence, { allDay: first.allDay, startDate: first.date, startTime: first.time, timeZone: zone });
      const repeatChanged = input.repeat !== undefined && !(parsed.kind === 'rule' && sameRule(parsed.rule, input.repeat));
      if (repeatChanged) {
        if (parsed.kind !== 'rule' || !parsed.editable) invalid(CALENDAR_WRITE_MESSAGES.repeatReadOnly);
        if (input.repeat === null) invalid(CALENDAR_WRITE_MESSAGES.stopSeries);
      }
      const move = moving ? moveSeries(master, cur, input, timeZone, zone) : null;
      // Not silently moved an hour later on a night the clocks go forward (R3-M).
      if (move?.startMissing) invalid(CALENDAR_WRITE_MESSAGES.startMissing(move.startDate, move.startTime!));
      // A monthly or yearly series repeats on its first day's date. Moved by days, every
      // occurrence has to land on the same day of the month (and month) as this one does, or the
      // series wouldn't follow the person's move: the 30th moved to the 1st puts the first day on
      // the 31st (R3-I2). And a day that isn't in every month (or, yearly, every year) repeats less
      // often than one that is, so a move to or from one adds or drops occurrences: monthly, both
      // the old and the new first day are the 28th or earlier; yearly, neither is February 29 (C-C1).
      const freq = repeatChanged ? input.repeat?.freq : parsed.kind === 'rule' ? parsed.rule.freq : undefined;
      if (move && move.days !== 0 && (freq === 'monthly' || freq === 'yearly')) {
        const to = first.allDay ? input.startDate : utcToWall(wallToUtcMs(input.startDate, input.startTime!, timeZone), zone).date;
        const [, fromMonth, fromDay] = move.startDate.split('-');
        const [, toMonth, toDay] = to.split('-');
        const shortMonths = freq === 'monthly' && (Number(first.date.slice(8, 10)) > 28 || Number(move.startDate.slice(8, 10)) > 28);
        const leapDay = freq === 'yearly' && (first.date.slice(5) === '02-29' || move.startDate.slice(5) === '02-29');
        if (fromDay !== toDay || (freq === 'yearly' && fromMonth !== toMonth) || shortMonths || leapDay) {
          this.deps.logger.info({ freq, days: move.days }, 'calendar series move refused: its occurrences would land on other dates');
          invalid(CALENDAR_WRITE_MESSAGES.moveInGoogle);
        }
      }
      if (moving || repeatChanged) {
        const blocked = await this.moveBlocked(masterRead, parsed, zone, deadline);
        if (blocked?.checkFailed) throw blocked.checkFailed;
        if (blocked) invalid(moving ? CALENDAR_WRITE_MESSAGES.moveInGoogle : CALENDAR_WRITE_MESSAGES.repeatReadOnly);
      }
      if (move) body = { ...body, start: move.start, end: move.end };
      // A timed series whose start time changes gets its UNTIL written again, as the end of its
      // last day, even when the days don't move (R1-I1, R3-I3).
      const untilMoves = move !== null && move.minutes !== 0 && parsed.kind === 'rule' && parsed.rule.end.type === 'on';
      if (parsed.kind === 'rule' && (repeatChanged || (move && move.days !== 0) || untilMoves)) {
        let rule = repeatChanged ? input.repeat! : parsed.rule;
        if (move && sameWeekdays(rule, parsed.rule)) rule = shiftWeekdays(rule, move.days);
        // An end the person left as it was moves with the series, so its last occurrence stays the
        // last (R3-I3): `parsed.rule.end` is that occurrence's date, which moves by the same days.
        if (move && rule.end.type === 'on' && parsed.rule.end.type === 'on' && rule.end.date === parsed.rule.end.date) {
          rule = { ...rule, end: { type: 'on', date: addDays(rule.end.date, move.days) } };
        }
        let startDate = move?.startDate ?? first.date;
        let startTime = move?.startTime ?? first.time;
        // New weekdays that leave out the series' first day would leave it as an occurrence on
        // its own: the first day moves to the first of them on or after it (R3-M).
        if (repeatChanged && rule.freq === 'weekly' && !(parsed.rule.freq === 'weekly' && sameWeekdays(rule, parsed.rule))) {
          let ahead = 0;
          while (ahead < 7 && !rule.weekdays.includes(WEEKDAYS[(weekdayOf(startDate) + ahead) % 7]!)) ahead++;
          if (ahead > 0) {
            const aligned = shiftSeriesDays(move?.start ?? master.start!, move?.end ?? master.end!, zone, ahead);
            if (aligned.startMissing) invalid(CALENDAR_WRITE_MESSAGES.startMissing(aligned.startDate, aligned.startTime!));
            body = { ...body, start: aligned.start, end: aligned.end };
            startDate = aligned.startDate;
            startTime = aligned.startTime;
            this.deps.logger.info({ days: ahead }, "calendar series' first day moved to its new weekdays");
          }
        }
        // Against the series' own first day (M-7), not the instance the form shows.
        invalid(repeatEndsTooEarly(rule, startDate));
        body.recurrence = [serializeRule(rule, { allDay: first.allDay, startDate, startTime, timeZone: zone }, untilValue(master.recurrence))];
      }
      target = masterRead;
    }
    if (Object.keys(body).length === 0) return;
    try {
      await this.writePatch('update', target, { ...body, extendedProperties: { private: { [UPDATED_BY]: attributionValue(this.installId(), userId) } } }, deadline);
    } finally {
      // Sent, so it may have landed even if the answer says otherwise (R3-M).
      this.invalidate();
    }
    this.deps.logger.info({ userId, scope: u.scope, fields: Object.keys(body) }, 'calendar event updated');
  }

  /**
   * A delete (spec §9.4). One event is deleted; one instance of a series is patched to
   * `cancelled` (Google's guide cancels instances with PUT; PATCH and DELETE on an instance are
   * UNVERIFIED, research notes §6, and `writePatch` falls back to PUT); all events deletes the
   * series, checked against the series' own read-only state (M4). An event that's already gone, or
   * an instance that's already cancelled (M8), counts as deleted.
   */
  async delete(userId: number, eventId: string, q: { scope: EditScope; etag: string; seriesEtag?: string }): Promise<void> {
    const deadline = this.deadline();
    const timeZone = this.timeZone();
    const done = () => {
      this.invalidate();
      this.deps.logger.info({ userId, scope: q.scope }, 'calendar event deleted');
    };
    // A delete that was sent may have landed whatever the answer (R3-M).
    const sent = async (write: () => Promise<void>) => {
      try {
        await write();
      } catch (err) {
        this.invalidate();
        throw err;
      }
    };
    let currentRead: EventRead;
    try {
      currentRead = await this.get(eventId, deadline);
    } catch (err) {
      if (err instanceof AppError && err.code === 'not_found') return done();
      throw err;
    }
    const current = currentRead.event;
    if (q.scope === 'this' && current.status === 'cancelled') return done();
    if (current.etag !== q.etag) throw this.conflict('delete', 'precheck');
    if (q.scope === 'this') {
      if (this.stored(current, timeZone).readOnly) throw new AppError('validation', CALENDAR_WRITE_MESSAGES.readOnly);
      if (current.recurrence?.length) throw new AppError('validation', CALENDAR_WRITE_MESSAGES.chooseAll);
      if (current.recurringEventId) await sent(() => this.writePatch('delete', currentRead, { status: 'cancelled' }, deadline));
      else await sent(() => this.writeDelete('delete', current, deadline));
    } else {
      const seriesId = this.seriesIdOf(current);
      if (seriesId === null) throw new AppError('validation', CALENDAR_WRITE_MESSAGES.notRepeating);
      const master = seriesId === current.id ? current : (await this.get(seriesId, deadline)).event;
      if (master.status === 'cancelled') return done();
      if (q.seriesEtag === undefined || master.etag !== q.seriesEtag) throw this.conflict('delete', 'precheck');
      if (this.stored(master, timeZone).readOnly) throw new AppError('validation', CALENDAR_WRITE_MESSAGES.readOnly);
      await sent(() => this.writeDelete('delete', master, deadline));
    }
    done();
  }
}

function sameWeekdays(a: RepeatRule, b: RepeatRule): boolean {
  return a.freq === 'weekly' && b.freq === 'weekly' && [...a.weekdays].sort().join() === [...b.weekdays].sort().join();
}
