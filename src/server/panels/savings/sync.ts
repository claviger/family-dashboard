import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Logger } from 'pino';
import { addDays, isLocalDate } from '../../../shared/dates.js';
import { localDate, type Clock } from '../../core/clock.js';
import { loggableError } from '../../core/errors.js';
import { LockWaitTimeout } from '../../core/lock.js';
import type { Db } from '../../db/index.js';
import { connections, plaidItems, type SavingsAccountRow } from '../../db/schema.js';
import {
  classifyPlaidError, INVESTMENTS_PAGE_SIZE, PlaidApiError, plaidAmountCents, PlaidPastDeadline, SYNC_PAGE_SIZE,
  type PlaidInvestmentTransaction, type TransactionsSyncPage,
} from '../../integrations/plaid/client.js';
import type { Plaid, PlaidSession } from '../../integrations/plaid/plaid.js';
import { getFamilySettings } from '../../settings.js';
import { cashAccountFlow, classifyInvestmentTransaction } from './flows.js';
import { deleteFlowsById, investmentFlowIdsIn, liveAccountsOf, putSnapshot, removeFlows, replaceCsvTwin, upsertFlow } from './store.js';

/**
 * The Savings panel's side of Plaid (the Savings spec, "Sync"; plan decisions 3 to 8, 15 and 17).
 * Every call goes through `plaid.withItem`, under the Item's lock, which records the result on the
 * connection (main spec §8) and sets and clears the backoff, exactly as for a bank. One run:
 *
 * 1. `/accounts/get` (Plaid's cached balances, free; research plaid-savings §5): today's snapshot
 *    for each shown or hidden account, replacing an earlier one today. An account Plaid lists that
 *    the Item's list doesn't have sets `new_accounts_at`, for Load accounts.
 * 2. `/transactions/sync` from the Item's cursor, every page buffered, then applied with the new
 *    cursor in one database transaction: the cash accounts' posted transactions become flows; a
 *    removed one deletes its flow. A mutation mid-run restarts from the stored cursor (at most 3
 *    times). With `full_resync_at` set (an account shown after the pick), it first catches up from
 *    the cursor and then reads the whole history with no cursor, clearing the marker, as Spend does.
 *    Interest (isPlaidInterest) isn't a flow. A new flow replaces the imported flow it matches (`replaceCsvTwin`).
 * 3. `/investments/transactions/get` over the window (`investmentsWindow`), every page, for the
 *    investment accounts: cash movements become flows; a stored one in the window that Plaid no
 *    longer lists is deleted, only when the read was complete (paging reached the total, which
 *    never changed between pages), every entry parsed, and the answer wasn't empty (an empty one
 *    with stored flows in the window deletes nothing, and is logged). Investments refused for the Item
 *    (`INVESTMENTS_UNAVAILABLE`) isn't a failure: the Item says so, and the next run asks again.
 *    A passing failure there (`PRODUCT_NOT_READY`, Plaid or the bank briefly down) doesn't fail
 *    the run either: the balances and cash flows are kept, the connection isn't backed off, the
 *    code goes on the Item (`investments_error_code`), and the next run reads the same window.
 *    Only the request's deadline (`PlaidPastDeadline`) still defers the run.
 *
 * Its own copy of the page loop and of the background folding, modeled on BankSync's (decision 17).
 * Logs carry ids, counts, and Plaid's `type:subtype` values, never names, amounts, or tokens.
 */

export const INVESTMENTS_WINDOW_DAYS = 30;
export const INVESTMENTS_OVERLAP_DAYS = 7;
/** `/investments/transactions/get` goes back at most 24 months (research plaid-savings §3.1). */
export const INVESTMENTS_MAX_DAYS = 729;
export const MAX_MUTATION_RESTARTS = 3;
/** A run past this many pages of either call is a loop. */
export const MAX_PAGES_PER_RUN = 200;
/** Plaid's codes for "this Item has no Investments", which aren't connection failures (decision 8, research plaid-savings §7). */
export const INVESTMENTS_UNAVAILABLE: ReadonlySet<string> = new Set(['PRODUCTS_NOT_SUPPORTED', 'NO_INVESTMENT_ACCOUNTS', 'INVALID_PRODUCT', 'ADDITIONAL_CONSENT_REQUIRED']);
/** `investments_error_code` for a passing failure that had no Plaid code (no answer, or an answer that couldn't be read). */
export const INVESTMENTS_NO_ANSWER = 'NO_ANSWER';

