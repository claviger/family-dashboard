import { and, asc, eq, inArray, isNotNull, isNull, max, min } from 'drizzle-orm';
import {
  SAVINGS_CARD_GRAPH_MONTHS, SAVINGS_MESSAGES, SAVINGS_STALE_AFTER_MS, type MonthBreakdown, type SavingsAccountRef, type SavingsOverview, type SavingsSummary,
} from '../../../shared/savings.js';
import { localDate, type Clock } from '../../core/clock.js';
import { AppError } from '../../core/errors.js';
import type { Db } from '../../db/index.js';
import { connections, plaidItems, savingsAccounts, savingsBalances, savingsFlows, savingsImports, type PlaidItemRow, type SavingsAccountRow } from '../../db/schema.js';
import { getFamilySettings } from '../../settings.js';
import { fixFor } from '../spend/banks.js';
import { balanceSeries, monthBounds, monthBreakdown, sumBreakdowns, type AccountFlows, type Snapshot } from './math.js';
import { accountData } from './store.js';

/**
 * The Savings panel's reads (the Savings spec, "Numbers shown", "Line graph", "Home card"; plan
 * decisions 10 to 14). No Plaid calls: what the sync stored is all they need.
 */

export interface SavingsReadDeps {
  db: Db;
  clock: Clock;
}

interface AccountWithItem {
  account: SavingsAccountRow;
  /** Null for an account added by hand. */
  item: PlaidItemRow | null;
}

/** Every Savings account, with its Item when it's linked, oldest first. */
function accountsWithItems(db: Db): AccountWithItem[] {
  return db.select({ account: savingsAccounts, item: plaidItems }).from(savingsAccounts)
    .leftJoin(plaidItems, eq(plaidItems.id, savingsAccounts.plaidItemId))
    .orderBy(asc(savingsAccounts.id))
    .all();
}

/** The days each import covers, per account. */
type ImportRanges = ReadonlyMap<number, readonly { from: string; to: string }[]>;

/**
 * The days each import covers, per account: the file's own first and last day, recorded at Import
 * (0014). An import from before then has none recorded, so it covers from its first to its last
 * flow or balance still stored. An undone import covers nothing.
 */
function importRanges(db: Db): ImportRanges {
  const byImport = new Map<number, { accountId: number; from: string; to: string }>();
  const recorded = db.select({ id: savingsImports.id, accountId: savingsImports.accountId, from: savingsImports.firstDate, to: savingsImports.lastDate }).from(savingsImports).all();
  for (const r of recorded) if (r.from !== null && r.to !== null) byImport.set(r.id, { accountId: r.accountId, from: r.from, to: r.to });
  const known = new Set(byImport.keys());
  const add = (rows: { importId: number | null; accountId: number; from: string | null; to: string | null }[]) => {
    for (const r of rows) {
      if (r.importId === null || r.from === null || r.to === null || known.has(r.importId)) continue;
      const had = byImport.get(r.importId);
      byImport.set(r.importId, had
        ? { accountId: r.accountId, from: had.from < r.from ? had.from : r.from, to: had.to > r.to ? had.to : r.to }
        : { accountId: r.accountId, from: r.from, to: r.to });
    }
  };
  add(db.select({ importId: savingsFlows.importId, accountId: savingsFlows.accountId, from: min(savingsFlows.date), to: max(savingsFlows.date) })
    .from(savingsFlows).where(isNotNull(savingsFlows.importId)).groupBy(savingsFlows.importId, savingsFlows.accountId).all());
  add(db.select({ importId: savingsBalances.importId, accountId: savingsBalances.accountId, from: min(savingsBalances.date), to: max(savingsBalances.date) })
    .from(savingsBalances).where(isNotNull(savingsBalances.importId)).groupBy(savingsBalances.importId, savingsBalances.accountId).all());
  const out = new Map<number, { from: string; to: string }[]>();
  for (const r of byImport.values()) out.set(r.accountId, [...(out.get(r.accountId) ?? []), { from: r.from, to: r.to }]);
  return out;
}

const isShown = (a: AccountWithItem) => a.account.hiddenAt === null && a.account.removedAt === null;

