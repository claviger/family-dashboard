import { z } from 'zod';
import { LocalDateSchema } from './dates.js';
import { ConnectionStatusSchema } from './integrations.js';
import { MAX_AMOUNT_CENTS } from './money.js';

/** Spend panel shapes (spec §12): what the database stores, and the API's inputs, responses, and messages. */

/** `excluded` is Payments and transfers (left out of totals); `uncategorized` is the fallback. Spec §12.5. */
export const CATEGORY_KINDS = ['normal', 'excluded', 'uncategorized'] as const;
export type CategoryKind = (typeof CATEGORY_KINDS)[number];

/** Where a transaction's category or person came from (spec §12.9). */
export const FIELD_SOURCES = ['manual', 'rule', 'mapping', 'default'] as const;
export type FieldSource = (typeof FIELD_SOURCES)[number];

export const TRANSACTION_SOURCES = ['plaid', 'csv'] as const;
export type TransactionSource = (typeof TRANSACTION_SOURCES)[number];

/** Spec §12.4. Phase 6a stores only `manual` rows; `plaid` comes with phase 6b; `inferred` dates are computed, never stored. */
export const STATEMENT_SOURCES = ['plaid', 'inferred', 'manual'] as const;
export type StatementSource = (typeof STATEMENT_SOURCES)[number];

export const MATCH_TYPES = ['contains', 'exact'] as const;
export type MatchType = (typeof MATCH_TYPES)[number];

/**
 * What happens to one row of an uploaded CSV (spec §12.13):
 * - `new`: imported unless the admin leaves it out.
 * - `duplicate`: looks like a transaction already stored (the duplicate test); left out unless the admin includes it.
 * - `already_imported`: its reference number is already stored for this card; never imported again.
 * - `repeated`: its reference number is on an earlier row of the same file; never imported.
 * - `pending_credit`: a temporary credit that hasn't posted (empty date, `TEMPRET`); never imported.
 * - `unreadable`: couldn't be read; `reason` says why.
 */
export const PREVIEW_ROW_STATUSES = ['new', 'duplicate', 'already_imported', 'repeated', 'pending_credit', 'unreadable'] as const;
export type PreviewRowStatus = (typeof PREVIEW_ROW_STATUSES)[number];

export const PreviewRowSchema = z.object({
  /** 1-based line number in the file, which is what the preview shows. */
  line: z.number(),
  status: z.enum(PREVIEW_ROW_STATUSES),
  /** YYYY-MM-DD, from Posted Date. */
  date: z.string().nullable(),
  reference: z.string().nullable(),
  payee: z.string().nullable(),
  address: z.string().nullable(),
  /** Positive means money spent (the sign is already flipped from the file's). */
  amountCents: z.number().nullable(),
  /**
   * For a row that can't be imported: why, in plain words. For a `new` row: `POSSIBLE_DUPLICATE`
   * when it matches a stored transaction in every way but the reference number (a warning; it
   * starts ticked unless such rows are most of the new ones, see `startsTicked`).
   */
  reason: z.string().nullable(),
  /** For `duplicate`: the stored transaction it looks like. For a `new` row with `POSSIBLE_DUPLICATE`: the near match. */
  duplicateOf: z.object({ id: z.number(), date: z.string(), merchant: z.string(), amountCents: z.number() }).nullable(),
});
export type PreviewRow = z.infer<typeof PreviewRowSchema>;

/**
 * A `new` row's warning: same card, same amount, dates close, and a similar merchant as a stored
 * transaction, but a different reference number. The bank says they're different, so it isn't a
 * duplicate, but if the bank renumbers transactions between downloads, this is how it shows up.
 */
export const POSSIBLE_DUPLICATE = 'Possible duplicate (different reference number)';

/**
 * A `new` row whose reference number is held by a CSV row a bank transaction replaced, from an
 * import that was undone. Importing it adopts that row into this import instead of adding it again.
 */
export const IMPORT_REPLACED_ROW = 'Already shown from the bank. Importing keeps it with this file instead of adding it twice.';

// --- The API (spec §13): inputs, responses, and the messages people see. ---