export type SavingsSyncReason = 'scheduled' | 'webhook' | 'refresh' | 'pick';
export type SavingsSkipReason = 'removed' | 'not_picked' | 'backoff' | 'needs_reconnect';

export interface SavingsSyncCounts {
  snapshots: number;
  /** Shown accounts with no readable `balances.current`. */
  noBalance: number;
  /** Accounts Plaid listed that the Item's list doesn't have. */
  unknownAccounts: number;
  flowsAdded: number;
  flowsUpdated: number;
  flowsRemoved: number;
  /** Imported flows a new Plaid flow replaced. */
  csvReplaced: number;
  /** Cash-account transactions taken as interest (isPlaidInterest), so not flows. */
  interest: number;
  /** Entries on shown accounts that aren't flows (pending, market activity, zero). */
  notFlows: number;
  otherCurrency: number;
  signMismatch: number;
  unreadable: number;
  /** Entries the client couldn't parse. */
  skippedEntries: number;
  transactionPages: number;
  restarts: number;
  /** `retry`: a passing failure; the next run reads the window again. `incomplete`: read, but not every page, so nothing was deleted. */
  investments: 'synced' | 'incomplete' | 'unavailable' | 'retry' | 'none';
  /** Investment transactions seen, by Plaid's `type:subtype` (enum values only). */
  byType: Record<string, number>;
}

export type SavingsSyncOutcome =
  | { status: 'synced'; counts: SavingsSyncCounts }
  | { status: 'skipped'; reason: SavingsSkipReason }
  | { status: 'deferred' };

export interface SavingsRunSummary {
  total: number;
  done: number;
  skipped: number;
  failed: number;
}

export interface SavingsSyncDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  plaid: Plaid;
  /** `/transactions/sync`'s `count`. Tests pass a small one. */
  pageSize?: number;
}

function emptyCounts(): SavingsSyncCounts {
  return {
    snapshots: 0, noBalance: 0, unknownAccounts: 0, flowsAdded: 0, flowsUpdated: 0, flowsRemoved: 0, csvReplaced: 0, interest: 0, notFlows: 0, otherCurrency: 0, signMismatch: 0,
    unreadable: 0, skippedEntries: 0, transactionPages: 0, restarts: 0, investments: 'none', byType: {},
  };
}

/** The brokerage's window (decision 7): from the earlier of 30 days ago and 7 days before `through`, at most 729 days back, to today. */
export function investmentsWindow(today: string, through: string | null): { start: string; end: string } {
  const recent = addDays(today, -INVESTMENTS_WINDOW_DAYS);
  const resume = through === null ? recent : addDays(through, -INVESTMENTS_OVERLAP_DAYS);
  const earlier = resume < recent ? resume : recent;
  const floor = addDays(today, -INVESTMENTS_MAX_DAYS);
  return { start: earlier < floor ? floor : earlier, end: today };
}

/** Nothing to do once the lock is held. Not Plaid's, so withItem records nothing. */
class Skipped extends Error {
  constructor(readonly reason: SavingsSkipReason) {
    super(`skipped: ${reason}`);
    this.name = 'Skipped';
  }
}

export class SavingsSync {
  private readonly queued = new Map<number, { started: boolean; again: boolean }>();
  private readonly background = new Set<Promise<void>>();

  constructor(private readonly deps: SavingsSyncDeps) {}

