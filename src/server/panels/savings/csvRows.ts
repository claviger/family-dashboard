import { createHash } from 'node:crypto';
import { daysBetween } from '../../../shared/dates.js';
import type { SavingsAccountKind, SavingsBalanceSource, SavingsFlowKind, SavingsGroupChoice, SavingsGroupChoices, SavingsMapping } from '../../../shared/savings.js';
import type { ReadRow } from './csvMapping.js';
import type { BuiltInFormat } from './importFormats.js';

/**
 * What rows mean (the CSV import spec, "What rows mean", "Daily balances", "Overlap rules"; plan
 * decisions 10 to 12, 17 and 18). Pure. Only dates, amounts in cents, and directions come out; a
 * row's description is read for its group label and goes into its key's hash, nowhere else.
 */

/** The longest a group label is: what a saved choice's key may be (SavingsGroupChoicesSchema). */
const GROUP_LABEL_MAX = 100;

/** The description's first two words, uppercased, with digits and punctuation dropped, at most 100 characters. '' for none. */
export function groupLabel(description: string): string {
  return description.toUpperCase().replace(/[^\p{L}\s]/gu, ' ').split(/\s+/).filter((w) => w !== '').slice(0, 2).join(' ').slice(0, GROUP_LABEL_MAX);
}

/** Words that look like money moving in or out of an investment account, matched at a word's start (plan decision 11). */
const MONEY_MOVING_WORDS = ['TRANSFER', 'DEPOSIT', 'WITHDRAWAL', 'CHECK', 'ACH', 'EFT', 'CONTRIBUTION', 'DISTRIBUTION'] as const;

/** The spec's defaults for a group no profile or format has decided. */
export function defaultChoice(kind: SavingsAccountKind, label: string): SavingsGroupChoice {
  if (kind === 'cash') return label.includes('INTEREST') ? 'not_counted' : 'by_sign';
  const words = label.split(' ');
  return words.some((w) => MONEY_MOVING_WORDS.some((m) => w.startsWith(m))) ? 'by_sign' : 'not_counted';
}

export interface RowGroup {
  label: string;
  count: number;
}

/** Each label with its row count, most rows first, then by label. */
export function groupsOf(rows: readonly ReadRow[]): RowGroup[] {
  const counts = new Map<string, number>();
  for (const r of rows) {
    const label = groupLabel(r.description);
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  return [...counts].map(([label, count]) => ({ label, count })).sort((a, b) => b.count - a.count || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
}

/** A built-in format's choice for every group (plan decision 13). */
export function choicesFor(groups: readonly RowGroup[], format: BuiltInFormat): SavingsGroupChoices {
  return Object.fromEntries(groups.map((g) => [g.label, format.rules[g.label] ?? format.otherwise]));
}

/** A row's flow under its group's choice (plan decision 12): none for a zero or missing amount, or Not counted. */
function flowOf(choice: SavingsGroupChoice, cents: number | null): { kind: SavingsFlowKind; cents: number } | null {
  if (cents === null || cents === 0 || choice === 'not_counted') return null;
  const kind: SavingsFlowKind = choice === 'deposit' ? 'deposit' : choice === 'withdrawal' ? 'withdrawal' : cents > 0 ? 'deposit' : 'withdrawal';
  return { kind, cents: Math.abs(cents) };
}

/** The file's order from consecutive dates (plan decision 17): more steps back in time than forward is newest first; a tie, too. */
export function fileOrder(rows: readonly Pick<ReadRow, 'date'>[]): 'newest_first' | 'oldest_first' {
  let back = 0;
  let forward = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i]!.date < rows[i - 1]!.date) back++;
    else if (rows[i]!.date > rows[i - 1]!.date) forward++;
  }
  return forward > back ? 'oldest_first' : 'newest_first';
}

