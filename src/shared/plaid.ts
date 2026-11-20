import { z } from 'zod';
import { ConnectionStatusSchema } from './integrations.js';
import { CardOptionSchema, CategoryRefSchema } from './spend.js';

/**
 * What the browser and the server share about Plaid (spec §12.2, §12.7, docs/research/plaid-6b.md):
 * Link's metadata and errors, Spend settings' banks, and the category mapping editor.
 */

/** Plaid's Trial plan allows this many Items, removed ones included (research §9). */
export const PLAID_TRIAL_LIMIT = 10;

/**
 * Which panel a Plaid Item belongs to (the Savings spec): `spend` for card banks, `savings` for the
 * Savings panel's Fidelity login. Every Item made before the Savings panel is `spend`.
 */
export const PLAID_PURPOSES = ['spend', 'savings'] as const;
export type PlaidPurpose = (typeof PLAID_PURPOSES)[number];

/**
 * Link's `onSuccess` metadata (research §3.2), as the Link page posts it. It comes from the admin's
 * browser, so the server only uses it for the duplicate check: what's stored comes from Plaid's
 * own `/item/get` and `/accounts/get`.
 */
export const PlaidLinkMetadataSchema = z.object({
  institution: z.object({ institution_id: z.string().min(1).max(100), name: z.string().max(200) }).nullable(),
  accounts: z.array(z.object({
    id: z.string().min(1).max(200),
    name: z.string().max(200),
    mask: z.string().max(20).nullable(),
    type: z.string().max(50),
    subtype: z.string().max(50).nullable(),
  })).max(100),
  link_session_id: z.string().max(200).optional(),
});
export type PlaidLinkMetadata = z.infer<typeof PlaidLinkMetadataSchema>;

/**
 * Why a link didn't finish, as `?bank_error=` on Spend settings: the code goes in the URL, the
 * message is what the page shows.
 */
export const PLAID_LINK_ERRORS = {
  exited: "The bank wasn't connected. Nothing changed.",
  trial_limit: "Plaid's Trial plan allows 10 bank connections, and they've all been used. Removing a bank doesn't free one.",
  duplicate: 'That bank login is already connected. Nothing new was connected.',
  expired: 'That connection attempt expired or came from another session. Start again from Spend settings.',
  institution: "That bank isn't available through Plaid right now. Try again later.",
  failed: "Couldn't finish connecting the bank. Try again in a few minutes.",
  key_mismatch: "Banks can't be connected right now because the server's encryption key changed. An admin needs to fix the key.",
  not_admin: 'Only an admin can connect a bank.',
  busy: 'That bank is busy syncing. Try again in a minute.',
  /** The exchange was sent but its answer never came (review C-S-M4): it's counted against the Trial. */
  maybe_connected: 'Plaid may have made this connection. Check Spend settings in a minute before linking again.',
} as const;
export type PlaidLinkError = keyof typeof PLAID_LINK_ERRORS;

/** What people see about a bank connection. Never a token, an id, or Plaid's own error text (spec §14). */
export const PLAID_MESSAGES = {
  keyMismatch: "Bank connections are unavailable: the server's TOKEN_ENCRYPTION_KEY doesn't match the stored credentials. An admin needs to fix the key.",
  notFound: "That bank connection isn't here anymore. Reload the page.",
  linkExpired: PLAID_LINK_ERRORS.expired,
  trialLimit: PLAID_LINK_ERRORS.trial_limit,
  unreachable: "Couldn't reach Plaid. Try again in a few minutes.",
  busy: 'Plaid is busy right now. Try again in a few minutes.',
  /** A sync held the bank's lock past the request's deadline. */
  itemBusy: PLAID_LINK_ERRORS.busy,
  /** `GET /connect/plaid/link` opened from another site (Sec-Fetch-Site). */
  notFromHere: 'Start connecting a bank from Spend settings.',
  /** The request's time ran out before Plaid answered (waiting for a sync included). */
  outOfTime: 'Plaid took too long to answer. Try again in a minute.',
  institution: PLAID_LINK_ERRORS.institution,
  failed: PLAID_LINK_ERRORS.failed,
  reconnect: 'The bank needs you to sign in again. Reconnect it in Spend settings.',
  gone: 'This bank connection no longer works at Plaid. Remove it and connect the bank again.',
  unreadable: "The saved bank connection couldn't be read. Remove it and connect the bank again.",
  duplicate: (name: string) => `That bank login is already connected as ${name}. Nothing new was connected.`,
} as const;