  /**
   * One run for the Item. Plaid's errors are rethrown as they are (withItem has recorded them).
   * `deadline` (epoch ms, the real clock) is a request's: past it, waiting for the lock or before a
   * call, the run is `deferred` (what earlier steps stored stays; each step's writes are whole).
   */
  async syncItem(itemId: number, opts: { reason: SavingsSyncReason; ignoreBackoff?: boolean; deadline?: number; onStart?: () => void }): Promise<SavingsSyncOutcome> {
    const skip = this.skipReason(itemId, opts.ignoreBackoff === true);
    if (skip) return { status: 'skipped', reason: skip };
    try {
      return await this.deps.plaid.withItem(itemId, async (s) => {
        if (s.item.pickedAt === null) throw new Skipped('not_picked');
        opts.onStart?.();
        return { status: 'synced' as const, counts: await this.runLocked(s, opts.reason, opts.deadline) };
      }, { deadline: opts.deadline });
    } catch (err) {
      if (err instanceof Skipped) return { status: 'skipped', reason: err.reason };
      if (err instanceof PlaidPastDeadline || err instanceof LockWaitTimeout) {
        this.deps.logger.info({ itemId, reason: opts.reason, waitedForLock: err instanceof LockWaitTimeout }, 'savings sync deferred');
        return { status: 'deferred' };
      }
      throw err;
    }
  }

  private async runLocked(s: PlaidSession, reason: SavingsSyncReason, deadline: number | undefined): Promise<SavingsSyncCounts> {
    const { db, clock } = this.deps;
    const counts = emptyCounts();
    const accounts = liveAccountsOf(db, s.item.id);
    const today = localDate(clock.now(), getFamilySettings(db).timeZone);

    await this.syncBalances(s, accounts, today, deadline, counts);

    const cash = new Map(accounts.filter((a) => a.kind === 'cash').map((a) => [a.plaidAccountId!, a]));
    const full = s.item.fullResyncAt !== null;
    const starts: (string | null)[] = full && s.item.cursor !== null ? [s.item.cursor, null] : [s.item.cursor];
    for (const cursor of starts) {
      const { pages, restarts } = await this.fetchTransactions(s, cursor, deadline);
      counts.transactionPages += pages.length;
      counts.restarts += restarts;
      this.applyTransactions(s.item.id, pages, cash, full && cursor === null, counts);
    }

    const investment = accounts.filter((a) => a.kind === 'investment');
    if (investment.length > 0) counts.investments = await this.syncInvestments(s, investment, today, deadline, counts);

    const now = clock.now();
    db.update(plaidItems).set({ lastSyncAt: now, updatedAt: now }).where(eq(plaidItems.id, s.item.id)).run();
    this.deps.logger.info({ itemId: s.item.id, reason, ...counts }, 'savings sync');
    return counts;
  }

  private async syncBalances(s: PlaidSession, accounts: readonly SavingsAccountRow[], today: string, deadline: number | undefined, counts: SavingsSyncCounts): Promise<void> {
    const { accounts: listed, skipped } = await s.client.getAccounts(s.accessToken, { deadline });
    counts.skippedEntries += skipped;
    const mine = new Map(accounts.map((a) => [a.plaidAccountId, a]));
    const known = new Set((s.item.accounts ?? []).map((a) => a.accountId));
    const fetchedAt = this.deps.clock.now();
    this.deps.db.transaction((tx) => {
      for (const a of listed) {
        if (!known.has(a.account_id)) counts.unknownAccounts++;
        const account = mine.get(a.account_id);
        if (!account) continue;
        const current = a.balances.current === null ? null : plaidAmountCents(a.balances.current);
        if (current === null) {
          counts.noBalance++;
          continue;
        }
        const available = a.balances.available === null ? null : (plaidAmountCents(a.balances.available)?.cents ?? null);
        putSnapshot(tx, account.id, today, { currentCents: current.cents, availableCents: available }, fetchedAt);
        counts.snapshots++;
      }
    });
    if (counts.unknownAccounts > 0) this.deps.plaid.noteNewAccounts(s.item.id);
  }

  /** Every page from `start` (null: the whole history), restarting on a mutation. Nothing is saved here. */
  private async fetchTransactions(s: PlaidSession, start: string | null, deadline: number | undefined): Promise<{ pages: TransactionsSyncPage[]; restarts: number }> {
    const count = this.deps.pageSize ?? SYNC_PAGE_SIZE;
    for (let restarts = 0; ; restarts++) {
      const pages: TransactionsSyncPage[] = [];
      try {
        let cursor = start;
        for (;;) {
          if (pages.length >= MAX_PAGES_PER_RUN) throw new Error(`A Savings sync run went past ${MAX_PAGES_PER_RUN} pages.`);
          const page = await s.client.syncTransactions(s.accessToken, { cursor, count }, { deadline });
          pages.push(page);
          if (!page.hasMore || page.nextCursor === '') break;
          cursor = page.nextCursor;
        }
      } catch (err) {
        if (classifyPlaidError(err) === 'mutation' && restarts < MAX_MUTATION_RESTARTS) continue;
        throw err;
      }
      return { pages, restarts };
    }
  }

