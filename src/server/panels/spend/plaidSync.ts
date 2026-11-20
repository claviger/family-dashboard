import { and, asc, eq, isNull, ne, or } from 'drizzle-orm';
import type { Logger } from 'pino';
import { z } from 'zod';
import { daysBetween, isLocalDate } from '../../../shared/dates.js';
import { PLAID_MESSAGES } from '../../../shared/plaid.js';
import type { Clock } from '../../core/clock.js';
import { loggableError } from '../../core/errors.js';
import { LockWaitTimeout } from '../../core/lock.js';
import type { Db } from '../../db/index.js';
import { cards, connections, plaidItems, statements } from '../../db/schema.js';
import {
  classifyPlaidError, PlaidApiError, plaidAmountCents, PlaidPastDeadline, SYNC_PAGE_SIZE,
  type PlaidCreditLiability, type TransactionsSyncPage,
} from '../../integrations/plaid/client.js';
import { RECONNECT_ERRORS, type Plaid, type PlaidSession } from '../../integrations/plaid/plaid.js';
import { EARLIEST_DATE } from './bofa.js';
import { INFERRED_MIN_GAP_DAYS } from './cycles.js';
import { addSyncCounts, applySyncRun, attachedAccounts, type SyncApplyCounts } from './plaidApply.js';

/**
 * Spend's side of Plaid (spec §12.3, §12.4, the design's "Backoff", "Webhook-driven syncs" and
 * "Jobs"): the `/transactions/sync` loop, liabilities into statements, and webhook dispatch. Every
 * call to Plaid goes through `plaid.withItem`, under the Item's lock, which records the result on
 * the connection (spec §8) and sets and clears the backoff.
 *
 * - **A sync run** reads every page from the stored cursor until `has_more` is false, buffering
 *   them, and only then applies them and saves the cursor in one database transaction
 *   (`applySyncRun`), so a failure part way through applies nothing and the next run starts from
 *   the same cursor (research §5.2). `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` restarts the
 *   run from the stored cursor with the buffer thrown away, at most MAX_MUTATION_RESTARTS times.
 *   An Item that wants a full resync (`full_resync_at`, set by the pick) gets a catch-up run from
 *   the stored cursor, saved, then a run with no cursor that clears the marker (review C-S-I1).
 *   A request's run (the pick, Refresh) has a deadline: past it, waiting for the lock or before a
 *   page, the run stops with nothing applied and comes back `deferred`, for `syncSoon`.
 * - **Skipped**: a removed Item, one still waiting for the pick (departure 2: a transaction needs a
 *   card), one that needs reconnecting (Plaid would only refuse), and, for scheduled and webhook
 *   runs, one in backoff. Refresh and the pick pass `ignoreBackoff`. Under a key mismatch the
 *   scheduled runs skip every Item at once, logged as skipped, rather than failing each one.
 * - **Webhooks** (research §7.4) are acted on in the background, at most one run at a time per
 *   Item and kind: a request while one is waiting for its turn joins it, and a request while one is
 *   running makes one more run after it, so a burst folds together. A Savings Item's
 *   `TRANSACTIONS`, `HOLDINGS` and `INVESTMENTS_TRANSACTIONS` new-data codes go to `deps.savings`;
 *   its `ITEM` codes are handled here like any bank's.
 * - **Spend's Items only** (`purpose = 'spend'`): a Savings Item is never synced, read for
 *   statements, or counted here (the Savings plan, decision 1).
 * - **Liabilities** (research §6): one `/liabilities/get` per Item, picking out its attached cards,
 *   as a call beside the sync (`sideCall`): it never sets the connection `ok` or backs it off.
 *   A new `last_statement_issue_date` becomes a `plaid` statement, unless an admin's manual date is
 *   within 15 days of it (editing a Plaid date makes it manual, so the bank's date must not come
 *   back beside it); within 15 days of a Plaid date already stored, it moves that one. The latest
 *   known date sets the card's usual closing day.
 * - **Login problems** a webhook reports are checked with `/item/get` before they're believed, and
 *   the daily statements job checks Items that need reconnecting the same way, clearing the state
 *   when Plaid reports no error (webhooks can come late and out of order).
 *
 * Logs carry ids, counts and Plaid's error codes (`plaid sync`, `plaid liabilities`, `plaid
 * webhook handled`), never a token, a body, or merchant text.
 */

/** A run restarted this many times for a mutation fails; the next one starts over (research §5.2). */
export const MAX_MUTATION_RESTARTS = 3;
/** 100,000 transactions at 500 a page: far past two years of a family's cards. A run past it is a loop. */
export const MAX_PAGES_PER_RUN = 200;

