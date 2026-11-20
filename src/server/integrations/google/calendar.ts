import { createHash } from 'node:crypto';
import { and, count, eq, isNotNull, isNull, lte, or } from 'drizzle-orm';
import type { Logger } from 'pino';
import { z } from 'zod';
import { CALENDAR_API_DISABLED_MESSAGE, CALENDAR_RECONNECT_MESSAGE, type PendingCalendar } from '../../../shared/calendar.js';
import type { ConnectionStatus } from '../../../shared/integrations.js';
import type { GoogleEndpoints } from '../../config.js';
import type { Clock } from '../../core/clock.js';
import { decryptSecret, encryptSecret, familyRevocationAad, pendingLinkAad, type Keyring } from '../../core/crypto.js';
import { AppError, loggableError } from '../../core/errors.js';
import { KeyedLock, LockWaitTimeout } from '../../core/lock.js';
import type { Db } from '../../db/index.js';
import { calendarCache, calendarLinkPending, connections, pendingRevocations, type ConnectionRow, type PendingRevocationRow } from '../../db/schema.js';
import { isUniqueViolation } from '../../panels/todo/internalBackend.js';
import {
  decryptCredentials, encryptCredentials, getFamilyConnection, insertFamilyConnection, recordConnectionFailure, recordConnectionSuccess,
} from '../connections.js';
import { getCalendarLinkStartedAt, setCalendarLinkStartedAt } from '../../settings.js';
import { keyMismatchWarning } from '../keyCheck.js';
import { GoogleApiError, GoogleCalendarClient, type CalendarClientOptions, type CallOptions, type EventBody, type EventRead, type GoogleEvent } from './calendarClient.js';
import { GoogleCalendarOAuth, GoogleOAuthError, GoogleOAuthUnavailable, REQUIRED_CALENDAR_SCOPES, type FetchFn, type LinkTokens } from './oauth.js';

/** Refresh an access token this long before it expires (they last about an hour). */
export const REFRESH_AHEAD_MS = 5 * 60_000;
/** How long a link waits for its admin to pick a calendar. */
export const PENDING_LINK_TTL_MS = 15 * 60_000;
/**
 * A disconnected link's refresh token that Google didn't confirm revoking is tried again hourly,
 * this many times (about half a day). Then retrying stops: the token is wiped, and the row stays
 * for a System warning naming the account whose access to remove by hand, until an admin
 * dismisses it (R2-I3). Bounded, like the chore retry cap.
 */
export const REVOCATION_ATTEMPTS = 12;
/**
 * Revocation retries wait this long after any link starts (R2-M5): until the consent page comes
 * back, nothing says which Google account is being linked, and revoking a token of that account
 * would end the new grant too (revocation is per account and project, research notes §1).
 */
export const LINK_START_QUIET_MS = 15 * 60_000;
/** Google's answers to a revocation that mean the token is already gone (RFC 7009 §2.2, research notes §1). */
const ALREADY_REVOKED = new Set(['invalid_token', 'invalid_grant']);

/** What people see. Never a token, an id, or Google's raw error text (spec §14). */
export const CALENDAR_MESSAGES = {
  notConnected: "Google Calendar isn't connected.",
  reconnect: CALENDAR_RECONNECT_MESSAGE,
  unreachable: "Couldn't reach Google Calendar. Try again in a few minutes.",
  busy: 'Google Calendar is busy right now. Try again in a minute.',
  calendarUnavailable: "Google Calendar won't show the family calendar right now. An admin can reconnect it or pick another calendar on the Admin page.",
  keyMismatch: "Google Calendar is unavailable: the server's TOKEN_ENCRYPTION_KEY doesn't match the stored credentials. An admin needs to fix the key.",
  linkExpired: 'That connection attempt expired. Connect Google Calendar again.',
  pickExpired: 'That calendar pick expired. Start again.',
  pickListed: 'Pick one of the calendars listed.',
  reconnectFirst: 'Reconnect Google Calendar first.',
  linkChanged: 'Google Calendar was reconnected or changed while this was happening. Try again.',
  apiDisabled: CALENDAR_API_DISABLED_MESSAGE,
} as const;

/** What `credentials_enc` holds once decrypted, on the connection and on a pending link. */
const CredentialsSchema = z.object({
  refreshToken: z.string().min(1),
  accessToken: z.string().min(1).nullable(),
  /** Epoch ms, or null when Google sent no expiry. */
  expiresAt: z.number().nullable(),
});
type Credentials = z.infer<typeof CredentialsSchema>;

/** The Google Calendar connection's `meta` (see the `connections` table). */
const MetaSchema = z.object({
  account: z.string().nullable(),
  accountId: z.string().nullable(),
  calendarId: z.string().min(1),
  calendarName: z.string(),
  calendarTimeZone: z.string().nullable(),
});
export type CalendarMeta = z.infer<typeof MetaSchema>;

const RevocationSchema = z.object({ refreshToken: z.string().min(1) });

/** What a "Change calendar" pick remembers of the token it copied (see `calendar_link_pending`). */
function fingerprint(refreshToken: string): string {
  return createHash('sha256').update(refreshToken).digest('base64url');
}

/** The linked calendar, as the panel needs it. */
export type CalendarState =
  | { connected: false; keyMismatch: boolean }
  | {
      connected: true; keyMismatch: boolean; connectionId: number; status: ConnectionStatus; meta: CalendarMeta; lastSuccessAt: Date | null; lastError: string | null; ownerUserId: number;
      /** The last call failed because the Calendar API isn't turned on, and none has worked since (C-M2). */
      apiDisabled: boolean;
    };

export interface GoogleCalendarDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  google: { clientId: string; clientSecret: string; endpoints: GoogleEndpoints };
  keyring: Keyring;
  fetch: FetchFn;
  /** TOKEN_ENCRYPTION_KEY failed the key check: nothing is fetched, linked, or written (spec §14). */
  keyMismatch?: boolean;
  /** Todoist is set up too, so the key mismatch warning names it (R4-M7). */
  todoistConfigured?: boolean;
  /** Plaid is set up too, so the key mismatch warning names the banks (phase 6b). */
  plaidConfigured?: boolean;
  /** For tests: the Calendar client's waits between retries. */
  clientOptions?: CalendarClientOptions;
}

