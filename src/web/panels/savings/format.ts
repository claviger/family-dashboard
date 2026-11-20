import { formatCents } from '../../../shared/money.js';
import {
  andList, nonzeroCounts, SAVINGS_MESSAGES, type MonthBreakdown, type SavingsAccountKind, type SavingsBalanceSource, type SavingsGroupChoice, type SavingsImportDraft,
  type SavingsImportFormat, type SavingsImportRecord, type SavingsImportResults,
} from '../../../shared/savings.js';

/**
 * Text for the Savings panel (the design system's "Content fundamentals": money with the symbol,
 * two decimals, tabular numerals in CSS). Pure, so it's unit-tested and type-checked with the
 * server code.
 */

export const money = (cents: number): string => formatCents(cents);

/** "+$12.34", "−$12.34" (U+2212, as the design system's figures do), "$0.00". */
export function signedMoney(cents: number): string {
  if (cents === 0) return formatCents(0);
  return `${cents > 0 ? '+' : '−'}${formatCents(Math.abs(cents))}`;
}

const MONTH = (month: string) => new Date(`${month}-01T12:00:00Z`);

/** "November 2026". */
export function monthLabel(month: string): string {
  return MONTH(month).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** "November". */
function monthName(month: string): string {
  return MONTH(month).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' });
}

/** "Nov", for the graph's axis. */
export function shortMonth(month: string): string {
  return MONTH(month).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
}

/** "Nov 12". */
export function dayLabel(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** "Cash ·4321", as Spend names a card. */
export function accountLabel(a: { nickname: string; mask: string | null }): string {
  return a.mask ? `${a.nickname} ·${a.mask}` : a.nickname;
}

/** The spec's two names for the rest of the change. */
export function changeLabel(kind: SavingsAccountKind): string {
  return kind === 'investment' ? 'Market change' : 'Other change';
}

/** "Start (end of October)", or "Since Nov 12" in the first month after linking. */
export function startLine(start: MonthBreakdown['start'], month: string): string {
  if (!start) return 'Start';
  if (start.sinceFirstSnapshot) return `Since ${dayLabel(start.date)}`;
  const previous = MONTH(month);
  previous.setUTCMonth(previous.getUTCMonth() - 1);
  return `Start (end of ${previous.toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' })})`;
}

/** "As of Nov 15, 6:05 AM", in the family time zone. */
export function asOfLine(iso: string, timeZone: string): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone });
  // Newer ICU puts a narrow no-break space before AM/PM; plain text reads the same either way.
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone }).replace(/[  ]/g, ' ');
  return `As of ${day}, ${time}`;
}

function balanceSourceLine(source: 'csv' | 'manual', date: string): string {
  return source === 'csv' ? `Imported balance for ${dayLabel(date)}` : `Set by hand for ${dayLabel(date)}`;
}

/** Under a month's end: when Plaid's balance was read, or where an imported, hand-set, or mixed one came from (plan decision 23). */
export function endLine(end: Pick<NonNullable<MonthBreakdown['end']>, 'date' | 'fetchedAt' | 'source'>, timeZone: string): string {
  if (end.source === 'plaid') return asOfLine(end.fetchedAt, timeZone);
  if (end.source === 'mixed') return `Some balances imported or set by hand, the latest for ${dayLabel(end.date)}`;
  return balanceSourceLine(end.source, end.date);
}

/** A hand-added account's newest balance, in words. */
export function handBalanceLine(latest: { date: string; source: SavingsBalanceSource } | null): string {
  if (!latest) return 'No balance yet';
  return latest.source === 'plaid' ? `Balance for ${dayLabel(latest.date)}` : balanceSourceLine(latest.source, latest.date);
}

/** The home card's line under a balance that didn't come from Plaid (its day and source, not "Updated"); null for Plaid's. */
export function summaryBalanceLine(a: { balanceDate: string | null; balanceSource: SavingsBalanceSource | null }): string | null {
  if (!a.balanceDate || !a.balanceSource || a.balanceSource === 'plaid') return null;
  return balanceSourceLine(a.balanceSource, a.balanceDate);
}