/** Plaid's codes for `/liabilities/get` that mean "no liabilities shared", not a broken connection (the design's "Error states"). */
const NO_LIABILITIES = new Set(['NO_LIABILITY_ACCOUNTS', 'ACCESS_NOT_GRANTED']);
/** `PENDING_DISCONNECT` is "fired 7 days before" the disconnection (research §7.4): the date when it doesn't say. */
export const DISCONNECT_NOTICE_MS = 7 * 24 * 60 * 60_000;
/** `ITEM` `ERROR` codes the admin fixes in update mode (research §8.2). */
const RECONNECT_CODES = new Set(['ITEM_LOGIN_REQUIRED', 'ACCESS_NOT_GRANTED', 'NO_ACCOUNTS', 'PASSWORD_RESET_REQUIRED', 'ITEM_LOCKED']);
/** Kept for `/transactions/get`; with sync, Plaid says to act on SYNC_UPDATES_AVAILABLE only (research §5.3). */
const LEGACY_TRANSACTION_CODES = new Set(['INITIAL_UPDATE', 'HISTORICAL_UPDATE', 'DEFAULT_UPDATE', 'TRANSACTIONS_REMOVED']);
/** A Savings Item's webhooks that say there's new data (research plaid-savings §6). */
const SAVINGS_NEW_DATA = new Set(['TRANSACTIONS:SYNC_UPDATES_AVAILABLE', 'HOLDINGS:DEFAULT_UPDATE', 'INVESTMENTS_TRANSACTIONS:DEFAULT_UPDATE']);

export type SyncReason = 'scheduled' | 'webhook' | 'refresh' | 'pick' | 'reconnect';
export type SkipReason = 'removed' | 'not_picked' | 'backoff' | 'needs_reconnect';

/**
 * `deferred`: the run's `deadline` passed, waiting for the Item's lock (another run had it) or
 * before a page. Nothing was applied and the cursor didn't move; the caller runs `syncSoon` and
 * says it's syncing in the background.
 */
export type SyncOutcome =
  | { status: 'synced'; counts: SyncApplyCounts; pages: number; restarts: number }
  | { status: 'skipped'; reason: SkipReason }
  | { status: 'deferred' };

/** What `/item/get` said about a login problem: confirmed and recorded, cleared, or nothing to change. */
export type ItemCheckOutcome = 'needs_reconnect' | 'repaired' | 'unchanged' | 'skipped';

/** What one `/liabilities/get` did, for the log line. */
export interface LiabilityCounts {
  /** Entries for attached cards. */
  cards: number;
  /** Plaid statements added. */
  added: number;
  /** Plaid statements already there, refreshed. */
  updated: number;
  /** Dates an admin's manual date within 15 days already covers. */
  keptManual: number;
  /** Entries with no statement date (BofA may not fill it, spec §19 item 1). */
  noDate: number;
  /** Cards whose usual closing day changed. */
  closingDays: number;
  /** Plaid statements whose date moved: a new date within 15 days of the stored one replaced it. */
  moved: number;
  /** Entries for accounts with no attached card. */
  unattached: number;
  /** Entries the client couldn't parse. */
  skipped: number;
  /** `NO_LIABILITY_ACCOUNTS` or `ACCESS_NOT_GRANTED`, when Plaid shared no liabilities. */
  unavailable: string | null;
}

export type LiabilitiesOutcome =
  | { status: 'refreshed'; counts: LiabilityCounts }
  | { status: 'skipped'; reason: SkipReason | 'no_cards' };

/** What a verified webhook led to, for the log and the tests. */
export type WebhookOutcome =
  | 'sync' | 'liabilities' | 'check_item' | 'needs_reconnect' | 'repaired' | 'new_accounts' | 'disconnect_at' | 'consent'
  | 'ignored' | 'unknown_item' | 'other_environment' | 'unreadable';

/** For a scheduled run over every Item. */
export interface RunSummary {
  total: number;
  done: number;
  skipped: number;
  failed: number;
}

export interface BankSyncDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  plaid: Plaid;
  /** `/transactions/sync`'s `count`. Tests pass a small one to get several pages. */
  pageSize?: number;
  /**
   * The Savings panel's sync (the Savings spec): a Savings Item's "new data" webhooks, and the sync
   * after its login is repaired, go there. Null or absent in tests of Spend alone.
   */
  savings?: { syncSoon(itemId: number): void } | null;
}

const DateText = z.string().max(64).refine((v) => !Number.isNaN(Date.parse(v)));