/** One provider call's view of the connection. */
interface Session {
  connection: ConnectionRow;
  meta: CalendarMeta;
  creds: Credentials;
}

/**
 * The family's Google Calendar link (spec §8, §9.1): the one family connection, its tokens and
 * status, linking, changing the calendar, disconnecting, and the revocations a disconnect leaves.
 * It's also the panel's CalendarProvider (src/server/panels/calendar/provider.ts): the event calls
 * go through `authed`, which refreshes the access token when it's due and once after a 401.
 *
 * One lock, `LOCK`, covers everything that reads and then writes the connection's credentials:
 * token refreshes (single-flight, so two requests don't both refresh), linking, disconnecting,
 * and revocation retries. It's keyed by the connection's kind rather than its row id because the
 * family has exactly one, and linking and revocation retries run when there's no row yet, or the
 * row is about to be replaced. API calls themselves run outside the lock; only a refresh holds it
 * across the network. Public methods take the lock; private helpers assume it (the lock rejects
 * re-entry).
 *
 * Revoking ends every grant the Google account gave this project, sign-in included (research
 * notes §1), so only `disconnect` revokes. A relink or reconnect, by any admin, simply replaces the
 * stored token.
 *
 * Status follows spec §8: `invalid_grant`, a 401 after a fresh token, or a missing scope sets
 * `needs_reconnect`; 3 other failures in a row set `error`; any success sets `ok`. A failure is
 * recorded only if the connection still holds the credentials the request used, so a request that
 * started before a relink can't mark the new link as broken.
 *
 * Tokens and event contents are never logged: log lines carry ids, counts, kinds, and Google's
 * error reasons.
 */
export class GoogleCalendar {
  static readonly LOCK = 'google_calendar';
  readonly oauth: GoogleCalendarOAuth;
  readonly client: GoogleCalendarClient;
  private readonly lock = new KeyedLock<string>();
  private keyMismatchNow: boolean;

  constructor(private readonly deps: GoogleCalendarDeps) {
    this.oauth = new GoogleCalendarOAuth(deps.google, deps.fetch);
    this.client = new GoogleCalendarClient(deps.google.endpoints.calendarApi, deps.fetch, deps.clientOptions);
    this.keyMismatchNow = deps.keyMismatch === true;
  }

  get keyMismatch(): boolean {
    return this.keyMismatchNow;
  }

  connection(): ConnectionRow | undefined {
    return getFamilyConnection(this.deps.db, 'google_calendar');
  }

  /** The linked calendar and its status. Never throws; doesn't decrypt anything. */
  state(): CalendarState {
    const conn = this.connection();
    const meta = conn ? MetaSchema.safeParse(conn.meta) : null;
    if (!conn || !meta?.success) return { connected: false, keyMismatch: this.keyMismatchNow };
    return {
      connected: true, keyMismatch: this.keyMismatchNow, connectionId: conn.id, status: conn.status, meta: meta.data,
      lastSuccessAt: conn.lastSuccessAt, lastError: conn.lastError, ownerUserId: conn.ownerUserId,
      // Any success since resets the failure count.
      apiDisabled: conn.lastError === CALENDAR_MESSAGES.apiDisabled && conn.consecutiveFailures > 0,
    };
  }

  // ---- Linking (spec §9.1).

  /**
   * `POST /connect/google-calendar/start` was called: revocation retries hold off for a while
   * (R2-M5). Saved in settings, so a restart in the middle of a link doesn't forget it (C-M5).
   */
  noteLinkStarted(): void {
    setCalendarLinkStartedAt(this.deps.db, this.deps.clock.now().getTime());
  }

  /**
   * The OAuth callback's work, under the lock: exchanges the code, then `beginLink`. Under the lock
   * so a revocation retry can't run between the moment Google issues the new tokens and the moment
   * the pick that holds them is saved (it would revoke them, when it's the same Google account).
   * `opts.deadline` (epoch ms, the real clock; the callback's, R4-M2) bounds the wait for the lock,
   * the code exchange, and listing the calendars. Past it, the call throws.
   */
  completeLink(
    userId: number,
    sessionHash: string,
    p: Parameters<GoogleCalendarOAuth['exchange']>[0],
    opts: { deadline?: number } = {},
  ): Promise<'ok' | 'scopes' | 'no_refresh' | 'no_calendars'> {
    if (this.keyMismatchNow) return Promise.reject(new AppError('integration_unavailable', CALENDAR_MESSAGES.keyMismatch));
    return this.lock.run(
      GoogleCalendar.LOCK,
      async () => this.beginLinkLocked(userId, sessionHash, await this.oauth.exchange(p, this.deps.clock.now(), opts), opts.deadline),
      opts,
    );
  }

  /**
   * After the code exchange: checks what Google granted, lists the account's writable calendars,
   * and saves the tokens, encrypted, for the admin to pick a calendar (`choose`). The working
   * connection, if there is one, isn't touched until then.
   * - `scopes`: granular consent left out a calendar scope (research notes §1). Google's `scope`
   *   field lists what was granted; if it's missing, RFC 6749 §5.1 says it was what was asked.
   * - `no_refresh`: no refresh token, so the link couldn't outlive the hour.
   * - `no_calendars`: the account can't make changes to any calendar.
   * Nothing is revoked in any case: that would end the account's sign-in grant too.
   */
  beginLink(userId: number, sessionHash: string, tokens: LinkTokens): Promise<'ok' | 'scopes' | 'no_refresh' | 'no_calendars'> {
    if (this.keyMismatchNow) return Promise.reject(new AppError('integration_unavailable', CALENDAR_MESSAGES.keyMismatch));
    return this.lock.run(GoogleCalendar.LOCK, () => this.beginLinkLocked(userId, sessionHash, tokens));
  }

