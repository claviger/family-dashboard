import { randomUUID } from 'node:crypto';
import { and, asc, count, eq, inArray, isNotNull, isNull, ne, or } from 'drizzle-orm';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { TodoistFreshness } from '../../../shared/integrations.js';
import type { TodoItem } from '../../../shared/todo.js';
import type { Clock } from '../../core/clock.js';
import { decryptSecret, encryptSecret, revocationAad, type Keyring } from '../../core/crypto.js';
import { AppError, loggableError } from '../../core/errors.js';
import { KeyedLock } from '../../core/lock.js';
import type { TodoistConfig } from '../../config.js';
import type { Db } from '../../db/index.js';
import {
  choreOccurrences, connections, panelGrants, pendingRevocations, todoistState, todos, users, type ConnectionRow, type TodoistStateRow, type TodoRow,
} from '../../db/schema.js';
import type { NewTodo, TodoChanges } from '../../panels/todo/backend.js';
import { isUniqueViolation, toTodoItem } from '../../panels/todo/internalBackend.js';
import { getFamilySettings } from '../../settings.js';
import {
  decryptCredentials, encryptCredentials, getUserConnection, recordConnectionFailure, recordConnectionSuccess,
} from '../connections.js';
import { keyMismatchWarning, resetTokenKeyCheck } from '../keyCheck.js';
import {
  TodoistClient, TodoistHttpError, TodoistOAuthError, type FetchFn, type SyncCommand, type SyncResponse, type TodoistItem, type TokenSet,
} from './client.js';
import { classifyCommandError, dueToTodoist, stableUuid } from './mapping.js';
import {
  applyConfirmation, applyRelinkLookup, applySyncResponse, findOrphanCopy, inInbox, isChoreLinked, matchLostCreate, mirrorRow, projectList,
  type ApplySummary, type RemoteChange,
} from './mirror.js';

/** Refresh an access token this long before it expires (they last an hour). */
export const REFRESH_AHEAD_MS = 5 * 60_000;
/** A full sync, which also reconciles the mirror, runs at least this often (see mirror.ts). */
export const FULL_SYNC_EVERY_MS = 24 * 60 * 60_000;
/**
 * How long the drill-down's list request waits for the sync it starts (spec §10.6) before it
 * serves the mirror anyway. An incremental sync is normally well under a second; Todoist's own
 * processing limit is 15 seconds. Three seconds shows fresh data in the usual case without making
 * the drill-down hang when Todoist is slow; the sync still finishes in the background, and the
 * list refetches every 60 seconds.
 */
export const LIST_SYNC_WAIT_MS = 3_000;
/** A list request doesn't start another sync within this long of the last one. */
export const LIST_SYNC_MIN_GAP_MS = 15_000;
/**
 * At most this many rows missing from one full sync are looked up (`GET /api/v1/tasks/{id}`) per
 * sync. Normally there are none: the incremental sync just before has already reported every
 * completion and deletion. The cap keeps one sync from making hundreds of calls (REST rate limits
 * aren't documented) and from holding the person's lock for long. Rows left over stay queued
 * (`todoist_state.pending_lookups`) and the next syncs work through them in order, without
 * repeating the full sync; it's counted as done once each has been tried.
 */
export const CONFIRM_PER_SYNC = 25;
/** The lookups in one sync stop after this long, too, so a slow Todoist can't hold the person's lock for minutes. */
export const CONFIRM_DEADLINE_MS = 30_000;
/**
 * A move into Todoist whose response was lost is replayed with the same uuid. If that many replays
 * come back with no `temp_id_mapping` and no single copy to claim, the row is marked
 * (`todoist_move_error = 'unconfirmed'`) and stays on the dashboard, changed locally.
 */
export const MOVE_REPLAYS_BEFORE_LOCAL = 3;
/**
 * A chore create's first-attempt time (`todoist_state.create_attempts`) is forgotten after this
 * long, on the next sync, so entries for creates that never settled (the occurrence was skipped,
 * say) don't pile up. The retry queue gives up on a create within about a day (TODO_RETRY_CAP),
 * so by then it's stuck on the System page. If an admin retries it later still, it starts over
 * with a new attempt time, and a task its first attempt made can't be claimed as its copy: the
 * create stays unconfirmed, and the admin can dismiss it.
 */
export const CREATE_ATTEMPT_TTL_MS = 7 * 24 * 60 * 60_000;

/** What people see. Never a token, an id, or Todoist's raw error text (spec §14). */
export const TODOIST_MESSAGES = {
  notLinked: "Todoist isn't linked.",
  reconnect: 'Todoist needs to be reconnected. Reconnect it in Settings.',
  unreachable: "Couldn't reach Todoist. Try again in a few minutes.",
  busy: 'Todoist is busy right now. Try again in a minute.',
  rejected: "Todoist didn't accept that change.",
  keyMismatch: "Todoist is unavailable: the server's TOKEN_ENCRYPTION_KEY doesn't match the stored credentials. An admin needs to fix the key.",
} as const;

/** What `credentials_enc` holds once decrypted. */
const CredentialsSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).nullable(),
  /** Epoch ms, or null when Todoist sent no expiry. */
  expiresAt: z.number().nullable(),
});
export type TodoistCredentials = z.infer<typeof CredentialsSchema>;

/** What `pending_revocations.credentials_enc` holds once decrypted: the tokens still to revoke. */
const PendingTokensSchema = z.object({ accessToken: z.string().min(1).nullable(), refreshToken: z.string().min(1).nullable() });
type PendingTokens = z.infer<typeof PendingTokensSchema>;

/** Each revocation request on unlink waits this long (the JSON try and the form fallback each). */
export const REVOKE_TIMEOUT_MS = 10_000;

/** Webhook-started syncs for one person start at least this far apart (see `syncFromWebhook`). */
export const WEBHOOK_SYNC_GAP_MS = 5_000;

export interface TodoistDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  config: TodoistConfig;
  keyring: Keyring;
  fetch: FetchFn;
  /**
   * True when TOKEN_ENCRYPTION_KEY doesn't match the stored key check (`checkTokenKey`). Then every
   * operation fails with `keyMismatch` and nothing is written: fixing the key brings every link
   * back as it was, instead of everyone having to reconnect.
   */
  keyMismatch?: boolean;
  /** Plaid is set up too, so the key mismatch warning names the banks, as the calendar's does (phase 6b). */
  plaidConfigured?: boolean;
}

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

/** A project's open tasks, looked up for a lost create (`Todoist.lostCreateLookup`). */
type LostCreateLookup = { items: TodoistItem[]; complete: boolean };

/** A command failed because its task is gone from Todoist. Internal: callers turn it into the right result. */
class TaskGone extends Error {}

function notFound(): AppError {
  return new AppError('not_found', 'To-do not found.');
}

/** `item_add` arguments for a to-do. `project_id` is left out when it's not known yet (Todoist defaults to Inbox). */
function addArgs(t: { title: string; notes: string | null; dueDate: string | null; dueTime: string | null }, projectId: string | null) {
  const due = dueToTodoist(t.dueDate, t.dueTime);
  return {
    content: t.title,
    ...(t.notes ? { description: t.notes } : {}),
    ...(projectId ? { project_id: projectId } : {}),
    ...(due ? { due } : {}),
  };
}

/**
 * A row that stays on the dashboard and is changed locally: completed history from before
 * linking, or one Todoist refused to take (`todoist_move_error`).
 */
function isLocalOnly(row: TodoRow): boolean {
  return row.backend === 'internal' && (row.completedAt !== null || row.todoistMoveError !== null);
}