/** The fields of a webhook body that are read (research §7.4). Anything else is ignored. */
const WebhookSchema = z.object({
  webhook_type: z.string().max(64),
  webhook_code: z.string().max(64),
  item_id: z.string().min(1).max(200).optional(),
  environment: z.string().max(32).optional(),
  error: z.object({ error_code: z.string().max(100).nullish() }).nullish(),
  disconnect_time: z.string().nullish(),
  consent_expiration_time: z.string().nullish(),
});

/** A timestamp Plaid sent, as it sent it, or null when it isn't one. */
function timestamp(value: string | null | undefined): string | null {
  return DateText.safeParse(value).success ? (value as string) : null;
}

function emptyLiabilityCounts(): LiabilityCounts {
  return { cards: 0, added: 0, updated: 0, moved: 0, keptManual: 0, noDate: 0, closingDays: 0, unattached: 0, skipped: 0, unavailable: null };
}

/** A sync or liabilities call that turned out to have nothing to do once it held the lock. Not Plaid's, so withItem doesn't record it. */
class Skipped extends Error {
  constructor(readonly reason: SkipReason | 'no_cards') {
    super(`skipped: ${reason}`);
    this.name = 'Skipped';
  }
}

/** A run's deadline passed before a page: the buffered pages are dropped. Not Plaid's, so withItem records nothing. */
class PastDeadline extends Error {
  constructor(readonly pagesDropped: number) {
    super('past the deadline');
    this.name = 'PastDeadline';
  }
}

export class BankSync {
  /** Background runs waiting or running, by `kind:itemId`. */
  private readonly queued = new Map<string, { started: boolean; again: boolean }>();
  private readonly background = new Set<Promise<void>>();

  constructor(private readonly deps: BankSyncDeps) {}

  // ---- The sync loop (spec §12.3, research §5).

  /**
   * One sync run for the Item. Plaid's errors are rethrown as they are (withItem has recorded
   * them); `plaidAppError` makes one plain. `deadline` (epoch ms, the real clock) is a request's:
   * it bounds the wait for the Item's lock and is checked before each page, and past it the run
   * is `deferred` with nothing applied. Background and scheduled runs don't pass one.
   */
  async syncItem(itemId: number, opts: { reason: SyncReason; ignoreBackoff?: boolean; deadline?: number; onStart?: () => void }): Promise<SyncOutcome> {
    const skip = this.skipReason(itemId, { needsPick: true, ignoreBackoff: opts.ignoreBackoff === true });
    if (skip) return { status: 'skipped', reason: skip };
    try {
      return await this.deps.plaid.withItem(itemId, async (s) => {
        // Read again under the lock: a reconnect may have found new accounts meanwhile.
        if (s.item.pickedAt === null) throw new Skipped('not_picked');
        opts.onStart?.();
        return this.runLocked(s, opts.reason, opts.deadline);
      }, { deadline: opts.deadline });
    } catch (err) {
      if (err instanceof Skipped) return { status: 'skipped', reason: err.reason as SkipReason };
      if (err instanceof PastDeadline || err instanceof LockWaitTimeout) {
        const pagesDropped = err instanceof PastDeadline ? err.pagesDropped : 0;
        this.deps.logger.info({ itemId, reason: opts.reason, waitedForLock: err instanceof LockWaitTimeout, pagesDropped }, 'plaid sync deferred');
        return { status: 'deferred' };
      }
      throw err;
    }
  }

  /**
   * Inside withItem: one pass from the stored cursor, or, when the Item wants a full resync
   * (`full_resync_at`, review C-S-I1), two. The rule: a cursor is never reset without first applying
   * what Plaid queued since it. So the catch-up pass runs from the stored cursor and is saved (its
   * removals applied), and only then is the whole history asked for with no cursor, saved with the
   * marker cleared. If the catch-up pass fails, nothing was reset and the marker stays. A stored
   * cursor that's already null needs only the full pass.
   */
  private async runLocked(s: PlaidSession, reason: SyncReason, deadline: number | undefined): Promise<SyncOutcome> {
    const full = s.item.fullResyncAt !== null;
    // Read before any pass saves: whether the Item had synced, so its pending rows can be reconciled.
    const hadSynced = s.item.lastSyncAt !== null;
    const starts: (string | null)[] = full && s.item.cursor !== null ? [s.item.cursor, null] : [s.item.cursor];
    let out: Extract<SyncOutcome, { status: 'synced' }> | null = null;
    for (const cursor of starts) {
      const pass = !full ? 'incremental' : cursor === null ? 'full' : 'catch_up';
      const { pages, restarts } = await this.fetchRun(s, cursor, reason, deadline);
      const last = pages.at(-1)!;
      const counts = applySyncRun(
        this.deps, s.item, { pages, nextCursor: last.nextCursor, transactionsUpdateStatus: last.transactionsUpdateStatus },
        pass === 'full' ? { full: { reconcilePending: hadSynced } } : {},
      );
      this.deps.logger.info(
        { itemId: s.item.id, reason, pass, pages: pages.length, restarts, transactionsStatus: last.transactionsUpdateStatus, ...counts },
        'plaid sync',
      );
      out = out === null
        ? { status: 'synced', counts, pages: pages.length, restarts }
        : { status: 'synced', counts: addSyncCounts(out.counts, counts), pages: out.pages + pages.length, restarts: out.restarts + restarts };
    }
    return out!;
  }