const PositiveIdSchema = (message: string) => z.int({ error: message }).positive(message);

export const CARD_NICKNAME_MAX = 40;
export const CATEGORY_NAME_MAX = 40;
export const RULE_TEXT_MAX = 100;
export const NOTE_MAX = 1000;
/** The CSV upload limit (spec §12.13). */
export const CSV_MAX_BYTES = 5 * 1024 * 1024;

const MASK_MESSAGE = 'Enter the last 2 to 4 characters of the card number, or leave it empty';

/** POST /cards and PUT /cards/:id (admins). An empty mask is none. Never more than 4 characters, so a card number can't be stored. */
export const CardInputSchema = z.object({
  nickname: z
    .string({ error: 'Enter a nickname' })
    .trim()
    .min(1, 'Enter a nickname')
    .max(CARD_NICKNAME_MAX, `Keep the nickname to ${CARD_NICKNAME_MAX} characters or fewer`),
  mask: z
    .string({ error: MASK_MESSAGE })
    .trim()
    .refine((s) => s === '' || /^[0-9A-Za-z]{2,4}$/.test(s), MASK_MESSAGE)
    .transform((s) => (s === '' ? null : s))
    .nullable(),
  included: z.boolean({ error: 'Included must be true or false' }),
  usualClosingDay: z
    .int({ error: 'Pick a closing day from 1 to 31, or none' })
    .min(1, 'Pick a closing day from 1 to 31, or none')
    .max(31, 'Pick a closing day from 1 to 31, or none')
    .nullable(),
});
export type CardInput = z.input<typeof CardInputSchema>;

export const CardOptionSchema = z.object({ id: z.number(), nickname: z.string(), mask: z.string().nullable(), archived: z.boolean() });
export type CardOption = z.infer<typeof CardOptionSchema>;

/** GET /cards (admins): every card, for Spend settings. */
export const CardSchema = CardOptionSchema.extend({
  included: z.boolean(),
  usualClosingDay: z.number().nullable(),
  /** Attached to a bank account through Plaid that's still linked (phase 6b). */
  plaidLinked: z.boolean(),
  /**
   * When its bank connection was removed (ISO): Spend settings says "bank connection removed". The card
   * stays, with the bank's transactions unless they were deleted with it (and then what they had replaced).
   */
  bankRemovedAt: z.string().nullable(),
  transactionCount: z.number(),
  /** When a CSV was last imported into it (ISO instant). */
  lastImportAt: z.string().nullable(),
  /** It can be deleted now: it has never had a transaction, deleted ones included, and no rule names it. */
  deletable: z.boolean(),
  /**
   * Why it can't be: `transactions` (it's archived instead, so Spend settings doesn't offer Delete),
   * or `rules` (Delete is shown as unavailable, "Rules use this card"). Null when it's deletable.
   */
  deleteBlocker: z.enum(['transactions', 'rules']).nullable(),
});
export type Card = z.infer<typeof CardSchema>;

/** POST /cards/:id/statements and PUT /statements/:id (admins). */
export const ClosingDateInputSchema = z.object({ closingDate: LocalDateSchema });

export const ClosingSchema = z.object({
  /** The statement row; null for an inferred date, which isn't stored. */
  id: z.number().nullable(),
  date: LocalDateSchema,
  source: z.enum(STATEMENT_SOURCES),
});
export type Closing = z.infer<typeof ClosingSchema>;

export const CYCLE_MODES = ['cycles', 'calendar_month'] as const;
export type CycleMode = (typeof CYCLE_MODES)[number];

/** GET /cards/:id/statements (admins): the card's closing dates, newest first, inferred ones included. */
export const CardStatementsSchema = z.object({ mode: z.enum(CYCLE_MODES), closingDay: z.number().nullable(), closings: z.array(ClosingSchema) });
export type CardStatements = z.infer<typeof CardStatementsSchema>;

export const CategoryRefSchema = z.object({ id: z.number(), name: z.string(), kind: z.enum(CATEGORY_KINDS), archived: z.boolean() });
export type CategoryRef = z.infer<typeof CategoryRefSchema>;

