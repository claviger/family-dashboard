import { z } from 'zod';
import { LocalDateSchema } from './dates.js';
import { ConnectionStatusSchema } from './integrations.js';
import { PLAID_LINK_ERRORS, type PlaidLinkError } from './plaid.js';

/**
 * What the browser and the server share about the Savings panel
 * (docs/specs/2026-11-19-savings-panel-design.md): summary numbers per account, the month's
 * breakdown, the six-month series, and Savings settings. Money is whole cents. No transaction
 * names or merchants ever appear here.
 */

/** A shown account's kind, from its Plaid `type` (plan decision 4): `depository` is cash, `investment` is investment. */
export const SAVINGS_ACCOUNT_KINDS = ['cash', 'investment'] as const;
export type SavingsAccountKind = (typeof SAVINGS_ACCOUNT_KINDS)[number];

export const SAVINGS_FLOW_KINDS = ['deposit', 'withdrawal'] as const;
export type SavingsFlowKind = (typeof SAVINGS_FLOW_KINDS)[number];

/**
 * Where a flow came from: the cash account's `/transactions/sync`, the brokerage's
 * `/investments/transactions/get`, or a Fidelity CSV import (`csv`, with its occurrence key's hash in
 * `plaid_id`; the CSV import spec, "Overlap rules").
 */
export const SAVINGS_FLOW_SOURCES = ['transactions', 'investments', 'csv'] as const;
export type SavingsFlowSource = (typeof SAVINGS_FLOW_SOURCES)[number];

/** How an account got here: picked from a Plaid connection, or added by hand in Savings settings (the CSV import spec, "Accounts"). */
export const SAVINGS_ACCOUNT_SOURCES = ['plaid', 'manual'] as const;
export type SavingsAccountSource = (typeof SAVINGS_ACCOUNT_SOURCES)[number];

/**
 * Where a day's balance came from. A Plaid balance replaces any other that day; a hand-set one
 * replaces an imported one; an imported one never replaces anything (the CSV import spec).
 */
export const SAVINGS_BALANCE_SOURCES = ['plaid', 'csv', 'manual'] as const;
export type SavingsBalanceSource = (typeof SAVINGS_BALANCE_SOURCES)[number];
/** A month's end: one source, or `mixed` for a total whose accounts' ends came from more than one. */
export const SAVINGS_END_SOURCES = [...SAVINGS_BALANCE_SOURCES, 'mixed'] as const;

/**
 * The format an import was read with: a built-in format (importFormats.ts), or `custom`, the admin's
 * own mapping. Stored in `savings_imports.layout` and `savings_import_previews.layout`, which keep
 * migration 0012's column name (plan decision 2).
 */
export const SAVINGS_IMPORT_FORMATS = ['fidelity_cash', 'fidelity_brokerage', 'custom'] as const;
export type SavingsImportFormat = (typeof SAVINGS_IMPORT_FORMATS)[number];

/** How a file writes its dates: `YYYY-MM-DD`, `M/D/YYYY`, `D/M/YYYY`, padded or not. */
export const SAVINGS_DATE_FORMATS = ['ymd', 'mdy', 'dmy'] as const;
export type SavingsDateFormat = (typeof SAVINGS_DATE_FORMATS)[number];
export const SAVINGS_DATE_FORMAT_LABELS: Record<SavingsDateFormat, string> = { ymd: 'YYYY-MM-DD', mdy: 'M/D/YYYY', dmy: 'D/M/YYYY' };

/** What a description group's rows count as (the CSV import spec, "What rows mean"). */
export const SAVINGS_GROUP_CHOICES = ['deposit', 'withdrawal', 'by_sign', 'not_counted'] as const;
export type SavingsGroupChoice = (typeof SAVINGS_GROUP_CHOICES)[number];

/** A column, by its index in the header (plan decision 3). */
const ColumnSchema = z.number({ error: 'Choose a column.' }).int('Choose a column.').min(0, 'Choose a column.').max(199, 'Choose a column.');

