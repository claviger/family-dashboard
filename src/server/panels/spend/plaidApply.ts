import { and, asc, eq, gte, inArray, isNotNull, isNull, lt, lte, or } from 'drizzle-orm';
import { addDays, isLocalDate } from '../../../shared/dates.js';
import type { Clock } from '../../core/clock.js';
import type { Db } from '../../db/index.js';
import { cards, plaidItems, transactions, type PlaidItemRow, type TransactionRow } from '../../db/schema.js';
import { plaidAmountCents, type PlaidTransaction, type TransactionsSyncPage } from '../../integrations/plaid/client.js';
import { DUPLICATE_TEST, DuplicateMatcher, type DuplicateCandidate } from './duplicates.js';
import { restoreReplaced } from './replaced.js';
import { repointDuplicates, settleDuplicate } from './twins.js';
import { categorize } from './rules.js';
import { loadCategorizer } from './store.js';

/**
 * Applying one `/transactions/sync` run to `transactions` (spec §12.3, §12.13, the design's
 * departures 6 and 7). Pure database work: the sync loop (plaidSync.ts) fetches every page of a
 * run, then hands them here, and the changes and the new cursor are saved in one database
 * transaction, so a run is applied whole or not at all and the cursor never moves past changes
 * that weren't saved (research §5.2).
 *
 * In order:
 * 1. The pages are folded into each transaction's last state in the run (a later page wins).
 * 2. Removed: soft-deleted (`removed_at` and `deleted_at`), kept 7 days so a posted version that
 *    comes later can still carry its fields over; `pruneRemovedTransactions` hard-deletes them after.
 * 3. Added and modified are one upsert by `plaid_transaction_id`: an id already stored is updated
 *    (so a full resync is harmless), an id we don't have is added. Categories go through
 *    `categorize` with the stored row as `current`, so a manual edit is kept and history is never
 *    erased, and a row whose values didn't change isn't written at all (its `updated_at` stays, and a
 *    stale draft's `expected` still matches).
 * 4. Each new posted row then takes manual fields (category, person, note) from, in turn:
 *    - its pending version (`pending_transaction_id`), live or removed in the last 7 days; when
 *      that isn't stored (Plaid names none, or names one we never had, as when the history comes
 *      again under new ids, review C-S-I2), a pending row on its card that Plaid removed in the
 *      last 7 days and that passes the duplicate test;
 *    - failing that, a posted row on its card that Plaid removed in the last 7 days and that passes
 *      the duplicate test (churn: Plaid re-adds a changed transaction under a new id, research §5.3).
 *      Whatever pointed at the churned row (the CSV row it replaced, say) is pointed at the new one,
 *      since the churned row is pruned after 7 days;
 *    - a live CSV row on its card that passes the duplicate test, which is then soft-deleted
 *      (§12.13), unless a CSV row already points at the new row (it took one over from churn).
 *      Only posted rows replace CSV rows: a pending amount can still change (departure 6);
 *    - in the same pass, a live posted Plaid row on its card from a bank that's no longer linked (its
 *      account isn't attached to any linked Item): after a Remove that kept the transactions, or a
 *      key reset, the bank linked again re-sends up to 730 days under new ids, and attached to the
 *      same card that would double the history. A row of a linked Item is never a candidate. The
 *      same rule holds: a new row such a row already points at takes no other.
 *    Each source gets `replaced_by_id`, so it's never carried over or matched twice.
 *
 * Transactions of an account that isn't on the Item's account list at all (Plaid changed its id,
 * or it's new) aren't applied: they're counted, and the Item's `new_accounts_at` is set so Spend
 * settings offers to load the accounts. Nothing is lost: attaching an account after the first pick
 * asks for a full resync (`full_resync_at`), and the one that follows is idempotent. The cursor is
 * never reset for it: the sync loop first brings the Item current from it, so removals Plaid queued
 * since are applied, and only then asks for the whole history (`FullResync`, review C-S-I1).
 *
 * Matching is greedy (`DuplicateMatcher`), so the new rows are taken in a fixed order (card,
 * amount, date, Plaid id) whatever order Plaid sent them in, and each is tested with its merchant
 * name, then its raw name. Plaid's merchant text is never logged; the counts are for the log line.
 */

/** Removed rows are kept this long for carry-over and churn, then pruned (spec §12.3). */
export const REMOVED_KEEP_MS = 7 * 24 * 60 * 60 * 1000;