  /** One run's pages and its cursor, in one database transaction. */
  private applyTransactions(itemId: number, pages: readonly TransactionsSyncPage[], cash: ReadonlyMap<string, SavingsAccountRow>, fullPass: boolean, counts: SavingsSyncCounts): void {
    const last = pages.at(-1)!;
    const now = this.deps.clock.now();
    this.deps.db.transaction((tx) => {
      for (const page of pages) {
        for (const t of [...page.added, ...page.modified]) {
          const account = cash.get(t.account_id);
          if (!account) continue;
          const c = isLocalDate(t.date) ? cashAccountFlow(t, account.isoCurrencyCode) : { flow: null, unreadable: true as const };
          if ('otherCurrency' in c && c.otherCurrency) counts.otherCurrency++;
          if ('unreadable' in c && c.unreadable) counts.unreadable++;
          if ('interest' in c && c.interest) counts.interest++;
          if (c.flow === null) {
            counts.notFlows++;
            counts.flowsRemoved += removeFlows(tx, 'transactions', [t.transaction_id]);
            continue;
          }
          const r = upsertFlow(tx, { accountId: account.id, source: 'transactions', plaidId: t.transaction_id, date: t.date, ...c.flow }, now);
          if (r === 'added') {
            counts.flowsAdded++;
            counts.csvReplaced += replaceCsvTwin(tx, { accountId: account.id, date: t.date, ...c.flow });
          } else if (r === 'updated') counts.flowsUpdated++;
        }
        counts.flowsRemoved += removeFlows(tx, 'transactions', page.removed.map((r) => r.transaction_id));
      }
      tx.update(plaidItems)
        .set({
          cursor: last.nextCursor === '' ? null : last.nextCursor,
          ...(last.transactionsUpdateStatus !== null ? { transactionsStatus: last.transactionsUpdateStatus } : {}),
          ...(fullPass ? { fullResyncAt: null } : {}),
          updatedAt: now,
        })
        .where(eq(plaidItems.id, itemId))
        .run();
    });
  }