/** A column by its name, or "Column 3" when the header cell is empty. */
export function columnName(header: readonly string[], column: number): string {
  return header[column]?.trim() || `Column ${column + 1}`;
}

/** "YOU SOLD …", or "No description". */
export function groupName(label: string): string {
  return label === '' ? 'No description' : `${label} …`;
}

const CHOICE_WORDS: Record<SavingsGroupChoice, string> = { deposit: 'deposits', withdrawal: 'withdrawals', by_sign: 'by sign', not_counted: 'not counted' };
export const CHOICE_LABELS: Record<SavingsGroupChoice, string> = { deposit: 'Deposit', withdrawal: 'Withdrawal', by_sign: 'By sign', not_counted: 'Not counted' };
export const choiceWords = (c: SavingsGroupChoice) => CHOICE_WORDS[c];

/** "YOU SOLD … (12): not counted", as the results list a group. */
export function groupLine(g: { label: string; count: number; choice: SavingsGroupChoice }): string {
  return `${groupName(g.label)} (${g.count}): ${CHOICE_WORDS[g.choice]}`;
}

type ResultCounts = Pick<SavingsImportResults, 'deposits' | 'withdrawals' | 'balances'>;

/** "Adds 2 deposits, 1 withdrawal, and 7 daily balances." */
export function importAddsLine(p: ResultCounts): string {
  const parts = nonzeroCounts([[p.deposits.add, 'deposit'], [p.withdrawals.add, 'withdrawal'], [p.balances.add, 'daily balance']]);
  return parts.length === 0 ? 'Nothing new to add.' : `Adds ${andList(parts)}.`;
}

/** What Import skips, or null. */
export function importSkippedLine(p: ResultCounts): string | null {
  const parts = nonzeroCounts([[p.deposits.already, 'deposit'], [p.withdrawals.already, 'withdrawal'], [p.balances.skipped, 'daily balance']]);
  return parts.length === 0 ? null : `Skipped, since they're already here or Plaid has them: ${andList(parts)}.`;
}

const uploadDay = (uploadedAt: string, timeZone: string) => new Date(uploadedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone });

const uploadTime = (uploadedAt: string, timeZone: string) =>
  new Date(uploadedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone }).replace(/[  ]/g, ' ');

/**
 * Each listed import's name for Undo, by id, every one its own: "statement.csv, Nov 15"; with the
 * time when the same file was imported more than once that day ("a.csv, Nov 19, 3:05 PM"); and
 * numbered in list order if even the minute matches.
 */
export function importNames(records: readonly Pick<SavingsImportRecord, 'id' | 'fileName' | 'uploadedAt'>[], timeZone: string): Map<number, string> {
  const group = <T,>(items: readonly T[], key: (t: T) => string) => {
    const out = new Map<string, T[]>();
    for (const t of items) out.set(key(t), [...(out.get(key(t)) ?? []), t]);
    return out;
  };
  const names = new Map<number, string>();
  for (const sameDay of group(records, (r) => `${r.fileName ?? 'the file'}, ${uploadDay(r.uploadedAt, timeZone)}`).entries()) {
    const [dayName, rs] = sameDay;
    if (rs.length === 1) {
      names.set(rs[0]!.id, dayName);
      continue;
    }
    for (const [timeName, same] of group(rs, (r) => `${dayName}, ${uploadTime(r.uploadedAt, timeZone)}`)) {
      same.forEach((r, i) => names.set(r.id, same.length === 1 ? timeName : `${timeName} (${i + 1})`));
    }
  }
  return names;
}

/** A saved import, with what Undo would delete. */
export function importRecordLine(r: Pick<SavingsImportRecord, 'fileName' | 'uploadedAt' | 'uploadedBy' | 'flowsLeft' | 'balancesLeft'>, timeZone: string): string {
  const day = uploadDay(r.uploadedAt, timeZone);
  const left = nonzeroCounts([[r.flowsLeft, 'deposit or withdrawal', 'deposits and withdrawals'], [r.balancesLeft, 'daily balance']]);
  return `${r.fileName ?? 'A file'}, ${day}${r.uploadedBy ? `, by ${r.uploadedBy}` : ''}: ${left.length === 0 ? 'nothing left' : andList(left)}`;
}