/** What a sync page carries that's applied. `TransactionsSyncPage` fits. */
export type SyncPageChanges = Pick<TransactionsSyncPage, 'added' | 'modified' | 'removed'>;

/** A whole run: every page from the stored cursor until `has_more` was false. */
export interface SyncRun {
  /** In the order Plaid returned them. */
  pages: readonly SyncPageChanges[];
  /** The last page's `next_cursor`, saved with the changes. `""` (no data yet) is saved as null. */
  nextCursor: string;
  /** The last page's `transactions_update_status`. Null leaves the stored one. */
  transactionsUpdateStatus: string | null;
}

/** What a run did, for the `plaid sync` log line. Counts only. */
export interface SyncApplyCounts {
  /** New rows stored. */
  added: number;
  /** Stored rows whose values changed. */
  modified: number;
  /** Listed in added or modified, but nothing changed (or the row was already replaced). */
  unchanged: number;
  /** Rows soft-deleted because Plaid removed them. */
  removed: number;
  /** Of those, posted ones: rare enough to be worth seeing (churn, or a reversed charge). */
  removedPosted: number;
  /** New posted rows that took fields from their pending version. */
  carriedPending: number;
  /** New posted rows that took fields from a removed posted row (churn). */
  churned: number;
  /**
   * Rows (a CSV row, an old bank's row) brought back because Plaid removed the posted row that had
   * replaced them, and nothing took its place (`restoreReplaced`).
   */
  restoredReplaced: number;
  /** Replaced CSV rows whose import was undone, hard-deleted instead of brought back. */
  purgedReplaced: number;
  /** CSV rows a new Plaid row replaced. */
  replacedCsv: number;
  /**
   * Plaid rows of a bank that's no longer linked (removed, or forgotten by a key reset) that a new
   * row replaced: the bank linked again re-sends its history under new ids.
   */
  replacedOldBank: number;
  /** Amounts with more than two decimal places, rounded to the cent. */
  roundedAmounts: number;
  /** Transactions dropped for an amount past MAX_AMOUNT_CENTS. */
  droppedAmounts: number;
  /** Transactions dropped for an account on the Item's list that's skipped, waiting for the pick, or on a removed card. */
  droppedAccounts: number;
  /**
   * Transactions dropped for an account the Item's list doesn't have (an id Plaid changed, or a new
   * account): they set the Item's `new_accounts_at`.
   */
  unknownAccounts: number;
  /** Transactions dropped for a date that isn't a real YYYY-MM-DD. */
  unreadableDates: number;
  /**
   * Live pending rows of the Item's attached accounts that a full resync didn't return, soft-deleted
   * as if Plaid had removed them (review C-S-I1). Posted rows are never reconciled this way.
   */
  reconciledPending: number;
}

export function emptySyncCounts(): SyncApplyCounts {
  return {
    added: 0, modified: 0, unchanged: 0, removed: 0, removedPosted: 0, carriedPending: 0, churned: 0, restoredReplaced: 0, purgedReplaced: 0, replacedCsv: 0, replacedOldBank: 0, roundedAmounts: 0,
    droppedAmounts: 0, droppedAccounts: 0, unknownAccounts: 0, unreadableDates: 0, reconciledPending: 0,
  };
}

/** Two runs' counts together, for a sync that made a catch-up pass and then a full one. */
export function addSyncCounts(a: SyncApplyCounts, b: SyncApplyCounts): SyncApplyCounts {
  const out = { ...a };
  for (const key of Object.keys(out) as (keyof SyncApplyCounts)[]) out[key] += b[key];
  return out;
}

/**
 * A run asked for with no cursor because the Item's `full_resync_at` is set (review C-S-I1). It
 * clears the marker in the same transaction that saves its cursor, unless Plaid answered "no data
 * yet" (`next_cursor` `""`): then nothing is reset, the stored cursor stays, and so does the marker.
 * `reconcilePending`: the Item had synced before, so a live pending row of an attached account that
 * this whole history doesn't list is gone at Plaid (its removal was lost somehow) and is
 * soft-deleted. A posted row missing from it is left alone: deleting one wrongly would be worse.
 */
export interface FullResync {
  reconcilePending: boolean;
}

type Change = { kind: 'upsert'; tx: PlaidTransaction } | { kind: 'removed' };