  /** Every page of one run from `start` (null: the whole history), restarting on a mutation. Nothing is saved here. */
  private async fetchRun(s: PlaidSession, start: string | null, reason: SyncReason, deadline: number | undefined): Promise<{ pages: TransactionsSyncPage[]; restarts: number }> {
    const count = this.deps.pageSize ?? SYNC_PAGE_SIZE;
    for (let restarts = 0; ; restarts++) {
      const pages: TransactionsSyncPage[] = [];
      try {
        let cursor = start;
        for (;;) {
          if (deadline !== undefined && Date.now() >= deadline) throw new PastDeadline(pages.length);
          if (pages.length >= MAX_PAGES_PER_RUN) throw new Error(`A Plaid sync run went past ${MAX_PAGES_PER_RUN} pages.`);
          // A page that can't finish inside the request's deadline isn't asked for, or is cut off.
          const page = await s.client.syncTransactions(s.accessToken, { cursor, count }, { deadline });
          pages.push(page);
          // `""` means Plaid has no data yet: there's nothing more to page through.
          if (!page.hasMore || page.nextCursor === '') break;
          cursor = page.nextCursor;
        }
      } catch (err) {
        // The request ran out of time: nothing is applied, so the cursor stays where it was.
        if (err instanceof PlaidPastDeadline) throw new PastDeadline(pages.length);
        if (classifyPlaidError(err) === 'mutation' && restarts < MAX_MUTATION_RESTARTS) {
          this.deps.logger.info({ itemId: s.item.id, reason, restarts: restarts + 1, pagesDropped: pages.length }, 'plaid sync restarted after a mutation');
          continue;
        }
        throw err;
      }
      return { pages, restarts };
    }
  }

  /** Why the Item isn't synced now, or null. Read without the lock; syncItem checks the pick again under it. */
  private skipReason(itemId: number, opts: { needsPick: boolean; ignoreBackoff: boolean }): SkipReason | null {
    const item = this.deps.plaid.item(itemId);
    if (!item || item.removedAt !== null || item.connectionId === null || item.purpose !== 'spend') return 'removed';
    if (opts.needsPick && item.pickedAt === null) return 'not_picked';
    const status = this.deps.db.select({ status: connections.status }).from(connections).where(eq(connections.id, item.connectionId)).get()?.status;
    if (status === undefined) return 'removed';
    if (status === 'needs_reconnect') return 'needs_reconnect';
    if (!opts.ignoreBackoff && item.backoffUntil !== null && item.backoffUntil.getTime() > this.deps.clock.now().getTime()) return 'backoff';
    return null;
  }

  /** Spend's Items that aren't removed, oldest first. */
  private liveItemIds(): number[] {
    return this.deps.db.select({ id: plaidItems.id }).from(plaidItems)
      .where(and(isNull(plaidItems.removedAt), eq(plaidItems.purpose, 'spend')))
      .orderBy(asc(plaidItems.id)).all().map((r) => r.id);
  }

  /** `spend.transactionsSync`: every Item, one after another, stopping early when `signal` aborts. A failure is logged and counted. */
  async syncAll(opts: { signal?: AbortSignal } = {}): Promise<RunSummary> {
    return this.forEachItem('sync', opts.signal, (id) => this.syncItem(id, { reason: 'scheduled' }));
  }

  /**
   * `spend.statementsSync`: liabilities for every Item. An Item that needs reconnecting is checked
   * with `/item/get` first (`checkItem`), so a login problem Plaid has since cleared (a missed
   * `LOGIN_REPAIRED`) doesn't stay forever; a failed check is logged, not counted.
   */
  async refreshAllLiabilities(opts: { signal?: AbortSignal } = {}): Promise<RunSummary> {
    return this.forEachItem('liabilities', opts.signal, async (id) => {
      if (this.connectionOf(id)?.status === 'needs_reconnect') {
        try {
          await this.checkItem(id, { reason: 'scheduled' });
        } catch (err) {
          this.deps.logger.warn({ itemId: id, ...this.facts(err) }, 'plaid item check failed');
        }
      }
      return this.refreshLiabilities(id, { reason: 'scheduled' });
    });
  }