// --- Spend settings' banks (spec §12.2, the design's departures 2, 3 and 11). ---

/**
 * An account of a bank, as the pick step and the bank list show it:
 * - `attached`: on `card`, synced;
 * - `skipped`: the admin chose not to track it, so its transactions are dropped; attaching it later
 *   resyncs the bank from the start (departure 2);
 * - `waiting`: not decided yet. While any account waits, the bank isn't synced.
 */
export const BANK_ACCOUNT_STATES = ['attached', 'skipped', 'waiting'] as const;
export type BankAccountState = (typeof BANK_ACCOUNT_STATES)[number];

export const BankAccountViewSchema = z.object({
  /** Plaid's `account_id`: what the pick sends back. */
  accountId: z.string(),
  name: z.string(),
  officialName: z.string().nullable(),
  mask: z.string().nullable(),
  subtype: z.string().nullable(),
  state: z.enum(BANK_ACCOUNT_STATES),
  /** The card it's attached to; null unless `attached`. */
  card: CardOptionSchema.nullable(),
  /**
   * For an account that isn't attached: the card with the same last 4, if exactly one. The bank's
   * own missing cards come first (an account id that changed), then the attachable cards (spec §12.2).
   */
  suggestedCardId: z.number().nullable(),
});
export type BankAccountView = z.infer<typeof BankAccountViewSchema>;

export const BankViewSchema = z.object({
  /** The local Item id: `?bank=`, `/connect/plaid/link?item=`, and the bank routes take it. */
  id: z.number(),
  institutionName: z.string().nullable(),
  status: ConnectionStatusSchema,
  /**
   * A plain line about the last failure, when the status isn't ok or the failure came after the
   * last success (a first sync that failed once, say). Never Plaid's own text.
   */
  lastError: z.string().nullable(),
  /**
   * What fixes a `needs_reconnect`: update mode (Reconnect), only removing and linking again, or
   * either (`reconnect_or_remove`: access was revoked at the bank, USER_PERMISSION_REVOKED, so offer
   * Reconnect and "Remove and connect again"). Null otherwise.
   */
  fix: z.enum(['reconnect', 'remove', 'reconnect_or_remove']).nullable(),
  /** ISO instants. `lastSuccessAt` is any successful call to Plaid; `lastSyncAt` the last saved sync run. */
  lastSuccessAt: z.string().nullable(),
  lastSyncAt: z.string().nullable(),
  /** "Choose cards": some account is waiting, so the bank isn't synced until the pick is saved. */
  needsPick: z.boolean(),
  /**
   * The first pick was saved, so the bank syncs (and Refresh works), even while an account it
   * listed later waits for a card.
   */
  picked: z.boolean(),
  /**
   * False when the bank's account list couldn't be fetched after linking: the pick is refused until
   * Load accounts (`POST /banks/:id/load-accounts`) fetches it. `accounts` is empty meanwhile.
   */
  accountsLoaded: z.boolean(),
  accounts: z.array(BankAccountViewSchema),
  /**
   * Cards attached to this bank whose account it didn't share when it was last reconnected or
   * loaded. They keep their history. The pick may attach a new account to one of them (the bank
   * changed the account's id), so they're choices for this bank's accounts beside `attachableCards`.
   */
  missingCards: z.array(CardOptionSchema),
  /** Plaid's consent end (ISO), and `PENDING_DISCONNECT`'s date: "Reconnect before" it. */
  consentExpiresAt: z.string().nullable(),
  disconnectAt: z.string().nullable(),
  /**
   * When Plaid said the login has new accounts, or a sync saw transactions for an account the
   * bank's list doesn't have. Two fixes, until a reconnect (or a load that finds a new account):
   * "Load accounts" first (`load-accounts`, which picks up an account the login already shares, an
   * id that changed say), and "Add accounts" (update mode with Account Select) beside it.
   */
  newAccountsAt: z.string().nullable(),
});
export type BankView = z.infer<typeof BankViewSchema>;