  private async beginLinkLocked(userId: number, sessionHash: string, tokens: LinkTokens, deadline?: number): Promise<'ok' | 'scopes' | 'no_refresh' | 'no_calendars'> {
    const scopeField = tokens.grantedScopes === null ? 'absent' : 'present';
    if (tokens.grantedScopes !== null && !REQUIRED_CALENDAR_SCOPES.every((s) => tokens.grantedScopes!.includes(s))) {
      this.deps.logger.warn({ userId, reason: 'scopes', scopeField }, 'google calendar link refused');
      return 'scopes';
    }
    if (!tokens.refreshToken) {
      this.deps.logger.warn({ userId, reason: 'no_refresh' }, 'google calendar link refused');
      return 'no_refresh';
    }
    const { calendars, skipped } = await this.client.listCalendars(tokens.accessToken, deadline === undefined ? {} : { deadline });
    if (calendars.length === 0) {
      this.deps.logger.warn({ userId, reason: 'no_calendars', skipped }, 'google calendar link refused');
      return 'no_calendars';
    }
    const creds: Credentials = { refreshToken: tokens.refreshToken, accessToken: tokens.accessToken, expiresAt: tokens.expiresAt?.getTime() ?? null };
    this.savePending(userId, sessionHash, creds, { id: tokens.account.id, email: tokens.account.email }, calendars.map(toPending));
    this.deps.logger.info({ userId, calendars: calendars.length, skipped, scopeField }, 'google calendar link waiting for a calendar');
    return 'ok';
  }

  /**
   * "Change calendar": lists the calendars again with the saved token and offers them as a new
   * pick, without the consent screen. The saved tokens are copied into the pending link, with the
   * connection they came from and a fingerprint of the refresh token, so `choose` can tell if that
   * link was disconnected or replaced meanwhile. (Not a fingerprint of the whole ciphertext: an
   * access-token refresh changes that every hour, and shouldn't spoil the pick.)
   */
  async beginChange(userId: number, sessionHash: string): Promise<'ok' | 'no_calendars'> {
    const { result: calendars, session } = await this.authed((token) => this.client.listCalendars(token).then((r) => r.calendars));
    if (calendars.length === 0) return 'no_calendars';
    this.savePending(userId, sessionHash, session.creds, { id: session.meta.accountId, email: session.meta.account }, calendars.map(toPending), {
      connectionId: session.connection.id, fingerprint: fingerprint(session.creds.refreshToken),
    });
    return 'ok';
  }

  private savePending(
    userId: number,
    sessionHash: string,
    creds: Credentials,
    account: { id: string | null; email: string | null },
    calendars: PendingCalendar[],
    source: { connectionId: number; fingerprint: string } | null = null,
  ): void {
    const now = this.deps.clock.now();
    const values = {
      sessionHash,
      credentialsEnc: encryptSecret(this.deps.keyring, JSON.stringify(creds), pendingLinkAad(userId)),
      accountId: account.id,
      account: account.email,
      calendars,
      sourceConnectionId: source?.connectionId ?? null,
      sourceFingerprint: source?.fingerprint ?? null,
      createdAt: now,
      expiresAt: new Date(now.getTime() + PENDING_LINK_TTL_MS),
    };
    this.deps.db.insert(calendarLinkPending).values({ userId, ...values }).onConflictDoUpdate({ target: calendarLinkPending.userId, set: values }).run();
  }

  /** The admin's own pick, if it was started in this session and hasn't expired. */
  pending(userId: number, sessionHash: string): { account: string | null; calendars: PendingCalendar[]; expiresAt: string } | null {
    const row = this.pendingRow(userId, sessionHash);
    return row ? { account: row.account, calendars: row.calendars, expiresAt: row.expiresAt.toISOString() } : null;
  }

  private pendingRow(userId: number, sessionHash: string) {
    const row = this.deps.db.select().from(calendarLinkPending).where(eq(calendarLinkPending.userId, userId)).get();
    if (!row || row.sessionHash !== sessionHash || row.expiresAt.getTime() <= this.deps.clock.now().getTime()) return null;
    return row;
  }

  /** Cancel: deletes the admin's pick only if it was started in this session (R4-M3). */
  cancelPending(userId: number, sessionHash: string): void {
    this.deps.db.delete(calendarLinkPending).where(and(eq(calendarLinkPending.userId, userId), eq(calendarLinkPending.sessionHash, sessionHash))).run();
  }

  /** Deletes picks nobody finished. The tokens in them are dropped, not revoked. */
  prunePending(): number {
    return this.deps.db.delete(calendarLinkPending).where(lte(calendarLinkPending.expiresAt, this.deps.clock.now())).run().changes;
  }