/** Which column plays each role (the CSV import spec, "Mapping columns"). */
export const SavingsMappingSchema = z.object({
  date: z.object({ column: ColumnSchema, format: z.enum(SAVINGS_DATE_FORMATS, { error: 'Choose how the dates are written.' }) }),
  amount: z.discriminatedUnion('kind', [
    /** One signed column; `inIsNegative` for a bank that writes money in as negative. */
    z.object({ kind: z.literal('signed'), column: ColumnSchema, inIsNegative: z.boolean() }),
    /** Money out and money in in separate columns, both positive. */
    z.object({ kind: z.literal('split'), debit: ColumnSchema, credit: ColumnSchema }),
  ], { error: 'Choose the amount column, or the debit and credit columns.' }),
  /** `isValue`: for an investment account, the column is the account's whole value. A cash account's balance always is. */
  balance: z.object({ column: ColumnSchema, isValue: z.boolean() }).nullable(),
  description: ColumnSchema.nullable(),
});
export type SavingsMapping = z.infer<typeof SavingsMappingSchema>;

/** Each group's choice, by its label (`''` is the rows with no description). */
export const SavingsGroupChoicesSchema = z
  .record(z.string().max(100), z.enum(SAVINGS_GROUP_CHOICES, { error: 'Choose Deposit, Withdrawal, By sign, or Not counted.' }))
  .refine((r) => Object.keys(r).length <= 1000, 'There are too many groups to save.');
export type SavingsGroupChoices = Record<string, SavingsGroupChoice>;

/**
 * What a draft import keeps (server only, `savings_import_previews.plan`; plan decision 4): the
 * table's header and cells, for an hour, and the admin's mapping and choices so far. Never the
 * preamble, the footer, or the file.
 */
export interface SavingsImportDraftPlan {
  header: string[];
  rows: { line: number; cells: string[] }[];
  mapping: SavingsMapping | null;
  choices: SavingsGroupChoices;
  /** Where the mapping and choices came from at upload; kept through every PUT. Absent on drafts from before it was added: 'guess'. */
  prefilled?: 'profile' | 'builtin' | 'guess';
  /** A columns-only PUT sets it: the admin goes through the groups step before results or Import (plan decision 14). */
  groupsPending?: boolean;
}

/** The most a CSV upload may be: Spend's limit. */
export const SAVINGS_CSV_MAX_BYTES = 5 * 1024 * 1024;
/** How many rows the mapping step shows (the spec's sample). */
export const SAVINGS_SAMPLE_ROWS = 8;

/** A description group. `choice` null: not decided yet (a new group; plan decision 13); `suggested` is what the form starts with. */
export const SavingsImportGroupSchema = z.object({
  label: z.string(),
  count: z.number(),
  choice: z.enum(SAVINGS_GROUP_CHOICES).nullable(),
  suggested: z.enum(SAVINGS_GROUP_CHOICES),
});
export type SavingsImportGroup = z.infer<typeof SavingsImportGroupSchema>;

/** What Import would do now. `already`: in the file and here already (imported before, or Plaid has it). */
export const SavingsImportResultsSchema = z.object({
  dateRange: z.object({ from: z.string(), to: z.string() }),
  deposits: z.object({ add: z.number(), already: z.number() }),
  withdrawals: z.object({ add: z.number(), already: z.number() }),
  /** `skipped`: the day has a balance, or is on or after the account's first Plaid balance. */
  balances: z.object({ add: z.number(), skipped: z.number() }),
  warnings: z.array(z.object({ id: z.string(), message: z.string() })),
});
export type SavingsImportResults = z.infer<typeof SavingsImportResultsSchema>;

/**
 * An import being set up (the CSV import spec, "Importing"): the answer to the upload and to every
 * PUT /imports/:id. The web shows the columns step until `mapping` is set, then the groups step
 * until every group has a choice, then `results`.
 */