export const RemovedBankViewSchema = z.object({
  id: z.number(),
  institutionName: z.string().nullable(),
  removedAt: z.string(),
  /** An admin removed it, keeping or deleting its transactions, or a key reset forgot it (spec §14). */
  reason: z.enum(['removed', 'removed_with_transactions', 'key_reset']),
  /**
   * Whether Plaid's access is known to be ended (review C-W-I2): `waiting`, Plaid didn't confirm and
   * the hourly retries are still asking; `not_asked`, it was given up on (the token couldn't be
   * read, or the retries ran out), and a notice says where to end it instead; `confirmed`, nothing is
   * outstanding (Plaid confirmed, or an admin dismissed that notice).
   */
  revocation: z.enum(['confirmed', 'waiting', 'not_asked']),
  /**
   * Its cards, marked "bank connection removed". They keep the bank's transactions, unless it was
   * removed with them (`removed_with_transactions`): then only what those had replaced is left.
   */
  cards: z.array(CardOptionSchema),
});
export type RemovedBankView = z.infer<typeof RemovedBankViewSchema>;

/** GET /api/panels/spend/banks (admins; a 404 without Plaid's keys), and what every bank route answers. */
export const BanksViewSchema = z.object({
  configured: z.boolean(),
  /** TOKEN_ENCRYPTION_KEY doesn't match: nothing can be linked, synced or removed until the System page's reset. */
  keyMismatch: z.boolean(),
  serverNow: z.string(),
  /** Items this install had Plaid create, removed ones included, against the Trial's limit (departure 3: shown, never enforced here). */
  trial: z.object({ used: z.number(), limit: z.number() }),
  /** Linked banks, oldest first. */
  banks: z.array(BankViewSchema),
  /** Removed banks, most recently removed first. */
  removed: z.array(RemovedBankViewSchema),
  /** Cards an account can be attached to: not archived, and not on another bank account that's still linked. */
  attachableCards: z.array(CardOptionSchema),
  /** Removals Plaid never confirmed, each naming the bank. Dismissed on the System page. */
  notices: z.array(z.object({ id: z.number(), message: z.string() })),
  /**
   * A plain line about what the request left to the background, to show beside the bank: the pick's
   * or Refresh's sync ran past the request's deadline (BANK_MESSAGES.pickDeferred, refreshDeferred),
   * or Remove couldn't get Plaid to end its access (removeUnconfirmed, removeNotAsked). Null
   * otherwise, and always null from GET.
   */
  message: z.string().nullable(),
});
export type BanksView = z.infer<typeof BanksViewSchema>;

const AccountIdSchema = z.string({ error: 'Choose an account from the list.' }).min(1, 'Choose an account from the list.').max(200, 'Choose an account from the list.');

/**
 * POST /banks/:id/accounts: what to do with each account. `attach` puts it on an existing card,
 * `create` makes a new excluded card for it, `skip` leaves it out. Every waiting account must be
 * decided in one request; a skipped one can be attached later.
 */
export const BankPickInputSchema = z.object({
  accounts: z
    .array(
      z.discriminatedUnion('action', [
        z.object({ accountId: AccountIdSchema, action: z.literal('attach'), cardId: z.int({ error: 'Pick a card from the list.' }).positive('Pick a card from the list.') }),
        z.object({ accountId: AccountIdSchema, action: z.literal('create') }),
        z.object({ accountId: AccountIdSchema, action: z.literal('skip') }),
      ], { error: 'Choose a card, a new card, or Skip for each account.' }),
      { error: 'Send the accounts as a list.' },
    )
    .max(100, 'Send at most 100 accounts.')
    .refine((list) => new Set(list.map((a) => a.accountId)).size === list.length, 'Each account can only be listed once.'),
});
export type BankPickInput = z.input<typeof BankPickInputSchema>;
export type BankPickChoice = z.infer<typeof BankPickInputSchema>['accounts'][number];