/**
 * Whether `month`'s deposits and withdrawals are known: a linked cash account always, a linked
 * brokerage unless Plaid refused Investments, and any account (a hand-added one only then) when one
 * of its imports' days reach into the month (plan decision 22). Outside them it shows the total
 * change, not $0 of flows.
 */
function flowsAvailable(a: AccountWithItem, ranges: ImportRanges, month: string): boolean {
  const { first, last } = monthBounds(month);
  // A month one of the account's imports covers has its flows from the file, linked or not.
  const imported = (ranges.get(a.account.id) ?? []).some((r) => r.from <= last && r.to >= first);
  if (a.account.source === 'manual') return imported;
  return imported || a.account.kind === 'cash' || a.item?.investmentsStatus !== 'unavailable';
}

function ref(a: AccountWithItem, ranges: ImportRanges, month: string): SavingsAccountRef {
  return {
    id: a.account.id, nickname: a.account.nickname, kind: a.account.kind, source: a.account.source, mask: a.account.mask,
    flowsAvailable: flowsAvailable(a, ranges, month), connectionRemoved: a.account.removedAt !== null,
  };
}

/** The graph's flows for each shown account: its known months only, after its first balance. */
function seriesFlows(shown: readonly AccountWithItem[], ranges: ImportRanges, data: ReturnType<typeof accountData>): AccountFlows[] {
  return shown.map((a) => {
    const { snapshots, flows } = data.get(a.account.id)!;
    return { flows, known: (month: string) => flowsAvailable(a, ranges, month), after: snapshots[0]?.date ?? null };
  });
}

/** The total of the shown accounts over the last `months` months, with flows (spec "Line graph", "Home card"). */
function shownSeries(shown: readonly AccountWithItem[], ranges: ImportRanges, data: ReturnType<typeof accountData>, day: string, months?: number) {
  const snapshots: Snapshot[][] = shown.map((a) => data.get(a.account.id)!.snapshots);
  return balanceSeries(snapshots, day, shown.map((a) => a.account.nickname), { months, flows: seriesFlows(shown, ranges, data) });
}

function today(deps: SavingsReadDeps): string {
  return localDate(deps.clock.now(), getFamilySettings(deps.db).timeZone);
}

/** Live Savings connections that need the admin: Reconnect, or remove and connect again (as Spend's card, main spec §12.11). */
function attention(db: Db): SavingsSummary['attention'] {
  return db.select({
    item: plaidItems,
    connection: {
      id: connections.id, status: connections.status, consecutiveFailures: connections.consecutiveFailures,
      lastSuccessAt: connections.lastSuccessAt, lastError: connections.lastError, lastErrorAt: connections.lastErrorAt,
    },
  })
    .from(plaidItems)
    .innerJoin(connections, eq(connections.id, plaidItems.connectionId))
    .where(and(eq(plaidItems.purpose, 'savings'), isNull(plaidItems.removedAt), eq(connections.status, 'needs_reconnect')))
    .orderBy(asc(plaidItems.id))
    .all()
    .flatMap(({ item, connection }) => {
      const fix = fixFor(item, connection);
      return fix ? [{ itemId: item.id, institutionName: item.institutionName, fix }] : [];
    });
}

