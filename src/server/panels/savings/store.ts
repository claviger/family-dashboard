import { and, asc, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import type { SavingsBalanceSource, SavingsFlowKind, SavingsFlowSource } from '../../../shared/savings.js';
import type { Db } from '../../db/index.js';
import { savingsAccounts, savingsBalances, savingsFlows, type SavingsAccountRow } from '../../db/schema.js';
import type { DbOrTx } from '../../integrations/connections.js';
import { addDays, daysBetween } from '../../../shared/dates.js';
import { PLAID_TWIN_DAYS } from './csvRows.js';
import type { FlowPoint, Snapshot } from './math.js';

/**
 * The Savings tables' reads and writes (the Savings spec, "Data"): one snapshot per account per
 * day (a later fetch the same day replaces it), flows keyed by source and Plaid id, and deleting a
 * connection's data. `Plaid.remove` and the key reset use `deleteSavingsData` and
 * `markSavingsAccountsRemoved` inside their own transactions.
 */

/** How many ids go in one `IN (...)`, well under SQLite's limit on bound values. */
const ID_CHUNK = 500;

function chunks<T>(values: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += ID_CHUNK) out.push(values.slice(i, i + ID_CHUNK));
  return out;
}

/** The Item's accounts that are still on it (shown or hidden), oldest first. */
export function liveAccountsOf(db: DbOrTx, itemId: number): SavingsAccountRow[] {
  return db.select().from(savingsAccounts).where(and(eq(savingsAccounts.plaidItemId, itemId), isNull(savingsAccounts.removedAt))).orderBy(asc(savingsAccounts.id)).all();
}

/** Today's balance from Plaid: a later fetch the same day replaces it, and it replaces an imported or hand-set balance for the day. */
export function putSnapshot(db: DbOrTx, accountId: number, date: string, values: { currentCents: number; availableCents: number | null }, fetchedAt: Date): void {
  const set = { ...values, fetchedAt, source: 'plaid' as const, importId: null };
  db.insert(savingsBalances)
    .values({ accountId, date, ...set })
    .onConflictDoUpdate({ target: [savingsBalances.accountId, savingsBalances.date], set })
    .run();
}

/** Set balance (plan decision 21): the day's `manual` balance, over an imported or earlier hand-set one. A Plaid balance wins: `plaid`, and nothing is written. */
export function putManualBalance(db: DbOrTx, accountId: number, date: string, cents: number, now: Date): 'saved' | 'plaid' {
  const existing = db.select({ source: savingsBalances.source }).from(savingsBalances).where(and(eq(savingsBalances.accountId, accountId), eq(savingsBalances.date, date))).get();
  if (existing?.source === 'plaid') return 'plaid';
  const set = { currentCents: cents, availableCents: null, fetchedAt: now, source: 'manual' as const, importId: null };
  db.insert(savingsBalances).values({ accountId, date, ...set }).onConflictDoUpdate({ target: [savingsBalances.accountId, savingsBalances.date], set }).run();
  return 'saved';
}

/**
 * A new Plaid flow takes the place of the imported flow it matches (plan decision 24): same account,
 * kind, and amount, within 3 days, the nearest date first, then the oldest row. Deletes it: 1, or 0.
 */
export function replaceCsvTwin(db: DbOrTx, f: { accountId: number; date: string; kind: SavingsFlowKind; amountCents: number }): number {
  const candidates = db.select({ id: savingsFlows.id, date: savingsFlows.date }).from(savingsFlows)
    .where(and(
      eq(savingsFlows.accountId, f.accountId), eq(savingsFlows.source, 'csv'), eq(savingsFlows.kind, f.kind), eq(savingsFlows.amountCents, f.amountCents),
      gte(savingsFlows.date, addDays(f.date, -PLAID_TWIN_DAYS)), lte(savingsFlows.date, addDays(f.date, PLAID_TWIN_DAYS)),
    ))
    .all();
  const best = candidates.sort((a, b) => Math.abs(daysBetween(f.date, a.date)) - Math.abs(daysBetween(f.date, b.date)) || a.id - b.id)[0];
  return best ? db.delete(savingsFlows).where(eq(savingsFlows.id, best.id)).run().changes : 0;
}

/** The sources the Plaid sync writes. `csv` flows are the import's (imports.ts), with their import id. */
type PlaidFlowSource = Exclude<SavingsFlowSource, 'csv'>;

export interface FlowInput {
  accountId: number;
  source: PlaidFlowSource;
  plaidId: string;
  date: string;
  kind: SavingsFlowKind;
  amountCents: number;
}

/** Inserts or updates one flow by its source and Plaid id. Says which, for the sync's counts. */
export function upsertFlow(db: DbOrTx, f: FlowInput, now: Date): 'added' | 'updated' | 'unchanged' {
  const existing = db.select().from(savingsFlows).where(and(eq(savingsFlows.source, f.source), eq(savingsFlows.plaidId, f.plaidId))).get();
  if (!existing) {
    db.insert(savingsFlows).values({ ...f, createdAt: now, updatedAt: now }).run();
    return 'added';
  }
  if (existing.accountId === f.accountId && existing.date === f.date && existing.kind === f.kind && existing.amountCents === f.amountCents) return 'unchanged';
  db.update(savingsFlows).set({ accountId: f.accountId, date: f.date, kind: f.kind, amountCents: f.amountCents, updatedAt: now }).where(eq(savingsFlows.id, existing.id)).run();
  return 'updated';
}