/**
 * POST /banks/:id/remove. `deleteTransactions` hard-deletes only the bank's own rows, and brings back
 * what they had replaced (CSV rows, or an earlier connection's), with what was set by hand (decision 9).
 */
export const BankRemoveInputSchema = z.object({ deleteTransactions: z.boolean({ error: 'Say whether to delete its transactions.' }) });

export const BANK_MESSAGES = {
  accountNotListed: "That account isn't on this bank connection anymore. Reload the page.",
  accountAttached: 'That account is already on a card.',
  decideEvery: 'Choose a card, a new card, or Skip for every account before saving.',
  cardTaken: 'That card is already connected to another bank account. Pick another card.',
  cardTwice: 'Each card can take only one bank account.',
  accountIdInUse: 'That bank account is already on another card from an earlier connection, so nothing was saved. Attach it to that card, or skip it.',
  pickFirst: 'Choose cards for this bank first.',
  loadAccountsFirst: "This bank's accounts haven't been loaded yet. Load them, then choose cards.",
  pickDeferred: 'Saved. Syncing in the background.',
  refreshDeferred: 'Syncing in the background.',
  /** Removed here, but Plaid didn't confirm ending its access in time: `retryRevocations` asks every hour. */
  removeUnconfirmed: "Plaid didn't confirm it removed its access yet. The dashboard will keep trying every hour.",
  /** Removed here, but its token couldn't be read, so Plaid was never asked (the lasting notice says the same). */
  removeNotAsked:
    "Plaid wasn't asked to end its access, because the saved connection couldn't be read. Remove the dashboard in the bank's connected apps settings, or at my.plaid.com.",
} as const;

// --- The Plaid category mapping editor (spec §12.7). ---

/**
 * PFC v2's 18 primary codes (research §2.4), as migration 0007 seeds them. A detailed code is its
 * primary's code, an underscore, and more. Codes seen on transactions as a primary count as
 * primaries too, so a v1 primary is told apart the same way.
 */
export const PFC_V2_PRIMARIES = [
  'FOOD_AND_DRINK', 'GENERAL_MERCHANDISE', 'HOME_IMPROVEMENT', 'RENT_AND_UTILITIES', 'ENTERTAINMENT', 'TRAVEL', 'MEDICAL', 'TRANSPORTATION',
  'BANK_FEES', 'PERSONAL_CARE', 'GENERAL_SERVICES', 'GOVERNMENT_AND_NON_PROFIT', 'LOAN_PAYMENTS', 'TRANSFER_IN', 'TRANSFER_OUT',
  'LOAN_DISBURSEMENTS', 'INCOME', 'OTHER',
] as const;

export const PFC_KINDS = ['primary', 'detailed'] as const;
export type PfcKind = (typeof PFC_KINDS)[number];

/** A Plaid category code as Plaid writes them: what `:code` in the mapping routes must look like. */
export const PFC_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,99}$/;

export const MappingRowSchema = z.object({
  code: z.string(),
  kind: z.enum(PFC_KINDS),
  /** A detailed code's primary, which it falls back to without a row of its own. Null for a primary. */
  primary: z.string().nullable(),
  taxonomyVersion: z.string(),
  /** Its family category. An archived one is skipped (spec §12.7), so the editor flags it. */
  category: CategoryRefSchema,
  /** Live transactions with this code. */
  transactionCount: z.number(),
});
export type MappingRow = z.infer<typeof MappingRowSchema>;