/** What Undo says first when a later import skipped rows as already here (the record's `overlaps`), or null. */
export function undoWarning(r: Pick<SavingsImportRecord, 'overlaps'>): string | null {
  return r.overlaps > 0 ? SAVINGS_MESSAGES.importUndoOverlaps : null;
}

const FORMAT_NAMES: Record<SavingsImportFormat, string> = { fidelity_cash: 'Fidelity cash management', fidelity_brokerage: 'Fidelity brokerage', custom: 'your own columns' };

/** "Saved import settings: Fidelity cash management, 9 groups". */
export function profileLine(p: { format: SavingsImportFormat; groups: readonly unknown[] }): string {
  return `Saved import settings: ${FORMAT_NAMES[p.format]}, ${p.groups.length} ${p.groups.length === 1 ? 'group' : 'groups'}`;
}

/**
 * Where the upload's answer filled the steps in from. Only the first answer says it: once the
 * admin changes anything it no longer describes what's on screen. Null when a saved or built-in
 * mapping didn't fit (the draft's `problem` says why) or there's nothing to say.
 */
export function prefilledLine(d: Pick<SavingsImportDraft, 'prefilled' | 'format' | 'suggested' | 'problem'>): string | null {
  if (d.problem) return null;
  if (d.prefilled === 'profile') return "Filled in from this account's saved import settings. Check them before importing.";
  if (d.prefilled === 'builtin' && d.format !== 'custom') return `This looks like a ${FORMAT_NAMES[d.format]} file, so the columns and groups are filled in. Check them before importing.`;
  return d.suggested ? 'The columns are a guess from their names. Check each one.' : null;
}

/** The first step that needs the admin (plan decision 14): columns, then groups, then the results. */
export function importStep(d: Pick<SavingsImportDraft, 'mapping' | 'groups' | 'results'>): 'map' | 'groups' | 'results' {
  if (d.results) return 'results';
  return d.mapping && d.groups ? 'groups' : 'map';
}

/**
 * The current month before its first snapshot holds at last month's last one (the server's
 * breakdown): said in words, so "Now" isn't read as this month's balance.
 */
export function heldLine(end: Pick<NonNullable<MonthBreakdown['end']>, 'date'> | null, month: string): string | null {
  if (!end || end.date >= `${month}-01`) return null;
  return `No balance read in ${monthName(month)} yet`;
}

/** "A, B and C". */
function listed(parts: readonly string[]): string {
  return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
}

/**
 * Under the graph, for accounts linked after the line starts (`BalanceSeries.joins`): "Roth IRA was
 * added on Nov 19, so the total steps up there." Null with none.
 */
export function joinsLine(joins: readonly { date: string; nickname: string }[]): string | null {
  if (joins.length === 0) return null;
  const parts = joins.map((j, i) => (i === 0 ? `${j.nickname} was added on ${dayLabel(j.date)}` : `${j.nickname} on ${dayLabel(j.date)}`));
  return `${listed(parts)}, so the total steps up ${joins.length === 1 ? 'there' : 'on those days'}.`;
}

/**
 * The total's start when some accounts start from last month's end and others only since their
 * first snapshot this month: "Mixed: Roth IRA since Nov 19, the rest from the end of last month".
 * Null when every account starts the same way.
 */
export function mixedStartLine(rows: readonly { name: string; start: MonthBreakdown['start'] }[]): string | null {
  const since = rows.filter((r) => r.start?.sinceFirstSnapshot);
  const fromEnd = rows.filter((r) => r.start && !r.start.sinceFirstSnapshot);
  if (since.length === 0 || fromEnd.length === 0) return null;
  return `Mixed: ${listed(since.map((r) => `${r.name} since ${dayLabel(r.start!.date)}`))}, the rest from the end of last month`;
}

const compact = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

/**
 * The graph's y-axis ticks (the dataviz guidance): in full under $10,000 ("$6,200"), compact on an
 * axis that reaches it ("$10K", "$62.5K", "$1.25M"), one style for the whole axis.
 */