export const SavingsImportDraftSchema = z.object({
  id: z.string(),
  account: z.object({ id: z.number(), nickname: z.string(), kind: z.enum(SAVINGS_ACCOUNT_KINDS) }),
  fileName: z.string().nullable(),
  rows: z.number(),
  header: z.array(z.string()),
  /** The first SAVINGS_SAMPLE_ROWS rows' cells. */
  sample: z.array(z.array(z.string())),
  /** Each column's date formats (none: not a date column). Two for the date column: the admin chooses. */
  dateFormats: z.array(z.array(z.enum(SAVINGS_DATE_FORMATS))),
  format: z.enum(SAVINGS_IMPORT_FORMATS),
  /** Where the mapping and choices came from: the account's saved settings, a built-in format, or a guess. */
  prefilled: z.enum(['profile', 'builtin', 'guess']),
  mapping: SavingsMappingSchema.nullable(),
  /** A starting point for the columns step when `mapping` is null. */
  suggested: SavingsMappingSchema.nullable(),
  /** Why a saved or built-in mapping didn't fit this file, or null. */
  problem: z.string().nullable(),
  groups: z.array(SavingsImportGroupSchema).nullable(),
  results: SavingsImportResultsSchema.nullable(),
  expiresAt: z.string(),
});
export type SavingsImportDraft = z.infer<typeof SavingsImportDraftSchema>;

/** PUT /imports/:id: the mapping, and once the groups step is done, every group's choice. */
export const SavingsImportUpdateSchema = z.object({ mapping: SavingsMappingSchema, choices: SavingsGroupChoicesSchema.optional() });
export type SavingsImportUpdate = z.infer<typeof SavingsImportUpdateSchema>;

/** A saved import, as Savings settings lists it. `flowsLeft` and `balancesLeft` are what Undo would delete now. */
export const SavingsImportRecordSchema = z.object({
  id: z.number(),
  accountId: z.number(),
  fileName: z.string().nullable(),
  format: z.enum(SAVINGS_IMPORT_FORMATS),
  uploadedAt: z.string(),
  uploadedBy: z.string().nullable(),
  depositsAdded: z.number(),
  withdrawalsAdded: z.number(),
  balancesAdded: z.number(),
  skipped: z.number(),
  flowsLeft: z.number(),
  balancesLeft: z.number(),
  /**
   * Later imports of this account that skipped rows as already here. A conservative hint, not a
   * count of rows: a skip may have been this import's rows, or Plaid's or a hand-set balance. When
   * it isn't 0, Undo may leave a gap that importing the later file again fills.
   */
  overlaps: z.number(),
});
export type SavingsImportRecord = z.infer<typeof SavingsImportRecordSchema>;

/** An account's saved import settings (the spec's "Saved per account"). */
export const SavingsImportProfileViewSchema = z.object({
  accountId: z.number(),
  format: z.enum(SAVINGS_IMPORT_FORMATS),
  header: z.array(z.string()),
  mapping: SavingsMappingSchema,
  groups: z.array(z.object({ label: z.string(), choice: z.enum(SAVINGS_GROUP_CHOICES) })),
  updatedAt: z.string(),
});
export type SavingsImportProfileView = z.infer<typeof SavingsImportProfileViewSchema>;

/** PATCH /accounts/:id/import-profile: new choices for groups already saved. */
export const SavingsProfilePatchSchema = z.object({ choices: SavingsGroupChoicesSchema });