/** Each day's end balance: the newest row that day with a number, by the file's order. Oldest day first. */
export function dayEndBalances(rows: readonly Pick<ReadRow, 'date' | 'balanceCents'>[], order: 'newest_first' | 'oldest_first'): { date: string; cents: number }[] {
  const out = new Map<string, number>();
  const inOrder = order === 'newest_first' ? rows : [...rows].reverse();
  for (const r of inOrder) if (r.balanceCents !== null && !out.has(r.date)) out.set(r.date, r.balanceCents);
  return [...out].map(([date, cents]) => ({ date, cents })).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * Each flow's re-import key (plan decision 18): the account, date, direction, amount, the full
 * description, and which of the identical rows that day it is, in file order. A SHA-256: the text
 * isn't stored.
 */
export function csvFlowKeys(accountId: number, flows: readonly { date: string; kind: SavingsFlowKind; cents: number; description: string }[]): string[] {
  const seen = new Map<string, number>();
  return flows.map((f) => {
    const base = JSON.stringify([accountId, f.date, f.kind, f.cents, f.description]);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return createHash('sha256').update(`savings-csv-v1\n${base}\n${n}`).digest('hex');
  });
}

export interface ReadPlan {
  flows: { date: string; kind: SavingsFlowKind; cents: number; key: string }[];
  balances: { date: string; cents: number }[];
}

/**
 * The rows as an account's flows and day-end balances. `choices` must hold every group's label. A
 * cash account's balance column is its value; an investment account's only when it's marked so.
 */
export function readRows(accountId: number, kind: SavingsAccountKind, rows: readonly ReadRow[], mapping: SavingsMapping, choices: SavingsGroupChoices): ReadPlan {
  const flowRows: { date: string; kind: SavingsFlowKind; cents: number; description: string }[] = [];
  for (const r of rows) {
    const flow = flowOf(choices[groupLabel(r.description)] ?? 'not_counted', r.cents);
    if (flow) flowRows.push({ date: r.date, ...flow, description: r.description });
  }
  const keys = csvFlowKeys(accountId, flowRows);
  const balances = mapping.balance !== null && (kind === 'cash' || mapping.balance.isValue);
  return {
    flows: flowRows.map((f, i) => ({ date: f.date, kind: f.kind, cents: f.cents, key: keys[i]! })),
    balances: balances ? dayEndBalances(rows, fileOrder(rows)) : [],
  };
}

/** How far apart a CSV flow and a Plaid flow may be dated and still be the same one. */
export const PLAID_TWIN_DAYS = 3;

/**
 * Which CSV flows a Plaid flow on the account already covers (the spec's "CSV vs Plaid flows"): the
 * same kind and amount, dated within 3 days, one to one, nearest dates first (then the earlier CSV
 * date, then file order, then the older Plaid row). The covered flows' indexes.
 */
export function plaidTwins(
  csv: readonly { date: string; kind: SavingsFlowKind; cents: number }[],
  plaid: readonly { id: number; date: string; kind: SavingsFlowKind; cents: number }[],
): Set<number> {
  const byValue = new Map<string, number[]>();
  plaid.forEach((p, j) => {
    const id = `${p.kind}:${p.cents}`;
    byValue.set(id, [...(byValue.get(id) ?? []), j]);
  });
  const pairs: { i: number; j: number; d: number }[] = [];
  csv.forEach((c, i) => {
    for (const j of byValue.get(`${c.kind}:${c.cents}`) ?? []) {
      const d = Math.abs(daysBetween(c.date, plaid[j]!.date));
      if (d <= PLAID_TWIN_DAYS) pairs.push({ i, j, d });
    }
  });
  pairs.sort((a, b) => a.d - b.d || (csv[a.i]!.date < csv[b.i]!.date ? -1 : csv[a.i]!.date > csv[b.i]!.date ? 1 : 0) || a.i - b.i || plaid[a.j]!.id - plaid[b.j]!.id);
  const covered = new Set<number>();
  const used = new Set<number>();
  for (const p of pairs) {
    if (covered.has(p.i) || used.has(p.j)) continue;
    covered.add(p.i);
    used.add(p.j);
  }
  return covered;
}

/**
 * The spec's balance rules for an import: a day gets an imported balance only before the account's
 * first Plaid balance, and only when it has none yet (never over a Plaid, hand-set, or earlier one).
 */
export function importableBalances(
  balances: readonly { date: string; cents: number }[],
  existing: readonly { date: string; source: SavingsBalanceSource }[],
): { add: { date: string; cents: number }[]; skipped: number } {
  const firstPlaid = existing.filter((e) => e.source === 'plaid').map((e) => e.date).sort()[0] ?? null;
  const taken = new Set(existing.map((e) => e.date));
  const add = balances.filter((b) => !taken.has(b.date) && (firstPlaid === null || b.date < firstPlaid));
  return { add, skipped: balances.length - add.length };
}