export function axisLabels(ticks: readonly number[]): string[] {
  const top = Math.max(...ticks.map((c) => Math.abs(c))) / 100;
  return ticks.map((cents) => {
    const dollars = cents / 100;
    const sign = dollars < 0 ? '−' : '';
    const abs = Math.abs(dollars);
    if (top < 10_000 || abs === 0) return `${sign}$${Math.round(abs).toLocaleString('en-US')}`;
    if (abs >= 1_000_000) return `${sign}$${compact(abs / 1_000_000)}M`;
    return `${sign}$${compact(abs / 1_000)}K`;
  });
}

/** Why an account shows only its total change: a linked account without deposits and withdrawals, or a hand-added account's month no import covers. Null when they're known. */
export function noFlowsNote(account: { source: 'plaid' | 'manual'; flowsAvailable: boolean }): string | null {
  if (account.flowsAvailable) return null;
  return account.source === 'manual' ? SAVINGS_MESSAGES.noImportForMonth : SAVINGS_MESSAGES.noFlows;
}

/**
 * The home card's "Updated": the oldest Plaid read among linked accounts (each one's `asOf` is its
 * newest Plaid balance). Nothing refreshes an account added by hand (plan decision 23). Null for none.
 */
export function updatedAsOf(accounts: readonly { account: { source: 'plaid' | 'manual' }; asOf: string | null }[]): string | null {
  return accounts.filter((a) => a.account.source === 'plaid').map((a) => a.asOf).filter((v): v is string => v !== null).sort()[0] ?? null;
}

type DayFlows = { date: string; depositCents: number; withdrawalCents: number };

/** A day's flows for the graph's tooltip and spoken text: "Deposits $X · Withdrawals $Y", only the parts it has; null without any. */
export function flowDayLine(f: DayFlows | undefined): string | null {
  if (!f) return null;
  const parts = [f.depositCents > 0 ? `Deposits ${money(f.depositCents)}` : null, f.withdrawalCents > 0 ? `Withdrawals ${money(f.withdrawalCents)}` : null]
    .filter((p): p is string => p !== null);
  return parts.length === 0 ? null : parts.join(' · ');
}

/** The window's deposits and withdrawals, and on how many days. */
export function flowTotals(flows: readonly DayFlows[]): { depositCents: number; withdrawalCents: number; depositDays: number; withdrawalDays: number } {
  let depositCents = 0, withdrawalCents = 0, depositDays = 0, withdrawalDays = 0;
  for (const f of flows) {
    if (f.depositCents > 0) { depositCents += f.depositCents; depositDays++; }
    if (f.withdrawalCents > 0) { withdrawalCents += f.withdrawalCents; withdrawalDays++; }
  }
  return { depositCents, withdrawalCents, depositDays, withdrawalDays };
}

const days = (n: number) => `${n} ${n === 1 ? 'day' : 'days'}`;

/** The six-month graph's flow lines, for screen readers: "Deposits $X on 4 days, withdrawals $Y on 9 days, not counting transfers between your accounts." */
export function flowsSummaryLine(flows: readonly DayFlows[]): string | null {
  if (flows.length === 0) return null;
  const t = flowTotals(flows);
  const parts = [
    t.depositDays > 0 ? `deposits ${money(t.depositCents)} on ${days(t.depositDays)}` : 'no deposits',
    t.withdrawalDays > 0 ? `withdrawals ${money(t.withdrawalCents)} on ${days(t.withdrawalDays)}` : 'no withdrawals',
  ];
  return `Flow lines: ${parts.join(', ')}, not counting transfers between your accounts.`;
}

/** The home card graph's text: "Last month: from $A to $B; deposits $X, withdrawals $Y." (the flows only when it has some). */
export function cardGraphLine(points: readonly { cents: number }[], flows: readonly DayFlows[]): string {
  const from = `Last month: from ${money(points[0]!.cents)} to ${money(points.at(-1)!.cents)}`;
  if (flows.length === 0) return `${from}.`;
  const t = flowTotals(flows);
  return `${from}; deposits ${money(t.depositCents)}, withdrawals ${money(t.withdrawalCents)}.`;
}