  private async syncInvestments(
    s: PlaidSession, accounts: readonly SavingsAccountRow[], today: string, deadline: number | undefined, counts: SavingsSyncCounts,
  ): Promise<SavingsSyncCounts['investments']> {
    const window = investmentsWindow(today, s.item.investmentsThrough);
    const got: PlaidInvestmentTransaction[] = [];
    let skipped = 0;
    // Complete: paging reached the total, and every page gave the same total. An empty page short
    // of the total, or a total that changed mid-read, leaves entries unread, so nothing is deleted.
    let complete = false;
    try {
      let total: number | null = null;
      for (let offset = 0, pages = 0; ; pages++) {
        if (pages >= MAX_PAGES_PER_RUN) throw new Error(`A Savings investments read went past ${MAX_PAGES_PER_RUN} pages.`);
        const page = await s.client.getInvestmentTransactions(s.accessToken, { startDate: window.start, endDate: window.end, count: INVESTMENTS_PAGE_SIZE, offset }, { deadline });
        if (total !== null && page.total !== total) break;
        total = page.total;
        got.push(...page.transactions);
        skipped += page.skipped;
        const read = page.transactions.length + page.skipped;
        offset += read;
        if (offset >= total) {
          complete = true;
          break;
        }
        if (read === 0) break;
      }
    } catch (err) {
      const now = this.deps.clock.now();
      if (err instanceof PlaidApiError && err.errorCode !== null && INVESTMENTS_UNAVAILABLE.has(err.errorCode)) {
        this.deps.db.update(plaidItems).set({ investmentsStatus: 'unavailable', investmentsErrorCode: err.errorCode, updatedAt: now }).where(eq(plaidItems.id, s.item.id)).run();
        this.deps.logger.info({ itemId: s.item.id, errorCode: err.errorCode }, 'savings investments unavailable');
        return 'unavailable';
      }
      // The request's deadline defers the whole run (syncItem); anything else passing is retried next run.
      if (err instanceof PlaidPastDeadline || classifyPlaidError(err) !== 'transient') throw err;
      const code = err instanceof PlaidApiError && err.errorCode !== null ? err.errorCode : INVESTMENTS_NO_ANSWER;
      // An "unavailable" Item keeps its code, which says how to fix it; a passing failure doesn't change that.
      if (s.item.investmentsStatus !== 'unavailable') {
        this.deps.db.update(plaidItems).set({ investmentsErrorCode: code, updatedAt: now }).where(eq(plaidItems.id, s.item.id)).run();
      }
      this.deps.logger.warn({ itemId: s.item.id, ...this.facts(err) }, 'savings investments failed; read again next sync');
      return 'retry';
    }
    counts.skippedEntries += skipped;
    const mine = new Map(accounts.map((a) => [a.plaidAccountId, a]));
    const now = this.deps.clock.now();
    let emptyKept = 0;
    this.deps.db.transaction((tx) => {
      const flowIds = new Set<string>();
      for (const t of got) {
        const key = `${t.type ?? 'null'}:${t.subtype ?? 'null'}`;
        counts.byType[key] = (counts.byType[key] ?? 0) + 1;
        const account = mine.get(t.account_id);
        if (!account) continue;
        if (!isLocalDate(t.date)) {
          counts.unreadable++;
          continue;
        }
        if (t.unofficial_currency_code !== null || (account.isoCurrencyCode !== null && t.iso_currency_code !== null && t.iso_currency_code !== account.isoCurrencyCode)) {
          counts.otherCurrency++;
          continue;
        }
        const c = classifyInvestmentTransaction(t);
        if (c.signMismatch) counts.signMismatch++;
        if (c.unreadable) counts.unreadable++;
        if (c.flow === null) {
          counts.notFlows++;
          continue;
        }
        flowIds.add(t.investment_transaction_id);
        const r = upsertFlow(tx, { accountId: account.id, source: 'investments', plaidId: t.investment_transaction_id, date: t.date, ...c.flow }, now);
        if (r === 'added') {
          counts.flowsAdded++;
          counts.csvReplaced += replaceCsvTwin(tx, { accountId: account.id, date: t.date, ...c.flow });
        } else if (r === 'updated') counts.flowsUpdated++;
      }
      // Cancelled (or no longer a flow): stored in the window, not listed now. Only after a complete
      // read in which every entry parsed: an entry not seen might just be unread.
      // An answer with nothing at all in a window that has stored flows is more likely Plaid's
      // hiccup than every flow cancelled at once: nothing is deleted, and the log says so.
      if (complete && skipped === 0) {
        const stale = investmentFlowIdsIn(tx, accounts.map((a) => a.id), window.start, window.end).filter((f) => !flowIds.has(f.plaidId));
        if (got.length === 0 && stale.length > 0) emptyKept = stale.length;
        else counts.flowsRemoved += deleteFlowsById(tx, stale.map((f) => f.id));
      }
      // Incomplete: the window isn't moved on, so the next run reads the unread (oldest) part again.
      tx.update(plaidItems)
        .set({ investmentsStatus: 'available', investmentsErrorCode: null, ...(complete ? { investmentsThrough: window.end } : {}), updatedAt: now })
        .where(eq(plaidItems.id, s.item.id))
        .run();
    });
    if (emptyKept > 0) this.deps.logger.warn({ itemId: s.item.id, stored: emptyKept }, 'savings investments read empty; nothing deleted');
    if (!complete) this.deps.logger.warn({ itemId: s.item.id, read: got.length + skipped }, 'savings investments read incomplete; nothing deleted');
    return complete ? 'synced' : 'incomplete';
  }

  /** Why the Item isn't synced now, or null. Read without the lock; syncItem checks the pick again under it. */
  private skipReason(itemId: number, ignoreBackoff: boolean): SavingsSkipReason | null {
    const item = this.deps.plaid.item(itemId);
    if (!item || item.removedAt !== null || item.connectionId === null || item.purpose !== 'savings') return 'removed';
    if (item.pickedAt === null) return 'not_picked';
    const status = this.deps.db.select({ status: connections.status }).from(connections).where(eq(connections.id, item.connectionId)).get()?.status;
    if (status === undefined) return 'removed';
    if (status === 'needs_reconnect') return 'needs_reconnect';
    if (!ignoreBackoff && item.backoffUntil !== null && item.backoffUntil.getTime() > this.deps.clock.now().getTime()) return 'backoff';
    return null;
  }