  /**
   * The admin picks the calendar: the pending link becomes the family's connection. Any admin can
   * reconnect (spec §8): an existing connection is updated in place, keeping its row id (so its
   * credentials, bound to the row, still decrypt) and taking the new admin as `owner_user_id`.
   * - A replaced token of the same Google account isn't revoked: that would end the new link too.
   *   A replaced token of a different Google account is queued for revocation (`pending_revocations`),
   *   and the Reconnect copy says so.
   * - A revocation still waiting for the account being linked is dropped: it would end this link.
   * - A "Change calendar" pick whose source link was disconnected or replaced since is refused.
   * The cache is cleared, since the calendar may differ.
   */
  async choose(userId: number, sessionHash: string, calendarId: string): Promise<void> {
    if (this.keyMismatchNow) throw new AppError('integration_unavailable', CALENDAR_MESSAGES.keyMismatch);
    await this.lock.run(GoogleCalendar.LOCK, async () => {
      const pending = this.pendingRow(userId, sessionHash);
      if (!pending) throw new AppError('not_found', CALENDAR_MESSAGES.linkExpired);
      const picked = pending.calendars.find((c) => c.id === calendarId);
      if (!picked) throw new AppError('validation', CALENDAR_MESSAGES.pickListed);
      const existing = this.connection();
      const existingCreds = existing ? this.readCredentials(existing) : null;
      if (pending.sourceConnectionId !== null && (existing?.id !== pending.sourceConnectionId || !existingCreds || fingerprint(existingCreds.refreshToken) !== pending.sourceFingerprint)) {
        this.cancelPending(userId, sessionHash);
        throw new AppError('not_found', CALENDAR_MESSAGES.pickExpired);
      }
      // A Change calendar pick copies the saved token: if Google stopped taking it, so has the copy (R2-M4).
      if (pending.sourceConnectionId !== null && existing?.status === 'needs_reconnect') {
        throw new AppError('conflict', CALENDAR_MESSAGES.reconnectFirst);
      }
      let creds: Credentials;
      try {
        creds = CredentialsSchema.parse(JSON.parse(decryptSecret(this.deps.keyring, pending.credentialsEnc, pendingLinkAad(userId))));
      } catch (err) {
        this.deps.logger.error({ userId, error: err instanceof Error ? err.name : 'unknown' }, "a pending google calendar link couldn't be decrypted");
        this.cancelPending(userId, sessionHash);
        throw new AppError('not_found', CALENDAR_MESSAGES.linkExpired);
      }
      const meta: CalendarMeta = { account: pending.account, accountId: pending.accountId, calendarId: picked.id, calendarName: picked.name, calendarTimeZone: picked.timeZone };
      const now = this.deps.clock.now();
      const previous = existing ? MetaSchema.safeParse(existing.meta) : null;
      const previousAccount = previous?.success ? previous.data.accountId : null;
      const otherAccount = existingCreds !== null && previousAccount !== null && pending.accountId !== null && previousAccount !== pending.accountId;
      let dropped = 0;
      try {
        this.deps.db.transaction((tx) => {
          if (existing) {
            tx.update(connections)
              .set({
                credentialsEnc: encryptCredentials(this.deps.keyring, existing, creds), meta, ownerUserId: userId,
                status: 'ok', consecutiveFailures: 0, lastError: null, lastErrorAt: null, lastSuccessAt: now, updatedAt: now,
              })
              .where(eq(connections.id, existing.id))
              .run();
          } else {
            insertFamilyConnection(tx, this.deps.keyring, { kind: 'google_calendar', ownerUserId: userId, meta, now }, creds);
          }
          tx.delete(calendarLinkPending).where(eq(calendarLinkPending.userId, userId)).run();
          if (otherAccount) this.queueRevocation(tx, userId, { id: previousAccount, email: previous?.success ? previous.data.account : null }, existingCreds!.refreshToken, now);
          if (pending.accountId !== null) {
            dropped = tx.delete(pendingRevocations)
              .where(and(eq(pendingRevocations.kind, 'google_calendar'), eq(pendingRevocations.accountId, pending.accountId)))
              .run().changes;
          }
          tx.delete(calendarCache).run();
        });
      } catch (err) {
        if (isUniqueViolation(err)) throw new AppError('conflict', 'Another admin just connected Google Calendar. Reload the page to see it.');
        throw err;
      }
      this.deps.logger.info(
        { userId, reconnected: existing !== undefined, sameAccount: existing ? previousAccount === meta.accountId : null, queuedOldAccount: otherAccount, droppedRevocations: dropped },
        'google calendar linked',
      );
    });
  }

  /** The connection's credentials, or null when they can't be read (logged, never thrown). */
  private readCredentials(conn: ConnectionRow): Credentials | null {
    try {
      return CredentialsSchema.parse(decryptCredentials(this.deps.keyring, conn));
    } catch {
      return null;
    }
  }

  /** A token to revoke later (`retryRevocations`), bound to its `pending_revocations` row, with the account it belongs to. */
  private queueRevocation(
    tx: Parameters<Parameters<Db['transaction']>[0]>[0],
    ownerUserId: number,
    account: { id: string | null; email: string | null },
    refreshToken: string,
    now: Date,
  ): void {
    const row = tx.insert(pendingRevocations)
      .values({ kind: 'google_calendar', ownerUserId, accountId: account.id, accountEmail: account.email, credentialsEnc: '', createdAt: now })
      .returning({ id: pendingRevocations.id })
      .get();
    tx.update(pendingRevocations)
      .set({ credentialsEnc: encryptSecret(this.deps.keyring, JSON.stringify({ refreshToken }), familyRevocationAad('google_calendar', row.id)) })
      .where(eq(pendingRevocations.id, row.id))
      .run();
  }

  /**
   * Disconnects (spec §9.1, §9.7), under the lock: revokes the refresh token first, best effort,
   * then deletes the connection and the cached events. Revoking also ends the Google account's
   * consent for sign-in, so the admin is told before confirming; dashboard sessions are the
   * server's own and stay signed in. A token Google didn't confirm revoking is kept, encrypted, in
   * `pending_revocations` (in the same transaction) for `retryRevocations`. Every calendar pick in
   * progress is deleted too, so a "Change calendar" pick (which holds a copy of this token) can't
   * bring the link back afterwards. Refused with a mismatched key: the token couldn't be read to
   * revoke it, and restoring the key brings the link back.
   */
  disconnect(userId: number): Promise<{ wasLinked: boolean; revoked: boolean }> {
    if (this.keyMismatchNow) return Promise.reject(new AppError('integration_unavailable', CALENDAR_MESSAGES.keyMismatch));
    return this.lock.run(GoogleCalendar.LOCK, async () => {
      const conn = this.connection();
      if (!conn) return { wasLinked: false, revoked: false };
      const meta = MetaSchema.safeParse(conn.meta);
      let creds: Credentials | null = null;
      try {
        creds = CredentialsSchema.parse(decryptCredentials(this.deps.keyring, conn));
      } catch {
        this.deps.logger.warn({ userId }, "google calendar credentials couldn't be decrypted for revocation");
      }
      const revoked = creds ? (await this.revoke(creds.refreshToken)) === null : false;
      const now = this.deps.clock.now();
      this.deps.db.transaction((tx) => {
        if (creds && !revoked) {
          this.queueRevocation(tx, userId, { id: meta.success ? meta.data.accountId : null, email: meta.success ? meta.data.account : null }, creds.refreshToken, now);
        }
        tx.delete(connections).where(eq(connections.id, conn.id)).run();
        tx.delete(calendarCache).run();
        tx.delete(calendarLinkPending).run();
      });
      this.deps.logger.info({ userId, revoked, waiting: creds !== null && !revoked }, 'google calendar disconnected');
      return { wasLinked: true, revoked };
    });
  }

  /**
   * Null when the token is revoked, or Google says it's already gone (`invalid_token`, or
   * `invalid_grant`). Otherwise a plain line saying what Google answered, for `last_error`, and the
   * caller tries again later: any other 4xx (`invalid_request`, say) is a failure, not a success
   * (R2-I1). The log has the code and the HTTP status, never the token.
   */
  private async revoke(token: string): Promise<string | null> {
    try {
      await this.oauth.revoke(token);
      return null;
    } catch (err) {
      if (err instanceof GoogleOAuthError && ALREADY_REVOKED.has(err.code)) return null;
      const status = err instanceof GoogleOAuthError || err instanceof GoogleOAuthUnavailable ? err.status : null;
      const code = err instanceof GoogleOAuthError ? err.code : err instanceof GoogleOAuthUnavailable ? err.code : null;
      const kind = err instanceof GoogleOAuthUnavailable ? err.kind : err instanceof GoogleOAuthError ? 'refused' : 'unknown';
      this.deps.logger.warn({ ...loggableError(err), kind, code, status }, 'google calendar revocation failed');
      if (err instanceof GoogleOAuthError) return `Google answered HTTP ${err.status ?? 'error'} (${err.code}).`;
      if (status !== null) return `Google answered HTTP ${status}.`;
      return "Couldn't reach Google.";
    }
  }