/**
 * Each transaction's last state in the run. Plaid lists a transaction once per page; across pages a
 * later entry is newer, and a removal on a page is taken after its additions.
 */
function fold(pages: readonly SyncPageChanges[]): Map<string, Change> {
  const net = new Map<string, Change>();
  for (const page of pages) {
    for (const tx of [...page.added, ...page.modified]) {
      net.delete(tx.transaction_id);
      net.set(tx.transaction_id, { kind: 'upsert', tx });
    }
    for (const r of page.removed) {
      net.delete(r.transaction_id);
      net.set(r.transaction_id, { kind: 'removed' });
    }
  }
  return net;
}

/** Few enough bound values per query for any SQLite build. */
function chunked<T>(list: readonly T[], size = 500): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

const collapse = (text: string | null) => {
  const s = text?.replace(/\s+/g, ' ').trim() ?? '';
  return s === '' ? null : s;
};

/** The merchant name, or the raw description when there's none (as rules and the table read it). */
const merchantOf = (row: Pick<TransactionRow, 'merchant' | 'rawName'>) => (row.merchant && row.merchant.trim() !== '' ? row.merchant : row.rawName);

/** The Plaid-owned columns of a row, from Plaid's transaction. */
function plaidFields(tx: PlaidTransaction, cardId: number, amountCents: number) {
  const merchant = collapse(tx.merchant_name);
  const pfc = tx.personal_finance_category;
  return {
    cardId,
    plaidTransactionId: tx.transaction_id,
    plaidAccountId: tx.account_id,
    pending: tx.pending,
    pendingTransactionId: tx.pending_transaction_id,
    date: tx.date,
    authorizedDate: tx.authorized_date !== null && isLocalDate(tx.authorized_date) ? tx.authorized_date : null,
    amountCents,
    // As Plaid sends them: one or the other is set. The column's USD default never applies here.
    isoCurrencyCode: tx.iso_currency_code,
    unofficialCurrencyCode: tx.unofficial_currency_code,
    merchant,
    rawName: collapse(tx.name) ?? merchant ?? '',
    originalDescription: tx.original_description,
    plaidPfcPrimary: pfc?.primary ?? null,
    plaidPfcDetailed: pfc?.detailed ?? null,
    plaidPfcConfidence: pfc?.confidence_level ?? null,
    plaidPfcVersion: pfc?.version ?? null,
    merchantEntityId: tx.merchant_entity_id,
    logoUrl: tx.logo_url,
    counterparties: tx.counterparties,
  };
}

type RowValues = Partial<typeof transactions.$inferInsert>;

function same(a: unknown, b: unknown): boolean {
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') return JSON.stringify(a) === JSON.stringify(b);
  return a === b;
}

/** Only the values that differ from what's stored. */
function changes(row: TransactionRow, next: RowValues): RowValues {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(next)) {
    if (!same(row[key as keyof TransactionRow], value)) out[key] = value;
  }
  return out as RowValues;
}

/**
 * What `to` takes from `from`: a manual category, a manual person, a note, each only where `to`
 * has none of its own yet (a posted row may already have its pending version's, say).
 */
function manualFieldsFrom(from: TransactionRow, to: TransactionRow): RowValues {
  const set: RowValues = {};
  if (from.categorySource === 'manual' && to.categorySource !== 'manual') Object.assign(set, { categoryId: from.categoryId, categorySource: 'manual' });
  if (from.personSource === 'manual' && to.personSource !== 'manual') Object.assign(set, { personUserId: from.personUserId, personSource: 'manual' });
  if (from.note !== null && to.note === null) set.note = from.note;
  return set;
}

/** Greedy matching takes rows in this order, so the result doesn't depend on Plaid's. */
function matchingOrder(rows: readonly TransactionRow[]): TransactionRow[] {
  return [...rows].sort(
    (a, b) => a.cardId - b.cardId || a.amountCents - b.amountCents || a.date.localeCompare(b.date) || a.plaidTransactionId!.localeCompare(b.plaidTransactionId!),
  );
}

/** A Plaid row against the matcher's candidates: its merchant name first, then its raw name (the 6a handoff). */
function matchPlaidRow(matcher: DuplicateMatcher, row: TransactionRow): DuplicateCandidate | null {
  const base = { cardId: row.cardId, date: row.date, amountCents: row.amountCents, reference: null };
  const merchant = row.merchant && row.merchant.trim() !== '' ? row.merchant : null;
  const byMerchant = merchant !== null ? matcher.match({ ...base, merchant }) : null;
  if (byMerchant) return byMerchant;
  return row.rawName !== merchant ? matcher.match({ ...base, merchant: row.rawName }) : null;
}