  private connectionOf(itemId: number) {
    const item = this.deps.plaid.item(itemId);
    if (!item || item.removedAt !== null || item.connectionId === null) return undefined;
    return this.deps.db.select().from(connections).where(eq(connections.id, item.connectionId)).get();
  }

  /**
   * Asks `/item/get` what the Item's error is now, under its lock and beside the sync (`sideCall`,
   * allowed while it needs reconnecting): a login code there (ITEM_LOGIN_REQUIRED and the like)
   * sets `needs_reconnect`; no error clears it and syncs, unless access was revoked
   * (USER_PERMISSION_REVOKED, which `/item/get` isn't known to report). A bank gone at Plaid, or
   * credentials that can't be read, isn't asked about. An `ITEM` `ERROR` webhook comes here rather than being believed as it
   * is, so a `LOGIN_REPAIRED` that arrived before a late `ERROR` wins.
   */
  async checkItem(itemId: number, opts: { reason: SyncReason; onStart?: () => void }): Promise<ItemCheckOutcome> {
    const before = this.connectionOf(itemId);
    if (!before) return 'skipped';
    // Gone at Plaid, or credentials that can't be read: asking again can't change that.
    if (before.lastError === PLAID_MESSAGES.gone || before.lastError === PLAID_MESSAGES.unreadable) return 'unchanged';
    const outcome = await this.deps.plaid.withItem(itemId, async (s): Promise<ItemCheckOutcome> => {
      opts.onStart?.();
      const got = await s.client.getItem(s.accessToken);
      const code = got.error?.error_code ?? null;
      const conn = this.connectionOf(itemId);
      if (!conn) return 'skipped';
      if (code !== null && RECONNECT_CODES.has(code)) {
        if (conn.status === 'needs_reconnect') return 'unchanged';
        this.deps.plaid.markNeedsReconnect(itemId, code);
        return 'needs_reconnect';
      }
      // The connection's last error says so until a reconnect clears it; the last webhook code
      // doesn't, since any later webhook replaces it.
      const revoked = conn.lastError === RECONNECT_ERRORS.USER_PERMISSION_REVOKED;
      if (code !== null || conn.status !== 'needs_reconnect' || revoked) return 'unchanged';
      this.deps.plaid.clearReconnect(itemId);
      return 'repaired';
    }, { allowNeedsReconnect: true, sideCall: true });
    this.deps.logger.info({ itemId, reason: opts.reason, outcome }, 'plaid item checked');
    if (outcome === 'repaired') this.syncSoonFor(itemId);
    return outcome;
  }

  private async forEachItem(kind: string, signal: AbortSignal | undefined, run: (id: number) => Promise<{ status: string }>): Promise<RunSummary> {
    const ids = this.liveItemIds();
    const summary: RunSummary = { total: ids.length, done: 0, skipped: 0, failed: 0 };
    // Nothing can be read under a key mismatch, so every Item would only fail: the run is skipped,
    // and the System page already says why (review C-S-M5).
    if (this.deps.plaid.keyMismatch) {
      this.deps.logger.info({ kind, items: ids.length, outcome: 'skipped', reason: 'key_mismatch' }, 'plaid scheduled run skipped');
      return { ...summary, skipped: ids.length };
    }
    for (const id of ids) {
      if (signal?.aborted) break;
      try {
        const outcome = await run(id);
        if (outcome.status === 'skipped') summary.skipped++;
        else summary.done++;
      } catch (err) {
        summary.failed++;
        this.deps.logger.warn({ itemId: id, kind, ...this.facts(err) }, 'plaid scheduled run failed for an item');
      }
    }
    return summary;
  }

  // ---- Background runs, for webhooks.

  /** A sync in the background (a webhook's): folded with any already waiting or running for the Item. */
  syncSoon(itemId: number): void {
    this.later(`sync:${itemId}`, (onStart) => this.syncItem(itemId, { reason: 'webhook', onStart }));
  }

  /** The sync that fits the Item's panel, in the background: Spend's here, Savings' through `deps.savings`. */
  private syncSoonFor(itemId: number): void {
    if (this.deps.plaid.item(itemId)?.purpose === 'savings') this.deps.savings?.syncSoon(itemId);
    else this.syncSoon(itemId);
  }

  /** `/liabilities/get` in the background, folded the same way. */
  liabilitiesSoon(itemId: number): void {
    this.later(`liabilities:${itemId}`, (onStart) => this.refreshLiabilities(itemId, { reason: 'webhook', onStart }));
  }