/** GET /categories: in order. `inUse` (a transaction, rule, or Plaid mapping names it) means it can be archived but not deleted. */
export const CategorySchema = CategoryRefSchema.extend({ inUse: z.boolean() });
export type Category = z.infer<typeof CategorySchema>;

/** POST /categories and PUT /categories/:id (admins). */
export const CategoryInputSchema = z.object({
  name: z
    .string({ error: 'Enter a name' })
    .trim()
    .min(1, 'Enter a name')
    .max(CATEGORY_NAME_MAX, `Keep the name to ${CATEGORY_NAME_MAX} characters or fewer`),
});

/** POST .../move (admins): the move up and move down buttons. */
export const MoveInputSchema = z.object({ direction: z.enum(['up', 'down'], { error: 'Move up or down' }) });
export type MoveDirection = z.infer<typeof MoveInputSchema>['direction'];

export const SpendPersonSchema = z.object({ id: z.number(), displayName: z.string(), color: z.string(), active: z.boolean() });
export type SpendPerson = z.infer<typeof SpendPersonSchema>;

/** A rule's smallest or largest amount past `MAX_AMOUNT_CENTS` either way (the rule form says it too). */
export const AMOUNT_LIMIT_MESSAGE = 'Enter an amount of at most $10,000,000';

const AmountLimitSchema = z
  .int({ error: 'Enter an amount in cents' })
  .min(-MAX_AMOUNT_CENTS, AMOUNT_LIMIT_MESSAGE)
  .max(MAX_AMOUNT_CENTS, AMOUNT_LIMIT_MESSAGE)
  .nullable();

/**
 * POST /rules and PUT /rules/:id (admins). `setPerson` is a user id, 'household', or null (leave
 * the person alone). `applyToPast` re-applies every rule to past transactions after saving, leaving
 * fields set by hand alone. `placeFirst` puts a new rule at the top (used by "Add
 * rule" on a transaction, which is meant to win); otherwise new rules go last.
 */
export const RuleInputSchema = z
  .object({
    matchText: z
      .string({ error: 'Enter the text to match' })
      .trim()
      .min(1, 'Enter the text to match')
      .max(RULE_TEXT_MAX, `Keep the text to ${RULE_TEXT_MAX} characters or fewer`),
    matchType: z.enum(MATCH_TYPES, { error: 'Pick contains or exact' }),
    cardId: PositiveIdSchema('Pick a card from the list').nullable(),
    minCents: AmountLimitSchema,
    maxCents: AmountLimitSchema,
    setCategoryId: PositiveIdSchema('Pick a category from the list').nullable(),
    setPerson: z.union([z.literal('household'), PositiveIdSchema('Pick a person from the list')], { error: 'Pick a person from the list' }).nullable(),
    applyToPast: z.boolean({ error: 'Apply to past transactions must be true or false' }).default(false),
    placeFirst: z.boolean().default(false),
  })
  .refine((r) => r.setCategoryId !== null || r.setPerson !== null, 'Pick a category, a person, or both')
  .refine((r) => r.minCents === null || r.maxCents === null || r.minCents <= r.maxCents, "The smallest amount can't be more than the largest");
export type RuleInput = z.input<typeof RuleInputSchema>;

export const RULE_PROBLEMS = {
  archivedCategory: "Its category is archived, so it doesn't set the category until it's edited.",
  inactivePerson: "Its person is deactivated, so it doesn't set the person until it's edited.",
  archivedCard: 'Its card is archived.',
} as const;

export const RuleSchema = z.object({
  id: z.number(),
  position: z.number(),
  matchText: z.string(),
  matchType: z.enum(MATCH_TYPES),
  card: CardOptionSchema.nullable(),
  minCents: z.number().nullable(),
  maxCents: z.number().nullable(),
  setCategory: CategoryRefSchema.nullable(),
  setPerson: z.union([z.object({ kind: z.literal('household') }), z.object({ kind: z.literal('user'), person: SpendPersonSchema })]).nullable(),
  /** Why it's flagged in Spend settings (RULE_PROBLEMS); empty when it applies in full. */
  problems: z.array(z.string()),
});
export type Rule = z.infer<typeof RuleSchema>;