function candidate(row: TransactionRow): DuplicateCandidate {
  return { id: row.id, cardId: row.cardId, date: row.date, amountCents: row.amountCents, merchant: merchantOf(row), reference: row.csvReference };
}

/** The Item's attached accounts: Plaid account id to card id. A skipped account has no card, so its transactions are dropped. */
export function attachedAccounts(db: Db, itemId: number): Map<string, number> {
  return new Map(
    db
      .select({ id: cards.id, accountId: cards.plaidAccountId })
      .from(cards)
      .where(and(eq(cards.plaidItemId, itemId), isNotNull(cards.plaidAccountId), isNull(cards.removedAt)))
      .all()
      .map((c) => [c.accountId!, c.id]),
  );
}

/**
 * Plaid account ids attached to a card of an Item that's still linked, any Item. A Plaid row whose
 * account isn't one of them belongs to a bank that's gone (removed, or forgotten by a key reset).
 */
function linkedAccountIds(db: Db): Set<string> {
  return new Set(
    db
      .select({ accountId: cards.plaidAccountId })
      .from(cards)
      .innerJoin(plaidItems, eq(plaidItems.id, cards.plaidItemId))
      .where(and(isNotNull(cards.plaidAccountId), isNull(cards.removedAt), isNull(plaidItems.removedAt)))
      .all()
      .map((c) => c.accountId!),
  );
}

/**
 * Applies one run for `item` and saves its cursor, all in one database transaction. The sync loop
 * (plaidSync.ts) calls it under the Item's lock with every page it buffered. Also sets the Item's
 * `transactions_status` and `last_sync_at`. An Item removed meanwhile keeps its cursor, and its
 * cards are removed, so nothing is added to them.
 */