  /** `checkItem` in the background, folded the same way. */
  checkItemSoon(itemId: number): void {
    this.later(`item:${itemId}`, (onStart) => this.checkItem(itemId, { reason: 'webhook', onStart }));
  }

  /**
   * One run at a time per key. A request while one waits for the lock joins it (it hasn't read
   * anything yet); a request while one is running makes one more run after it. Failures were
   * recorded by withItem and are only logged here.
   */
  private later(key: string, run: (onStart: () => void) => Promise<unknown>): void {
    const entry = this.queued.get(key);
    if (entry) {
      if (entry.started) entry.again = true;
      return;
    }
    const state = { started: false, again: false };
    this.queued.set(key, state);
    this.track((async () => {
      try {
        do {
          state.again = false;
          state.started = false;
          try {
            await run(() => {
              state.started = true;
            });
          } catch (err) {
            this.deps.logger.warn({ key, ...this.facts(err) }, 'plaid background run failed');
          }
        } while (state.again);
      } finally {
        this.queued.delete(key);
      }
    })());
  }

  private track(p: Promise<void>): void {
    this.background.add(p);
    void p.finally(() => this.background.delete(p));
  }

  /** Resolves once no background work is left (tests, and shutdown). */
  async idle(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  // ---- Liabilities (spec §12.4, research §6).

  /**
   * One `/liabilities/get` for the Item, into its attached cards' statements. `NO_LIABILITY_ACCOUNTS`
   * and `ACCESS_NOT_GRANTED` aren't connection failures: the cards keep their inferred dates.
   */
  async refreshLiabilities(itemId: number, opts: { reason: SyncReason; ignoreBackoff?: boolean; deadline?: number; onStart?: () => void }): Promise<LiabilitiesOutcome> {
    const skip = this.skipReason(itemId, { needsPick: false, ignoreBackoff: opts.ignoreBackoff === true });
    if (skip) return { status: 'skipped', reason: skip };
    if (attachedAccounts(this.deps.db, itemId).size === 0) return { status: 'skipped', reason: 'no_cards' };
    try {
      return await this.deps.plaid.withItem(itemId, async (s) => {
        opts.onStart?.();
        let credit: PlaidCreditLiability[];
        let skipped = 0;
        try {
          ({ credit, skipped } = await s.client.getLiabilities(s.accessToken));
        } catch (err) {
          if (err instanceof PlaidApiError && err.errorCode !== null && NO_LIABILITIES.has(err.errorCode)) {
            const counts = { ...emptyLiabilityCounts(), unavailable: err.errorCode };
            this.deps.logger.info({ itemId, reason: opts.reason, ...counts }, 'plaid liabilities');
            return { status: 'refreshed' as const, counts };
          }
          throw err;
        }
        const counts = this.applyLiabilities(itemId, credit);
        counts.skipped = skipped;
        this.deps.logger.info({ itemId, reason: opts.reason, ...counts }, 'plaid liabilities');
        return { status: 'refreshed' as const, counts };
      }, { deadline: opts.deadline, sideCall: true });
    } catch (err) {
      if (err instanceof Skipped) return { status: 'skipped', reason: err.reason };
      throw err;
    }
  }

  /** Statements from one `/liabilities/get`, in one transaction. */
  private applyLiabilities(itemId: number, credit: readonly PlaidCreditLiability[]): LiabilityCounts {
    const { db } = this.deps;
    const counts = emptyLiabilityCounts();
    const cardOf = attachedAccounts(db, itemId);
    const now = this.deps.clock.now();
    const cents = (n: number | null) => (n === null ? null : (plaidAmountCents(n)?.cents ?? null));
    db.transaction((tx) => {
      for (const l of credit) {
        const cardId = l.account_id === null ? undefined : cardOf.get(l.account_id);
        if (cardId === undefined) {
          counts.unattached++;
          continue;
        }
        counts.cards++;
        const date = l.last_statement_issue_date;
        if (date === null || !isLocalDate(date) || date < EARLIEST_DATE) {
          counts.noDate++;
          continue;
        }
        const values = {
          statementBalanceCents: cents(l.last_statement_balance),
          paymentDueDate: l.next_payment_due_date !== null && isLocalDate(l.next_payment_due_date) ? l.next_payment_due_date : null,
          minimumPaymentCents: cents(l.minimum_payment_amount),
          fetchedAt: now,
          updatedAt: now,
        };
        const known = tx.select().from(statements).where(eq(statements.cardId, cardId)).all();
        const gap = (r: { closingDate: string }) => Math.abs(daysBetween(r.closingDate, date));
        const same = known.find((r) => r.closingDate === date);
        // A Plaid date within 15 days of a stored Plaid date is that statement's date moving.
        const moved = same ? undefined : known.filter((r) => r.source === 'plaid' && gap(r) <= INFERRED_MIN_GAP_DAYS).sort((a, b) => gap(a) - gap(b))[0];
        if (same?.source === 'plaid') {
          tx.update(statements).set(values).where(eq(statements.id, same.id)).run();
          counts.updated++;
        } else if (same || known.some((r) => r.source === 'manual' && gap(r) <= INFERRED_MIN_GAP_DAYS)) {
          counts.keptManual++;
          continue;
        } else if (moved) {
          tx.update(statements).set({ closingDate: date, ...values }).where(eq(statements.id, moved.id)).run();
          counts.moved++;
        } else {
          tx.insert(statements).values({ cardId, closingDate: date, source: 'plaid', ...values, createdAt: now }).run();
          counts.added++;
        }
        // The latest known date says which day the card closes on now (spec §12.4).
        if (known.every((r) => r.id === moved?.id || r.closingDate <= date)) {
          const day = Number(date.slice(8, 10));
          counts.closingDays += tx.update(cards)
            .set({ usualClosingDay: day, updatedAt: now })
            .where(and(eq(cards.id, cardId), isNull(cards.removedAt), or(isNull(cards.usualClosingDay), ne(cards.usualClosingDay, day))))
            .run().changes;
        }
      }
    });
    return counts;
  }

  // ---- Webhooks (research §7.4, the design's "Webhook status codes").

  /**
   * A verified webhook, after the 200 (the route calls `receiveWebhook`): found by Plaid's
   * `item_id`, checked against PLAID_ENV, and dispatched. Syncs and liabilities run in the
   * background; the rest are plain writes.
   */
  handleWebhook(payload: Record<string, unknown>): WebhookOutcome {
    const parsed = WebhookSchema.safeParse(payload);
    if (!parsed.success) {
      this.deps.logger.warn('plaid webhook without a type and code; ignored');
      return 'unreadable';
    }
    const w = parsed.data;
    const facts = { type: w.webhook_type, code: w.webhook_code };
    const done = (outcome: WebhookOutcome, more: Record<string, unknown> = {}): WebhookOutcome => {
      this.deps.logger.info({ ...facts, ...more, outcome }, 'plaid webhook handled');
      return outcome;
    };
    if (w.environment !== undefined && w.environment !== this.deps.plaid.config.env) {
      this.deps.logger.warn({ ...facts, environment: w.environment }, 'plaid webhook for another environment');
      return 'other_environment';
    }
    const item = w.item_id === undefined ? undefined : this.deps.plaid.itemByPlaidId(w.item_id);
    if (!item || item.removedAt !== null) return done('unknown_item', { plaidItemId: w.item_id ?? null });
    const itemId = item.id;
    this.deps.plaid.setLastWebhookCode(itemId, `${w.webhook_type}:${w.webhook_code}`);

    if (item.purpose === 'savings' && w.webhook_type !== 'ITEM') {
      // Decision 15: "new data" for a Savings Item is a Savings sync; anything else (LIABILITIES) isn't its.
      if (SAVINGS_NEW_DATA.has(`${w.webhook_type}:${w.webhook_code}`)) {
        this.deps.savings?.syncSoon(itemId);
        return done('sync', { itemId, purpose: 'savings' });
      }
      return done('ignored', { itemId, purpose: 'savings' });
    }
    if (w.webhook_type === 'TRANSACTIONS') {
      if (w.webhook_code === 'SYNC_UPDATES_AVAILABLE') {
        this.syncSoon(itemId);
        return done('sync', { itemId });
      }
      return done('ignored', { itemId, legacy: LEGACY_TRANSACTION_CODES.has(w.webhook_code) });
    }
    if (w.webhook_type === 'LIABILITIES' && w.webhook_code === 'DEFAULT_UPDATE') {
      this.liabilitiesSoon(itemId);
      return done('liabilities', { itemId });
    }
    if (w.webhook_type === 'ITEM') {
      switch (w.webhook_code) {
        case 'ERROR': {
          const code = w.error?.error_code ?? null;
          if (code !== null && RECONNECT_CODES.has(code)) {
            // Not believed as it is: webhooks can be late or out of order, so /item/get decides.
            this.checkItemSoon(itemId);
            return done('check_item', { itemId, errorCode: code });
          }
          // Anything else shows up on the next sync, which records it with its own message.
          return done('ignored', { itemId, errorCode: code });
        }
        case 'USER_PERMISSION_REVOKED':
          this.deps.plaid.markNeedsReconnect(itemId, 'USER_PERMISSION_REVOKED');
          return done('needs_reconnect', { itemId });
        case 'LOGIN_REPAIRED':
          this.deps.plaid.clearReconnect(itemId);
          this.syncSoonFor(itemId);
          return done('repaired', { itemId });
        case 'NEW_ACCOUNTS_AVAILABLE':
          this.deps.plaid.noteNewAccounts(itemId);
          return done('new_accounts', { itemId });
        case 'PENDING_DISCONNECT':
        case 'PENDING_EXPIRATION': {
          // PENDING_EXPIRATION is Europe's; handled the same way in case it ever comes. Without a
          // date, it's 7 days from now, when Plaid says the notice comes.
          const at = timestamp(w.disconnect_time) ?? timestamp(w.consent_expiration_time)
            ?? new Date(this.deps.clock.now().getTime() + DISCONNECT_NOTICE_MS).toISOString();
          this.deps.plaid.noteDisconnectAt(itemId, at);
          return done('disconnect_at', { itemId });
        }
        case 'CONSENT_UPDATED':
          this.deps.plaid.setConsentExpiration(itemId, timestamp(w.consent_expiration_time));
          return done('consent', { itemId });
        default:
          // WEBHOOK_UPDATE_ACKNOWLEDGED, USER_ACCOUNT_REVOKED (not sent for BofA), and new codes.
          return done('ignored', { itemId });
      }
    }
    return done('ignored', { itemId });
  }

  /**
   * A verified webhook the replay set dropped (the same signing input within its window). Only a
   * "there's new data" code still does anything: `TRANSACTIONS` `SYNC_UPDATES_AVAILABLE` asks for
   * a sync, and `LIABILITIES` `DEFAULT_UPDATE` for liabilities, each folding into one already
   * pending. That way a genuine webhook whose body and `iat` second match an earlier one (G1-I1
   * keys the set on the signing input) never waits for the 6-hourly sync. A captured JWT replayed
   * can only cause extra syncs, which are idempotent and fold together. Every other replayed code
   * is dropped, as before, and nothing is recorded (no `last_webhook_code`).
   */
  handleReplayedWebhook(payload: Record<string, unknown>): WebhookOutcome {
    const parsed = WebhookSchema.safeParse(payload);
    if (!parsed.success) return 'unreadable';
    const w = parsed.data;
    if (w.environment !== undefined && w.environment !== this.deps.plaid.config.env) return 'other_environment';
    const key = `${w.webhook_type}:${w.webhook_code}`;
    const item = w.item_id === undefined ? undefined : this.deps.plaid.itemByPlaidId(w.item_id);
    if (item?.purpose === 'savings') {
      if (!SAVINGS_NEW_DATA.has(key)) return 'ignored';
      if (item.removedAt !== null) return 'unknown_item';
      this.deps.savings?.syncSoon(item.id);
      this.deps.logger.info({ type: w.webhook_type, code: w.webhook_code, itemId: item.id, purpose: 'savings' }, 'plaid webhook replayed; asked for new data anyway');
      return 'sync';
    }
    const sync = key === 'TRANSACTIONS:SYNC_UPDATES_AVAILABLE';
    const liabilities = key === 'LIABILITIES:DEFAULT_UPDATE';
    if (!sync && !liabilities) return 'ignored';
    if (!item || item.removedAt !== null) return 'unknown_item';
    if (sync) this.syncSoon(item.id);
    else this.liabilitiesSoon(item.id);
    this.deps.logger.info({ type: w.webhook_type, code: w.webhook_code, itemId: item.id }, 'plaid webhook replayed; asked for new data anyway');
    return sync ? 'sync' : 'liabilities';
  }

  /** `POST /webhooks/plaid`'s hand-off: the webhook is handled after the response, and `idle()` waits for it. */
  receiveWebhook(payload: Record<string, unknown>, opts: { replay?: boolean } = {}): void {
    this.track(
      new Promise<void>((resolve) => setImmediate(resolve))
        .then(() => {
          if (opts.replay) this.handleReplayedWebhook(payload);
          else this.handleWebhook(payload);
        })
        .catch((err: unknown) => this.deps.logger.error(loggableError(err), 'plaid webhook handling failed')),
    );
  }

  /** Plaid's facts about a failure, never its message. */
  private facts(err: unknown): Record<string, unknown> {
    if (err instanceof PlaidApiError) return { status: err.status, errorType: err.errorType, errorCode: err.errorCode };
    return { kind: classifyPlaidError(err), ...loggableError(err) };
  }
}