export const UnmappedCodeSchema = z.object({
  code: z.string(),
  kind: z.enum(PFC_KINDS),
  primary: z.string().nullable(),
  /** As the transactions carry it; null if they don't say. */
  taxonomyVersion: z.string().nullable(),
  transactionCount: z.number(),
  /** What applies now: a detailed code's primary's category, or null for Uncategorized. */
  fallsBackTo: CategoryRefSchema.nullable(),
});
export type UnmappedCode = z.infer<typeof UnmappedCodeSchema>;

/** GET /api/panels/spend/mappings (admins), and what PUT and DELETE answer: every mapping row, and codes seen on transactions that have none. Sorted by code. */
export const MappingViewSchema = z.object({ rows: z.array(MappingRowSchema), unmapped: z.array(UnmappedCodeSchema) });
export type MappingView = z.infer<typeof MappingViewSchema>;

/** PUT /api/panels/spend/mappings/:code (admins). */
export const MappingInputSchema = z.object({ categoryId: z.int({ error: 'Pick a category from the list.' }).positive('Pick a category from the list.') });

/** One Save (review G4-I3) takes at most this many codes. Plaid's taxonomy has about 120. */
export const MAPPING_BATCH_MAX = 500;

const CategoryIdSchema = z.int({ error: 'Pick a category from the list.' }).positive('Pick a category from the list.');

/**
 * PATCH /api/panels/spend/mappings (admins): the mapping editor's one Save. Each change maps a
 * code to a category, or (`categoryId: null`) deletes a detailed code's own row so it falls back
 * to its primary's. `expected` is what the page last saw stored for the code (a category id, or
 * null for no row of its own): if someone else has changed it since, to anything but this
 * change's own value, the whole Save is refused with a 409 naming it. Left out, it isn't checked.
 * All or nothing, like the transactions' batch PATCH.
 */
export const MappingBatchChangeSchema = z.object({
  code: z.string({ error: 'Choose a category code from the list.' }).regex(PFC_CODE_PATTERN, 'Choose a category code from the list.'),
  categoryId: CategoryIdSchema.nullable(),
  expected: CategoryIdSchema.nullable().optional(),
});
export type MappingBatchChange = z.input<typeof MappingBatchChangeSchema>;

export const MappingBatchSchema = z.object({
  changes: z
    .array(MappingBatchChangeSchema, { error: 'Send the changes as a list.' })
    .min(1, 'There are no changes to save.')
    .max(MAPPING_BATCH_MAX, `Save at most ${MAPPING_BATCH_MAX} changes at a time.`)
    .refine((list) => new Set(list.map((c) => c.code)).size === list.length, 'Each code can only be listed once.'),
});

/** What a refused Save's `details` say, for the page to show beside the rows. */
export type MappingBatchProblem =
  | { missingCodes: string[] }
  | { conflicts: { code: string; current: number | null }[] }
  | { code: string; problem: string };

export const MAPPING_MESSAGES = {
  unknownCode: "Plaid hasn't sent that category code here. Reload the page.",
  unknownCodes: (n: number) =>
    n === 1 ? "Nothing was saved. One of these category codes isn't here anymore. Reload the page." : `Nothing was saved. ${n} of these category codes aren't here anymore. Reload the page.`,
  notFound: 'That code has no mapping of its own.',
  primaryStays: "A primary code's mapping can be changed but not deleted: its detailed codes fall back to it.",
  changedMeanwhile: (n: number) =>
    n === 1
      ? 'Nothing was saved. Someone else changed one of these categories while you were editing. Check it, then save again.'
      : `Nothing was saved. Someone else changed ${n} of these categories while you were editing. Check the flagged ones, then save again.`,
} as const;

/**
 * A Plaid category code as people read it: "FOOD_AND_DRINK" is "Food and drink", and a detailed
 * code under it, "FOOD_AND_DRINK_COFFEE", is "Food and drink: coffee".
 */
export function pfcLabel(code: string, primary: string | null): string {
  const words = (s: string) => s.toLowerCase().split('_').filter(Boolean).join(' ');
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  if (primary !== null && code.startsWith(`${primary}_`)) return `${cap(words(primary))}: ${words(code.slice(primary.length + 1))}`;
  return cap(words(code));
}