/** better-sqlite3's error code (e.g. SQLITE_CONSTRAINT_UNIQUE), possibly wrapped by Drizzle as `cause`. */
function sqliteCode(err: unknown): string | undefined {
  for (let e = err; e instanceof Error; e = e.cause) {
    const code = (e as Error & { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** True when a constraint error (or its Drizzle-wrapped cause) names `column`, e.g. `todoist_state.todoist_user_id`. */
function violates(err: unknown, column: string): boolean {
  for (let e = err; e instanceof Error; e = e.cause) if (e.message.includes(column)) return true;
  return false;
}

/** When Todoist took a full sync's snapshot (research notes §2), or `now` when it didn't say. */
function snapshotOf(res: SyncResponse, now: Date): Date {
  return res.fullSyncDateUtc ? new Date(res.fullSyncDateUtc) : now;
}

/**
 * A row still waiting for its lookup: an open mirror row with a task id that nothing has written
 * since the full sync's snapshot (a later sync or write that touched it has heard from Todoist).
 */
function isUnsettledMirrorRow(row: TodoRow, snapshotAt: Date): boolean {
  return row.backend === 'todoist' && row.deletedAt === null && row.completedAt === null && row.todoistTaskId !== null && row.updatedAt.getTime() <= snapshotAt.getTime();
}

/** One locked operation on one person's account. */
interface Session {
  userId: number;
  conn: ConnectionRow;
  creds: TodoistCredentials;
  state: TodoistStateRow;
  /** Remote changes seen so far, reported once the lock is released. */
  changes: RemoteChange[];
  /**
   * Rows dropped so far because their task left the mirror's scope (mirror.ts), by row id, as they
   * were. A write whose own row was dropped (moved out of the Inbox in Todoist meanwhile) answers
   * with it: the write went through, the to-do just isn't on this list any more.
   */
  dropped: Map<number, TodoItem>;
}

/**
 * One family's Todoist integration (spec §10.6): linked accounts, their tokens, and the mirror.
 *
 * Every operation on a person's account runs under a per-user lock (`KeyedLock`): syncs, writes,
 * token refreshes, link, and unlink. Inside the lock, code calls the private, unlocked helpers;
 * the lock isn't reentrant. Remote changes found along the way are reported to the listener
 * (TodoService) after the lock is released, so chore handlers that write back can't deadlock.
 *
 * Connection status follows spec §8: an authorization failure sets `needs_reconnect`, 3 other
 * failures in a row set `error`, and any success sets `ok` and `last_success_at`.
 *
 * Tokens are never logged. Log lines carry the user id, counts, and Todoist's error tags.
 */
export class Todoist {
  readonly client: TodoistClient;
  private readonly lock = new KeyedLock<number>();
  private readonly queuedSyncs = new Map<number, Promise<void>>();
  /** Per person: when the last webhook-started sync started, and the timer for one that's waiting. */
  private readonly webhookSyncs = new Map<number, { startedAt: number; timer: NodeJS.Timeout | null }>();
  private listener: ((changes: RemoteChange[]) => Promise<void>) | null = null;
  /** Starts as `deps.keyMismatch`; `resetLinksForNewKey` clears it. */
  private keyMismatchNow: boolean;

  constructor(private readonly deps: TodoistDeps) {
    this.client = new TodoistClient(deps.config, deps.fetch);
    this.keyMismatchNow = deps.keyMismatch === true;
  }

  /** TOKEN_ENCRYPTION_KEY failed the key check: nothing can be linked, synced, or unlinked. */
  get keyMismatch(): boolean {
    return this.keyMismatchNow;
  }

  /** TodoService subscribes here, to turn remote changes into to-do events. */
  onRemoteChanges(listener: (changes: RemoteChange[]) => Promise<void>): void {
    this.listener = listener;
  }

  connection(userId: number): ConnectionRow | undefined {
    return getUserConnection(this.deps.db, 'todoist', userId);
  }

  state(userId: number): TodoistStateRow | undefined {
    return this.deps.db.select().from(todoistState).where(eq(todoistState.userId, userId)).get();
  }

  /** Linked, whatever the status: their to-dos live in the mirror, even while it needs reconnecting. */
  isLinked(userId: number): boolean {
    return this.connection(userId) !== undefined;
  }

  needsReconnect(userId: number): boolean {
    return this.connection(userId)?.status === 'needs_reconnect';
  }

  /**
   * For the to-do list and home card: status, last sync, and the project names the list needs.
   * Admins read other people's lists, so this names only the Inbox, the chores project, and the
   * projects the person's live rows are in (a chore to-do moved elsewhere, say), never the rest of
   * the account's projects. The person's own link (`allProjects`, for the chores project picker)
   * is the only place every name goes. Null when not linked.
   */
  freshness(userId: number): TodoistFreshness | null {
    const conn = this.connection(userId);
    const state = this.state(userId);
    if (!conn || !state) return null;
    const used = new Set(
      this.deps.db.selectDistinct({ projectId: todos.todoistProjectId }).from(todos)
        .where(and(eq(todos.ownerUserId, userId), isNull(todos.deletedAt), isNotNull(todos.todoistProjectId)))
        .all()
        .map((r) => r.projectId!),
    );
    if (state.inboxProjectId) used.add(state.inboxProjectId);
    if (state.choresProjectId) used.add(state.choresProjectId);
    const shown = Object.fromEntries(Object.entries(state.projects).filter(([id]) => used.has(id)));
    return {
      status: conn.status,
      lastSyncAt: state.lastSyncAt?.toISOString() ?? null,
      projects: projectList(shown, state.inboxProjectId),
      serverNow: this.deps.clock.now().toISOString(),
    };
  }

  /** Every project name in the person's account, Inbox first: only for their own link (the chores project picker). */
  allProjects(userId: number): { id: string; name: string }[] {
    const state = this.state(userId);
    return state ? projectList(state.projects, state.inboxProjectId) : [];
  }

  /** The linked user for a webhook's `user_id`, or null. */
  userForTodoistId(todoistUserId: string): number | null {
    return this.deps.db.select({ userId: todoistState.userId }).from(todoistState).where(eq(todoistState.todoistUserId, todoistUserId)).get()?.userId ?? null;
  }

  /**
   * Starts an incremental sync, or joins one that's queued and hasn't started yet. One that's
   * already running doesn't count: a change may have landed after it began. Rejects with an
   * AppError when it fails; the failure is also recorded on the connection.
   */
  requestSync(userId: number): Promise<void> {
    const queued = this.queuedSyncs.get(userId);
    if (queued) return queued;
    const run = this.withSession(userId, async (s) => {
      if (this.queuedSyncs.get(userId) === run) this.queuedSyncs.delete(userId);
      await this.syncLocked(s);
    });
    this.queuedSyncs.set(userId, run);
    void run.catch(() => {}).finally(() => {
      if (this.queuedSyncs.get(userId) === run) this.queuedSyncs.delete(userId);
    });
    return run;
  }

  /**
   * A webhook's sync. Todoist sends a delivery for every change, and may send one again, so a burst
   * of edits in Todoist would start a burst of syncs. The first delivery starts a sync at once; any
   * more within WEBHOOK_SYNC_GAP_MS of it only mark the person, and one sync starts when the gap
   * ends. A failure is recorded on the connection, as for any sync.
   */
  syncFromWebhook(userId: number): void {
    const entry = this.webhookSyncs.get(userId);
    if (entry?.timer) return;
    const start = () => {
      this.webhookSyncs.set(userId, { startedAt: this.deps.clock.now().getTime(), timer: null });
      void this.requestSync(userId).catch(() => {});
    };
    const wait = entry ? entry.startedAt + WEBHOOK_SYNC_GAP_MS - this.deps.clock.now().getTime() : 0;
    if (wait <= 0) {
      start();
      return;
    }
    const timer = setTimeout(start, wait);
    timer.unref();
    this.webhookSyncs.set(userId, { startedAt: entry!.startedAt, timer });
  }

  /** Forgets a waiting webhook sync, e.g. on unlink. */
  private cancelWebhookSync(userId: number): void {
    const timer = this.webhookSyncs.get(userId)?.timer;
    if (timer) clearTimeout(timer);
    this.webhookSyncs.delete(userId);
  }

  /**
   * The drill-down's list request (spec §10.6): starts a sync and waits up to LIST_SYNC_WAIT_MS
   * for it, then returns so the mirror is served. Never throws.
   */
  async syncBeforeRead(userId: number): Promise<void> {
    const conn = this.connection(userId);
    const state = this.state(userId);
    if (!conn || !state || conn.status === 'needs_reconnect') return;
    const now = this.deps.clock.now().getTime();
    if (state.lastSyncAt && now - state.lastSyncAt.getTime() < LIST_SYNC_MIN_GAP_MS) return;
    const sync = this.requestSync(userId).catch(() => {});
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, LIST_SYNC_WAIT_MS);
      timer.unref();
    });
    await Promise.race([sync, timeout]);
    clearTimeout(timer);
  }

  /**
   * The `todo.todoistSync` job (spec §3.5): every linked, active person with the To-do panel whose
   * link doesn't need reconnecting. Someone whose To-do panel was turned off keeps their link,
   * unsynced, and syncing resumes when it's turned back on. Also finishes moving to-dos from
   * before linking, if a move failed. Returns how many failed; each failure is also recorded on
   * that person's connection.
   */
  async syncAll(): Promise<{ total: number; failed: number }> {
    const linked = this.deps.db
      .select({ userId: connections.ownerUserId })
      .from(connections)
      .innerJoin(users, eq(users.id, connections.ownerUserId))
      .innerJoin(panelGrants, and(eq(panelGrants.userId, users.id), eq(panelGrants.panelId, 'todo')))
      .where(and(eq(connections.kind, 'todoist'), eq(users.active, true)))
      .all();
    let failed = 0;
    let total = 0;
    if (this.keyMismatchNow) return { total, failed };
    for (const { userId } of linked) {
      if (this.needsReconnect(userId)) continue;
      total++;
      try {
        await this.requestSync(userId);
        if (this.waitingToMove(userId) > 0) await this.migrate(userId);
      } catch {
        failed++;
      }
    }
    return { total, failed };
  }

  // ---- Linking and unlinking (spec §10.6).

  /**
   * Finishes a link after the OAuth callback, under the person's lock.
   *
   * First, which Todoist account is it? A sync of just the `user` resource says, cheaply, with its
   * email and Inbox. That's checked before anything is stored:
   * - `in_use`: another dashboard user is linked to that Todoist account (webhooks map by it). The
   *   new token isn't revoked: if Todoist revokes per account rather than per token (UNVERIFIED),
   *   that would end the other person's link too.
   * - `other_account`: this person is reconnecting to a different account than before. Its new
   *   token is revoked, best effort, since nobody will use it.
   *
   * Then the first sync. A reconnect to the same account picks up from the stored sync token, so
   * whatever changed while the link was broken arrives as changes (completions as completions);
   * Todoist answers `full_sync: true` if that token is too old, and that's handled like any full
   * sync. A new link is a full sync. Open internal rows that kept a task id from an earlier link
   * to the same account are converted in place (spec §10.6, "Relinking later"). Task ids kept from
   * a different account are forgotten first (`forgetOtherAccountTasks`), so those rows are moved
   * in as new tasks instead of being looked up, answered 404, and deleted.
   *
   * The connection, the sync state, and that first sync's changes are saved in one transaction:
   * if applying it fails, nothing is stored, and the person can simply try again. Moving the other
   * open internal rows into Todoist is `migrate()`, which the callback starts in the background.
   */
  async link(userId: number, tokens: TokenSet): Promise<'linked' | 'reconnected' | 'in_use' | 'other_account'> {
    if (this.keyMismatchNow) throw new AppError('integration_unavailable', TODOIST_MESSAGES.keyMismatch);
    const changes: RemoteChange[] = [];
    const result = await this.lock.run(userId, async () => {
      const probe = await this.client.sync(tokens.accessToken, { syncToken: '*', resourceTypes: ['user'] });
      const user = probe.user;
      if (!user) throw new TodoistHttpError('bad_response', 200, "Todoist's user sync had no user.");
      const holder = this.userForTodoistId(user.id);
      const existing = this.state(userId);
      if (holder !== null && holder !== userId) {
        this.deps.logger.warn({ userId, reason: 'in_use' }, 'todoist link refused');
        return 'in_use' as const;
      }
      if (existing && existing.todoistUserId !== user.id) {
        this.deps.logger.warn({ userId, reason: 'other_account' }, 'todoist link refused');
        // Nobody will use these: both are revoked, best effort (nothing was stored).
        await this.revokeAll({ accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
        return 'other_account' as const;
      }
      const res = await this.client.sync(tokens.accessToken, { syncToken: existing?.syncToken ?? '*' });
      const full = !existing?.syncToken || res.fullSync;
      const now = this.deps.clock.now();
      const creds: TodoistCredentials = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt?.getTime() ?? null };
      const credentialsEnc = encryptCredentials(this.deps.keyring, { kind: 'todoist', scope: 'user', ownerUserId: userId }, creds);
      const meta = { account: user.email };
      const conn = this.connection(userId);
      const timeZone = getFamilySettings(this.deps.db).timeZone;
      let summary: ApplySummary;
      try {
        summary = this.deps.db.transaction((tx) => {
          if (conn) {
            tx.update(connections)
              .set({ credentialsEnc, meta, status: 'ok', consecutiveFailures: 0, lastError: null, lastErrorAt: null, lastSuccessAt: now, updatedAt: now })
              .where(eq(connections.id, conn.id))
              .run();
          } else {
            tx.insert(connections)
              .values({ kind: 'todoist', scope: 'user', ownerUserId: userId, credentialsEnc, meta, lastSuccessAt: now, createdAt: now, updatedAt: now })
              .run();
          }
          if (!existing) tx.insert(todoistState).values({ userId, todoistUserId: user.id, inboxProjectId: user.inboxProjectId, createdAt: now, updatedAt: now }).run();
          this.forgetOtherAccountTasks(tx, userId, user.id);
          return applySyncResponse(tx, { userId, timeZone, now, requestedFull: full, ownRowIds: new Set() }, res);
        });
      } catch (err) {
        // Someone else linked the same Todoist account while this link's syncs were out (their
        // lock is their own): the check above passed, but the unique index didn't.
        if (isUniqueViolation(err) && violates(err, 'todoist_state.todoist_user_id')) {
          this.deps.logger.warn({ userId, reason: 'in_use' }, 'todoist link refused');
          return 'in_use' as const;
        }
        throw err;
      }
      changes.push(...summary.changes);
      const s = this.open(userId, changes);
      if (full) {
        this.startLookups(s, summary.missing, snapshotOf(res, now));
        if (await this.confirmMissing(s)) this.markFullSync(s);
      }
      this.deps.logger.info({ userId, reconnected: conn !== undefined, full, items: summary.items, changes: summary.changes.length }, 'todoist linked');
      return conn ? ('reconnected' as const) : ('linked' as const);
    });
    await this.report(userId, changes);
    return result;
  }

  /** Open to-dos from before linking that aren't in Todoist yet, not counting ones Todoist refused. */
  waitingToMove(userId: number): number {
    return this.deps.db
      .select({ n: count() })
      .from(todos)
      .where(this.waitingRows(userId))
      .get()!.n;
  }

  private waitingRows(userId: number) {
    return and(
      eq(todos.ownerUserId, userId),
      eq(todos.backend, 'internal'),
      isNull(todos.deletedAt),
      isNull(todos.completedAt),
      isNull(todos.todoistMoveError),
    );
  }

  /**
   * Linking `accountId`: internal rows that kept a task id from another Todoist account forget it,
   * in the link's transaction, before anything is matched or looked up. Their old ids mean
   * nothing in this account (a lookup would 404 as if the task were deleted, and deleting the row
   * would skip its chore), so `migrate` adds them as new tasks. A row with a task id but no
   * account can't be told apart, so it's treated the same way: a possible duplicate task is
   * better than a lost to-do.
   */
  private forgetOtherAccountTasks(tx: Tx, userId: number, accountId: string): void {
    tx.update(todos)
      .set({ todoistTaskId: null, todoistAccountId: null })
      .where(and(
        eq(todos.ownerUserId, userId),
        eq(todos.backend, 'internal'),
        isNotNull(todos.todoistTaskId),
        or(isNull(todos.todoistAccountId), ne(todos.todoistAccountId, accountId)),
      ))
      .run();
  }

  /**
   * Moves every open internal to-do into Todoist (spec §10.6, "On linking"): chore to-dos into
   * the chores project, the rest into Inbox, each converted in place (`adoptMany`). Up to 100 rows
   * per request, and the lock is released between requests, so the person's own changes and syncs
   * don't wait for the whole move. Each row's command uuid is derived from the link and the row
   * (`adoptMany`), so a crash part way through leaves the moved rows moved, and a rerun creates no
   * duplicates. Completed internal rows stay as they are: they're history.
   *
   * Runs after linking and from every `todo.todoistSync` run, so a move that failed is picked up
   * again. A row Todoist refuses outright is marked and left on the dashboard (it's no longer
   * waiting); any other failure stops the run, since Todoist is probably down.
   */
  async migrate(userId: number): Promise<{ moved: number; waiting: number }> {
    let moved = 0;
    for (;;) {
      const batch = await this.withSession(userId, async (s) => {
        if (!s.state.syncToken) await this.syncLocked(s);
        const rows = this.deps.db.select().from(todos).where(this.waitingRows(userId)).orderBy(asc(todos.id)).limit(100).all();
        if (rows.length === 0) return null;
        const result = await this.adoptMany(s, rows);
        return { rows: rows.length, settled: result.size, moved: [...result.values()].filter((r) => r === 'moved').length };
      });
      if (!batch) break;
      moved += batch.moved;
      // Some rows neither moved nor were refused (no mapping, no copy found): try those later.
      if (batch.settled < batch.rows) break;
    }
    return { moved, waiting: this.waitingToMove(userId) };
  }

  /**
   * Unlinks (spec §10.6, "On unlinking"), under the lock:
   * - First the tokens are revoked with `POST /api/v1/revoke`, each with a REVOKE_TIMEOUT_MS
   *   timeout: the access token, and the refresh token too, since whether revoking one revokes
   *   the other is UNVERIFIED. Revoking first means a crash part way leaves a link whose tokens
   *   don't work (it shows as needing reconnecting, and can be unlinked again), never a deleted
   *   link whose tokens still do.
   * - Every mirror row becomes an internal row in place, so ids, chore occurrences, and queued
   *   actions keep working. Rows are never copied. Open rows keep `todoist_task_id` and the
   *   account it belongs to, so a later relink to the same account matches them (a link to a
   *   different account forgets them); completed and deleted rows don't need it.
   * - The sync state and the connection are deleted. A token Todoist didn't confirm revoking is
   *   kept, encrypted, in `pending_revocations`, in the same transaction; `retryRevocations`
   *   (the hourly `todo.todoistRevocations` job) tries it again, and the System page warns until
   *   it's gone.
   * Works whatever the link's status, including when the credentials can't be decrypted (then
   * there's nothing to revoke). Refused with a mismatched TOKEN_ENCRYPTION_KEY: the tokens
   * couldn't be read to revoke them, and restoring the key should bring the link back.
   */
  unlink(userId: number): Promise<void> {
    if (this.keyMismatchNow) return Promise.reject(new AppError('integration_unavailable', TODOIST_MESSAGES.keyMismatch));
    return this.lock.run(userId, async () => {
      const conn = this.connection(userId);
      if (!conn) return;
      let creds: TodoistCredentials | null = null;
      try {
        creds = CredentialsSchema.parse(decryptCredentials(this.deps.keyring, conn));
      } catch {
        this.deps.logger.warn({ userId }, "todoist credentials couldn't be decrypted for revocation");
      }
      const left = creds ? await this.revokeAll(creds) : null;
      const now = this.deps.clock.now();
      const accountId = this.state(userId)?.todoistUserId ?? null;
      this.deps.db.transaction((tx) => {
        if (left && (left.accessToken || left.refreshToken)) {
          tx.insert(pendingRevocations)
            .values({
              kind: 'todoist', ownerUserId: userId, accountId, createdAt: now,
              credentialsEnc: encryptSecret(this.deps.keyring, JSON.stringify(left), revocationAad('todoist', userId)),
            })
            .run();
        }
        this.dropLink(tx, userId, conn.id, now);
      });
      this.forgetSyncs(userId);
      this.deps.logger.info(
        { userId, accessRevoked: creds ? left!.accessToken === null : null, refreshRevoked: creds?.refreshToken ? left!.refreshToken === null : null },
        'todoist unlinked',
      );
    });
  }

  /**
   * The local half of an unlink, in the caller's transaction: every mirror row becomes an internal
   * row in place (open rows keep `todoist_task_id` and `todoist_account_id` for a later relink to
   * the same account), and the sync state and the connection are deleted.
   */
  private dropLink(tx: Tx, userId: number, connectionId: number, now: Date): void {
    const mine = and(eq(todos.ownerUserId, userId), eq(todos.backend, 'todoist'));
    tx.update(todos)
      .set({ backend: 'internal', todoistProjectId: null, todoistRecurring: false, todoistDueTimezone: null, updatedAt: now })
      .where(and(mine, isNull(todos.deletedAt), isNull(todos.completedAt)))
      .run();
    tx.update(todos)
      .set({ backend: 'internal', todoistTaskId: null, todoistAccountId: null, todoistProjectId: null, todoistRecurring: false, todoistDueTimezone: null, updatedAt: now })
      .where(and(mine, or(isNotNull(todos.deletedAt), isNotNull(todos.completedAt))))
      .run();
    // Rows Todoist refused, or whose move never settled, are ordinary internal rows again; a
    // later link (with new command uuids) tries them again.
    tx.update(todos)
      .set({ todoistMoveError: null, todoistMoveAttemptedAt: null, todoistMoveReplays: 0 })
      .where(and(eq(todos.ownerUserId, userId), or(isNotNull(todos.todoistMoveError), isNotNull(todos.todoistMoveAttemptedAt))))
      .run();
    tx.delete(todoistState).where(eq(todoistState.userId, userId)).run();
    tx.delete(connections).where(eq(connections.id, connectionId)).run();
  }

  /** Forgets any sync queued or waiting for someone who is no longer linked. */
  private forgetSyncs(userId: number): void {
    this.queuedSyncs.delete(userId);
    this.cancelWebhookSync(userId);
  }

  /**
   * The way back from a lost TOKEN_ENCRYPTION_KEY (spec §14), an admin's action on the System page,
   * only while the key doesn't match. The stored tokens were encrypted with the lost key, so they
   * can't be read, used, or revoked. Every link is dropped as on unlink (rows become internal in
   * place, open ones keep their task id), its encrypted tokens are deleted, and so are tokens that
   * were waiting to be revoked. Then the current key becomes the reference (`resetTokenKeyCheck`)
   * and Todoist works again: each person connects again, and can remove the old access from their
   * Todoist settings. Nothing is sent to Todoist. Returns how many links were dropped.
   */
  async resetLinksForNewKey(): Promise<{ unlinked: number }> {
    if (!this.keyMismatchNow) throw new AppError('conflict', 'TOKEN_ENCRYPTION_KEY matches the stored credentials, so there is nothing to reset.');
    // `resetLinksForNewKey` (keyReset.ts) forgets the calendar first. While any other kind is
    // still saved, the old key is still needed for it, so this resets nothing.
    const others = this.deps.db.select({ n: count() }).from(connections).where(ne(connections.kind, 'todoist')).get()!.n
      + this.deps.db.select({ n: count() }).from(pendingRevocations).where(and(ne(pendingRevocations.kind, 'todoist'), isNull(pendingRevocations.gaveUpAt))).get()!.n;
    if (others > 0) throw new AppError('conflict', 'Other integrations still have credentials saved with the old key, so nothing was reset.');
    const linked = this.deps.db.select({ id: connections.id, userId: connections.ownerUserId }).from(connections).where(eq(connections.kind, 'todoist')).all();
    for (const { id, userId } of linked) {
      await this.lock.run(userId, async () => {
        this.deps.db.transaction((tx) => this.dropLink(tx, userId, id, this.deps.clock.now()));
        this.forgetSyncs(userId);
      });
    }
    this.deps.db.delete(pendingRevocations).where(eq(pendingRevocations.kind, 'todoist')).run();
    if (!resetTokenKeyCheck(this.deps.db, this.deps.keyring)) {
      throw new AppError('conflict', 'Something was saved with the old key while resetting. Try again.');
    }
    this.keyMismatchNow = false;
    this.deps.logger.warn({ unlinked: linked.length }, 'todoist links reset for a new TOKEN_ENCRYPTION_KEY');
    return { unlinked: linked.length };
  }

  /**
   * Revokes both tokens (see `unlink`), at once, and returns the ones Todoist didn't confirm
   * (null where it did, or there was none).
   */
  private async revokeAll(tokens: { accessToken: string | null; refreshToken: string | null }): Promise<PendingTokens> {
    const [access, refresh] = await Promise.all([
      tokens.accessToken ? this.client.revoke(tokens.accessToken, 'access_token', REVOKE_TIMEOUT_MS).then(() => null, () => tokens.accessToken) : null,
      tokens.refreshToken ? this.client.revoke(tokens.refreshToken, undefined, REVOKE_TIMEOUT_MS).then(() => null, () => tokens.refreshToken) : null,
    ]);
    return { accessToken: access, refreshToken: refresh };
  }

  /**
   * The hourly `todo.todoistRevocations` job: tries again to revoke tokens an unlink couldn't
   * (`pending_revocations`), and deletes each row once nothing is left to revoke. Does nothing with
   * a mismatched TOKEN_ENCRYPTION_KEY. Returns how many rows were tried and how many still failed.
   *
   * Each row is retried under its owner's lock, so it can't race a link. If the owner is linked to
   * the same Todoist account again, they've authorized it again: whether revoking an old token
   * ends the new grant too is UNVERIFIED, so the row is dropped instead, and that's logged.
   */
  async retryRevocations(): Promise<{ total: number; failed: number }> {
    if (this.keyMismatchNow) return { total: 0, failed: 0 };
    const rows = this.deps.db.select().from(pendingRevocations).where(eq(pendingRevocations.kind, 'todoist')).all();
    let failed = 0;
    for (const row of rows) {
      const ok = await this.lock.run(row.ownerUserId, () => this.retryRevocation(row));
      if (!ok) failed++;
    }
    return { total: rows.length, failed };
  }

  /** One `pending_revocations` row, under its owner's lock. False when something is still left to revoke. */
  private async retryRevocation(row: typeof pendingRevocations.$inferSelect): Promise<boolean> {
    const now = this.deps.clock.now();
    if (row.accountId !== null && this.state(row.ownerUserId)?.todoistUserId === row.accountId) {
      this.deps.db.delete(pendingRevocations).where(eq(pendingRevocations.id, row.id)).run();
      this.deps.logger.info({ userId: row.ownerUserId, attempts: row.attempts }, 'dropped a waiting todoist revocation: the person linked that account again');
      return true;
    }
    let tokens: PendingTokens;
    try {
      tokens = PendingTokensSchema.parse(JSON.parse(decryptSecret(this.deps.keyring, row.credentialsEnc, revocationAad(row.kind, row.ownerUserId))));
    } catch (err) {
      this.deps.logger.error({ userId: row.ownerUserId, error: err instanceof Error ? err.name : 'unknown' }, "a todoist token kept for revocation couldn't be decrypted");
      this.deps.db.update(pendingRevocations).set({ attempts: row.attempts + 1, lastError: "The saved token couldn't be read.", lastAttemptAt: now }).where(eq(pendingRevocations.id, row.id)).run();
      return false;
    }
    const left = await this.revokeAll(tokens);
    if (!left.accessToken && !left.refreshToken) {
      this.deps.db.delete(pendingRevocations).where(eq(pendingRevocations.id, row.id)).run();
      this.deps.logger.info({ userId: row.ownerUserId, attempts: row.attempts + 1 }, 'todoist tokens revoked after unlinking');
      return true;
    }
    this.deps.db.update(pendingRevocations)
      .set({
        credentialsEnc: encryptSecret(this.deps.keyring, JSON.stringify(left), revocationAad(row.kind, row.ownerUserId)),
        attempts: row.attempts + 1,
        lastError: "Couldn't reach Todoist to revoke the sign-in.",
        lastAttemptAt: now,
      })
      .where(eq(pendingRevocations.id, row.id))
      .run();
    return false;
  }

  /** For the System page: a key mismatch, and unlinked sign-ins that are still waiting to be revoked. */
  warnings(): string[] {
    const key = this.keyMismatchNow ? [keyMismatchWarning({ todoist: true, plaid: this.deps.plaidConfigured === true })] : [];
    const { n } = this.deps.db.select({ n: count() }).from(pendingRevocations).where(eq(pendingRevocations.kind, 'todoist')).get()!;
    if (n === 0) return key;
    return [
      ...key,
      `Couldn't revoke the Todoist sign-in of ${n === 1 ? 'an unlinked account' : `${n} unlinked accounts`} yet. ` +
        "It's tried again every hour. Until then the person can also remove the dashboard's access from their Todoist account.",
    ];
  }

  /**
   * A cleanup run at every start (index.ts), before any sync or request: until the owner's change
   * request of 2026-11-16, the mirror held every active task from every project. Now it holds the
   * Inbox and chore to-dos (mirror.ts), so live mirror rows from other projects are dropped the
   * same quiet way a sync drops a task that leaves the Inbox: hard-deleted, with no remote change
   * and no event. Chore-linked rows are kept wherever they are, and so are rows whose project isn't
   * known. Completed rows from other projects go too. Deleted rows are left as they are: they're
   * real deletions, and history may point at them.
   *
   * It runs every time rather than once, so rows an older version mirrored again (a rollback, then
   * this version again) go too; with nothing to drop it's one small query per linked person. It's
   * local only (the stored Inbox id and each row's last known project), so it needs neither Todoist
   * nor the tokens. A person whose Inbox isn't known yet, or whose stored Inbox id isn't one of
   * their projects (stale or damaged, which could otherwise drop their whole list), is skipped,
   * and tried again next start. Logs counts only, and only when it did or skipped something.
   */
  cleanUpOutOfScopeRows(): { people: number; skipped: number; dropped: number; keptChores: number } {
    const result = this.deps.db.transaction((tx) => {
      const counts = { people: 0, skipped: 0, dropped: 0, keptChores: 0 };
      for (const state of tx.select().from(todoistState).all()) {
        const inbox = state.inboxProjectId;
        if (!inbox || !Object.hasOwn(state.projects, inbox)) {
          counts.skipped++;
          continue;
        }
        counts.people++;
        const outside = tx.select().from(todos)
          .where(and(
            eq(todos.ownerUserId, state.userId),
            eq(todos.backend, 'todoist'),
            isNull(todos.deletedAt),
            isNotNull(todos.todoistProjectId),
            ne(todos.todoistProjectId, inbox),
          ))
          .all();
        for (const row of outside) {
          if (isChoreLinked(tx, row)) {
            counts.keptChores++;
            continue;
          }
          tx.delete(todos).where(eq(todos.id, row.id)).run();
          counts.dropped++;
        }
      }
      return counts;
    });
    if (result.dropped > 0 || result.skipped > 0) this.deps.logger.info(result, 'todoist: dropped rows from outside the Inbox');
    return result;
  }

  /** Where chore to-dos go (spec §10.6). Null means Inbox. The project must be one of the person's. */
  setChoresProject(userId: number, projectId: string | null): void {
    const state = this.state(userId);
    if (!state) throw new AppError('not_found', TODOIST_MESSAGES.notLinked);
    if (projectId !== null && !Object.hasOwn(state.projects, projectId)) throw new AppError('validation', "That project isn't in your Todoist.");
    // Picking a project, Inbox included, answers the note about a lost one.
    this.deps.db.update(todoistState).set({ choresProjectId: projectId, choresProjectLost: null, updatedAt: this.deps.clock.now() }).where(eq(todoistState.userId, userId)).run();
  }

  // ---- Task writes (TodoistBackend). Spec §10.6: changes go to Todoist first; the mirror is
  // updated from Todoist's response, and a failed write changes nothing locally. Each write is a
  // `/sync` request carrying the command and the incremental sync, so the response brings the
  // command's result and everything else that changed. Rows still `internal` (open to-dos from
  // before linking that haven't moved yet) are moved into Todoist first ("adopted"). Rows that
  // stay internal (completed history, or ones Todoist refused to take) are changed locally.

  /**
   * `item_add`. A chore's to-do goes into the chores project (spec §10.6), anything else into Inbox.
   *
   * A chore's to-do is created by the retry job as well as by a request, so its command is stable:
   * the uuid and temp id come from the link's uuid seed, the connection, the occurrence and its
   * createdAt, and a generation (how many to-dos that occurrence has had deleted), which changes
   * exactly when the occurrence needs a new to-do (see `stableUuid`). A create whose response was lost is sent again unchanged, Todoist won't run it
   * twice, and the task it made is recognized (`claimTask`) instead of being made again.
   */
  createTask(ownerId: number, todo: NewTodo): Promise<TodoItem> {
    return this.withSession(ownerId, async (s) => {
      const chore = todo.choreOccurrenceId;
      if (chore !== null && this.liveChoreTodo(chore)) throw new AppError('conflict', 'That chore already has a to-do.');
      const projectId = this.projectFor(s, chore !== null);
      const args = addArgs(todo, projectId);
      let cmd: SyncCommand;
      if (chore === null) {
        cmd = { type: 'item_add', uuid: randomUUID(), temp_id: randomUUID(), args };
      } else {
        // The occurrence's createdAt tells apart an occurrence id handed out again after a restore.
        const parts = [s.state.uuidSeed, s.conn.id, chore, this.occurrenceCreatedAt(chore), this.deletedChoreTodos(chore)];
        cmd = { type: 'item_add', uuid: stableUuid('chore-add', ...parts), temp_id: stableUuid('chore-add-temp', ...parts), args };
      }
      // A random uuid is never replayed, so only its mapping can name its task.
      const attemptedAt = chore === null ? this.deps.clock.now() : this.createAttemptedAt(s, cmd.uuid);
      const own = new Set<number>();
      let rowId = 0;
      let orphan: string | null = null;
      let unconfirmed = false;
      let lookup: LostCreateLookup | null = null;
      try {
        await this.send(s, [cmd], own, (tx, res) => {
          const claim = this.claimTask(tx, s, res, cmd, { exceptRowId: 0, title: todo.title, projectId, dueDate: todo.dueDate, attemptedAt, lookup });
          // Not thrown here: the rest of the response is still applied. In the Inbox that includes
          // the task this create made, if it's listed, so the next replay can claim it as a copy.
          // Outside the Inbox the sync leaves it out, and the next replay looks it up again.
          if (!claim) {
            unconfirmed = true;
            return;
          }
          const now = this.deps.clock.now();
          try {
            rowId = tx.insert(todos)
              .values({
                ...todo, ownerUserId: ownerId, backend: 'todoist', todoistTaskId: claim.taskId, todoistAccountId: s.state.todoistUserId, todoistProjectId: projectId, completedAt: claim.completedAt, createdAt: now, updatedAt: now,
              })
              .returning({ id: todos.id })
              .get().id;
          } catch (err) {
            // Another request linked a to-do to this occurrence while ours was out.
            if (!isUniqueViolation(err)) throw err;
            orphan = claim.taskId;
            throw new AppError('conflict', 'That chore already has a to-do.');
          }
          own.add(rowId);
          if (chore !== null) this.forgetCreateAttempt(tx, ownerId, cmd.uuid);
        }, async (res) => {
          lookup = await this.lostCreateLookup(s, res, cmd, projectId);
        });
      } catch (err) {
        if (orphan) await this.call(s, [{ type: 'item_delete', uuid: randomUUID(), args: { id: orphan } }]).catch(() => {});
        if (chore !== null && (orphan || (err instanceof AppError && err.message === TODOIST_MESSAGES.rejected))) {
          this.forgetCreateAttempt(this.deps.db, ownerId, cmd.uuid);
        }
        throw err;
      }
      if (unconfirmed) throw new AppError('integration_unavailable', "Todoist didn't confirm the new to-do. Refresh to see whether it was added.");
      return this.ownResult(s, ownerId, rowId);
    });
  }

  /**
   * What a write returns for its own row: the row as the response left it, or, if the response
   * showed its task outside the mirror's scope (moved out of the Inbox in Todoist meanwhile) and
   * the mirror dropped it, the row as it was just before. The write went through either way.
   * Throws `not_found` when the row is gone for any other reason.
   */
  private ownResult(s: Session, ownerId: number, id: number): TodoItem {
    const row = this.liveRow(ownerId, id);
    if (row) return toTodoItem(row);
    const dropped = s.dropped.get(id);
    if (dropped) return dropped;
    throw notFound();
  }

  /**
   * `item_update` with only the fields that changed. A repeating task's date can't be changed here:
   * sending a plain date would drop its repeat rule, so that's a validation error. A fixed-timezone
   * task keeps its zone when its time changes. It never sends a project: editing a to-do here
   * leaves it where it is in Todoist.
   */
  updateTask(ownerId: number, id: number, changes: TodoChanges): Promise<TodoItem> {
    return this.withSession(ownerId, async (s) => {
      let row = this.liveRow(ownerId, id);
      if (!row) throw notFound();
      if (isLocalOnly(row)) return this.updateLocal(row, changes);
      if (row.backend === 'internal') {
        const moved = await this.adopt(s, row);
        if (!moved) return this.updateLocal(this.liveRow(ownerId, id)!, changes);
        row = moved;
      }
      const next = {
        title: changes.title ?? row.title,
        notes: changes.notes !== undefined ? changes.notes : row.notes,
        dueDate: changes.dueDate !== undefined ? changes.dueDate : row.dueDate,
        dueTime: changes.dueTime !== undefined ? changes.dueTime : row.dueTime,
      };
      const args: Record<string, unknown> = { id: row.todoistTaskId };
      if (next.title !== row.title) args.content = next.title;
      if (next.notes !== row.notes) args.description = next.notes ?? '';
      if (next.dueDate !== row.dueDate || next.dueTime !== row.dueTime) {
        if (row.todoistRecurring) throw new AppError('validation', 'This to-do repeats in Todoist. Change its date in Todoist.');
        const zone = row.todoistDueTimezone;
        args.due = dueToTodoist(next.dueDate, next.dueTime, zone ? { timeZone: zone, familyTimeZone: getFamilySettings(this.deps.db).timeZone } : undefined);
      }
      if (Object.keys(args).length === 1) return toTodoItem(row);
      const target = row;
      await this.sendForRow(s, target, [{ type: 'item_update', uuid: randomUUID(), args }], (tx) => {
        tx.update(todos)
          .set({ ...next, todoistDueTimezone: next.dueTime ? target.todoistDueTimezone : null, updatedAt: this.deps.clock.now() })
          .where(eq(todos.id, target.id))
          .run();
      });
      // Deleted in Todoist while the edit was out: reported as a remote change, and `not_found`.
      // Moved out of the Inbox meanwhile: dropped from the mirror, and the edit is still answered.
      return this.ownResult(s, ownerId, id);
    });
  }

  /**
   * `item_close`, which does what Todoist's own check-off does (spec §10.6): a regular task is
   * completed; a repeating one moves to its next date and stays open. Returns the completed item,
   * or null when nothing was completed: already completed (decided from the mirror, because
   * Todoist answers "ok" to closing a closed task), missing, or a repeating task that was
   * rescheduled (TodoService then returns it, open, with its new date, and emits no event).
   */
  closeTask(ownerId: number, id: number, completedAt: Date): Promise<TodoItem | null> {
    return this.withSession(ownerId, async (s) => {
      let row = this.liveRow(ownerId, id);
      if (!row || row.completedAt !== null) return null;
      if (row.backend === 'internal') {
        const moved = isLocalOnly(row) ? null : await this.adopt(s, row);
        if (!moved) return this.setCompletedLocal(row, completedAt);
        // A relink found it already checked off in Todoist (reported as Todoist's completion).
        if (moved.completedAt !== null) return null;
        row = moved;
      }
      const target = row;
      await this.sendForRow(s, target, [{ type: 'item_close', uuid: randomUUID(), args: { id: target.todoistTaskId } }], (tx, res) => {
        // What closing did is decided by the response: the mirror's repeat flag may be out of date
        // (the task was made repeating in Todoist, or stopped repeating). The item is in the
        // response when the close changed it (verified live). Only if it isn't does the mirror's
        // flag decide. Either way the completion is this write's own result, not a remote change.
        const item = res.items.find((i) => i.id === target.todoistTaskId);
        const completes = item ? item.checked : !target.todoistRecurring;
        if (completes) tx.update(todos).set({ completedAt, updatedAt: this.deps.clock.now() }).where(eq(todos.id, target.id)).run();
      });
      const after = this.liveRow(ownerId, id);
      if (after) return after.completedAt !== null ? toTodoItem(after) : null;
      // Dropped because its task left the Inbox meanwhile: the close went through, so it answers
      // with the row as it was just before, completed or not (a repeating task stays open). There's
      // no row left to read back, and null would make TodoService answer 404.
      return s.dropped.get(id) ?? null;
    });
  }

  /** `item_uncomplete`. A completed row that was never in Todoist is moved there, open. */
  reopenTask(ownerId: number, id: number): Promise<TodoItem | null> {
    return this.withSession(ownerId, async (s) => {
      let row = this.liveRow(ownerId, id);
      if (!row || row.completedAt === null) return null;
      if (row.backend === 'internal') {
        const moved = row.todoistMoveError === null ? await this.adopt(s, row) : null;
        if (!moved) return this.setCompletedLocal(row, null);
        // Added as a new task, or a relink found its task open in Todoist: open either way.
        if (moved.completedAt === null) return toTodoItem(moved);
        // A relink found its task completed in Todoist: reopen it there.
        row = moved;
      }
      const target = row;
      await this.sendForRow(s, target, [{ type: 'item_uncomplete', uuid: randomUUID(), args: { id: target.todoistTaskId } }], (tx) => {
        tx.update(todos).set({ completedAt: null, updatedAt: this.deps.clock.now() }).where(eq(todos.id, target.id)).run();
      });
      const after = this.liveRow(ownerId, id);
      if (after) return after.completedAt === null ? toTodoItem(after) : null;
      // Dropped because its task left the Inbox meanwhile: the reopen went through, so it answers
      // with the row as it was just before (see `closeTask`).
      return s.dropped.get(id) ?? null;
    });
  }

  /**
   * `item_delete` (which also deletes subtasks; their rows go with the next response). A task
   * that's already gone from Todoist counts as deleted. A row that was never in Todoist is just
   * deleted here.
   *
   * An internal row whose move into Todoist was sent but never settled (its response was lost)
   * may have a task in Todoist. The move is replayed first, which is safe (same uuid); if that
   * names the task, the task is deleted in Todoist too. If it doesn't (Todoist is down, or the
   * replay has no mapping and there's no copy to claim), the row is deleted here anyway, as the
   * person asked, and the possible orphan in Todoist is logged.
   */
  deleteTask(ownerId: number, id: number): Promise<TodoItem> {
    return this.withSession(ownerId, async (s) => {
      let row = this.liveRow(ownerId, id);
      if (!row) throw notFound();
      const deleteRow = (tx: Tx | Db, rowId: number) => {
        const now = this.deps.clock.now();
        tx.update(todos).set({ deletedAt: now, updatedAt: now }).where(eq(todos.id, rowId)).run();
      };
      if (row.backend === 'internal') {
        const unsettled = row.todoistMoveAttemptedAt !== null && row.completedAt === null && (row.todoistMoveError === null || row.todoistMoveError === 'unconfirmed');
        const moved = unsettled ? await this.adopt(s, row).catch((err: unknown) => {
          // Its task was deleted in Todoist, and the row with it: that's what was asked.
          if (err instanceof AppError && err.code === 'not_found') return 'gone' as const;
          if (err instanceof AppError && err.code === 'integration_unavailable') return null;
          throw err;
        }) : null;
        if (moved === 'gone') return toTodoItem(row);
        if (!moved) {
          if (unsettled) this.deps.logger.warn({ userId: ownerId, todoId: row.id }, 'deleted a to-do whose move into todoist never settled; its task may be left in todoist');
          deleteRow(this.deps.db, row.id);
          return toTodoItem(row);
        }
        row = moved;
      }
      const target = row;
      await this.sendForRow(s, target, [{ type: 'item_delete', uuid: randomUUID(), args: { id: target.todoistTaskId } }], (tx) => deleteRow(tx, target.id), false);
      return toTodoItem(target);
    });
  }

  /**
   * Runs `fn` under the user's lock with an open session, then reports remote changes. A
   * `TaskGone` is internal: every caller should have turned it into a result, but if one slips
   * out, it's a refused change, never a 500.
   */
  private async withSession<T>(userId: number, fn: (s: Session) => Promise<T>): Promise<T> {
    const changes: RemoteChange[] = [];
    try {
      return await this.lock.run(userId, () => fn(this.open(userId, changes)));
    } catch (err) {
      if (err instanceof TaskGone) throw new AppError('integration_unavailable', TODOIST_MESSAGES.rejected);
      throw err;
    } finally {
      await this.report(userId, changes);
    }
  }

  /** Hands remote changes to the listener. Called after the lock is released. */
  private async report(userId: number, changes: RemoteChange[]): Promise<void> {
    if (changes.length === 0 || !this.listener) return;
    try {
      await this.listener(changes);
    } catch (err) {
      // Only the error's name and code: a Drizzle error quotes the query's values (task titles).
      this.deps.logger.error({ userId, ...loggableError(err) }, 'reporting todoist changes failed');
    }
  }

  /**
   * Loads the connection and decrypts its credentials. With the wrong key (the key check failed at
   * startup) nothing is written. With the right key, a row that still won't decrypt was damaged or
   * moved, and reconnecting is the fix (spec §14).
   */
  private open(userId: number, changes: RemoteChange[]): Session {
    if (this.keyMismatchNow) throw new AppError('integration_unavailable', TODOIST_MESSAGES.keyMismatch);
    const conn = this.connection(userId);
    const state = this.state(userId);
    if (!conn || !state) throw new AppError('integration_unavailable', TODOIST_MESSAGES.notLinked);
    if (conn.status === 'needs_reconnect') throw new AppError('integration_unavailable', TODOIST_MESSAGES.reconnect);
    let creds: TodoistCredentials;
    try {
      creds = CredentialsSchema.parse(decryptCredentials(this.deps.keyring, conn));
    } catch (err) {
      // Only the error's name: a JSON or zod message could quote the decrypted text.
      this.deps.logger.error({ userId, error: err instanceof Error ? err.name : 'unknown' }, "todoist credentials couldn't be decrypted");
      recordConnectionFailure(this.deps.db, conn, this.deps.clock.now(), "The saved Todoist sign-in couldn't be read. Reconnect Todoist.", true);
      throw new AppError('integration_unavailable', TODOIST_MESSAGES.reconnect);
    }
    return { userId, conn, creds, state, changes, dropped: new Map() };
  }

  private saveCredentials(s: Session): void {
    const now = this.deps.clock.now();
    this.deps.db
      .update(connections)
      .set({ credentialsEnc: encryptCredentials(this.deps.keyring, s.conn, s.creds), updatedAt: now })
      .where(eq(connections.id, s.conn.id))
      .run();
  }

  /** The access token, refreshed first if it's about to expire. */
  private async accessToken(s: Session): Promise<string> {
    const { expiresAt, refreshToken } = s.creds;
    if (expiresAt !== null && refreshToken && expiresAt - this.deps.clock.now().getTime() < REFRESH_AHEAD_MS) {
      await this.refreshTokens(s);
    }
    return s.creds.accessToken;
  }

  /**
   * Refreshes under the lock, so it's single-flight per user, and stores the result before using
   * it. Refresh tokens rotate, and presenting a used one again more than 60 seconds later revokes
   * every token the user has for this app (research notes §1): the lock and the immediate save are
   * what prevent that. A response with no refresh token is the 60-second replay grace: the old
   * refresh token is used up, so it isn't kept. The new access token works until it expires, and
   * then the link needs reconnecting, cleanly, instead of a later refresh with a used token
   * revoking everything. `invalid_grant` means the grant is gone, so the link needs reconnecting.
   */
  private async refreshTokens(s: Session): Promise<void> {
    const refreshToken = s.creds.refreshToken;
    if (!refreshToken) throw this.failure(s, new TodoistHttpError('auth', 401, 'No refresh token'));
    let next;
    try {
      next = await this.client.refresh(refreshToken, this.deps.clock.now());
    } catch (err) {
      if (err instanceof TodoistOAuthError && err.code === 'invalid_grant') {
        this.deps.logger.warn({ userId: s.userId, code: err.code }, 'todoist refused the refresh token');
        throw this.failure(s, new TodoistHttpError('auth', err.status, 'invalid_grant'));
      }
      throw this.failure(s, err);
    }
    s.creds = { accessToken: next.accessToken, refreshToken: next.refreshToken, expiresAt: next.expiresAt?.getTime() ?? null };
    this.saveCredentials(s);
    this.deps.logger.info({ userId: s.userId, rotated: next.refreshToken !== null }, 'todoist token refreshed');
  }

  /**
   * Records a failed call on the connection and returns the error to throw: `integration_unavailable`
   * with a plain message. Authorization failures set `needs_reconnect`.
   */
  private failure(s: Session, err: unknown): AppError {
    if (err instanceof AppError) return err;
    const conn = this.connection(s.userId) ?? s.conn;
    const now = this.deps.clock.now();
    if (err instanceof TodoistHttpError) {
      const auth = err.kind === 'auth';
      this.deps.logger.warn({ userId: s.userId, kind: err.kind, status: err.status, retryAfterSec: err.retryAfterSec }, 'todoist request failed');
      recordConnectionFailure(this.deps.db, conn, now, auth ? 'Todoist stopped accepting the saved sign-in.' : err.message, auth);
      return new AppError('integration_unavailable', auth ? TODOIST_MESSAGES.reconnect : err.kind === 'rate_limited' ? TODOIST_MESSAGES.busy : TODOIST_MESSAGES.unreachable);
    }
    this.deps.logger.warn({ userId: s.userId, error: err instanceof Error ? err.name : 'unknown' }, 'todoist request failed');
    recordConnectionFailure(this.deps.db, conn, now, 'Todoist returned an unexpected error.', false);
    return new AppError('integration_unavailable', TODOIST_MESSAGES.unreachable);
  }

  /**
   * Runs one authenticated request. On a 401 it refreshes once and retries (the docs say not to
   * retry with the expired token). A 403 isn't refreshed: a new access token has the same grant,
   * so it can't fix a missing scope or a revoked app (an HTTP-level 403 still sets
   * `needs_reconnect`, in `failure`). Failures are recorded on the connection. Success isn't: a
   * sync response counts once it's applied (`apply`).
   */
  private async authed<T>(s: Session, request: (accessToken: string) => Promise<T>): Promise<T> {
    let token = await this.accessToken(s);
    for (let attempt = 0; ; attempt++) {
      try {
        return await request(token);
      } catch (err) {
        if (err instanceof TodoistHttpError && err.kind === 'auth' && err.status === 401 && attempt === 0 && s.creds.refreshToken) {
          await this.refreshTokens(s);
          token = s.creds.accessToken;
          continue;
        }
        throw this.failure(s, err);
      }
    }
  }

  /** One `/sync` request: incremental from the stored token (or full), with any commands. */
  private call(s: Session, commands: SyncCommand[], full = false): Promise<SyncResponse> {
    const syncToken = full || !s.state.syncToken ? '*' : s.state.syncToken;
    return this.authed(s, (token) => this.client.sync(token, { syncToken, commands }));
  }

  /**
   * Applies a response in one transaction, keeps the session's state current, and only then marks
   * the connection `ok`. If applying throws (a bug, a constraint), nothing is saved, so the stored
   * sync token doesn't move, and the failure is recorded: the link mustn't show `ok` while its
   * token is stuck.
   */
  private apply(s: Session, res: SyncResponse, requestedFull: boolean, ownRowIds: ReadonlySet<number>, before?: (tx: Parameters<Parameters<Db['transaction']>[0]>[0]) => void): ApplySummary {
    const now = this.deps.clock.now();
    const timeZone = getFamilySettings(this.deps.db).timeZone;
    let summary: ApplySummary;
    try {
      summary = this.deps.db.transaction((tx) => {
        before?.(tx);
        return applySyncResponse(tx, { userId: s.userId, timeZone, now, requestedFull, ownRowIds }, res);
      });
    } catch (err) {
      throw this.applyFailure(s, err, now);
    }
    recordConnectionSuccess(this.deps.db, s.conn.id, now);
    s.state = this.state(s.userId)!;
    s.changes.push(...summary.changes);
    for (const item of summary.dropped) s.dropped.set(item.id, item);
    this.logApplied(s, summary, res);
    return summary;
  }

  /**
   * Saving what Todoist sent failed (a bug, a constraint): recorded on the connection, so the link
   * doesn't show `ok` while nothing moves, and returned as a plain error to throw. An AppError
   * thrown on purpose inside the transaction is passed through.
   */
  private applyFailure(s: Session, err: unknown, now: Date): AppError {
    if (err instanceof AppError) return err;
    // Only the error's name and SQLite's code: Drizzle's message quotes the query's values, which
    // are people's task titles and notes.
    this.deps.logger.error({ userId: s.userId, error: err instanceof Error ? err.name : 'unknown', sqliteCode: sqliteCode(err) }, "couldn't apply a todoist sync response");
    recordConnectionFailure(this.deps.db, this.connection(s.userId) ?? s.conn, now, "Couldn't save what Todoist sent. It will be tried again.", false);
    return new AppError('integration_unavailable', TODOIST_MESSAGES.unreachable);
  }

  /**
   * Counts only, never content. These lines confirm, in the app's own traffic, that incremental
   * syncs report deletions (`deletedSeen`) and completions (`checkedSeen`), and how many rows a
   * full sync didn't list (`missing`; normally 0, since an incremental sync runs first).
   * `dropped` counts rows whose task left the Inbox, and `outOfScope` items from other projects
   * that were left out (see mirror.ts).
   */
  private logApplied(s: Session, summary: ApplySummary, res: SyncResponse): void {
    this.deps.logger.info(
      {
        userId: s.userId,
        full: summary.full,
        items: summary.items,
        deletedSeen: summary.deletedSeen,
        checkedSeen: summary.checkedSeen,
        missing: summary.missing.length,
        dropped: summary.dropped.length,
        outOfScope: summary.outOfScope,
        changes: summary.changes.length,
        skipped: res.skipped,
        projects: res.projects.length,
      },
      'todoist sync applied',
    );
  }

  /**
   * One sync under the lock:
   * 1. Incremental, from the stored token (when there is one). It reports completions and
   *    deletions, which a full sync can't tell apart, so they're applied first.
   * 2. A full sync, when there's no token yet or the last one finished more than
   *    FULL_SYNC_EVERY_MS ago (or when Todoist answered step 1 with `full_sync: true`), unless an
   *    earlier full sync's lookups are still in progress. It rebuilds the project names, and the
   *    open rows it doesn't list are queued to be looked up (`startLookups`). A full sync whose
   *    snapshot is more than a minute old is followed by another incremental one (research notes §2).
   * 3. Up to CONFIRM_PER_SYNC queued lookups (`confirmMissing`). The full sync counts as done
   *    (`last_full_sync_at`) once every queued row has been tried once, so it always finishes:
   *    only a failed request or the per-sync cap carries lookups over to the next sync.
   */
  private async syncLocked(s: Session): Promise<void> {
    const now = this.deps.clock.now();
    this.pruneCreateAttempts(s, now);
    let full = false;
    if (s.state.syncToken) {
      const res = await this.call(s, []);
      const summary = this.apply(s, res, false, new Set());
      if (summary.full) {
        full = true;
        await this.afterFullSync(s, res, summary, now);
      }
    }
    const fullDue = !s.state.lastFullSyncAt || now.getTime() - s.state.lastFullSyncAt.getTime() >= FULL_SYNC_EVERY_MS;
    // Lookups that have dragged on for a day start over with a fresh full sync.
    const lookupsStale = s.state.lookupsSnapshotAt !== null && now.getTime() - s.state.lookupsSnapshotAt.getTime() >= FULL_SYNC_EVERY_MS;
    if (!full && fullDue && (s.state.lookupsSnapshotAt === null || lookupsStale)) {
      const res = await this.call(s, [], true);
      await this.afterFullSync(s, res, this.apply(s, res, true, new Set()), now);
    }
    if (s.state.lookupsSnapshotAt !== null && (await this.confirmMissing(s))) this.markFullSync(s);
  }

  /**
   * After any full sync response, asked for or not: if its snapshot is more than a minute old, an
   * incremental sync catches up on what changed since (research notes §2). Then the rows it didn't
   * list are queued for lookup.
   */
  private async afterFullSync(s: Session, res: SyncResponse, summary: ApplySummary, now: Date): Promise<void> {
    const snapshot = snapshotOf(res, now);
    if (now.getTime() - snapshot.getTime() > 60_000) this.apply(s, await this.call(s, []), false, new Set());
    this.startLookups(s, summary.missing, snapshot);
  }

  /** Queues the rows a full sync didn't list for `confirmMissing`, replacing any earlier queue. */
  private startLookups(s: Session, missing: TodoRow[], snapshotAt: Date): void {
    this.deps.db.update(todoistState)
      .set({ pendingLookups: missing.map((r) => r.id), lookupsSnapshotAt: snapshotAt })
      .where(eq(todoistState.userId, s.userId))
      .run();
    s.state = this.state(s.userId)!;
  }

  /**
   * Works through the queued lookups of rows a full sync didn't list, one `GET /api/v1/tasks/{id}`
   * each (verified live: 200 with `checked: true` is completed, 200 with `checked: false` is open
   * after all, 404 NOT_FOUND is deleted). Open or completed in another project, for a row that
   * isn't chore-linked, means it left the Inbox: dropped quietly (`applyConfirmation`), never
   * taken for a deletion. Any answer counts as tried, including one that tells
   * nothing (another 4xx: the row is left alone until the next daily full sync). A row that's been
   * heard from since the snapshot, or isn't an open mirror row any more, is dropped without a
   * lookup.
   *
   * At most CONFIRM_PER_SYNC lookups, and none after CONFIRM_DEADLINE_MS. A request that fails
   * (Todoist down, rate-limited) stops them. Either way the rest stay queued, in order, for the
   * next sync. Returns true when the queue is empty.
   */
  private async confirmMissing(s: Session): Promise<boolean> {
    const queue = s.state.pendingLookups;
    const snapshotAt = s.state.lookupsSnapshotAt!;
    const started = this.deps.clock.now().getTime();
    const counts = { completed: 0, deleted: 0, open: 0, dropped: 0, unknown: 0, settled: 0, left: 0 };
    let next = 0;
    let looked = 0;
    const save = () => {
      const left = queue.slice(next);
      counts.left = left.length;
      this.deps.db.update(todoistState).set({ pendingLookups: left }).where(eq(todoistState.userId, s.userId)).run();
      s.state = this.state(s.userId)!;
      if (queue.length > 0) this.deps.logger.info({ userId: s.userId, ...counts }, 'todoist full sync: looked up tasks it did not list');
    };
    try {
      for (; next < queue.length; next++) {
        const row = this.deps.db.select().from(todos).where(eq(todos.id, queue[next]!)).get();
        if (!row || row.ownerUserId !== s.userId || !isUnsettledMirrorRow(row, snapshotAt)) {
          counts.settled++;
          continue;
        }
        if (looked >= CONFIRM_PER_SYNC || this.deps.clock.now().getTime() - started >= CONFIRM_DEADLINE_MS) break;
        looked++;
        let found;
        try {
          found = await this.authed(s, async (token) => {
            try {
              return await this.client.getTask(token, row.todoistTaskId!);
            } catch (err) {
              // A 4xx about this one task (e.g. 400 for an id Todoist doesn't accept, or a 403 for
              // a task the person can't see any more) isn't a connection problem.
              if (err instanceof TodoistHttpError && err.kind === 'rejected') return null;
              throw err;
            }
          });
        } catch (err) {
          if (err instanceof AppError && err.message === TODOIST_MESSAGES.reconnect) throw err;
          break;
        }
        if (!found) {
          counts.unknown++;
          continue;
        }
        const timeZone = getFamilySettings(this.deps.db).timeZone;
        const now = this.deps.clock.now();
        let applied;
        try {
          applied = this.deps.db.transaction((tx) => applyConfirmation(tx, { timeZone, now }, row.id, found));
        } catch (err) {
          // Like `apply`: recorded, and a plain error. The row stays queued.
          throw this.applyFailure(s, err, now);
        }
        if (!applied) {
          counts.settled++;
          continue;
        }
        if (applied.change) s.changes.push(applied.change);
        // Open or completed in another project: it left the Inbox, so it's dropped, never deleted.
        counts[applied.dropped ? 'dropped' : found.state]++;
      }
    } finally {
      save();
    }
    return s.state.pendingLookups.length === 0;
  }

  private markFullSync(s: Session): void {
    const now = this.deps.clock.now();
    this.deps.db.update(todoistState)
      .set({ lastFullSyncAt: now, lookupsSnapshotAt: null, pendingLookups: [], updatedAt: now })
      .where(eq(todoistState.userId, s.userId))
      .run();
    s.state = this.state(s.userId)!;
  }

  /**
   * Sends commands with the incremental sync and applies the response in one transaction:
   * `local` first (the command's expected effect on its own row), then the response. `prepare`
   * runs in between, before the transaction, for requests `local` depends on; if it throws, the
   * response isn't applied and the stored sync token doesn't move, so nothing is lost. Rows in
   * `own` are passed on as this write's own rows only if the command succeeded (see
   * `ApplyContext.ownRowIds`). If a command failed, `local` is skipped, the rest of the response is
   * still applied (those changes are real), and the failure is thrown: an auth error sets
   * `needs_reconnect`, a missing task is `TaskGone`, anything else is a plain
   * `integration_unavailable`.
   */
  private async send(
    s: Session,
    commands: SyncCommand[],
    own: ReadonlySet<number>,
    local?: (tx: Tx, res: SyncResponse) => void,
    prepare?: (res: SyncResponse) => Promise<void>,
  ): Promise<SyncResponse> {
    const res = await this.call(s, commands);
    const failed = commands.find((c) => res.syncStatus[c.uuid] !== 'ok');
    // Requests `local` needs answered first (a lost create's lookup), outside the transaction.
    if (!failed && prepare) await prepare(res);
    this.apply(s, res, !s.state.syncToken, failed ? new Set() : own, failed ? undefined : (tx) => local?.(tx, res));
    if (!failed) return res;
    const status = res.syncStatus[failed.uuid];
    const err = status && status !== 'ok' ? status : { error: 'No status for the command' };
    this.deps.logger.warn(
      { userId: s.userId, command: failed.type, errorTag: err.error_tag, errorCode: err.error_code, httpCode: err.http_code },
      'todoist command failed',
    );
    const kind = classifyCommandError(err);
    if (kind === 'auth') throw this.commandAuthFailure(s);
    // An item_add names no existing task, so "not found" there is about something else (its
    // project, say): Todoist refused it.
    if (kind === 'not_found' && failed.type !== 'item_add') throw new TaskGone();
    throw new AppError('integration_unavailable', TODOIST_MESSAGES.rejected);
  }

  private commandAuthFailure(s: Session): AppError {
    recordConnectionFailure(this.deps.db, this.connection(s.userId) ?? s.conn, this.deps.clock.now(), 'Todoist stopped accepting the saved sign-in.', true);
    return new AppError('integration_unavailable', TODOIST_MESSAGES.reconnect);
  }

  /**
   * `send` for a command on one mirror row. If Todoist says the task is gone, the row is removed
   * here too; with `reportGone` (every command but a delete) that's reported as a remote deletion
   * and the call throws `not_found`, since what the person tried can't happen.
   */
  private async sendForRow(s: Session, row: TodoRow, commands: SyncCommand[], local: (tx: Tx, res: SyncResponse) => void, reportGone = true): Promise<void> {
    try {
      await this.send(s, commands, new Set([row.id]), local);
    } catch (err) {
      if (!(err instanceof TaskGone)) throw err;
      const now = this.deps.clock.now();
      const { changes } = this.deps.db.update(todos).set({ deletedAt: now, updatedAt: now }).where(and(eq(todos.id, row.id), isNull(todos.deletedAt))).run();
      if (!reportGone) return;
      // If the same response listed the task as deleted, the mirror already removed the row and
      // reported it: once is enough.
      if (changes === 1) s.changes.push({ before: toTodoItem(row), after: null });
      throw notFound();
    }
  }

  /**
   * The Todoist task for an `item_add` that went through: from `temp_id_mapping`, or, when a
   * replayed command comes back without one (UNVERIFIED), from the copy an earlier sync mirrored
   * of the task it made (`findOrphanCopy`, among rows first inserted after `attemptedAt`). That
   * copy is dropped silently: it was this to-do all along. Its completion is handed back, so the
   * caller keeps it (the task may have been checked off in Todoist meanwhile).
   *
   * A task outside the Inbox (a chore to-do in a chores project that isn't the Inbox) has no
   * mirror copy, since syncs leave those out. For those, the caller looked the project's tasks up
   * in Todoist before this transaction (`lostCreateLookup`), and `matchLostCreate` picks the one
   * task with the same title and due date, added since the first attempt, that no live row has.
   * Two or more matches, or a list that didn't come back whole, are ambiguous: nothing is claimed,
   * and only counts are logged.
   *
   * Null when there's no telling; the caller leaves things as they were, to be tried again.
   */
  private claimTask(
    tx: Tx,
    s: Session,
    res: SyncResponse,
    cmd: SyncCommand,
    p: { exceptRowId: number; title: string; projectId: string | null; dueDate: string | null; attemptedAt: Date; lookup: LostCreateLookup | null },
  ): { taskId: string; completedAt: Date | null } | null {
    const mapped = res.tempIdMapping[cmd.temp_id!];
    const copy = mapped
      ? mirrorRow(tx, s.userId, mapped)
      : findOrphanCopy(tx, { userId: s.userId, exceptRowId: p.exceptRowId, title: p.title, projectId: p.projectId, attemptedAt: p.attemptedAt });
    if (!mapped && !copy && p.lookup && p.projectId !== null) {
      const { match, candidates } = matchLostCreate(tx, { userId: s.userId, items: p.lookup.items, title: p.title, projectId: p.projectId, dueDate: p.dueDate, attemptedAt: p.attemptedAt });
      if (match && p.lookup.complete) return { taskId: match.id, completedAt: null };
      if (candidates > 1 || !p.lookup.complete) {
        this.deps.logger.warn({ userId: s.userId, candidates, complete: p.lookup.complete }, "todoist couldn't tell which task a lost create made; nothing claimed");
      }
      return null;
    }
    const taskId = mapped ?? copy?.todoistTaskId ?? null;
    if (!taskId) return null;
    const claimed = copy && copy.id !== p.exceptRowId ? copy : null;
    if (claimed) {
      const now = this.deps.clock.now();
      tx.update(todos).set({ deletedAt: now, updatedAt: now }).where(eq(todos.id, claimed.id)).run();
    }
    return { taskId, completedAt: claimed?.completedAt ?? null };
  }

  /**
   * For an `item_add` that went through but came back without a `temp_id_mapping` (a replay, the
   * UNVERIFIED case), into a project outside the Inbox: that project's open tasks, from
   * `GET /api/v1/tasks` (`TodoistClient.listTasks`), for `claimTask` to match. Fetched before the
   * apply transaction, since it's a request. Null when there's nothing to look up: the command
   * failed, it has a mapping, or its project is the Inbox (whose copy a sync mirrors, and
   * `findOrphanCopy` finds). A 4xx is null too (nothing can be claimed); any other failure throws,
   * so the response isn't applied and the replay is simply tried again later.
   */
  private async lostCreateLookup(s: Session, res: SyncResponse, cmd: SyncCommand, projectId: string | null): Promise<LostCreateLookup | null> {
    if (res.syncStatus[cmd.uuid] !== 'ok' || res.tempIdMapping[cmd.temp_id!] !== undefined) return null;
    if (projectId === null || inInbox(projectId, s.state.inboxProjectId)) return null;
    return this.authed(s, async (token) => {
      try {
        return await this.client.listTasks(token, { projectId });
      } catch (err) {
        if (err instanceof TodoistHttpError && err.kind === 'rejected') return null;
        throw err;
      }
    });
  }

  /**
   * When a chore create's command was first sent (see `todoist_state.create_attempts`). Saved
   * before the request goes out, so a lost response still leaves it behind.
   */
  private createAttemptedAt(s: Session, uuid: string): Date {
    const known = s.state.createAttempts[uuid];
    if (known !== undefined) return new Date(known);
    const now = this.deps.clock.now();
    this.deps.db.update(todoistState).set({ createAttempts: { ...s.state.createAttempts, [uuid]: now.getTime() } }).where(eq(todoistState.userId, s.userId)).run();
    s.state = this.state(s.userId)!;
    return now;
  }

  /** Forgets chore-create attempts older than CREATE_ATTEMPT_TTL_MS, so the map can't grow forever. */
  private pruneCreateAttempts(s: Session, now: Date): void {
    const all = s.state.createAttempts;
    const kept = Object.fromEntries(Object.entries(all).filter(([, at]) => now.getTime() - at <= CREATE_ATTEMPT_TTL_MS));
    if (Object.keys(kept).length === Object.keys(all).length) return;
    this.deps.db.update(todoistState).set({ createAttempts: kept }).where(eq(todoistState.userId, s.userId)).run();
    s.state = this.state(s.userId)!;
  }

  /** The chore create settled (made, claimed, or refused): its first-attempt time isn't needed any more. */
  private forgetCreateAttempt(db: Tx | Db, userId: number, uuid: string): void {
    const state = db.select({ createAttempts: todoistState.createAttempts }).from(todoistState).where(eq(todoistState.userId, userId)).get();
    if (!state || !Object.hasOwn(state.createAttempts, uuid)) return;
    const { [uuid]: _settled, ...rest } = state.createAttempts;
    db.update(todoistState).set({ createAttempts: rest }).where(eq(todoistState.userId, userId)).run();
  }

  /**
   * Moves internal rows into Todoist (spec §10.6, "On linking"), up to 100 per request (Todoist's
   * limit per request), and converts each in place, so its id, and every chore occurrence and
   * queued action pointing at it, stay the same. Each row's command uuid and temp id come from
   * the link's uuid seed, the connection id, and the row's id and createdAt (see `stableUuid`),
   * so a request retried after a crash sends the same commands,
   * and Todoist won't run any of them twice (`claimTask` finds the tasks they made).
   *
   * A row that kept its task id from an earlier link (spec §10.6, "Relinking later") is looked up
   * first (`relinkLookups`): it's added again only if Todoist can't say what became of that task.
   *
   * Returns what happened to each row: `moved`, `gone` (its task was deleted in Todoist while
   * unlinked, so the row is deleted too), `dropped` (its task is in another project now and the row
   * isn't chore-linked, so it left the mirror's scope and was dropped, without adding it to the
   * Inbox again), or `rejected` (Todoist refused it outright; the reason is saved in
   * `todoist_move_error`, it isn't tried again, and it stays a local row). A row that's none of
   * these is left as it was, for the next try.
   */
  private async adoptMany(s: Session, rows: TodoRow[]): Promise<Map<number, 'moved' | 'rejected' | 'gone' | 'dropped'>> {
    const result = new Map<number, 'moved' | 'rejected' | 'gone' | 'dropped'>();
    const batch: TodoRow[] = [];
    for (const row of rows.slice(0, 100)) {
      // Only a task id from this same account can be looked up (see `forgetOtherAccountTasks`).
      const kept = row.todoistTaskId !== null && row.todoistAccountId === s.state.todoistUserId;
      const outcome = kept ? await this.relinkLookup(s, row) : null;
      if (outcome) result.set(row.id, outcome === 'converted' ? 'moved' : outcome);
      else batch.push(row);
    }
    if (batch.length === 0) return result;
    // Saved before anything is sent, so a lost response still leaves it behind (see `claimTask`).
    const firstTry = this.deps.clock.now();
    if (batch.length > 0) {
      this.deps.db.update(todos)
        .set({ todoistMoveAttemptedAt: firstTry })
        .where(and(inArray(todos.id, batch.map((r) => r.id)), isNull(todos.todoistMoveAttemptedAt)))
        .run();
    }
    const moves = batch.map((row) => {
      const projectId = this.projectFor(s, row.choreOccurrenceId !== null);
      const attemptedAt = row.todoistMoveAttemptedAt ?? firstTry;
      // The row's createdAt tells apart a row id handed out again after a restore.
      const parts = [s.state.uuidSeed, s.conn.id, row.id, row.createdAt.getTime()];
      const cmd: SyncCommand = {
        type: 'item_add',
        uuid: stableUuid('adopt', ...parts),
        temp_id: stableUuid('adopt-temp', ...parts),
        args: addArgs(row, projectId),
      };
      return { row, projectId, cmd, attemptedAt };
    });
    const res = await this.call(s, moves.map((m) => m.cmd));
    const statusOf = (m: (typeof moves)[number]) => res.syncStatus[m.cmd.uuid];
    const ok = moves.filter((m) => statusOf(m) === 'ok');
    // A replayed move into a project outside the Inbox with no mapping: that project's tasks are
    // looked up first, once per project, before the transaction (see `claimTask`).
    const lookups = new Map<string, LostCreateLookup | null>();
    const lookupFor = new Map<string, LostCreateLookup | null>();
    for (const m of ok) {
      if (m.projectId === null) continue;
      const key = m.projectId;
      if (!lookups.has(key)) {
        const needed = res.tempIdMapping[m.cmd.temp_id!] === undefined && !inInbox(key, s.state.inboxProjectId);
        if (!needed) continue;
        lookups.set(key, await this.lostCreateLookup(s, res, m.cmd, key));
      }
      lookupFor.set(m.cmd.uuid, lookups.get(key) ?? null);
    }
    let authFailed = false;
    this.apply(s, res, !s.state.syncToken, new Set(ok.map((m) => m.row.id)), (tx) => {
      const now = this.deps.clock.now();
      for (const m of moves) {
        const status = statusOf(m);
        if (status === 'ok') {
          const claim = this.claimTask(tx, s, res, m.cmd, {
            exceptRowId: m.row.id, title: m.row.title, projectId: m.projectId, dueDate: m.row.dueDate, attemptedAt: m.attemptedAt, lookup: lookupFor.get(m.cmd.uuid) ?? null,
          });
          if (!claim) {
            // A replay that settled nothing: no mapping, and no single copy to claim. After a few,
            // the row stays on the dashboard, changed locally, instead of failing every write.
            const replays = m.row.todoistMoveReplays + 1;
            const giveUp = replays >= MOVE_REPLAYS_BEFORE_LOCAL;
            tx.update(todos)
              .set({ todoistMoveReplays: replays, ...(giveUp ? { todoistMoveError: 'unconfirmed' } : {}), updatedAt: now })
              .where(eq(todos.id, m.row.id))
              .run();
            if (giveUp) {
              result.set(m.row.id, 'rejected');
              this.deps.logger.warn({ userId: s.userId, todoId: m.row.id, replays }, "todoist never confirmed a to-do being moved there; it stays on the dashboard");
            }
            continue;
          }
          tx.update(todos)
            .set({
              backend: 'todoist', todoistTaskId: claim.taskId, todoistAccountId: s.state.todoistUserId, todoistProjectId: m.projectId, completedAt: claim.completedAt,
              todoistMoveAttemptedAt: null, todoistMoveReplays: 0, updatedAt: now,
            })
            .where(eq(todos.id, m.row.id))
            .run();
          result.set(m.row.id, 'moved');
        } else if (status && classifyCommandError(status) === 'auth') {
          authFailed = true;
        } else if (status) {
          // Any other failure of an item_add, ITEM_NOT_FOUND included (it names no existing task).
          tx.update(todos).set({ todoistMoveError: status.error_tag ?? status.error ?? 'rejected', updatedAt: now }).where(eq(todos.id, m.row.id)).run();
          result.set(m.row.id, 'rejected');
          this.deps.logger.warn({ userId: s.userId, todoId: m.row.id, errorTag: status.error_tag }, "todoist refused a to-do being moved there; it stays on the dashboard");
        }
      }
    });
    if (authFailed) throw this.commandAuthFailure(s);
    this.deps.logger.info({ userId: s.userId, moved: [...result.values()].filter((r) => r === 'moved').length, of: moves.length }, 'moved to-dos into todoist');
    return result;
  }

  /**
   * `adoptMany` for one row: the converted row (which may be completed, if a relink found its task
   * checked off in Todoist), or null if Todoist refused it (it stays local). Throws `not_found` if
   * its task was deleted in Todoist (the row is deleted and that's reported), or if it's in another
   * project now and the row was dropped from the mirror (quietly, see `adoptMany`).
   */
  private async adopt(s: Session, row: TodoRow): Promise<TodoRow | null> {
    const result = (await this.adoptMany(s, [row])).get(row.id);
    if (result === 'rejected') return null;
    if (result === 'gone' || result === 'dropped') throw notFound();
    if (result !== 'moved') throw new AppError('integration_unavailable', "Todoist didn't confirm a to-do being moved there. It will be tried again.");
    const moved = this.liveRow(s.userId, row.id);
    if (!moved) throw notFound();
    return moved;
  }

  /**
   * Looks up the task an internal row kept from an earlier link, before it's added to Todoist
   * again (`applyRelinkLookup`): `converted`, `gone`, or `dropped` (in another project now), or
   * null when there's no telling (a 4xx, or the row changed), and it's added as a new task. A
   * failed request throws, so nothing is added while Todoist can't be asked.
   */
  private async relinkLookup(s: Session, row: TodoRow): Promise<'converted' | 'gone' | 'dropped' | null> {
    const found = await this.authed(s, async (token) => {
      try {
        return await this.client.getTask(token, row.todoistTaskId!);
      } catch (err) {
        if (err instanceof TodoistHttpError && err.kind === 'rejected') return null;
        throw err;
      }
    });
    if (!found) return null;
    const now = this.deps.clock.now();
    const timeZone = getFamilySettings(this.deps.db).timeZone;
    let applied;
    try {
      applied = this.deps.db.transaction((tx) => applyRelinkLookup(tx, { userId: s.userId, accountId: s.state.todoistUserId, timeZone, now }, row.id, found));
    } catch (err) {
      throw this.applyFailure(s, err, now);
    }
    if (!applied) return null;
    if (applied.change) s.changes.push(applied.change);
    this.deps.logger.info({ userId: s.userId, todoId: row.id, found: found.state, outcome: applied.outcome }, 'todoist relink: looked up a task kept from the earlier link');
    return applied.outcome;
  }

  /** Edits a row that stays local: completed history from before linking, or one Todoist refused. */
  private updateLocal(row: TodoRow, changes: TodoChanges): TodoItem {
    const after = this.deps.db.update(todos).set({ ...changes, updatedAt: this.deps.clock.now() }).where(eq(todos.id, row.id)).returning().get();
    return toTodoItem(after!);
  }

  /** Completes or reopens a row that stays local. Returns the changed item, like the backend's conditional writes. */
  private setCompletedLocal(row: TodoRow, completedAt: Date | null): TodoItem {
    const after = this.deps.db.update(todos).set({ completedAt, updatedAt: this.deps.clock.now() }).where(eq(todos.id, row.id)).returning().get();
    return toTodoItem(after!);
  }

  /** How many of an occurrence's to-dos have been deleted: the generation in a chore create's uuid. */
  private deletedChoreTodos(choreOccurrenceId: number): number {
    return this.deps.db
      .select({ n: count() })
      .from(todos)
      .where(and(eq(todos.choreOccurrenceId, choreOccurrenceId), isNotNull(todos.deletedAt)))
      .get()!.n;
  }

  /** When a chore occurrence was created, in epoch ms, or 0 if there's no such occurrence. */
  private occurrenceCreatedAt(choreOccurrenceId: number): number {
    return this.deps.db.select({ at: choreOccurrences.createdAt }).from(choreOccurrences).where(eq(choreOccurrences.id, choreOccurrenceId)).get()?.at.getTime() ?? 0;
  }

  /** One of the owner's live rows, mirror or not. */
  private liveRow(ownerId: number, id: number): TodoRow | undefined {
    return this.deps.db.select().from(todos).where(and(eq(todos.id, id), eq(todos.ownerUserId, ownerId), isNull(todos.deletedAt))).get();
  }

  private liveChoreTodo(choreOccurrenceId: number): boolean {
    return this.deps.db.select({ id: todos.id }).from(todos).where(and(eq(todos.choreOccurrenceId, choreOccurrenceId), isNull(todos.deletedAt))).get() !== undefined;
  }

  /** Spec §10.6: chore to-dos go into the chores project (Inbox by default); everything else into Inbox. */
  private projectFor(s: Session, chore: boolean): string | null {
    return chore ? (s.state.choresProjectId ?? s.state.inboxProjectId) : s.state.inboxProjectId;
  }
}