/** A rule save, and how many transactions changed when it was applied to past ones (null when it wasn't). */
export const RuleSaveResponseSchema = z.object({ rule: RuleSchema, applied: z.number().nullable() });
export type RuleSaveResponse = z.infer<typeof RuleSaveResponseSchema>;

export const SpendTransactionSchema = z.object({
  id: z.number(),
  cardId: z.number(),
  source: z.enum(TRANSACTION_SOURCES),
  /** The posted date (or, for pending ones, the transaction date): what decides the cycle. */
  date: LocalDateSchema,
  /** The merchant name, or the raw description when there's none. */
  merchant: z.string(),
  rawName: z.string(),
  amountCents: z.number(),
  currency: z.string(),
  pending: z.boolean(),
  category: CategoryRefSchema,
  categorySource: z.enum(FIELD_SOURCES),
  /** Null is Household. */
  person: SpendPersonSchema.nullable(),
  personSource: z.enum(FIELD_SOURCES),
  note: z.string().nullable(),
  /**
   * Its twins: the other live transactions on its card with the same date and amount, whatever
   * their names, by id. A row with any can be removed as a duplicate (admins, spec §12.12).
   */
  twinIds: z.array(z.number()),
});
export type SpendTransaction = z.infer<typeof SpendTransactionSchema>;

/** The fields Remove duplicate copies to a lone twin, and Undo takes back. */
export const CARRIED_FIELDS = ['category', 'person', 'note'] as const;
export type CarriedField = (typeof CARRIED_FIELDS)[number];

/** POST /transactions/:id/remove-duplicate (admins): what was removed, and what was copied to its twin. */
export const DuplicateRemovalSchema = z.object({
  id: z.number(),
  /** The one twin it copied fields to, or null (several twins, or nothing to copy). */
  copiedTo: z.number().nullable(),
  copied: z.array(z.enum(CARRIED_FIELDS)),
});
export type DuplicateRemoval = z.infer<typeof DuplicateRemovalSchema>;

/** POST /transactions/:id/restore-duplicate (admins): the row back, and the copies taken back from its twin. */
export const DuplicateRestoreSchema = z.object({
  transaction: SpendTransactionSchema,
  reverted: z.array(z.enum(CARRIED_FIELDS)),
});
export type DuplicateRestore = z.infer<typeof DuplicateRestoreSchema>;

/** PATCH /transactions/:id (anyone with the panel). Each field given is set by hand. `personUserId` null is Household. */
export const TransactionPatchSchema = z
  .object({
    categoryId: PositiveIdSchema('Pick a category from the list').optional(),
    personUserId: PositiveIdSchema('Pick a person from the list').nullable().optional(),
    note: z.string({ error: 'The note must be text' }).max(NOTE_MAX, `Keep the note to ${NOTE_MAX.toLocaleString('en-US')} characters or fewer`).nullable().optional(),
  })
  .refine((p) => p.categoryId !== undefined || p.personUserId !== undefined || p.note !== undefined, 'Change the category, the person, or the note');
export type TransactionPatch = z.input<typeof TransactionPatchSchema>;

/** The most transactions one save from the drill-down can change. */
export const TRANSACTION_BATCH_MAX = 500;
const BATCH_TOO_BIG = `That's too many changes at once. Save changes on ${TRANSACTION_BATCH_MAX} transactions or fewer at a time.`;

/**
 * One transaction's category and person picks, in a batch. `personUserId` null is Household.
 * `expected` is what the page last saw saved in each field it changes: if someone else has changed
 * a field since, the batch is refused (409) rather than overwriting their change unseen.
 */
export const TransactionBatchChangeSchema = z
  .object({
    id: PositiveIdSchema('That transaction no longer exists.'),
    categoryId: PositiveIdSchema('Pick a category from the list').optional(),
    personUserId: PositiveIdSchema('Pick a person from the list').nullable().optional(),
    expected: z
      .object({
        categoryId: PositiveIdSchema('Pick a category from the list').optional(),
        personUserId: PositiveIdSchema('Pick a person from the list').nullable().optional(),
      })
      .optional(),
  })
  .refine((c) => c.categoryId !== undefined || c.personUserId !== undefined, 'Change the category or the person');