  /**
   * The hourly `calendar.revocations` job: tries again to revoke what a disconnect couldn't, under
   * the lock, so it can't race a link. If the family calendar is linked to the same Google account
   * again, revoking would end that link too (revocation is per account and project), so the row is
   * dropped instead. A row waits (it isn't tried and nothing is counted) while revoking might end a
   * link in progress or in place:
   * - for 15 minutes after any link starts (R2-M5), since the account isn't known yet;
   * - while an admin's pick holds new tokens for that account: the pick may become the link;
   * - for a row whose account is unknown, while any calendar link or pick exists (R2-M6).
   * After REVOCATION_ATTEMPTS failures, or at once for a token that won't decrypt (R2-M15),
   * retrying stops: the row keeps `gave_up_at` and the account, its token is wiped, and it's
   * counted in `gaveUp`. Rows given up on aren't counted in `total`.
   */
  async retryRevocations(): Promise<{ total: number; failed: number; gaveUp: number }> {
    if (this.keyMismatchNow) return { total: 0, failed: 0, gaveUp: 0 };
    const rows = this.deps.db.select().from(pendingRevocations)
      .where(and(eq(pendingRevocations.kind, 'google_calendar'), isNull(pendingRevocations.gaveUpAt)))
      .all();
    let failed = 0;
    let gaveUp = 0;
    for (const row of rows) {
      const result = await this.lock.run(GoogleCalendar.LOCK, () => this.retryRevocation(row));
      if (result === 'failed') failed++;
      if (result === 'gave_up') gaveUp++;
    }
    return { total: rows.length, failed, gaveUp };
  }

  private async retryRevocation(row: PendingRevocationRow): Promise<'done' | 'failed' | 'gave_up' | 'waiting'> {
    const linkStartedAt = getCalendarLinkStartedAt(this.deps.db);
    if (linkStartedAt !== null && this.deps.clock.now().getTime() - linkStartedAt < LINK_START_QUIET_MS) {
      this.deps.logger.info({ attempts: row.attempts }, 'a google calendar revocation waits: a link was started recently');
      return 'waiting';
    }
    if (row.accountId === null && (this.connection() !== undefined || this.deps.db.select().from(calendarLinkPending).get())) {
      this.deps.logger.info({ attempts: row.attempts }, 'a google calendar revocation waits: its account is unknown and a calendar link or pick exists');
      return 'waiting';
    }
    if (row.accountId !== null && this.deps.db.select().from(calendarLinkPending).where(eq(calendarLinkPending.accountId, row.accountId)).get()) {
      this.deps.logger.info({ attempts: row.attempts }, 'a google calendar revocation waits: a pick for that account is in progress');
      return 'waiting';
    }
    const linked = this.state();
    if (row.accountId !== null && linked.connected && linked.meta.accountId === row.accountId) {
      this.deps.db.delete(pendingRevocations).where(eq(pendingRevocations.id, row.id)).run();
      this.deps.logger.info({ attempts: row.attempts }, 'dropped a waiting google calendar revocation: that account is linked again');
      return 'done';
    }
    let token: string | null = null;
    try {
      token = RevocationSchema.parse(JSON.parse(decryptSecret(this.deps.keyring, row.credentialsEnc, familyRevocationAad('google_calendar', row.id)))).refreshToken;
    } catch (err) {
      this.deps.logger.error({ error: err instanceof Error ? err.name : 'unknown' }, "a google calendar token kept for revocation couldn't be decrypted");
    }
    const attempts = row.attempts + 1;
    const now = this.deps.clock.now();
    // A token that won't decrypt never will: give up at once (R2-M15).
    const failure = token === null ? "The saved token couldn't be read." : await this.revoke(token);
    if (failure === null) {
      this.deps.db.delete(pendingRevocations).where(eq(pendingRevocations.id, row.id)).run();
      this.deps.logger.info({ attempts }, 'google calendar token revoked after disconnecting');
      return 'done';
    }
    if (token === null || attempts >= REVOCATION_ATTEMPTS) {
      // The token is of no more use here: it's wiped, and the row stays for the warning (R2-I3).
      this.deps.db.update(pendingRevocations)
        .set({ attempts, lastError: failure, lastAttemptAt: now, gaveUpAt: now, credentialsEnc: '' })
        .where(eq(pendingRevocations.id, row.id))
        .run();
      this.deps.logger.error({ attempts, account: row.accountId }, 'gave up revoking a disconnected google calendar token');
      return 'gave_up';
    }
    this.deps.db.update(pendingRevocations)
      .set({ attempts, lastError: failure, lastAttemptAt: now })
      .where(eq(pendingRevocations.id, row.id))
      .run();
    return 'failed';
  }

  /**
   * Revocations of an unknown account held back by the calendar link (R2-M6): they wait until it's
   * removed, which may be never, so each is a notice of its own that an admin can dismiss (C-M5).
   */
  private heldByLink() {
    const held = and(eq(pendingRevocations.kind, 'google_calendar'), isNull(pendingRevocations.gaveUpAt), isNull(pendingRevocations.accountId));
    return this.connection() === undefined ? null : held;
  }

  /** For the System page: a key mismatch, and disconnected access still waiting to be revoked (not counting `heldByLink`). */
  warnings(): string[] {
    const key = this.keyMismatchNow ? [keyMismatchWarning({ todoist: this.deps.todoistConfigured === true, plaid: this.deps.plaidConfigured === true })] : [];
    const waiting = and(eq(pendingRevocations.kind, 'google_calendar'), isNull(pendingRevocations.gaveUpAt));
    const { n } = this.deps.db.select({ n: count() }).from(pendingRevocations)
      .where(this.connection() === undefined ? waiting : and(waiting, isNotNull(pendingRevocations.accountId)))
      .get()!;
    if (n === 0) return key;
    return [
      ...key,
      "Couldn't revoke the dashboard's Google Calendar access after it was disconnected. It's tried again every hour. " +
        "Until then, you can remove the dashboard's access in that Google account's settings.",
    ];
  }