/** Deletes flows by Plaid id. Returns how many there were. */
export function removeFlows(db: DbOrTx, source: PlaidFlowSource, plaidIds: readonly string[]): number {
  let n = 0;
  for (const ids of chunks(plaidIds)) n += db.delete(savingsFlows).where(and(eq(savingsFlows.source, source), inArray(savingsFlows.plaidId, ids))).run().changes;
  return n;
}

/** The brokerage window's stored flows, for removing what Plaid no longer lists (decision 7). */
export function investmentFlowIdsIn(db: DbOrTx, accountIds: readonly number[], start: string, end: string): { id: number; plaidId: string; date: string }[] {
  if (accountIds.length === 0) return [];
  const out: { id: number; plaidId: string; date: string }[] = [];
  for (const ids of chunks(accountIds)) {
    // The date range is in the query, so the (account_id, date) index does the work.
    out.push(...db.select({ id: savingsFlows.id, plaidId: savingsFlows.plaidId, date: savingsFlows.date }).from(savingsFlows)
      .where(and(inArray(savingsFlows.accountId, ids), gte(savingsFlows.date, start), lte(savingsFlows.date, end), eq(savingsFlows.source, 'investments')))
      .all());
  }
  return out;
}

export function deleteFlowsById(db: DbOrTx, ids: readonly number[]): number {
  let n = 0;
  for (const part of chunks(ids)) n += db.delete(savingsFlows).where(inArray(savingsFlows.id, part)).run().changes;
  return n;
}

/** Every snapshot of these accounts, oldest first, by account. */
export function snapshotsFor(db: Db, accountIds: readonly number[]): Map<number, Snapshot[]> {
  const out = new Map<number, Snapshot[]>(accountIds.map((id) => [id, []]));
  for (const ids of chunks(accountIds)) {
    for (const r of db.select().from(savingsBalances).where(inArray(savingsBalances.accountId, ids)).orderBy(asc(savingsBalances.date)).all()) {
      out.get(r.accountId)!.push({ date: r.date, cents: r.currentCents, fetchedAt: r.fetchedAt, source: r.source });
    }
  }
  return out;
}

/** Every flow of these accounts, by account. */
export function flowsFor(db: Db, accountIds: readonly number[]): Map<number, FlowPoint[]> {
  const out = new Map<number, FlowPoint[]>(accountIds.map((id) => [id, []]));
  for (const ids of chunks(accountIds)) {
    for (const r of db.select().from(savingsFlows).where(inArray(savingsFlows.accountId, ids)).orderBy(asc(savingsFlows.date), asc(savingsFlows.id)).all()) {
      out.get(r.accountId)!.push({ date: r.date, kind: r.kind, cents: r.amountCents });
    }
  }
  return out;
}

/** Both, for the read model. */
export function accountData(db: Db, accountIds: readonly number[]): Map<number, { snapshots: Snapshot[]; flows: FlowPoint[] }> {
  const snaps = snapshotsFor(db, accountIds);
  const flows = flowsFor(db, accountIds);
  return new Map(accountIds.map((id) => [id, { snapshots: snaps.get(id)!, flows: flows.get(id)! }]));
}

/** "Also delete its data" (spec "Data"): the Item's accounts, and with them (cascade) their balances and flows. */
export function deleteSavingsData(db: DbOrTx, itemId: number): { accounts: number } {
  return { accounts: db.delete(savingsAccounts).where(eq(savingsAccounts.plaidItemId, itemId)).run().changes };
}

/** Removing a connection and keeping its data, or the key reset: its accounts leave the current views (decision 14). */
export function markSavingsAccountsRemoved(db: DbOrTx, itemIds: readonly number[], now: Date): number {
  let n = 0;
  for (const ids of chunks(itemIds)) {
    n += db.update(savingsAccounts).set({ removedAt: now, updatedAt: now }).where(and(inArray(savingsAccounts.plaidItemId, ids), isNull(savingsAccounts.removedAt))).run().changes;
  }
  return n;
}

/** Each account's newest balance with its source, for Savings settings. */
export function latestBalances(db: Db, accountIds: readonly number[]): Map<number, { date: string; cents: number; source: SavingsBalanceSource }> {
  const out = new Map<number, { date: string; cents: number; source: SavingsBalanceSource }>();
  for (const ids of chunks(accountIds)) {
    for (const r of db.select().from(savingsBalances).where(inArray(savingsBalances.accountId, ids)).orderBy(asc(savingsBalances.date)).all()) {
      out.set(r.accountId, { date: r.date, cents: r.currentCents, source: r.source });
    }
  }
  return out;
}