export function applySyncRun(deps: { db: Db; clock: Clock }, item: Pick<PlaidItemRow, 'id'>, run: SyncRun, opts: { full?: FullResync } = {}): SyncApplyCounts {
  const { db } = deps;
  const now = deps.clock.now();
  const keptSince = new Date(now.getTime() - REMOVED_KEEP_MS);
  const counts = emptySyncCounts();
  const net = fold(run.pages);
  // A full resync Plaid had no data for yet changes nothing about the Item's place: tried again next run.
  const fullDone = opts.full !== undefined && run.nextCursor !== '';

  const applyChanges = () => {
    const env = loadCategorizer(db);
    const cardOf = attachedAccounts(db, item.id);
    // An account Plaid stopped listing (`listed: false`) counts as unknown again if its transactions come back.
    const listed = new Set(
      (db.select({ accounts: plaidItems.accounts }).from(plaidItems).where(eq(plaidItems.id, item.id)).get()?.accounts ?? [])
        .filter((a) => a.listed !== false)
        .map((a) => a.accountId),
    );
    const stored = new Map<string, TransactionRow>();
    for (const ids of chunked([...net.keys()])) {
      for (const row of db.select().from(transactions).where(inArray(transactions.plaidTransactionId, ids)).all()) stored.set(row.plaidTransactionId!, row);
    }
    const update = (id: number, set: RowValues) => db.update(transactions).set({ ...set, updatedAt: now }).where(eq(transactions.id, id)).run();

    // Removed first, so a posted row later in the run finds its pending or churned source either way.
    const removedPosted: TransactionRow[] = [];
    for (const [id, change] of net) {
      if (change.kind !== 'removed') continue;
      const row = stored.get(id);
      if (!row || row.removedAt !== null) continue;
      update(row.id, { removedAt: now, deletedAt: row.deletedAt ?? now });
      counts.removed++;
      if (!row.pending) {
        counts.removedPosted++;
        removedPosted.push(row);
      }
    }
    // A full resync lists every transaction Plaid has: a live pending row of an attached account
    // that it doesn't list is gone (review C-S-I1). Soft-deleted like a removal, so a posted version
    // later in this run, or within 7 days, still carries its fields over.
    if (fullDone && opts.full!.reconcilePending) {
      for (const ids of chunked([...cardOf.keys()])) {
        const live = db.select().from(transactions)
          .where(and(eq(transactions.source, 'plaid'), eq(transactions.pending, true), isNull(transactions.deletedAt), isNull(transactions.removedAt), inArray(transactions.plaidAccountId, ids)))
          .all();
        for (const row of live) {
          if (net.get(row.plaidTransactionId!)?.kind === 'upsert') continue;
          update(row.id, { removedAt: now, deletedAt: now });
          counts.reconciledPending++;
        }
      }
    }
    /**
     * What a posted row this run removed had replaced, and nothing re-pointed (churn points it at
     * the new row), comes back (`restoreReplaced`). Run after churn and before the CSV pass, so a
     * re-add churn didn't match can take a restored CSV row again in this same run.
     */
    const restoreUnclaimed = () => {
      const { restored, purged } = restoreReplaced(db, removedPosted, now, () => env);
      counts.restoredReplaced += restored;
      counts.purgedReplaced += purged;
    };

    const inserted: TransactionRow[] = [];
    for (const [id, change] of net) {
      if (change.kind !== 'upsert') continue;
      const tx = change.tx;
      const cardId = cardOf.get(tx.account_id);
      if (cardId === undefined) {
        if (listed.has(tx.account_id)) counts.droppedAccounts++;
        else counts.unknownAccounts++;
        continue;
      }
      if (!isLocalDate(tx.date)) {
        counts.unreadableDates++;
        continue;
      }
      const amount = plaidAmountCents(tx.amount);
      if (!amount) {
        counts.droppedAmounts++;
        continue;
      }
      if (amount.rounded) counts.roundedAmounts++;
      const fields = plaidFields(tx, cardId, amount.cents);
      const row = stored.get(id);
      if (!row) {
        inserted.push(db.insert(transactions).values({ ...fields, ...categorize(fields, null, env), source: 'plaid', createdAt: now, updatedAt: now }).returning().get());
        counts.added++;
        continue;
      }
      // Its work went to another row (a posted version took its fields): it stays as it is.
      if (row.replacedById !== null) {
        counts.unchanged++;
        continue;
      }
      const set = changes(row, { ...fields, ...categorize(fields, row, env) });
      // Plaid lists it again, so it's back; unless an admin removed it as a duplicate, which stands.
      if (row.removedAt !== null) Object.assign(set, row.deletedReason === 'duplicate' ? { removedAt: null } : { removedAt: null, deletedAt: null });
      if (Object.keys(set).length === 0) {
        counts.unchanged++;
        continue;
      }
      update(row.id, set);
      counts.modified++;
    }

    const posted = matchingOrder(inserted.filter((r) => !r.pending));
    if (posted.length === 0) {
      restoreUnclaimed();
      return;
    }
    /** Sets on the new row, and keeps the in-memory copy in step for the next step's "none yet". */
    const take = (to: TransactionRow, from: TransactionRow) => {
      const set = manualFieldsFrom(from, to);
      if (Object.keys(set).length > 0) {
        update(to.id, set);
        Object.assign(to, set);
      }
    };
    const replace = (source: TransactionRow, by: TransactionRow) => update(source.id, { replacedById: by.id, deletedAt: source.deletedAt ?? now });
    /**
     * A new row takes `source`'s place for good (its pending version, or churn): what was removed as
     * `source`'s duplicate now points at it while it's still their twin, and when `source` itself
     * was removed as a duplicate, so is the new row while it still has a live twin (spec §12.12):
     * a removal by hand outlives the bank's new id, but never hides a charge whose amount changed.
     */
    const takeOver = (source: TransactionRow, row: TransactionRow) => {
      take(row, source);
      replace(source, row);
      repointDuplicates(db, source.id, row.id, now);
      // Read again: an earlier row in this run may have moved its twin on, or brought it back.
      const fresh = db.select().from(transactions).where(eq(transactions.id, source.id)).get()!;
      if (fresh.deletedReason !== 'duplicate') return;
      const set = { deletedAt: now, deletedReason: 'duplicate' as const, duplicateOfId: fresh.duplicateOfId, duplicateCarry: fresh.duplicateCarry };
      update(row.id, set);
      // Only while it's still a twin: a new amount or date (a tip, a fuel hold) is a real charge, left live.
      settleDuplicate(db, { ...row, ...set }, now, { prefer: fresh.duplicateOfId });
      Object.assign(row, db.select().from(transactions).where(eq(transactions.id, row.id)).get()!);
    };
    const cardIds = [...new Set(posted.map((r) => r.cardId))];

    // Pending to posted (spec §12.3): the pending row, live or removed within 7 days, not yet carried over.
    const sources = new Map<string, TransactionRow>();
    const pendingIds = [...new Set(posted.map((r) => r.pendingTransactionId).filter((v) => v !== null))];
    for (const ids of chunked(pendingIds)) {
      const rows = db
        .select()
        .from(transactions)
        .where(
          and(
            inArray(transactions.plaidTransactionId, ids),
            eq(transactions.source, 'plaid'),
            isNull(transactions.replacedById),
            // Removed as a duplicate by hand counts too: its posted version stays removed with it.
            or(isNull(transactions.deletedAt), gte(transactions.removedAt, keptSince), eq(transactions.deletedReason, 'duplicate')),
          ),
        )
        .all();
      for (const row of rows) sources.set(row.plaidTransactionId!, row);
    }
    const unsourced: TransactionRow[] = [];
    for (const row of posted) {
      const source = row.pendingTransactionId !== null ? sources.get(row.pendingTransactionId) : undefined;
      if (!source) {
        unsourced.push(row);
        continue;
      }
      sources.delete(row.pendingTransactionId!);
      takeOver(source, row);
      counts.carriedPending++;
    }

    /**
     * The new rows in `rows` matched against rows of their cards Plaid removed in the last 7 days,
     * pending or posted, not yet carried over. Gives back the rows left unmatched.
     */
    const fromRemoved = (rows: TransactionRow[], pending: boolean, matched: (row: TransactionRow, source: TransactionRow) => void): TransactionRow[] => {
      if (rows.length === 0) return rows;
      const removed = db
        .select()
        .from(transactions)
        .where(
          and(
            inArray(transactions.cardId, cardIds),
            eq(transactions.source, 'plaid'),
            eq(transactions.pending, pending),
            gte(transactions.removedAt, keptSince),
            isNull(transactions.replacedById),
          ),
        )
        .orderBy(asc(transactions.id))
        .all();
      if (removed.length === 0) return rows;
      const byId = new Map(removed.map((r) => [r.id, r]));
      const matcher = new DuplicateMatcher(removed.map(candidate));
      const left: TransactionRow[] = [];
      for (const row of rows) {
        const hit = matchPlaidRow(matcher, row);
        if (hit) matched(row, byId.get(hit.id)!);
        else left.push(row);
      }
      return left;
    };

    // The pending ids the unsourced rows name that are stored here in any state: carried over
    // already, or deleted outside the 7 days.
    const known = new Set<string>();
    const unsourcedIds = [...new Set(unsourced.map((r) => r.pendingTransactionId).filter((v) => v !== null))];
    for (const ids of chunked(unsourcedIds)) {
      const rows = db
        .select({ plaidTransactionId: transactions.plaidTransactionId })
        .from(transactions)
        .where(and(inArray(transactions.plaidTransactionId, ids), eq(transactions.source, 'plaid')))
        .all();
      for (const row of rows) known.add(row.plaidTransactionId!);
    }
    const namesKnown = (row: TransactionRow) => row.pendingTransactionId !== null && known.has(row.pendingTransactionId);

    // A posted row without its pending version here that names none (some banks never do) or names
    // one we never stored: a pending row Plaid removed (or one dropped with its old account id, its
    // removed bank, or a key reset) that passes the duplicate test. When the bank's history comes
    // again under new ids, the posted row names a pending id we never had, and this is how a pending
    // row's manual edits still carry over (review C-S-I2). A row naming a pending id we did store
    // (already carried over, or deleted outside the 7 days) has had its pending version, so it skips
    // this and goes straight to churn: a churned posted row still names the pending id its earlier
    // self took, and must not take a voided duplicate pre-auth's fields in place of its own.
    const unmatched = new Set(fromRemoved(unsourced.filter((r) => !namesKnown(r)), true, (row, source) => {
      takeOver(source, row);
      counts.carriedPending++;
    }));
    const left = unsourced.filter((r) => namesKnown(r) || unmatched.has(r));

    // Churn (research §5.3): a posted row Plaid removed in the last 7 days, on the same card, that
    // passes the duplicate test. What pointed at it (a CSV row it replaced, its pending version)
    // points at the new row instead, since the churned row is pruned after 7 days.
    fromRemoved(left, false, (row, source) => {
      db.update(transactions).set({ replacedById: row.id, updatedAt: now }).where(eq(transactions.replacedById, source.id)).run();
      takeOver(source, row);
      counts.churned++;
    });

    restoreUnclaimed();

    // Replacement (spec §12.13), one greedy pass: live rows of the card within the duplicate test's
    // window of the new rows, either CSV rows or Plaid rows of a bank that's no longer linked.
    const dates = posted.map((r) => r.date).sort();
    const linked = linkedAccountIds(db);
    // Posted rows only (departure 6): a pending amount can still change.
    const replaceable = (r: TransactionRow) => r.source === 'csv' || (r.source === 'plaid' && !r.pending && r.plaidAccountId !== null && !linked.has(r.plaidAccountId));
    const older = db
      .select()
      .from(transactions)
      .where(
        and(
          inArray(transactions.cardId, cardIds),
          isNull(transactions.deletedAt),
          isNull(transactions.replacedById),
          gte(transactions.date, addDays(dates[0]!, -DUPLICATE_TEST.dateWindowDays)),
          lte(transactions.date, addDays(dates.at(-1)!, DUPLICATE_TEST.dateWindowDays)),
        ),
      )
      .orderBy(asc(transactions.id))
      .all()
      .filter(replaceable);
    if (older.length === 0) return;
    // A new row a CSV or old-bank row already points at (it took one over from churn) has its twin.
    const taken = new Set<number>();
    for (const ids of chunked(posted.map((r) => r.id))) {
      for (const r of db.select().from(transactions).where(inArray(transactions.replacedById, ids)).all()) {
        if (replaceable(r)) taken.add(r.replacedById!);
      }
    }
    const olderById = new Map(older.map((r) => [r.id, r]));
    const matcher = new DuplicateMatcher(older.map(candidate));
    for (const row of posted) {
      // Removed as a duplicate (it took over a row that was): it replaces nothing.
      if (taken.has(row.id) || row.deletedAt !== null) continue;
      const hit = matchPlaidRow(matcher, row);
      if (!hit) continue;
      const source = olderById.get(hit.id)!;
      take(row, source);
      replace(source, row);
      if (source.source === 'csv') counts.replacedCsv++;
      else counts.replacedOldBank++;
    }
  };

  // better-sqlite3 is synchronous on one connection, so every read and write through db in here is
  // inside the transaction, and a throw rolls all of it back, cursor included.
  db.transaction(() => {
    applyChanges();
    const noticeNewAccounts = counts.unknownAccounts > 0
      && db.select({ at: plaidItems.newAccountsAt }).from(plaidItems).where(eq(plaidItems.id, item.id)).get()?.at === null;
    db.update(plaidItems)
      .set({
        // A full resync with no data yet keeps the stored cursor (the catch-up pass's): resetting it would lose what Plaid queues meanwhile.
        ...(opts.full && !fullDone ? {} : { cursor: run.nextCursor === '' ? null : run.nextCursor }),
        ...(fullDone ? { fullResyncAt: null } : {}),
        ...(noticeNewAccounts ? { newAccountsAt: now } : {}),
        ...(run.transactionsUpdateStatus !== null ? { transactionsStatus: run.transactionsUpdateStatus } : {}),
        lastSyncAt: now,
        updatedAt: now,
      })
      .where(and(eq(plaidItems.id, item.id), isNull(plaidItems.removedAt)))
      .run();
  });
  return counts;
}

/**
 * Hard-deletes rows Plaid removed more than 7 days ago (the `spend.pruneRemoved` job): by then a
 * posted version has had its chance to carry their fields over. CSV rows a Plaid row replaced have
 * no `removed_at` and stay, so their reference numbers keep a re-import from bringing them back.
 * A row still pointing at one it deletes (a CSV row whose replacement went before the run could
 * restore it, say) comes back first (`restoreReplaced`), in the same transaction, so nothing is
 * left pointing at a row that's gone.
 */
export function pruneRemovedTransactions(db: Db, now: Date): number {
  return db.transaction((tx) => {
    const old = and(isNotNull(transactions.removedAt), lt(transactions.removedAt, new Date(now.getTime() - REMOVED_KEEP_MS)));
    restoreReplaced(tx, tx.select().from(transactions).where(old).all(), now, () => loadCategorizer(db));
    return tx.delete(transactions).where(old).run().changes;
  });
}