export type TransactionBatchChange = z.input<typeof TransactionBatchChangeSchema>;

/** A batch's refusal `details` (beside the plain message), so the page can act on each row. */
export type TransactionBatchProblem =
  /**
   * 404: these transactions are gone, or on a card that isn't shown. `replacedBy` (old id to new
   * id, there only when some were) names the shown row that took a gone one's place: a Plaid row
   * that replaced a CSV row, or the posted version of a pending one.
   */
  | { missingIds: number[]; replacedBy?: Record<string, number> }
  /** 409: someone else changed these fields since the page saw them; `current` is what's saved now. */
  | { conflicts: { transactionId: number; field: 'category' | 'person'; current: number | null }[] }
  /** 400: a value that can't be assigned (archived, deactivated, gone), and the message without the merchant. */
  | { transactionId: number; field: 'category' | 'person'; problem: string };

/**
 * PATCH /transactions (anyone with the panel): the drill-down's one Save. Every change is made, or
 * none is. Each transaction is listed once.
 */
export const TransactionBatchSchema = z.object({
  changes: z
    .array(TransactionBatchChangeSchema, { error: 'Send the changes as a list' })
    .min(1, 'There are no changes to save')
    .max(TRANSACTION_BATCH_MAX, BATCH_TOO_BIG)
    .refine((list) => new Set(list.map((c) => c.id)).size === list.length, 'Each transaction can only be listed once'),
});
export type TransactionBatch = z.input<typeof TransactionBatchSchema>;

/** POST /transactions/:id/reset: Reset to automatic, for the fields given. */
export const ResetInputSchema = z.object({
  fields: z.array(z.enum(['category', 'person'], { error: 'Reset the category or the person' })).min(1, 'Reset the category or the person'),
});

export const CycleSchema = z.object({
  start: LocalDateSchema,
  end: LocalDateSchema,
  current: z.boolean(),
  /** Where the closing date that ends it came from; null for a calendar month. */
  closingSource: z.enum(STATEMENT_SOURCES).nullable(),
});
export type SpendCycle = z.infer<typeof CycleSchema>;

export const SpendTotalsSchema = z.object({
  /** The card's currency: every amount here is in it. */
  currency: z.string(),
  totalCents: z.number(),
  pendingCents: z.number(),
  /** The previous cycle's total, or null when there's no previous cycle. */
  previousCents: z.number().nullable(),
  /** Transactions left out of the totals because they're in another currency. */
  otherCurrencyCount: z.number(),
  byCategory: z.array(z.object({ category: CategoryRefSchema, cents: z.number(), previousCents: z.number() })),
  /** `person` null is Household. */
  byPerson: z.array(z.object({ person: SpendPersonSchema.nullable(), cents: z.number(), previousCents: z.number() })),
});
export type SpendTotals = z.infer<typeof SpendTotalsSchema>;

/** The `spend.transactionsSync` job's interval (spec §3.5). */
export const BANK_SYNC_INTERVAL_MS = 6 * 60 * 60_000;
/** Spec §8: data is stale when it's older than twice its source's normal refresh interval. */
export const BANK_STALE_AFTER_MS = 2 * BANK_SYNC_INTERVAL_MS;

/**
 * A linked card's bank connection, for the home card and the drill-down (the design's
 * "Freshness"). Null for a card with no bank, or one whose bank was removed.
 */
export const BankFreshnessSchema = z.object({
  /** The bank (local Item id): an admin's Reconnect link is `/connect/plaid/link?item=` it. */
  itemId: z.number(),
  institutionName: z.string().nullable(),
  status: ConnectionStatusSchema,
  /** When a sync run was last saved (ISO). */
  lastSyncAt: z.string().nullable(),
  /** `updatedAt` is more than BANK_STALE_AFTER_MS old. */
  stale: z.boolean(),
});
export type BankFreshness = z.infer<typeof BankFreshnessSchema>;