  /** The System page's notices an admin can dismiss: what `dismissRevocation` takes. */
  private dismissible() {
    const gaveUp = and(eq(pendingRevocations.kind, 'google_calendar'), isNotNull(pendingRevocations.gaveUpAt));
    const held = this.heldByLink();
    return held ? or(gaveUp, held)! : gaveUp;
  }

  /**
   * For the System page, each a lasting notice until an admin dismisses it:
   * - revocations given up on, naming the Google account whose access to remove by hand (R2-I3);
   * - revocations of an unknown account waiting for the calendar link to be removed (C-M5).
   */
  revocationNotices(): { id: number; message: string }[] {
    const disconnected = "Couldn't revoke the dashboard's Google Calendar access after it was disconnected. ";
    return this.deps.db.select().from(pendingRevocations)
      .where(this.dismissible())
      .orderBy(pendingRevocations.id)
      .all()
      .map((r) => ({
        id: r.id,
        message: r.gaveUpAt !== null
          ? disconnected + `Remove the dashboard's access in ${r.accountEmail ? `${r.accountEmail}'s` : "that"} Google account settings.`
          : disconnected + "Waiting until the calendar link is removed, because the account isn't known. " +
            "Dismissing this forgets the old access without revoking it: you can remove it in that Google account's settings.",
      }));
  }

  /** An admin dismissed a notice from `revocationNotices`. False when there was no such notice. */
  dismissRevocation(id: number): boolean {
    return this.deps.db.delete(pendingRevocations)
      .where(and(eq(pendingRevocations.id, id), this.dismissible()))
      .run().changes === 1;
  }

  /**
   * Part of "Reset links for a new key" (spec §14), only while the key doesn't match: the saved
   * tokens can't be read, so they're deleted without being revoked, with everything else of the
   * link. Leaves the key check to the caller. Returns whether a calendar was linked.
   */
  async forgetForNewKey(): Promise<{ disconnected: boolean }> {
    if (!this.keyMismatchNow) throw new AppError('conflict', 'TOKEN_ENCRYPTION_KEY matches the stored credentials, so there is nothing to reset.');
    return this.lock.run(GoogleCalendar.LOCK, async () => {
      const disconnected = this.connection() !== undefined;
      this.deps.db.transaction((tx) => {
        tx.delete(connections).where(eq(connections.kind, 'google_calendar')).run();
        // Ones given up on hold no token, and their notice still names the account (C-M5).
        tx.delete(pendingRevocations).where(and(eq(pendingRevocations.kind, 'google_calendar'), isNull(pendingRevocations.gaveUpAt))).run();
        tx.delete(calendarLinkPending).run();
        tx.delete(calendarCache).run();
      });
      return { disconnected };
    });
  }

  /** After the reset stored a check for the new key. */
  clearKeyMismatch(): void {
    this.keyMismatchNow = false;
  }

  // ---- The CalendarProvider calls (src/server/panels/calendar/provider.ts).

  /** One window of events, and the calendar's time zone, which is kept up to date from each answer. */
  async listEvents(q: { timeMin: string; timeMax: string; timeZone: string }, opts: CallOptions = {}): Promise<{ events: GoogleEvent[]; calendarTimeZone: string | null; skipped: number }> {
    const { result, session } = await this.authed((token, calendarId) => this.client.listEvents(token, calendarId, q, opts), { calendarLevel: true, deadline: opts.deadline });
    if (result.timeZone && result.timeZone !== session.meta.calendarTimeZone) {
      // Only if the link is still the one that answered.
      this.deps.db.update(connections)
        .set({ meta: { ...session.meta, calendarTimeZone: result.timeZone } })
        .where(and(eq(connections.id, session.connection.id), eq(connections.credentialsEnc, session.connection.credentialsEnc)))
        .run();
    }
    return { events: result.events, calendarTimeZone: result.timeZone, skipped: result.skipped };
  }

  async getEvent(eventId: string, opts: CallOptions = {}): Promise<EventRead> {
    return (await this.authed((token, calendarId) => this.client.getEvent(token, calendarId, eventId, opts), { deadline: opts.deadline })).result;
  }

  /**
   * A series' instances, or null when there are more than the client pages through (not a
   * connection problem). A check the panel makes before moving a series, so its failures don't
   * count against the connection's health; a link Google stopped accepting still needs a reconnect (R3-M).
   */
  async listInstances(seriesId: string, q: { timeMin: string; timeMax: string }, opts: CallOptions = {}): Promise<EventRead[] | null> {
    return (await this.authed(async (token, calendarId) => {
      try {
        return await this.client.listInstances(token, calendarId, seriesId, q, opts);
      } catch (err) {
        if (err instanceof GoogleApiError && err.reason === 'too_many_pages') return null;
        throw err;
      }
    }, { deadline: opts.deadline, health: false })).result;
  }

  async insertEvent(body: EventBody, opts: CallOptions = {}): Promise<GoogleEvent | null> {
    return (await this.authed((token, calendarId) => this.client.insertEvent(token, calendarId, body, opts), { deadline: opts.deadline, write: true })).result;
  }

  async patchEvent(eventId: string, body: EventBody, etag: string | null, opts: CallOptions = {}): Promise<GoogleEvent | null> {
    return (await this.authed((token, calendarId) => this.client.patchEvent(token, calendarId, eventId, body, etag, opts), { deadline: opts.deadline, write: true })).result;
  }

  async updateEvent(eventId: string, body: EventBody, etag: string | null, opts: CallOptions = {}): Promise<GoogleEvent | null> {
    return (await this.authed((token, calendarId) => this.client.updateEvent(token, calendarId, eventId, body, etag, opts), { deadline: opts.deadline, write: true })).result;
  }

  async deleteEvent(eventId: string, etag: string | null, opts: CallOptions = {}): Promise<void> {
    await this.authed((token, calendarId) => this.client.deleteEvent(token, calendarId, eventId, etag, opts), { deadline: opts.deadline, write: true });
  }

  // ---- Tokens and status.