  /** Savings Items that aren't removed, oldest first. */
  liveItemIds(): number[] {
    return this.deps.db.select({ id: plaidItems.id }).from(plaidItems)
      .where(and(isNull(plaidItems.removedAt), eq(plaidItems.purpose, 'savings')))
      .orderBy(asc(plaidItems.id)).all().map((r) => r.id);
  }

  /**
   * The `savings.sync` job: every Savings Item, one after another, stopping when `signal` aborts.
   * One that needs reconnecting is first checked with `check` (BankSync.checkItem, which asks
   * `/item/get` and clears the state when Plaid reports no error, queuing a sync, which counts as
   * done here rather than being run twice); a failed check is logged. A
   * run's failure is counted and logged. Under a key mismatch, nothing can be read: all skipped.
   */
  async syncAll(opts: { signal?: AbortSignal; check?: (itemId: number) => Promise<unknown> } = {}): Promise<SavingsRunSummary> {
    const ids = this.liveItemIds();
    const summary: SavingsRunSummary = { total: ids.length, done: 0, skipped: 0, failed: 0 };
    if (this.deps.plaid.keyMismatch) {
      this.deps.logger.info({ items: ids.length, reason: 'key_mismatch' }, 'savings scheduled run skipped');
      return { ...summary, skipped: ids.length };
    }
    for (const id of ids) {
      if (opts.signal?.aborted) break;
      if (opts.check && this.needsReconnect(id)) {
        try {
          // 'repaired': the check has already queued a sync (syncSoon), so this run doesn't make a second one.
          if ((await opts.check(id)) === 'repaired') {
            summary.done++;
            continue;
          }
        } catch (err) {
          this.deps.logger.warn({ itemId: id, ...this.facts(err) }, 'savings item check failed');
        }
      }
      try {
        const out = await this.syncItem(id, { reason: 'scheduled' });
        if (out.status === 'skipped') summary.skipped++;
        else summary.done++;
      } catch (err) {
        summary.failed++;
        this.deps.logger.warn({ itemId: id, ...this.facts(err) }, 'savings scheduled run failed for an item');
      }
    }
    return summary;
  }

  private needsReconnect(itemId: number): boolean {
    const item = this.deps.plaid.item(itemId);
    if (!item || item.connectionId === null) return false;
    return this.deps.db.select({ status: connections.status }).from(connections).where(eq(connections.id, item.connectionId)).get()?.status === 'needs_reconnect';
  }

  /**
   * A sync in the background (a webhook's, or a request's that ran out of time): one at a time per
   * Item. A request while one waits for the lock joins it; while one runs, it makes one more after.
   */
  syncSoon(itemId: number): void {
    const entry = this.queued.get(itemId);
    if (entry) {
      if (entry.started) entry.again = true;
      return;
    }
    const state = { started: false, again: false };
    this.queued.set(itemId, state);
    const p = (async () => {
      try {
        do {
          state.again = false;
          state.started = false;
          try {
            await this.syncItem(itemId, { reason: 'webhook', onStart: () => { state.started = true; } });
          } catch (err) {
            this.deps.logger.warn({ itemId, ...this.facts(err) }, 'savings background sync failed');
          }
        } while (state.again);
      } finally {
        this.queued.delete(itemId);
      }
    })();
    this.background.add(p);
    void p.finally(() => this.background.delete(p));
  }

  /** Resolves once no background work is left (tests, and shutdown). */
  async idle(): Promise<void> {
    while (this.background.size > 0) await Promise.allSettled([...this.background]);
  }

  /** Plaid's facts about a failure, never its message. */
  private facts(err: unknown): Record<string, unknown> {
    if (err instanceof PlaidApiError) return { status: err.status, errorType: err.errorType, errorCode: err.errorCode };
    return { kind: classifyPlaidError(err), ...loggableError(err) };
  }
}