/**
 * GET /overview?card=&cycle=: the drill-down (spec §12.12). `cards` are the included ones, archived
 * last. `cycle` is a cycle's start date; without it (or with one that isn't a cycle) it's the
 * current cycle. `cycles` are newest first: the current one and every past one with transactions.
 */
export const SpendOverviewSchema = z.object({
  serverNow: z.string(),
  cards: z.array(CardOptionSchema),
  card: CardOptionSchema.nullable(),
  mode: z.enum(CYCLE_MODES),
  cycles: z.array(CycleSchema),
  cycle: CycleSchema.nullable(),
  previous: CycleSchema.nullable(),
  totals: SpendTotalsSchema,
  transactions: z.array(SpendTransactionSchema),
  /** When this card's data last changed from its source: the later of its bank's last saved sync run and its last CSV import. */
  updatedAt: z.string().nullable(),
  bank: BankFreshnessSchema.nullable(),
});
export type SpendOverview = z.infer<typeof SpendOverviewSchema>;


export const OverviewQuerySchema = z.object({
  card: z.string().regex(/^\d+$/, 'Pick a card from the list').transform(Number).optional(),
  cycle: LocalDateSchema.optional(),
});

/** GET /summary: the home card (spec §12.11). */
export const SpendSummarySchema = z.object({
  serverNow: z.string(),
  cards: z.array(
    CardOptionSchema.extend({
      mode: z.enum(CYCLE_MODES),
      cycle: CycleSchema,
      /** The card's currency, which the totals are in. */
      currency: z.string(),
      totalCents: z.number(),
      pendingCents: z.number(),
      /** Transactions left out of the total because they're in another currency. */
      otherCurrencyCount: z.number(),
      /** The later of its bank's last saved sync run and its last CSV import (the design's "Freshness"). */
      updatedAt: z.string().nullable(),
      bank: BankFreshnessSchema.nullable(),
    }),
  ),
  /** The last 8 across the included cards, newest first. */
  recent: z.array(SpendTransactionSchema),
});
export type SpendSummary = z.infer<typeof SpendSummarySchema>;

/** POST /imports (admins, multipart: `cardId` and `file`): the preview (spec §12.13). */
export const ImportPreviewSchema = z.object({
  id: z.string(),
  card: CardOptionSchema,
  fileName: z.string().nullable(),
  rows: z.array(PreviewRowSchema),
  /** The earliest and latest posted dates among rows that can be imported. */
  dateRange: z.object({ from: LocalDateSchema, to: LocalDateSchema }).nullable(),
  warnings: z.array(z.object({ id: z.enum(['mostly_credits', 'card_mismatch', 'mostly_possible_duplicates']), message: z.string() })),
  expiresAt: z.string(),
});
export type ImportPreview = z.infer<typeof ImportPreviewSchema>;

/**
 * POST /imports/:id/commit: the line numbers of the rows to import, at least one. A save where no
 * line picked can be imported (by the preview's statuses) is refused. Rows picked that turn out to
 * be stored by now are skipped, and the import is still recorded.
 */
export const ImportCommitInputSchema = z.object({
  include: z
    .array(z.int({ error: 'Pick rows from the preview' }).positive('Pick rows from the preview'), { error: 'Pick rows from the preview' })
    .min(1, 'Pick at least one row to import.')
    .max(200_000),
});
export const ImportResultSchema = z.object({ imported: z.number(), skipped: z.number() });
export type ImportResult = z.infer<typeof ImportResultSchema>;

/** GET /cards/:id/imports (admins): the card's recent imports, newest first, for "Undo this import". */
export const CsvImportRecordSchema = z.object({
  id: z.number(),
  fileName: z.string().nullable(),
  /** ISO instant. */
  uploadedAt: z.string(),
  /** Who uploaded it, or null when they're gone. */
  uploadedBy: z.string().nullable(),
  importedCount: z.number(),
  /** Its transactions still stored: what an undo deletes. */
  transactionCount: z.number(),
});
export type CsvImportRecord = z.infer<typeof CsvImportRecordSchema>;