  /**
   * Runs one call with a valid access token: refreshed first when it's due, and once more after a
   * 401. A success records `ok`, unless another call set `needs_reconnect` while this one was out
   * (`open` refuses one that's already set, so a `needs_reconnect` seen now was set since): a
   * request that started earlier mustn't hide a broken link. Connection-level failures (auth, scopes, rate limits, no answer,
   * and, with `calendarLevel`, a calendar that's gone or refuses access) are recorded and become
   * `integration_unavailable`. Event-level answers (an event not found, gone, a stale etag, a
   * duplicate id, a refused change) are the caller's to handle, so they're rethrown as they are.
   */
  private async authed<T>(
    request: (token: string, calendarId: string) => Promise<T>,
    opts: { calendarLevel?: boolean; deadline?: number; health?: boolean; write?: boolean } = {},
  ): Promise<{ result: T; session: Session }> {
    const s = this.open();
    const link = { id: s.connection.id, calendarId: s.meta.calendarId };
    // A refresh re-reads the connection. If it's another row, or points at another calendar now,
    // this call was meant for a link that's gone: never carry on against the new one (R2-M13).
    const sameLink = () => {
      if (s.connection.id !== link.id || s.meta.calendarId !== link.calendarId) {
        this.deps.logger.info({}, 'google calendar link changed during a call; not sent');
        throw new AppError('conflict', CALENDAR_MESSAGES.linkChanged);
      }
    };
    let token = await this.accessToken(s, opts.deadline);
    sameLink();
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await request(token, link.calendarId);
        if (this.current(s) && this.connection()?.status !== 'needs_reconnect') recordConnectionSuccess(this.deps.db, s.connection.id, this.deps.clock.now());
        return { result, session: s };
      } catch (err) {
        if (err instanceof GoogleApiError && err.kind === 'auth' && attempt === 0) {
          token = await this.refresh(s, token, opts.deadline);
          sameLink();
          continue;
        }
        throw this.failure(s, err, opts.calendarLevel === true, opts.health !== false, opts.write === true);
      }
    }
  }

  /**
   * Loads the connection and decrypts its credentials. With the wrong key nothing is written.
   * With the right key, credentials that won't decrypt were damaged or moved, and reconnecting
   * is the fix (spec §14).
   */
  private open(): Session {
    if (this.keyMismatchNow) throw new AppError('integration_unavailable', CALENDAR_MESSAGES.keyMismatch);
    const conn = this.connection();
    if (!conn) throw new AppError('integration_unavailable', CALENDAR_MESSAGES.notConnected);
    if (conn.status === 'needs_reconnect') throw new AppError('integration_unavailable', CALENDAR_MESSAGES.reconnect);
    try {
      return { connection: conn, meta: MetaSchema.parse(conn.meta), creds: CredentialsSchema.parse(decryptCredentials(this.deps.keyring, conn)) };
    } catch (err) {
      // Only the error's name: a JSON or zod message could quote the decrypted text.
      this.deps.logger.error({ error: err instanceof Error ? err.name : 'unknown' }, "google calendar credentials couldn't be read");
      recordConnectionFailure(this.deps.db, conn, this.deps.clock.now(), "The saved Google Calendar sign-in couldn't be read. Reconnect it.", true);
      throw new AppError('integration_unavailable', CALENDAR_MESSAGES.reconnect);
    }
  }

  /** True while the connection still holds the credentials `s` was opened with (no relink, refresh, or disconnect since). */
  private current(s: Session): boolean {
    return this.connection()?.credentialsEnc === s.connection.credentialsEnc;
  }

  private async accessToken(s: Session, deadline?: number): Promise<string> {
    const { accessToken, expiresAt } = s.creds;
    if (accessToken && expiresAt !== null && expiresAt - this.deps.clock.now().getTime() > REFRESH_AHEAD_MS) return accessToken;
    return this.refresh(s, accessToken, deadline);
  }

  /**
   * Single-flight refresh, under the lock. The connection is read again first: another request may
   * have refreshed already (its token is used), or an admin may have relinked (the new link's token
   * is used). Otherwise the refresh token is traded for a new access token, which is saved, only
   * if the stored credentials are still the ones read, before it's used. Google's refresh tokens
   * don't appear to rotate (research notes §1), so the stored one is kept unless a new one arrives.
   * The caller's `deadline` bounds the wait for the lock and the refresh itself (R2-M7); running
   * out of it is the caller's problem, not the connection's, so it's never recorded.
   */
  private async refresh(s: Session, stale: string | null, deadline?: number): Promise<string> {
    try {
      return await this.refreshLocked(s, stale, deadline);
    } catch (err) {
      if (err instanceof LockWaitTimeout) {
        this.deps.logger.info({}, 'google calendar call ran out of time waiting for a token refresh');
        throw new AppError('integration_unavailable', CALENDAR_MESSAGES.unreachable);
      }
      throw err;
    }
  }

  private refreshLocked(s: Session, stale: string | null, deadline: number | undefined): Promise<string> {
    return this.lock.run(GoogleCalendar.LOCK, async () => {
      const conn = this.connection();
      if (!conn) throw new AppError('integration_unavailable', CALENDAR_MESSAGES.notConnected);
      if (conn.status === 'needs_reconnect') throw new AppError('integration_unavailable', CALENDAR_MESSAGES.reconnect);
      if (conn.credentialsEnc !== s.connection.credentialsEnc) {
        let fresh: Credentials;
        try {
          fresh = this.reopen(conn, s);
        } catch (err) {
          this.deps.logger.error({ error: err instanceof Error ? err.name : 'unknown' }, "google calendar credentials couldn't be read");
          recordConnectionFailure(this.deps.db, conn, this.deps.clock.now(), "The saved Google Calendar sign-in couldn't be read. Reconnect it.", true);
          throw new AppError('integration_unavailable', CALENDAR_MESSAGES.reconnect);
        }
        if (fresh.accessToken && fresh.accessToken !== stale && fresh.expiresAt !== null && fresh.expiresAt - this.deps.clock.now().getTime() > REFRESH_AHEAD_MS) {
          return fresh.accessToken;
        }
      }
      let next;
      try {
        next = await this.oauth.refresh(s.creds.refreshToken, this.deps.clock.now(), { deadline });
      } catch (err) {
        if (err instanceof GoogleOAuthError && err.code === 'invalid_grant') {
          this.deps.logger.warn({ code: err.code, status: err.status }, 'google refused the calendar refresh token');
          this.record(s, 'Google stopped accepting the saved sign-in.', true);
          throw new AppError('integration_unavailable', CALENDAR_MESSAGES.reconnect);
        }
        throw this.failure(s, err, false);
      }
      const creds: Credentials = { refreshToken: next.refreshToken ?? s.creds.refreshToken, accessToken: next.accessToken, expiresAt: next.expiresAt?.getTime() ?? null };
      const credentialsEnc = encryptCredentials(this.deps.keyring, conn, creds);
      const saved = this.deps.db.update(connections)
        .set({ credentialsEnc, updatedAt: this.deps.clock.now() })
        .where(and(eq(connections.id, conn.id), eq(connections.credentialsEnc, s.connection.credentialsEnc)))
        .run().changes === 1;
      if (saved) {
        s.connection = { ...s.connection, credentialsEnc };
        s.creds = creds;
      }
      this.deps.logger.info({ rotated: next.refreshToken !== null, saved }, 'google calendar token refreshed');
      return next.accessToken;
    }, { deadline });
  }

  /** `s` re-read from `conn`, which changed since `s` was opened. */
  private reopen(conn: ConnectionRow, s: Session): Credentials {
    const creds = CredentialsSchema.parse(decryptCredentials(this.deps.keyring, conn));
    s.connection = conn;
    s.meta = MetaSchema.parse(conn.meta);
    s.creds = creds;
    return creds;
  }

  /** Records a failure on the connection, if it still holds `s`'s credentials (see the class comment). */
  private record(s: Session, message: string, auth: boolean, health = true): void {
    // A call that doesn't count against health still records what needs a reconnect.
    if (!health && !auth) return;
    const conn = this.connection();
    if (!conn || conn.credentialsEnc !== s.connection.credentialsEnc) return;
    recordConnectionFailure(this.deps.db, conn, this.deps.clock.now(), message, auth);
  }

  /**
   * The error to throw for a failed call, after recording it when it's about the connection. A
   * plain message for people; the log has the kind, status, and Google's reason.
   *
   * A `write` that was sent and got no answer, a 5xx, or an answer that couldn't be read may have
   * been made: that's `outcome_unknown`, so the page keeps what it sent for a retry (C-M4). One
   * that was never sent (the token couldn't be renewed, the lock wait ran out) or that Google
   * refused (busy, the link, the API being off) is `integration_unavailable`. Running out of time
   * between retries counts as maybe sent: an earlier try may have reached Google.
   */
  private failure(s: Session, err: unknown, calendarLevel: boolean, health = true, write = false): Error {
    const record = (message: string, auth: boolean) => this.record(s, message, auth, health);
    if (err instanceof AppError) return err;
    const unknown = write ? 'outcome_unknown' : 'integration_unavailable';
    // The caller ran out of its own time: nothing about the connection (R2-M7).
    if (err instanceof GoogleApiError && err.reason === 'deadline') {
      this.deps.logger.info({ kind: 'network', reason: 'deadline' }, 'google calendar call ran out of time');
      return new AppError(unknown, CALENDAR_MESSAGES.unreachable);
    }
    if (err instanceof GoogleOAuthUnavailable && err.code === 'deadline') {
      this.deps.logger.info({ kind: 'network', reason: 'deadline' }, 'google calendar call ran out of time');
      return new AppError('integration_unavailable', CALENDAR_MESSAGES.unreachable);
    }
    if (err instanceof GoogleApiError) {
      this.deps.logger.warn({ kind: err.kind, status: err.status, reason: err.reason, retryAfterSec: err.retryAfterSec }, 'google calendar request failed');
      switch (err.kind) {
        case 'auth':
          record('Google stopped accepting the saved sign-in.', true);
          return new AppError('integration_unavailable', CALENDAR_MESSAGES.reconnect);
        case 'scope':
          record("Google no longer grants the dashboard's calendar permissions.", true);
          return new AppError('integration_unavailable', CALENDAR_MESSAGES.reconnect);
        case 'rate_limited':
          record('Google Calendar was limiting requests.', false);
          return new AppError('integration_unavailable', CALENDAR_MESSAGES.busy);
        case 'api_disabled':
          // Not a rate limit, and not the link: the project's admin turns the API on (C-M2).
          record(CALENDAR_MESSAGES.apiDisabled, false);
          return new AppError('integration_unavailable', CALENDAR_MESSAGES.apiDisabled);
        case 'bad_response':
          // One event that isn't in the documented shape is about that event, not the link (R2-M12).
          if (err.reason === 'event_shape') return err;
          record("Google Calendar couldn't be reached.", false);
          return new AppError(unknown, CALENDAR_MESSAGES.unreachable);
        case 'server':
        case 'network':
          record("Google Calendar couldn't be reached.", false);
          return new AppError(unknown, CALENDAR_MESSAGES.unreachable);
        case 'not_found':
        case 'gone':
        case 'forbidden':
          if (!calendarLevel) return err;
          record(err.kind === 'forbidden' ? 'Google Calendar refused access to the family calendar.' : "The family calendar couldn't be found.", false);
          return new AppError('integration_unavailable', CALENDAR_MESSAGES.calendarUnavailable);
        default:
          return err;
      }
    }
    if (err instanceof GoogleOAuthError) {
      // Not invalid_grant (that's handled in `refresh`): e.g. invalid_client, a client secret that changed.
      this.deps.logger.warn({ code: err.code, status: err.status }, 'google calendar token refresh failed');
      record("Google refused to renew the saved sign-in.", false);
      return new AppError('integration_unavailable', CALENDAR_MESSAGES.unreachable);
    }
    this.deps.logger.warn({ ...loggableError(err), kind: (err as { kind?: unknown }).kind }, 'google calendar request failed');
    record("Google Calendar couldn't be reached.", false);
    return new AppError(unknown, CALENDAR_MESSAGES.unreachable);
  }
}

function toPending(c: { id: string; name: string; timeZone: string | null; primary: boolean; accessRole: string }): PendingCalendar {
  return { id: c.id, name: c.name, timeZone: c.timeZone, primary: c.primary, accessRole: c.accessRole === 'owner' ? 'owner' : 'writer' };
}