/** GET /summary: the home card (spec "Home card"; decision 13). */
export function savingsSummary(deps: SavingsReadDeps): SavingsSummary {
  const now = deps.clock.now();
  const day = today(deps);
  const month = day.slice(0, 7);
  const shown = accountsWithItems(deps.db).filter(isShown);
  const ranges = importRanges(deps.db);
  const data = accountData(deps.db, shown.map((a) => a.account.id));
  const accounts = shown.map((a) => {
    const { snapshots, flows } = data.get(a.account.id)!;
    const latest = snapshots.at(-1) ?? null;
    // A linked account's "Updated" and stale come from its newest Plaid balance: a hand-set or
    // imported one must not make a failing sync look fresh. Its balance is still the newest of all.
    const fetched = a.account.source === 'plaid' ? snapshots.filter((x) => (x.source ?? 'plaid') === 'plaid').at(-1) ?? null : latest;
    const breakdown = monthBreakdown(snapshots, flows, month, { flowsAvailable: flowsAvailable(a, ranges, month), current: true });
    return {
      account: ref(a, ranges, month),
      balanceCents: latest?.cents ?? null,
      asOf: fetched?.fetchedAt.toISOString() ?? null,
      balanceDate: latest?.date ?? null,
      balanceSource: latest ? (latest.source ?? 'plaid') : null,
      monthChangeCents: breakdown.totalChangeCents,
      marketChangeCents: a.account.kind === 'investment' ? breakdown.changeCents : null,
      // Nothing refreshes a hand-added account (plan decision 23).
      stale: a.account.source === 'plaid' && fetched !== null && now.getTime() - fetched.fetchedAt.getTime() > SAVINGS_STALE_AFTER_MS,
    };
  });
  const sumOf = (values: (number | null)[]) => {
    const present = values.filter((v): v is number => v !== null);
    return present.length === 0 ? null : present.reduce((n, v) => n + v, 0);
  };
  return {
    serverNow: now.toISOString(),
    month,
    accounts,
    totalCents: sumOf(accounts.map((a) => a.balanceCents)),
    totalChangeCents: sumOf(accounts.map((a) => a.monthChangeCents)),
    stale: accounts.some((a) => a.stale),
    attention: attention(deps.db),
    series: shownSeries(shown, ranges, data, day, SAVINGS_CARD_GRAPH_MONTHS),
  };
}

/**
 * GET /overview?month=: the month's breakdown for every account that isn't hidden (removed ones
 * only in a past month that has their data), the total, the months with data (newest first, the
 * current month first), and the six-month series of the accounts shown now.
 */
export function savingsOverview(deps: SavingsReadDeps, requested: string | null): SavingsOverview {
  const day = today(deps);
  const current = day.slice(0, 7);
  const month = requested ?? current;
  if (month > current) throw new AppError('validation', SAVINGS_MESSAGES.monthNotStarted);
  const visible = accountsWithItems(deps.db).filter((a) => a.account.hiddenAt === null);
  const ranges = importRanges(deps.db);
  const data = accountData(deps.db, visible.map((a) => a.account.id));
  const { first, last } = monthBounds(month);

  const accounts = visible.flatMap((a) => {
    const { snapshots, flows } = data.get(a.account.id)!;
    const hasData = snapshots.some((s) => s.date >= first && s.date <= last);
    // A removed account is in past months that have its data, never the current one (as on the home card).
    if (a.account.removedAt !== null && (month === current || !hasData)) return [];
    return [{ account: ref(a, ranges, month), breakdown: monthBreakdown(snapshots, flows, month, { flowsAvailable: flowsAvailable(a, ranges, month), current: month === current }) }];
  });

  const months = new Set<string>([current]);
  for (const a of visible) for (const s of data.get(a.account.id)!.snapshots) months.add(s.date.slice(0, 7));
  const shown = visible.filter(isShown);
  const listed = [...months].filter((m) => m <= current).sort().reverse();
  if (month < listed.at(-1)!) throw new AppError('validation', SAVINGS_MESSAGES.monthBeforeData);

  return {
    serverNow: deps.clock.now().toISOString(),
    month,
    current: month === current,
    months: listed,
    accounts,
    total: sumBreakdowns(accounts.map((a): MonthBreakdown => a.breakdown)),
    series: shownSeries(shown, ranges, data, day),
  };
}

/** For Savings settings (connections.ts): a removed connection's kept accounts. */
export function keptAccountsOf(db: Db, itemIds: readonly number[]): Map<number, { id: number; nickname: string }[]> {
  const out = new Map<number, { id: number; nickname: string }[]>(itemIds.map((id) => [id, []]));
  if (itemIds.length === 0) return out;
  for (const r of db.select().from(savingsAccounts).where(inArray(savingsAccounts.plaidItemId, [...itemIds])).orderBy(asc(savingsAccounts.id)).all()) {
    out.get(r.plaidItemId!)!.push({ id: r.id, nickname: r.nickname });
  }
  return out;
}