/** DELETE /cards/:id/imports/:importId (admins): how many transactions the undo deleted. */
export const ImportUndoResultSchema = z.object({ removed: z.number() });
export type ImportUndoResult = z.infer<typeof ImportUndoResultSchema>;

/** Rows the admin can choose to import. Every other status is shown but can't be. */
export function canImport(status: PreviewRowStatus): boolean {
  return status === 'new' || status === 'duplicate';
}

const isPossibleDuplicate = (r: PreviewRow) => r.status === 'new' && r.reason === POSSIBLE_DUPLICATE;

/**
 * More than half of a preview's new rows are possible duplicates: the bank has likely renumbered
 * transactions already stored, so they start unticked, and the preview says why.
 */
export function mostlyPossibleDuplicates(rows: readonly PreviewRow[]): boolean {
  const fresh = rows.filter((r) => r.status === 'new');
  return fresh.filter(isPossibleDuplicate).length > fresh.length / 2;
}

/** The lines a preview starts with ticked: new rows, less possible duplicates when they're most of them. */
export function startsTicked(rows: readonly PreviewRow[]): number[] {
  const mostly = mostlyPossibleDuplicates(rows);
  return rows.filter((r) => r.status === 'new' && !(mostly && isPossibleDuplicate(r))).map((r) => r.line);
}

export const SPEND_MESSAGES = {
  cardNotFound: 'That card no longer exists.',
  cardArchived: 'That card is archived. Unarchive it in Spend settings first.',
  cardHasTransactions: 'This card has transactions, so it can be archived but not deleted.',
  cardInRules: 'Rules use this card. Change or delete them first.',
  closingNotFound: 'That closing date no longer exists.',
  closingExists: 'That card already has that closing date.',
  closingTooLate: 'Pick a closing date no more than two months from today.',
  closingTooEarly: 'Pick a closing date in 2000 or later.',
  closingPlaid: 'Closing dates from the bank can be changed, but not deleted.',
  categoryNotFound: 'That category no longer exists.',
  categoryExists: 'There is already a category with that name.',
  categorySpecial: "That category can't be archived or deleted. It can be renamed.",
  categoryInUse: 'This category is in use, so it can be archived but not deleted.',
  categoryArchived: 'That category is archived. Pick another one.',
  ruleNotFound: 'That rule no longer exists.',
  personInactive: 'Pick an active person, or Household.',
  transactionNotFound: 'That transaction no longer exists.',
  duplicateNoTwin: "There's no other transaction on this card with the same date and amount, so it wasn't removed.",
  duplicateAlreadyRemoved: 'That transaction is already removed.',
  duplicateNotRemoved: "That transaction isn't a removed duplicate, so there's nothing to bring back.",
  duplicateImportUndone: "That transaction's import was undone, so it can't be brought back. Import the file again instead.",
  duplicateBankRemoved: "The bank has since removed that transaction, so it can't be brought back.",
  batchTooBig: BATCH_TOO_BIG,
  transactionsNotFound: (n: number) => `${n} of these transactions no longer exist.`,
  transactionChangedMeanwhile: (merchant: string) => `Someone else changed ${merchant} while you were editing, so nothing was saved.`,
  transactionsChangedMeanwhile: (n: number) => `Someone else changed ${n} of these transactions while you were editing, so nothing was saved.`,
  importNotFound: 'That preview has expired. Upload the file again.',
  importNoFile: 'Choose a CSV file to upload.',
  importNothingPicked: 'None of the rows you picked can be imported.',
  importRecordNotFound: 'That import no longer exists.',
  importUndoEdited: (edited: number, total: number) =>
    `This import can't be undone because ${edited} of its ${total} transactions ${edited === 1 ? 'has' : 'have'} a category, person, or note set by hand. Undo those changes first.`,
  importMostlyPossibleDuplicates:
    "Most of this file's new rows look like transactions already here with a different reference number. The bank may have renumbered them, so they start unticked. Tick only the ones that are really new.",
  importTooBig: 'That file is too big. The limit is 5 MB.',
  importCardMismatch: (fileMask: string, cardMask: string) =>
    `The file name ends in ${fileMask}, but this card's last 4 is ${cardMask}. Check that you picked the right card.`,
} as const;