/** "1 deposit", "2 deposits". */
export function countOf(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/** The counts that aren't zero, as words. */
export function nonzeroCounts(counts: readonly (readonly [number, string, string?])[]): string[] {
  return counts.filter(([n]) => n > 0).map(([n, singular, plural]) => countOf(n, singular, plural));
}

/** "a", "a and b", "a, b, and c". */
export function andList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(', ')}, and ${items.at(-1)}`;
}

/** The home card warns once the latest snapshot is older than this: a day, plus the daily job's slack (plan decision 13). */
export const SAVINGS_STALE_AFTER_MS = 26 * 60 * 60_000;
/** The line graph's range (spec "Line graph"). */
export const SAVINGS_GRAPH_MONTHS = 6;
/** The home card's graph: the last month. */
export const SAVINGS_CARD_GRAPH_MONTHS = 1;
export const SAVINGS_NICKNAME_MAX = 40;
/** Set balance's limit, either way: $1,000,000,000.00. Its own, not Spend's per-transaction one. Negative is overdrawn. */
export const SAVINGS_MAX_BALANCE_CENTS = 100_000_000_000;

/** A calendar month, `YYYY-MM`. */
export const MonthSchema = z.string({ error: 'Pick a month.' }).regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Pick a month.');

/**
 * One account's (or the total's) numbers for one month (spec "Numbers shown"):
 * - `start`: the last snapshot before the month, or, in the first month after linking, the first
 *   snapshot (`sinceFirstSnapshot`, shown as "since <date>"). Null when the month has no snapshot.
 * - `end`: the latest snapshot in the month ("Now" for the current month), with when it was fetched.
 *   `end.source`: where the end balance came from (plan decision 23); `fetchedAt` only means something for `plaid`.
 * - `depositsCents`, `withdrawalsCents`: the month's flows, both positive; null when the account has
 *   no flows to count (the no-Investments fallback), or for a total that includes such an account.
 * - `changeCents`: Market change (investment) or Other change (cash): `end − start − deposits +
 *   withdrawals`. Null exactly when deposits are.
 * - `totalChangeCents`: `end − start`, always there when both are.
 */
export const MonthBreakdownSchema = z.object({
  start: z.object({ cents: z.number(), date: z.string(), sinceFirstSnapshot: z.boolean() }).nullable(),
  end: z.object({ cents: z.number(), date: z.string(), fetchedAt: z.string(), source: z.enum(SAVINGS_END_SOURCES) }).nullable(),
  depositsCents: z.number().nullable(),
  withdrawalsCents: z.number().nullable(),
  changeCents: z.number().nullable(),
  totalChangeCents: z.number().nullable(),
});
export type MonthBreakdown = z.infer<typeof MonthBreakdownSchema>;

export const SavingsAccountRefSchema = z.object({
  id: z.number(),
  nickname: z.string(),
  kind: z.enum(SAVINGS_ACCOUNT_KINDS),
  source: z.enum(SAVINGS_ACCOUNT_SOURCES),
  mask: z.string().nullable(),
  /**
   * Whether deposits and withdrawals are known for this month (the month asked for; the current month
   * on the home card). False for a linked brokerage Plaid refused Investments for, and for a
   * hand-added account in a month no import's dates cover (plan decision 22). Then only the total
   * change is shown.
   */
  flowsAvailable: z.boolean(),
  /** Its connection was removed and its data kept: past months only. */
  connectionRemoved: z.boolean(),
});
export type SavingsAccountRef = z.infer<typeof SavingsAccountRefSchema>;

/** A connection that needs the admin, for the home card's line and Reconnect link. */
export const SavingsAttentionSchema = z.object({
  /** The local Item id, for `/connect/plaid/link?item=`. */
  itemId: z.number(),
  institutionName: z.string().nullable(),
  /** Reconnect fixes it, or only removing it and connecting again does. */
  fix: z.enum(['reconnect', 'remove', 'reconnect_or_remove']),
});

/** A graph's data (spec "Line graph"): the drill-down's six months, the home card's one. */
export const BalanceSeriesSchema = z.object({
  /** One point a day, oldest first, from the first day with data in the range through today. */
  points: z.array(z.object({ date: z.string(), cents: z.number() })),
  /** The range's first day (six months, or the card's one month, before today). */
  rangeStart: z.string(),
  /** The first day drawn; null with no data. Later than `rangeStart` while the graph is still filling in. */
  startsOn: z.string().nullable(),
  /** Each month's last total in the range, oldest first; the current month's is "so far". */
  monthEnds: z.array(z.object({ month: z.string(), date: z.string(), cents: z.number() })),
  /** Accounts whose first snapshot is after `startsOn`, oldest first: the total steps up on that day because the account was linked then. */
  joins: z.array(z.object({ date: z.string(), nickname: z.string() })),
  /**
   * Each day's deposits and withdrawals into the shown accounts, from `startsOn` through today, only
   * days with one, oldest first; both positive. Only months whose flows are known count, and a
   * transfer between two shown accounts (the same amount out of one and into another within two
   * days) isn't in either.
   */
  flows: z.array(z.object({ date: z.string(), depositCents: z.number(), withdrawalCents: z.number() })),
});
export type BalanceSeries = z.infer<typeof BalanceSeriesSchema>;

/** GET /api/panels/savings/summary: the home card (spec "Home card"). */
export const SavingsSummarySchema = z.object({
  serverNow: z.string(),
  /** The current month, family time. */
  month: z.string(),
  accounts: z.array(z.object({
    account: SavingsAccountRefSchema,
    /** The latest snapshot's current balance; null before the first sync. */
    balanceCents: z.number().nullable(),
    /** When that snapshot was fetched (ISO). */
    asOf: z.string().nullable(),
    /** The latest balance's day and source: a hand-added account says where it came from instead of "Updated". */
    balanceDate: z.string().nullable(),
    balanceSource: z.enum(SAVINGS_BALANCE_SOURCES).nullable(),
    /** This month's total change (`end − start`), signed. */
    monthChangeCents: z.number().nullable(),
    stale: z.boolean(),
  })),
  totalCents: z.number().nullable(),
  totalChangeCents: z.number().nullable(),
  /** Any shown account's latest snapshot is older than SAVINGS_STALE_AFTER_MS. */
  stale: z.boolean(),
  attention: z.array(SavingsAttentionSchema),
  /** The graph on the card: the shown accounts' total over the last month, with its flows. */
  series: BalanceSeriesSchema,
});
export type SavingsSummary = z.infer<typeof SavingsSummarySchema>;


/** GET /api/panels/savings/overview?month=: the drill-down. */
export const SavingsOverviewSchema = z.object({
  serverNow: z.string(),
  month: z.string(),
  current: z.boolean(),
  /** Months with data, newest first, the current month always first. */
  months: z.array(z.string()),
  accounts: z.array(z.object({ account: SavingsAccountRefSchema, breakdown: MonthBreakdownSchema })),
  total: MonthBreakdownSchema,
  series: BalanceSeriesSchema,
});
export type SavingsOverview = z.infer<typeof SavingsOverviewSchema>;

export const OverviewQuerySchema = z.object({ month: MonthSchema.optional() });

// --- Savings settings (admins). ---

/**
 * An account of a Savings connection, as the pick and the list show it:
 * - `shown`: on the panel, as `nickname`;
 * - `hidden`: still synced, not shown;
 * - `skipped`: never stored or fetched;
 * - `waiting`: not decided yet. While any waits, the connection isn't synced.
 */
export const SAVINGS_ACCOUNT_STATES = ['shown', 'hidden', 'skipped', 'waiting'] as const;

export const SavingsSettingsAccountSchema = z.object({
  accountId: z.string(),
  name: z.string(),
  officialName: z.string().nullable(),
  mask: z.string().nullable(),
  type: z.string(),
  subtype: z.string().nullable(),
  state: z.enum(SAVINGS_ACCOUNT_STATES),
  /** The `savings_accounts` row for a shown or hidden account. */
  savingsAccountId: z.number().nullable(),
  nickname: z.string().nullable(),
  /** Link's filter only offers these, but the pick refuses anything else. */
  showable: z.boolean(),
});
export type SavingsSettingsAccount = z.infer<typeof SavingsSettingsAccountSchema>;

export const SavingsConnectionViewSchema = z.object({
  id: z.number(),
  institutionName: z.string().nullable(),
  status: ConnectionStatusSchema,
  lastError: z.string().nullable(),
  fix: z.enum(['reconnect', 'remove', 'reconnect_or_remove']).nullable(),
  lastSuccessAt: z.string().nullable(),
  lastSyncAt: z.string().nullable(),
  needsPick: z.boolean(),
  picked: z.boolean(),
  accountsLoaded: z.boolean(),
  accounts: z.array(SavingsSettingsAccountSchema),
  /**
   * Plaid's Investments for this connection: not tried yet, working, or refused with `code` (plan
   * decision 8). `code` with a status that isn't `unavailable` is a passing failure on the last
   * sync (Plaid's code, or NO_ANSWER), read again on the next one. `message` says which, in plain
   * words, with the fix for a refusal; null when there's nothing to say.
   */
  investments: z.object({ status: z.enum(['unknown', 'available', 'unavailable']), code: z.string().nullable(), message: z.string().nullable() }),
  consentExpiresAt: z.string().nullable(),
  disconnectAt: z.string().nullable(),
  newAccountsAt: z.string().nullable(),
});
export type SavingsConnectionView = z.infer<typeof SavingsConnectionViewSchema>;

export const RemovedSavingsConnectionSchema = z.object({
  id: z.number(),
  institutionName: z.string().nullable(),
  removedAt: z.string(),
  reason: z.enum(['removed', 'removed_with_transactions', 'key_reset']),
  revocation: z.enum(['confirmed', 'waiting', 'not_asked']),
  /** Accounts kept with their data (none when it was removed with its data). */
  accounts: z.array(z.object({ id: z.number(), nickname: z.string() })),
});

/** GET /api/panels/savings/settings, and what every settings route answers. */
/** An account added by hand, as Savings settings lists it. `latest`: its newest balance and where it came from. */
export const SavingsHandAccountSchema = z.object({
  id: z.number(),
  nickname: z.string(),
  kind: z.enum(SAVINGS_ACCOUNT_KINDS),
  hidden: z.boolean(),
  /** Removed, its history kept: listed by name only. */
  removed: z.boolean(),
  latest: z.object({ date: z.string(), cents: z.number(), source: z.enum(SAVINGS_BALANCE_SOURCES) }).nullable(),
});
export type SavingsHandAccount = z.infer<typeof SavingsHandAccountSchema>;

export const SavingsSettingsViewSchema = z.object({
  plaidConfigured: z.boolean(),
  keyMismatch: z.boolean(),
  serverNow: z.string(),
  /** Shared with Spend: both use the same 10 (plan decision 1). Null without Plaid. */
  trial: z.object({ used: z.number(), limit: z.number() }).nullable(),
  connections: z.array(SavingsConnectionViewSchema),
  removed: z.array(RemovedSavingsConnectionSchema),
  notices: z.array(z.object({ id: z.number(), message: z.string() })),
  handAccounts: z.array(SavingsHandAccountSchema),
  /** Every account's recent imports (linked and hand-added accounts that aren't removed). */
  imports: z.array(SavingsImportRecordSchema),
  /** Every such account's saved import settings. */
  profiles: z.array(SavingsImportProfileViewSchema),
  message: z.string().nullable(),
});
export type SavingsSettingsView = z.infer<typeof SavingsSettingsViewSchema>;

const AccountIdSchema = z.string({ error: 'Choose an account from the list.' }).min(1, 'Choose an account from the list.').max(200, 'Choose an account from the list.');
const NicknameSchema = z
  .string({ error: 'Give each account you show a nickname.' })
  .trim()
  .min(1, 'Give each account you show a nickname.')
  .max(SAVINGS_NICKNAME_MAX, `Keep nicknames to ${SAVINGS_NICKNAME_MAX} characters.`);

/** POST /connections/:id/accounts: every waiting account, Show (with a nickname) or Skip. A skipped one can be shown later. */
export const SavingsPickInputSchema = z.object({
  accounts: z
    .array(
      z.discriminatedUnion('action', [
        z.object({ accountId: AccountIdSchema, action: z.literal('show'), nickname: NicknameSchema }),
        z.object({ accountId: AccountIdSchema, action: z.literal('skip') }),
      ], { error: 'Choose Show or Skip for each account.' }),
      { error: 'Send the accounts as a list.' },
    )
    .max(100, 'Send at most 100 accounts.')
    .refine((list) => new Set(list.map((a) => a.accountId)).size === list.length, 'Each account can only be listed once.'),
});
export type SavingsPickChoice = z.infer<typeof SavingsPickInputSchema>['accounts'][number];

/** PATCH /accounts/:id. */
export const SavingsAccountPatchSchema = z
  .object({ nickname: NicknameSchema.optional(), hidden: z.boolean({ error: 'Say whether to hide it.' }).optional() })
  .refine((v) => v.nickname !== undefined || v.hidden !== undefined, 'There are no changes to save.');
export type SavingsAccountPatch = z.infer<typeof SavingsAccountPatchSchema>;

/** POST /connections/:id/remove. `deleteData` deletes its accounts' balances and flows (spec "Data"). */
export const SavingsRemoveInputSchema = z.object({ deleteData: z.boolean({ error: 'Say whether to delete its data.' }) });

/** POST /accounts: add an account by hand. */
export const SavingsHandAccountInputSchema = z.object({
  nickname: NicknameSchema,
  kind: z.enum(SAVINGS_ACCOUNT_KINDS, { error: 'Choose cash or investment.' }),
});
export type SavingsHandAccountInput = z.infer<typeof SavingsHandAccountInputSchema>;

/** POST /accounts/:id/balance: an amount as typed ("25,000.00", "$1,000"), for today or `date`. */
export const SavingsSetBalanceInputSchema = z.object({
  amount: z.string({ error: 'Enter the balance as an amount, like 1234.56.' }).max(40, 'Enter the balance as an amount, like 1234.56.'),
  date: LocalDateSchema.optional(),
});
export type SavingsSetBalanceInput = z.infer<typeof SavingsSetBalanceInputSchema>;

export const SAVINGS_MESSAGES = {
  balanceAmount: 'Enter the balance as an amount, like 1234.56.',
  balanceTooBig: 'Enter a balance between -$1,000,000,000.00 and $1,000,000,000.00.',
  balanceFuture: "That day hasn't happened yet. Pick today or an earlier day.",
  balanceTooOld: 'Pick a day in 2000 or later.',
  balanceFromPlaid: 'Plaid has a balance for that day, and it always wins. Pick another day.',
  linkedRemove: 'Remove a linked account with its connection.',
  linkedNeedsPlaid: "That account is linked through Plaid, which isn't set up on this server, so its imports and import settings can't be changed here.",
  accountNotFound: "That account isn't here anymore. Reload the page.",
  accountNotListed: "That account isn't on this connection anymore. Reload the page.",
  accountDecided: 'That account is already shown. Reload the page.',
  decideEvery: 'Choose Show or Skip for every account before saving.',
  notShowable: "That kind of account can't be shown in Savings.",
  accountIdInUse: 'That account is already shown from an earlier connection, so nothing was saved. Skip it, or remove the earlier connection with its data.',
  pickFirst: 'Choose which accounts to show first.',
  loadAccountsFirst: "This connection's accounts haven't been loaded yet. Load them, then choose.",
  monthNotStarted: "That month hasn't started yet.",
  monthBeforeData: 'There are no savings numbers for that month. Pick a later one.',
  /** A Savings connection that needs signing in again: Spend's line, pointing at Savings settings. */
  reconnect: 'The institution needs you to sign in again. Reconnect it in Savings settings.',
  pickDeferred: 'Saved. Syncing in the background.',
  refreshDeferred: 'Syncing in the background.',
  noFlows: "Deposits and withdrawals aren't available for this account, so this is the month's total change.",
  noImportForMonth: "No import covers this month, so this is the month's total change.",
  investmentsNotEnabled: "Investments isn't enabled for this Plaid account. The Plaid account's owner can turn it on in the Plaid Dashboard.",
  investmentsRetry: "Couldn't read the brokerage's activity this time. It's tried again at the next sync.",
  investmentsNotShared:
    "The institution didn't share investment activity, so the brokerage shows its total change only. Removing the connection and connecting again, allowing investments, may fix it.",
  graphFilling: (date: string) => `The graph starts on ${date}, the first day with a balance, and fills in over six months.`,
  mapColumnMissing: "That column isn't in this file. Choose the columns again.",
  mapSameColumn: 'Each column can only have one role.',
  mapBadDate: (line: number, format: string) => `Line ${line}'s date isn't a date written as ${format}, from 2000 to tomorrow, so nothing was imported. Check the date column and format.`,
  mapBadAmount: (line: number) => `Line ${line}'s amount isn't a number like 1,234.56 or (12.00), so nothing was imported. Check the amount columns.`,
  importNoFile: 'Choose a CSV file first.',
  importTooBig: 'That file is over 5 MB. Download a shorter period, and import it in parts.',
  importNotFound: 'That import has expired or was replaced. Upload the file again.',
  importNotReady: 'Choose the columns and what each group of rows counts as first.',
  importChooseEvery: 'Choose what every group of rows counts as.',
  importNothingNew: "Everything in this file is already here, so there's nothing to import.",
  importRecordNotFound: "That import isn't here anymore. Reload the page.",
  profileNotFound: "This account has no saved import settings. Reload the page.",
  profileUnknownGroup: "That group isn't in the saved settings anymore. Reload the page.",
  savedMappingDoesntFit: (why: string) => `The saved columns don't fit this file: ${why} Choose the columns again.`,
  importCashFormatOnInvestment: (nickname: string) => `This looks like a Fidelity cash management file, but ${nickname} is an investment account. Check that this is the right account.`,
  importBrokerageFormatOnCash: (nickname: string) => `This looks like a Fidelity brokerage file, but ${nickname} is a cash account. Check that this is the right account.`,
  importAccountMismatch: (fileEnd: string, mask: string) => `This file's account number ends in ${fileEnd}, but this account's ends in ${mask}. Check that this is the right account.`,
  imported: (r: { fileName: string | null; deposits: number; withdrawals: number; balances: number; skipped: number }) =>
    `Imported ${r.fileName ?? 'the file'}: ${andList(nonzeroCounts([[r.deposits, 'deposit'], [r.withdrawals, 'withdrawal'], [r.balances, 'daily balance']]))} added${r.skipped > 0 ? `, ${r.skipped} already here` : ''}.`,
  importUndoOverlaps: 'Undoing this also removes days a later import relied on; import that file again afterwards.',
  importUndone: (r: { fileName: string | null; flows: number; balances: number; overlaps?: number }) => {
    const parts = nonzeroCounts([[r.flows, 'deposit or withdrawal', 'deposits and withdrawals'], [r.balances, 'daily balance']]);
    const done = parts.length === 0 ? `Undid the import of ${r.fileName ?? 'the file'}. Nothing it added was still here.` : `Undid the import of ${r.fileName ?? 'the file'}: removed ${andList(parts)}.`;
    return (r.overlaps ?? 0) > 0 ? `${done} ${SAVINGS_MESSAGES.importUndoOverlaps}` : done;
  },
} as const;

/**
 * Why a Savings link didn't finish, as Savings settings shows `?bank_error=`: Spend's messages, with
 * the ones that name Spend settings reworded.
 */
export const SAVINGS_LINK_ERRORS: Record<PlaidLinkError, string> = {
  ...PLAID_LINK_ERRORS,
  expired: 'That connection attempt expired or came from another session. Start again from Savings settings.',
  maybe_connected: 'Plaid may have made this connection. Check Savings settings in a minute before connecting again.',
  not_admin: 'Only an admin can connect an account.',
  exited: "Nothing was connected. Nothing changed.",
  duplicate: 'That login is already connected. Nothing new was connected.',
};
