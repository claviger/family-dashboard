import { timingSafeEqual } from 'node:crypto';
import { and, asc, count, eq, gt, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import type { Logger } from 'pino';
import { z } from 'zod';
import { PLAID_LINK_ERRORS, PLAID_MESSAGES, type PlaidLinkError, type PlaidLinkMetadata, type PlaidPurpose } from '../../../shared/plaid.js';
import { SAVINGS_MESSAGES } from '../../../shared/savings.js';
import type { PlaidConfig } from '../../config.js';
import type { Clock } from '../../core/clock.js';
import { decryptSecret, encryptSecret, familyRevocationAad, type Keyring } from '../../core/crypto.js';
import { AppError, loggableError, type ErrorCode } from '../../core/errors.js';
import { KeyedLock, LockWaitTimeout } from '../../core/lock.js';
import type { Db } from '../../db/index.js';
import {
  cards, connections, pendingRevocations, plaidItems, plaidLinkPending, transactions,
  type ConnectionRow, type PendingRevocationRow, type PlaidItemAccount, type PlaidItemRow, type PlaidLinkPendingRow, type TransactionRow,
} from '../../db/schema.js';
import { getPlaidClientUserId, getPlaidItemsCreated, notePlaidItemCreated } from '../../settings.js';
import { decryptCredentials, insertFamilyConnection, recordConnectionFailure, recordConnectionSuccess, type DbOrTx } from '../connections.js';
import {
  classifyPlaidError, PlaidApiError, PlaidBadResponse, PlaidClient, PlaidPastDeadline, PlaidUnavailable,
  type AccountFilters, type FetchFn, type LinkTokenCreateRequest, type PlaidAccount, type PlaidClientOptions, type PlaidItem,
} from './client.js';
import { deleteSavingsData, markSavingsAccountsRemoved } from '../../panels/savings/store.js';
import { restoreReplaced } from '../../panels/spend/replaced.js';
import type { Categorizer } from '../../panels/spend/rules.js';
import { loadCategorizer } from '../../panels/spend/store.js';
import { PlaidWebhookVerifier } from './webhookVerify.js';

/** A Link session waits this long (the design's "Pending link storage"): enough for a bank's OAuth pages, shorter than Plaid's 4 hours. */
export const PENDING_LINK_TTL_MS = 30 * 60_000;
/** `/item/remove` that Plaid didn't confirm is tried again hourly, this many times, then given up on with a notice (like the calendar's). */
export const REVOCATION_ATTEMPTS = 12;

/**
 * What a removal did about Plaid's access: `done` (Plaid confirmed, or already had no such Item),
 * `waiting` (Plaid didn't confirm in time, so `retryRevocations` asks again every hour), or
 * `not_asked` (no token that could be read, so Plaid was never asked; the lasting notice says
 * where to end it instead).
 */
export type RemovalRevocation = 'done' | 'waiting' | 'not_asked';
/** After a transient failure, scheduled syncs wait this long, doubling, at most an hour (spec §14, the design's "Backoff"). */
export const BACKOFF_FIRST_MS = 5 * 60_000;
export const BACKOFF_MAX_MS = 60 * 60_000;
/** At most 30 characters, or Link shows "This Application" (research §2.1). */
export const PLAID_CLIENT_NAME = 'Family Dashboard';
/** Research §2.3: Link offers credit cards only, so nothing else is ever shared with us. */
const CREDIT_CARDS_ONLY: AccountFilters = { credit: { account_subtypes: ['credit card'] } };
/** Research §2.1: the most history Plaid gives, and it can't be raised later. */
const DAYS_REQUESTED = 730;
/**
 * The Savings link (plan decision 2, research plaid-savings §2.2): Transactions for the cash
 * account's flows; Investments only where Fidelity and this client have it, so its absence never
 * hides Fidelity in Link or fails the link. One constant, in case Fidelity lacks Transactions.
 */
export const SAVINGS_LINK_PRODUCTS = { products: ['transactions'], required_if_supported_products: ['investments'] } as const;
/** Research plaid-savings §2.3: Link offers cash and investment accounts only, never credit cards. */
const SAVINGS_ACCOUNTS: AccountFilters = { depository: { account_subtypes: ['all'] }, investment: { account_subtypes: ['all'] } };

/** What `credentials_enc` holds on a Plaid connection and on its waiting revocation. An access token doesn't expire (research §4.1). */
const CredentialsSchema = z.object({ accessToken: z.string().min(1) });

/** A Plaid connection's `meta`: Plaid's `item_id` (what a webhook names) and the bank, for the admin page. */
export interface PlaidConnectionMeta {
  itemId: string;
  institutionName: string | null;
}

/** The plain line stored as a connection's `last_error` (spec §8) for each failure. Never Plaid's own message text. */
export const RECONNECT_ERRORS: Record<string, string> = {
  ITEM_LOGIN_REQUIRED: 'The bank needs you to sign in again.',
  PASSWORD_RESET_REQUIRED: 'The bank needs a new password. Change it at the bank, then reconnect.',
  ITEM_LOCKED: 'The bank locked the login. Unlock it at the bank, then reconnect.',
  ACCESS_NOT_GRANTED: "The bank isn't sharing what the dashboard needs. Reconnect and allow it.",
  // Neutral: a Savings connection's accounts aren't cards.
  NO_ACCOUNTS: "The bank isn't sharing any accounts. Reconnect and pick them.",
  USER_PERMISSION_REVOKED: 'Access to the bank was revoked. Reconnect it, or remove it and connect the bank again.',
};

export interface PlaidDeps {
  db: Db;
  clock: Clock;
  logger: Logger;
  keyring: Keyring;
  fetch: FetchFn;
  config: PlaidConfig;
  /** The app's BASE_URL: the webhook and the OAuth redirect URI are on it. */
  baseUrl: string;
  /** TOKEN_ENCRYPTION_KEY failed the key check: nothing is fetched, linked, or written (spec §14). */
  keyMismatch?: boolean;
  /** For tests: the client's waits between retries, and its clock. */
  clientOptions?: PlaidClientOptions;
  /** For tests: a request's budget instead of PLAID_REQUEST_BUDGET_MS, so an overrun can be real and quick. */
  requestBudgetMs?: number;
}

/**
 * One budget per request that talks to Plaid (the pick, Refresh, Remove, Load accounts, and the
 * Link page's `/exchange` and `/updated`): the lock wait and every Plaid call it makes share it,
 * passed down as an absolute deadline, so the whole request stays well inside nginx's 60-second
 * proxy timeout (under 50 seconds with the answer written). A Plaid call never starts if it can't
 * finish in time (`PlaidPastDeadline`); a sync page that can't leaves the cursor where it was.
 */
export const PLAID_REQUEST_BUDGET_MS = 40_000;

/** One `withItem` call's view of the Item. `deadline` is the request's (epoch ms), for every Plaid call made with it. */
export interface PlaidSession {
  item: PlaidItemRow;
  connection: ConnectionRow;
  accessToken: string;
  client: PlaidClient;
  deadline?: number;
}

/** An Item and its connection's state, for Spend settings and the System page. No credentials. */
export interface PlaidItemView {
  item: PlaidItemRow;
  /** Null once the Item is removed. */
  connection: Pick<ConnectionRow, 'id' | 'status' | 'consecutiveFailures' | 'lastSuccessAt' | 'lastError' | 'lastErrorAt'> | null;
}

/**
 * A link step that didn't happen: `link` is the `?bank_error=` code for Spend settings, the
 * message says what happened in plain words.
 */
export class PlaidLinkRefused extends AppError {
  constructor(readonly link: PlaidLinkError, code: ErrorCode, message: string) {
    super(code, message);
    this.name = 'PlaidLinkRefused';
  }
}

function isPlaidFailure(err: unknown): err is PlaidApiError | PlaidUnavailable | PlaidBadResponse {
  return err instanceof PlaidApiError || err instanceof PlaidUnavailable || err instanceof PlaidBadResponse;
}

/** A Plaid code that means the bank can't be reached through Plaid (now, or for us): its own message. */
function isInstitutionCode(code: string | null | undefined): boolean {
  return !!code && (code.startsWith('INSTITUTION_') || code === 'UNAUTHORIZED_INSTITUTION');
}

/**
 * The error to show for a failed Plaid call outside Link (Refresh, say): an AppError with a plain
 * message. Anything that isn't Plaid's (a bug, a database error) is returned as it is.
 */
/** What a connection that needs signing in again says, pointing at its own panel's settings. */
export function reconnectMessage(purpose: PlaidPurpose = 'spend'): string {
  return purpose === 'savings' ? SAVINGS_MESSAGES.reconnect : PLAID_MESSAGES.reconnect;
}

/** `purpose`: whose settings a "reconnect" refusal sends the admin to (Spend's unless it's a Savings Item). */
export function plaidAppError(err: unknown, purpose: PlaidPurpose = 'spend'): Error {
  if (err instanceof AppError) return err;
  if (err instanceof LockWaitTimeout) return new AppError('integration_unavailable', PLAID_MESSAGES.itemBusy);
  if (err instanceof PlaidPastDeadline) return new AppError('integration_unavailable', PLAID_MESSAGES.outOfTime);
  if (!isPlaidFailure(err)) return err instanceof Error ? err : new Error('Unknown error');
  const code = err instanceof PlaidApiError ? err.errorCode : null;
  switch (classifyPlaidError(err)) {
    case 'trial_limit':
      return new AppError('conflict', PLAID_MESSAGES.trialLimit);
    case 'reconnect':
      return new AppError('integration_unavailable', reconnectMessage(purpose));
    case 'gone':
      return new AppError('integration_unavailable', PLAID_MESSAGES.gone);
    case 'transient':
    case 'mutation':
      if (code?.startsWith('INSTITUTION_')) return new AppError('integration_unavailable', PLAID_MESSAGES.institution);
      if (err instanceof PlaidApiError && (err.status === 429 || err.errorType === 'RATE_LIMIT_EXCEEDED')) return new AppError('integration_unavailable', PLAID_MESSAGES.busy);
      return new AppError('integration_unavailable', PLAID_MESSAGES.unreachable);
    default:
      if (isInstitutionCode(code)) return new AppError('integration_unavailable', PLAID_MESSAGES.institution);
      return new AppError('integration_unavailable', PLAID_MESSAGES.failed);
  }
}

/** A failed link step as a PlaidLinkRefused, with the `?bank_error=` code that fits. */
function linkRefusal(err: unknown): PlaidLinkRefused {
  if (err instanceof PlaidLinkRefused) return err;
  // Out of time, waiting for a sync's lock or for Plaid: trying again in a minute is the fix either way.
  if (err instanceof LockWaitTimeout || err instanceof PlaidPastDeadline) return new PlaidLinkRefused('busy', 'integration_unavailable', PLAID_MESSAGES.itemBusy);
  const code = err instanceof PlaidApiError ? err.errorCode : null;
  const app = plaidAppError(err);
  const message = app instanceof AppError ? app.message : PLAID_MESSAGES.failed;
  if (classifyPlaidError(err) === 'trial_limit') return new PlaidLinkRefused('trial_limit', 'conflict', message);
  if (isInstitutionCode(code)) return new PlaidLinkRefused('institution', 'integration_unavailable', message);
  if (app instanceof AppError) return new PlaidLinkRefused('failed', app.code, message);
  return new PlaidLinkRefused('failed', 'integration_unavailable', PLAID_MESSAGES.failed);
}

/** The `?bank_error=` code for whatever a link step threw. */
export function linkError(err: unknown): PlaidLinkError {
  return linkRefusal(err).link;
}

/** Link's own `onExit` error code (research §3.2), as the Link page reports it, to a `?bank_error=` code. */
function exitError(errorCode: string | null): PlaidLinkError {
  if (errorCode === null) return 'exited';
  if (errorCode === 'TRIAL_CONNECTION_LIMIT') return 'trial_limit';
  if (isInstitutionCode(errorCode)) return 'institution';
  return 'failed';
}

/** Session hashes compared in constant time (the design's "Pending link storage"). */
function sameSession(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function toItemAccount(a: PlaidAccount): PlaidItemAccount {
  return {
    accountId: a.account_id, name: a.name, officialName: a.official_name, mask: a.mask, type: a.type, subtype: a.subtype,
    isoCurrencyCode: a.balances.iso_currency_code, unofficialCurrencyCode: a.balances.unofficial_currency_code,
  };
}

/**
 * A fresh `/accounts/get` list in place of the Item's stored one (after a reconnect, or loading
 * accounts again): `fresh` is what Plaid lists now, then every account the Item had that it no
 * longer lists, kept with `listed: false` (never dropped: their ids are still the Item's, so
 * `itemAccountIds` covers their rows after an account id changes). `listed` counts the first part;
 * `added` counts accounts new to the Item, which wait for the pick.
 */
function reloadedAccounts(item: PlaidItemRow, accounts: PlaidAccount[]): { fresh: PlaidItemAccount[]; listed: number; added: number } {
  const before = new Map((item.accounts ?? []).map((a) => [a.accountId, a]));
  // An account the admin skipped stays skipped: only accounts new to the list wait for the pick.
  const now = accounts.map(toItemAccount).map((a) => (before.get(a.accountId)?.skipped === true ? { ...a, skipped: true } : a));
  const nowIds = new Set(now.map((a) => a.accountId));
  const gone = [...before.values()].filter((a) => !nowIds.has(a.accountId)).map((a): PlaidItemAccount => ({ ...a, listed: false }));
  return { fresh: [...now, ...gone], listed: now.length, added: now.filter((a) => !before.has(a.accountId)).length };
}

/** How many ids go in one `IN (...)`, well under SQLite's limit on bound values. */
const ID_CHUNK = 500;

function chunked<T>(values: readonly T[]): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < values.length; i += ID_CHUNK) out.push(values.slice(i, i + ID_CHUNK));
  return out;
}

/**
 * The Item's Plaid account ids: its stored list (accounts Plaid no longer lists included, so an
 * id from before an account id change is still the Item's), and its cards' attachments.
 * Transactions are the Item's by these: Plaid's account ids belong to one Item, so an earlier
 * Item's rows on the same card have others.
 */
function itemAccountIds(tx: DbOrTx, item: PlaidItemRow): string[] {
  const ids = new Set((item.accounts ?? []).map((a) => a.accountId));
  for (const c of tx.select({ accountId: cards.plaidAccountId }).from(cards).where(eq(cards.plaidItemId, item.id)).all()) {
    if (c.accountId !== null) ids.add(c.accountId);
  }
  return [...ids];
}

/** The live pending rows of these accounts, soft-deleted for the prune: their Item is gone and will never post them. */
function dropPending(tx: DbOrTx, accountIds: readonly string[], now: Date): number {
  let n = 0;
  for (const ids of chunked(accountIds)) {
    n += tx.update(transactions)
      .set({ deletedAt: now, removedAt: now, updatedAt: now })
      .where(and(eq(transactions.source, 'plaid'), eq(transactions.pending, true), isNull(transactions.deletedAt), inArray(transactions.plaidAccountId, ids)))
      .run().changes;
  }
  return n;
}

/**
 * "Delete its transactions": the Item's own rows (the `plaid` rows of its accounts) are
 * hard-deleted, and what they replaced is dealt with first (`restoreReplaced`). Returns how many
 * were deleted, restored, and purged.
 */
function deleteOwnRows(tx: DbOrTx, accountIds: readonly string[], now: Date, env: () => Categorizer): { deleted: number; restored: number; purged: number } {
  const own = chunked(accountIds).flatMap((ids) =>
    tx.select().from(transactions).where(and(eq(transactions.source, 'plaid'), inArray(transactions.plaidAccountId, ids))).all());
  if (own.length === 0) return { deleted: 0, restored: 0, purged: 0 };
  const { restored, purged } = restoreReplaced(tx, own, now, env);
  let deleted = 0;
  for (const ids of chunked(own.map((r) => r.id))) deleted += tx.delete(transactions).where(inArray(transactions.id, ids)).run().changes;
  return { deleted, restored, purged };
}

/** Plaid's facts about a failure, for a log line: never its message or body. */
function failureFacts(err: unknown): Record<string, unknown> {
  if (err instanceof PlaidApiError) return { path: err.path, status: err.status, errorType: err.errorType, errorCode: err.errorCode, requestId: err.requestId };
  if (err instanceof PlaidUnavailable) return { reason: err.reason };
  if (err instanceof PlaidBadResponse) return { path: err.path, reason: 'bad_response' };
  return loggableError(err);
}

/**
 * The family's bank links through Plaid (spec §8, §12.2, §14), like GoogleCalendar for the
 * calendar: one family connection per Item, its credentials (the access token) bound to the row
 * (`insertFamilyConnection`), and the Item's own state in `plaid_items`.
 *
 * - **Linking.** `createLinkToken` asks Plaid for a link token (a new Item, or update mode for one
 *   we have) and saves it in `plaid_link_pending`, bound to the admin and a hash of their session,
 *   for 30 minutes, so the OAuth return page can `resume` with the same token. `exchange` (new),
 *   `completeUpdate` (update mode) and `exit` each claim and delete that row, only for the same
 *   session. Before exchanging, the duplicate check (the design's) refuses the same bank login
 *   twice, since a duplicate costs a Trial connection.
 * - **The Trial counter** (`settings.plaid_items_created`) goes up in its own write the moment the
 *   exchange returns an access token, before anything else can fail, and never down. An exchange
 *   that was sent and timed out counts too (review C-S-M4): Plaid may have made the Item.
 * - **Calls.** Everything that uses an Item's access token goes through `withItem`, under a
 *   per-Item lock keyed by the local `plaid_items.id`. Status follows spec §8 and the design's
 *   "Error states": login problems set `needs_reconnect`; an Item Plaid no longer has does too,
 *   with a message saying to remove it; transient failures count toward `error` (3 in a row) and set
 *   `backoff_until`; a success sets `ok` and clears the backoff. Calls beside the sync
 *   (`sideCall`: liabilities, loading accounts) only ever record a login problem or a gone Item. A
 *   failure is recorded only if the connection still holds the credentials the call used.
 *   `KeyedLock` refuses re-entry, so code running inside `withItem` must not call another locked
 *   method for the same Item.
 * - **Removing** revokes first (`/item/remove`), then deletes the connection and marks the Item and
 *   its cards removed in one transaction, with what happens to its transactions (see `remove`). A
 *   revocation Plaid didn't confirm waits in `pending_revocations` for `retryRevocations`, which
 *   gives up after 12 tries with a notice naming the bank.
 * - **A key mismatch** refuses everything that would read or write credentials; `forgetForNewKey`
 *   is the way out (the design's departure 10).
 *
 * Logs carry ids, counts and Plaid's error codes, never a token, a body, or an account's name.
 */
export class Plaid {
  readonly client: PlaidClient;
  readonly verifier: PlaidWebhookVerifier;
  private readonly lock = new KeyedLock<number>();
  private keyMismatchNow: boolean;

  constructor(private readonly deps: PlaidDeps) {
    this.client = new PlaidClient(deps.config, deps.fetch, deps.clientOptions);
    this.verifier = new PlaidWebhookVerifier({ client: this.client, clock: deps.clock });
    this.keyMismatchNow = deps.keyMismatch === true;
  }

  get keyMismatch(): boolean {
    return this.keyMismatchNow;
  }

  /** After the reset stored a check for the new key. */
  clearKeyMismatch(): void {
    this.keyMismatchNow = false;
  }

  get config(): PlaidConfig {
    return this.deps.config;
  }

  /** A new request's deadline (epoch ms, the real clock): now plus its budget (PLAID_REQUEST_BUDGET_MS). */
  requestDeadline(): number {
    return Date.now() + (this.deps.requestBudgetMs ?? PLAID_REQUEST_BUDGET_MS);
  }

  /** Items this install has had Plaid create, removed ones included (the Trial count). */
  trialCount(): number {
    return getPlaidItemsCreated(this.deps.db);
  }

  item(itemId: number): PlaidItemRow | undefined {
    return this.deps.db.select().from(plaidItems).where(eq(plaidItems.id, itemId)).get();
  }

  /** The local Item for a webhook's `item_id`. */
  itemByPlaidId(plaidItemId: string): PlaidItemRow | undefined {
    return this.deps.db.select().from(plaidItems).where(eq(plaidItems.plaidItemId, plaidItemId)).get();
  }

  /** Every Item, removed ones included, oldest first, with its connection's state. */
  items(): PlaidItemView[] {
    return this.deps.db
      .select({
        item: plaidItems,
        connection: {
          id: connections.id, status: connections.status, consecutiveFailures: connections.consecutiveFailures,
          lastSuccessAt: connections.lastSuccessAt, lastError: connections.lastError, lastErrorAt: connections.lastErrorAt,
        },
      })
      .from(plaidItems)
      .leftJoin(connections, eq(connections.id, plaidItems.connectionId))
      .orderBy(asc(plaidItems.id))
      .all();
  }

  // ---- Linking (spec §12.2, research §2 to §4).

  /**
   * A link token for a new Item, or, with `itemId`, update mode for that Item (`addAccounts` adds
   * Account Select, for the new-accounts notice). `purpose` says which panel a new Item is for
   * (Spend's cards by default, or Savings' cash and investment accounts); in update mode the Item's
   * own purpose decides. Saved, with the purpose, as the admin's pending link for this session,
   * replacing any earlier one. Never retried, but for the Savings link's one retry without
   * Investments (`requestLinkToken`): the admin can click again.
   */
  async createLinkToken(
    userId: number,
    sessionHash: string,
    opts: { itemId?: number; addAccounts?: boolean; purpose?: PlaidPurpose },
  ): Promise<{ linkToken: string; mode: 'new' | 'update'; itemId: number | null; purpose: PlaidPurpose }> {
    this.refuseKeyMismatch();
    const base = {
      client_name: PLAID_CLIENT_NAME,
      language: 'en',
      country_codes: ['US'],
      user: { client_user_id: getPlaidClientUserId(this.deps.db) },
      redirect_uri: new URL('/connect/plaid/oauth-return', this.deps.baseUrl).href,
    };
    let req: LinkTokenCreateRequest;
    const itemId = opts.itemId ?? null;
    const addAccounts = itemId !== null && opts.addAccounts === true;
    let purpose: PlaidPurpose = opts.purpose ?? 'spend';
    if (itemId !== null) {
      let s: PlaidSession;
      try {
        s = this.open(itemId, true);
      } catch (err) {
        throw linkRefusal(err);
      }
      // An update-mode link is for its Item's panel, whatever the page asked.
      purpose = s.item.purpose;
      const filters = purpose === 'savings' ? SAVINGS_ACCOUNTS : CREDIT_CARDS_ONLY;
      // Update mode leaves out products and their settings, and the webhook (research §2.4).
      req = { ...base, access_token: s.accessToken, ...(addAccounts ? { update: { account_selection_enabled: true }, account_filters: filters } : {}) };
    } else if (purpose === 'savings') {
      // No `transactions.days_requested`: Plaid's default history (decision 2).
      req = {
        ...base,
        products: [...SAVINGS_LINK_PRODUCTS.products],
        required_if_supported_products: [...SAVINGS_LINK_PRODUCTS.required_if_supported_products],
        account_filters: SAVINGS_ACCOUNTS,
        webhook: new URL('/webhooks/plaid', this.deps.baseUrl).href,
      };
    } else {
      req = {
        ...base,
        products: ['transactions'],
        required_if_supported_products: ['liabilities'],
        transactions: { days_requested: DAYS_REQUESTED },
        account_filters: CREDIT_CARDS_ONLY,
        webhook: new URL('/webhooks/plaid', this.deps.baseUrl).href,
      };
    }
    const mode = itemId === null ? 'new' : 'update';
    const linkToken = await this.requestLinkToken(userId, mode, itemId, purpose, req);
    const now = this.deps.clock.now();
    const values = {
      sessionHash, linkToken, mode, plaidItemId: itemId, addAccounts, purpose, createdAt: now, expiresAt: new Date(now.getTime() + PENDING_LINK_TTL_MS),
    } as const;
    this.deps.db.insert(plaidLinkPending).values({ userId, ...values }).onConflictDoUpdate({ target: plaidLinkPending.userId, set: values }).run();
    this.deps.logger.info({ userId, mode, itemId, addAccounts, purpose }, 'plaid link started');
    return { linkToken, mode, itemId, purpose };
  }

  /**
   * `/link/token/create`, never retried, except once for a new Savings link that Plaid refused with
   * `INVALID_PRODUCT` (Investments isn't enabled for this client): asked again without
   * `required_if_supported_products`, so linking still works and the brokerage shows the fallback (decision 2).
   */
  private async requestLinkToken(userId: number, mode: 'new' | 'update', itemId: number | null, purpose: PlaidPurpose, req: LinkTokenCreateRequest): Promise<string> {
    try {
      return (await this.client.createLinkToken(req)).linkToken;
    } catch (err) {
      const withoutInvestments = purpose === 'savings' && mode === 'new' && err instanceof PlaidApiError && err.errorCode === 'INVALID_PRODUCT';
      if (!withoutInvestments) {
        this.deps.logger.warn({ userId, mode, itemId, purpose, ...failureFacts(err) }, 'plaid link token refused');
        throw linkRefusal(err);
      }
      this.deps.logger.warn({ userId, purpose, errorCode: 'INVALID_PRODUCT' }, 'plaid link token refused with investments; asking without it');
      const { required_if_supported_products: _investments, ...without } = req;
      try {
        return (await this.client.createLinkToken(without)).linkToken;
      } catch (again) {
        this.deps.logger.warn({ userId, mode, itemId, purpose, ...failureFacts(again) }, 'plaid link token refused');
        throw linkRefusal(again);
      }
    }
  }

  /** The OAuth return page opens Link again with the same token (research §3.4): only in the same session, before it expires. */
  resume(userId: number, sessionHash: string): { linkToken: string; mode: 'new' | 'update'; itemId: number | null; purpose: PlaidPurpose } {
    const row = this.pendingRow(userId, sessionHash);
    if (!row || row.expiresAt.getTime() <= this.deps.clock.now().getTime()) throw this.expired();
    return { linkToken: row.linkToken, mode: row.mode, itemId: row.plaidItemId, purpose: row.purpose };
  }

  /** The panel the admin's pending link is for, so a refusal can send them back to the right settings. Spend without one. */
  pendingPurpose(userId: number, sessionHash: string): PlaidPurpose {
    return this.pendingRow(userId, sessionHash)?.purpose ?? 'spend';
  }

  /**
   * Link's `onSuccess` for a new Item: the duplicate check, the exchange, the Trial counter, then
   * the connection and the `plaid_items` row (in one transaction), and `/item/get` and
   * `/accounts/get` for the bank's name, the consent date, and the accounts to pick from. The Item
   * isn't synced until the admin picks (the design's departure 2). If storing it fails, or
   * `/item/get` or `/accounts/get` fails for any reason but a passing one, the Item is removed at
   * Plaid, or its revocation queued, and nothing else is kept: the Trial connection is used either
   * way. A passing failure (`transient`: Plaid or the bank briefly down) keeps the Item, with
   * `accounts` null and whatever `/item/get` gave; `accountsLoaded: false` says so, and
   * `loadAccounts` fetches them later. Undoing a paid-for Item over a blip would cost another
   * Trial connection to fix. `opts.deadline` (epoch ms) is the request's: every Plaid call here
   * fits inside it, and one that can't (`PlaidPastDeadline`) counts as a passing failure.
   */
  async exchange(
    userId: number,
    sessionHash: string,
    publicToken: string,
    metadata: PlaidLinkMetadata,
    opts: { deadline?: number } = {},
  ): Promise<{ itemId: number; accountsLoaded: boolean; purpose: PlaidPurpose }> {
    const { deadline } = opts;
    this.refuseKeyMismatch();
    const pending = this.claimPending(userId, sessionHash, 'new');
    const purpose = pending.purpose;
    const duplicate = this.findDuplicate(metadata);
    if (duplicate) {
      this.deps.logger.warn({ userId, duplicateOf: duplicate.id }, 'plaid link refused: a duplicate');
      throw new PlaidLinkRefused('duplicate', 'conflict', PLAID_MESSAGES.duplicate(duplicate.institutionName ?? metadata.institution?.name ?? 'another bank'));
    }
    let exchanged: { accessToken: string; itemId: string };
    try {
      exchanged = await this.client.exchangePublicToken(publicToken, { deadline });
    } catch (err) {
      // Sent, and its answer never came (its own timeout, or the request's deadline): Plaid may have
      // made the Item, which uses a Trial connection. Counting it is the safe side (review C-S-M4).
      if ((err instanceof PlaidPastDeadline && err.sent) || (err instanceof PlaidUnavailable && err.reason === 'timeout')) {
        notePlaidItemCreated(this.deps.db);
        this.deps.logger.warn({ userId, ...failureFacts(err), trialCount: this.trialCount() }, 'plaid exchange may have finished; counted against the Trial');
        throw new PlaidLinkRefused('maybe_connected', 'integration_unavailable', PLAID_LINK_ERRORS.maybe_connected);
      }
      this.deps.logger.warn({ userId, ...failureFacts(err) }, 'plaid exchange failed');
      throw linkRefusal(err);
    }
    notePlaidItemCreated(this.deps.db);

    const now = this.deps.clock.now();
    const institutionName = metadata.institution?.name ?? null;
    let item: PlaidItemRow;
    try {
      item = this.deps.db.transaction((tx) => {
        const meta: PlaidConnectionMeta = { itemId: exchanged.itemId, institutionName };
        const conn = insertFamilyConnection(tx, this.deps.keyring, { kind: 'plaid', ownerUserId: userId, meta: { ...meta }, now }, { accessToken: exchanged.accessToken });
        return tx.insert(plaidItems).values({
          connectionId: conn.id, plaidItemId: exchanged.itemId, institutionId: metadata.institution?.institution_id ?? null, institutionName, purpose, createdAt: now, updatedAt: now,
        }).returning().get();
      });
    } catch (err) {
      await this.undoExchange(userId, exchanged, null, err, deadline);
      throw linkRefusal(new AppError('integration_unavailable', PLAID_MESSAGES.failed));
    }

    return this.lock.run(item.id, async () => {
      let got: PlaidItem | null = null;
      try {
        got = await this.client.getItem(exchanged.accessToken, { deadline });
        const { accounts, skipped } = await this.client.getAccounts(exchanged.accessToken, { deadline });
        this.storeItemFacts(item, exchanged.itemId, got, accounts.map(toItemAccount));
        this.deps.logger.info(
          { userId, itemId: item.id, purpose, institutionId: got.institution_id, accounts: accounts.length, skipped, trialCount: this.trialCount() },
          'plaid exchange done; the item waits for the pick',
        );
        return { itemId: item.id, accountsLoaded: true, purpose };
      } catch (err) {
        if (classifyPlaidError(err) === 'transient') {
          // The Item is real and paid for: keep it, with what /item/get gave if it answered, and
          // its accounts to load later (`loadAccounts`). The pick waits until they're loaded.
          try {
            if (got) this.storeItemFacts(item, exchanged.itemId, got, null);
            this.deps.logger.warn(
              { userId, itemId: item.id, ...failureFacts(err), itemLoaded: got !== null, trialCount: this.trialCount() },
              "plaid exchange done, but the bank's details couldn't be fetched yet; the item waits for them",
            );
            return { itemId: item.id, accountsLoaded: false, purpose };
          } catch (dbErr) {
            err = dbErr;
          }
        }
        await this.undoExchange(userId, exchanged, item, err, deadline);
        throw new PlaidLinkRefused('failed', 'integration_unavailable', PLAID_MESSAGES.failed);
      }
    }, { deadline });
  }

  /**
   * What `/item/get` said, and the accounts when `/accounts/get` gave them (null keeps whatever is
   * stored), on the Item and its connection's `meta`, in one transaction.
   */
  private storeItemFacts(item: PlaidItemRow, plaidItemId: string, got: PlaidItem, accounts: PlaidItemAccount[] | null): void {
    const updatedAt = this.deps.clock.now();
    const institutionName = got.institution_name ?? item.institutionName;
    this.deps.db.transaction((tx) => {
      tx.update(plaidItems)
        .set({
          institutionId: got.institution_id ?? item.institutionId, institutionName, consentExpirationTime: got.consent_expiration_time,
          ...(accounts ? { accounts } : {}), updatedAt,
        })
        .where(eq(plaidItems.id, item.id))
        .run();
      const meta: PlaidConnectionMeta = { itemId: plaidItemId, institutionName };
      if (item.connectionId !== null) tx.update(connections).set({ meta: { ...meta }, updatedAt }).where(eq(connections.id, item.connectionId)).run();
    });
  }

  /**
   * Something failed after the exchange: the access token is revoked (or its revocation queued, in
   * the same transaction that deletes what was stored), so no Item is left at Plaid that nothing
   * here knows about.
   */
  private async undoExchange(
    userId: number,
    exchanged: { accessToken: string; itemId: string },
    item: PlaidItemRow | null,
    cause: unknown,
    deadline: number | undefined,
  ): Promise<void> {
    // Past the request's deadline the revocation is queued, and the hourly job tries it.
    const failure = await this.revoke(exchanged.accessToken, deadline);
    const now = this.deps.clock.now();
    this.deps.db.transaction((tx) => {
      if (failure !== null) this.queueRevocation(tx, userId, exchanged.itemId, exchanged.accessToken, now);
      if (item) {
        // savings_accounts doesn't cascade from plaid_items: its rows go first (none are made before the pick).
        deleteSavingsData(tx, item.id);
        tx.delete(plaidItems).where(eq(plaidItems.id, item.id)).run();
        if (item.connectionId !== null) tx.delete(connections).where(eq(connections.id, item.connectionId)).run();
      }
    });
    this.deps.logger.error({ userId, ...failureFacts(cause), revoked: failure === null }, 'plaid exchange undone after a failure');
  }

  /**
   * Plaid's test for a duplicate Item (research §4.1, the design's "The duplicate check"): an Item
   * that isn't removed, at the same institution, with an account of the same name and mask as one
   * Link returned. A different login at the same bank has other accounts, so it's allowed.
   */
  private findDuplicate(metadata: PlaidLinkMetadata): PlaidItemRow | undefined {
    const institutionId = metadata.institution?.institution_id;
    if (!institutionId) return undefined;
    const candidates = this.deps.db.select().from(plaidItems)
      .where(and(eq(plaidItems.institutionId, institutionId), isNull(plaidItems.removedAt)))
      .all();
    return candidates.find((item) => (item.accounts ?? []).some((have) => metadata.accounts.some((got) => got.name === have.name && got.mask === have.mask)));
  }

  /**
   * Link's `onSuccess` in update mode: no exchange (the access token doesn't change, research
   * §2.4), so no new Trial connection. `/item/get` and `/accounts/get` refresh the consent date and
   * the account list; success sets the status `ok`. A new account in the list waits for the pick,
   * which pauses syncing until the admin decides it (departure 2); an account no longer listed
   * keeps its card and history, and stays on the list as `listed: false` (`reloadedAccounts`).
   * The new-accounts notice, the disconnect date and the backoff are cleared.
   * `opts.deadline` (epoch ms) bounds the wait for the Item's lock: past it (a sync is running),
   * it's refused as `busy`, "That bank is busy syncing", as it is when Plaid's reads don't fit in
   * what's left of it. The pending link is claimed only once the lock is held and Plaid has
   * answered, so after `busy` it's still there and trying again in a minute works.
   */
  async completeUpdate(userId: number, sessionHash: string, opts: { deadline?: number } = {}): Promise<{ itemId: number; newAccounts: number }> {
    this.refuseKeyMismatch();
    const pending = this.pendingRow(userId, sessionHash);
    if (!pending || pending.mode !== 'update' || pending.plaidItemId === null) throw this.expired();
    const itemId = pending.plaidItemId;
    try {
      return await this.withItem(itemId, async (s) => {
        // Plaid's reads first: they're safe to repeat, so if they don't fit in the request, the
        // pending link is still there to try again with.
        const got = await s.client.getItem(s.accessToken, { deadline: s.deadline });
        const { accounts, skipped } = await s.client.getAccounts(s.accessToken, { deadline: s.deadline });
        this.claimPending(userId, sessionHash, 'update', pending.linkToken);
        const { fresh, listed, added } = reloadedAccounts(s.item, accounts);
        this.deps.db.update(plaidItems)
          .set({
            institutionId: got.institution_id ?? s.item.institutionId, institutionName: got.institution_name ?? s.item.institutionName,
            consentExpirationTime: got.consent_expiration_time, accounts: fresh, newAccountsAt: null, disconnectAt: null, backoffUntil: null,
            pickedAt: added > 0 ? null : s.item.pickedAt, updatedAt: this.deps.clock.now(),
          })
          .where(eq(plaidItems.id, itemId))
          .run();
        // Fixed: the old error no longer describes the connection (the success itself is recorded by withItem).
        this.deps.db.update(connections)
          .set({ lastError: null, lastErrorAt: null })
          .where(and(eq(connections.id, s.connection.id), eq(connections.credentialsEnc, s.connection.credentialsEnc)))
          .run();
        this.deps.logger.info({ userId, itemId, accounts: listed, unlisted: fresh.length - listed, newAccounts: added, skipped }, 'plaid item reconnected');
        return { itemId, newAccounts: added };
      }, { allowNeedsReconnect: true, deadline: opts.deadline });
    } catch (err) {
      throw linkRefusal(err);
    }
  }

  /**
   * `/item/get` and `/accounts/get` again, under the Item's lock (`opts.deadline` bounds the wait),
   * storing what they say: for an Item whose accounts couldn't be fetched after the exchange (it
   * can't be picked until they're loaded), and for transactions on an account the Item's list
   * doesn't have (Task 6 sets `new_accounts_at` for those). As after a reconnect, an account new to
   * the list waits for the pick, and finding one clears the new-accounts notice. A call beside the
   * sync (`sideCall`): its success says nothing about syncing, so it doesn't touch the status.
   * Plaid's failures come back as `plaidAppError` makes them.
   */
  async loadAccounts(userId: number, itemId: number, opts: { deadline?: number } = {}): Promise<{ accounts: number; newAccounts: number }> {
    try {
      return await this.withItem(itemId, async (s) => {
        const got = await s.client.getItem(s.accessToken, { deadline: s.deadline });
        const { accounts, skipped } = await s.client.getAccounts(s.accessToken, { deadline: s.deadline });
        const { fresh, listed, added } = reloadedAccounts(s.item, accounts);
        this.deps.db.update(plaidItems)
          .set({
            institutionId: got.institution_id ?? s.item.institutionId, institutionName: got.institution_name ?? s.item.institutionName,
            consentExpirationTime: got.consent_expiration_time, accounts: fresh,
            pickedAt: added > 0 ? null : s.item.pickedAt, newAccountsAt: added > 0 ? null : s.item.newAccountsAt, updatedAt: this.deps.clock.now(),
          })
          .where(eq(plaidItems.id, itemId))
          .run();
        this.deps.logger.info({ userId, itemId, accounts: listed, unlisted: fresh.length - listed, newAccounts: added, skipped }, 'plaid accounts loaded');
        return { accounts: listed, newAccounts: added };
      }, { deadline: opts.deadline, sideCall: true });
    } catch (err) {
      throw plaidAppError(err, this.item(itemId)?.purpose);
    }
  }

  /**
   * Link's `onExit`: the admin closed Link, or it failed. Deletes the pending link, only for this
   * session. `errorCode` is Link's, from the browser; only something shaped like a Plaid code is logged.
   */
  exit(userId: number, sessionHash: string, errorCode: string | null): { itemId: number | null; error: PlaidLinkError; purpose: PlaidPurpose } {
    const code = errorCode !== null && /^[A-Z0-9_]{1,64}$/.test(errorCode) ? errorCode : errorCode === null ? null : 'UNKNOWN';
    const row = this.pendingRow(userId, sessionHash);
    if (!row) return { itemId: null, error: 'expired', purpose: 'spend' };
    this.deps.db.delete(plaidLinkPending).where(and(eq(plaidLinkPending.userId, userId), eq(plaidLinkPending.linkToken, row.linkToken))).run();
    this.deps.logger.info({ userId, mode: row.mode, itemId: row.plaidItemId, purpose: row.purpose, errorCode: code }, 'plaid link exited');
    return { itemId: row.plaidItemId, error: exitError(code), purpose: row.purpose };
  }

  /** Deletes pending links nobody finished (the `spend.pruneRemoved` job). */
  prunePending(): number {
    return this.deps.db.delete(plaidLinkPending).where(lte(plaidLinkPending.expiresAt, this.deps.clock.now())).run().changes;
  }

  private pendingRow(userId: number, sessionHash: string): PlaidLinkPendingRow | null {
    const row = this.deps.db.select().from(plaidLinkPending).where(eq(plaidLinkPending.userId, userId)).get();
    return row && sameSession(row.sessionHash, sessionHash) ? row : null;
  }

  /**
   * Takes the admin's pending link for this session, deleting it in the same statement that checks
   * it's still this one, of this mode, and not expired, so two requests can't both use it. Another
   * session's, or the wrong mode: refused, and the row is left for its own call. An expired one is
   * refused and deleted, since nothing can use it. With `linkToken`, only that pending link is
   * claimed (one started since in another tab is left alone).
   */
  private claimPending(userId: number, sessionHash: string, mode: 'new' | 'update', linkToken?: string): PlaidLinkPendingRow {
    const row = this.pendingRow(userId, sessionHash);
    if (!row || (linkToken !== undefined && row.linkToken !== linkToken)) throw this.expired();
    const now = this.deps.clock.now();
    const same = and(eq(plaidLinkPending.userId, userId), eq(plaidLinkPending.linkToken, row.linkToken));
    const claimed = this.deps.db.delete(plaidLinkPending)
      .where(and(same, eq(plaidLinkPending.mode, mode), gt(plaidLinkPending.expiresAt, now)))
      .run().changes === 1;
    if (claimed) return row;
    this.deps.db.delete(plaidLinkPending).where(and(same, lte(plaidLinkPending.expiresAt, now))).run();
    throw this.expired();
  }

  private expired(): PlaidLinkRefused {
    return new PlaidLinkRefused('expired', 'not_found', PLAID_MESSAGES.linkExpired);
  }

  private refuseKeyMismatch(): void {
    if (this.keyMismatchNow) throw new PlaidLinkRefused('key_mismatch', 'integration_unavailable', PLAID_MESSAGES.keyMismatch);
  }

  // ---- Calls and status (spec §8, §14).

  /**
   * Runs `fn` with the Item's access token, under the Item's lock (`opts.deadline`, epoch ms on the
   * real clock, bounds the wait, and is `s.deadline` for every Plaid call `fn` makes). Plaid failures are recorded on the connection (see the class
   * comment) and rethrown as they are, so the caller can tell a mutation from a login problem;
   * `plaidAppError` turns one into what people see. Anything else `fn` throws is rethrown and not
   * recorded. An Item that needs reconnecting is refused without asking Plaid, unless
   * `allowNeedsReconnect` (update mode's completion).
   *
   * `sideCall` is for calls beside the sync (`/liabilities/get`, loading accounts again): what the
   * connection's status and "Updated X ago" say is whether transactions sync, so their success
   * doesn't count (only a sync, or a reconnect, sets `ok` and resets the failure count), and their
   * passing failures neither count nor set the backoff. A login problem, or an Item Plaid no longer
   * has, still sets `needs_reconnect`: that's true of the whole connection.
   */
  withItem<T>(
    itemId: number,
    fn: (s: PlaidSession) => Promise<T>,
    opts: { deadline?: number; allowNeedsReconnect?: boolean; sideCall?: boolean } = {},
  ): Promise<T> {
    if (this.keyMismatchNow) return Promise.reject(new AppError('integration_unavailable', PLAID_MESSAGES.keyMismatch));
    const sideCall = opts.sideCall === true;
    return this.lock.run(itemId, async () => {
      const s: PlaidSession = { ...this.open(itemId, opts.allowNeedsReconnect === true), deadline: opts.deadline };
      const openedStatus = s.connection.status;
      let result: T;
      try {
        result = await fn(s);
      } catch (err) {
        if (isPlaidFailure(err)) this.recordFailure(s, err, sideCall);
        throw err;
      }
      if (!sideCall) this.recordSuccess(s, openedStatus);
      return result;
    }, { deadline: opts.deadline });
  }

  /**
   * Runs `fn` under the Item's lock without opening its credentials or recording anything on the
   * connection: for writes to the Item's own state that mustn't interleave with a sync run (Spend
   * settings' pick, which can ask for a full resync). Like `withItem`, it can't be nested for one Item.
   * Refused under a key mismatch, like every other change to a bank, until the key is fixed or the
   * System page's reset forgets the banks.
   */
  underLock<T>(itemId: number, fn: () => T | Promise<T>, opts: { deadline?: number } = {}): Promise<T> {
    if (this.keyMismatchNow) return Promise.reject(new AppError('integration_unavailable', PLAID_MESSAGES.keyMismatch));
    return this.lock.run(itemId, async () => fn(), opts);
  }

  /**
   * The Item, its connection, and the decrypted access token. Credentials that won't decrypt with
   * the right key were damaged or moved: that's recorded as needing a new link (spec §14).
   */
  private open(itemId: number, allowNeedsReconnect: boolean): PlaidSession {
    if (this.keyMismatchNow) throw new AppError('integration_unavailable', PLAID_MESSAGES.keyMismatch);
    const item = this.item(itemId);
    const conn = item && item.removedAt === null && item.connectionId !== null
      ? this.deps.db.select().from(connections).where(eq(connections.id, item.connectionId)).get()
      : undefined;
    if (!item || !conn) throw new AppError('not_found', PLAID_MESSAGES.notFound);
    if (conn.status === 'needs_reconnect' && !allowNeedsReconnect) {
      const gone = conn.lastError === PLAID_MESSAGES.gone || conn.lastError === PLAID_MESSAGES.unreadable;
      throw new AppError('integration_unavailable', gone ? (conn.lastError as string) : reconnectMessage(item.purpose));
    }
    try {
      return { item, connection: conn, accessToken: CredentialsSchema.parse(decryptCredentials(this.deps.keyring, conn)).accessToken, client: this.client };
    } catch (err) {
      // Only the error's name: a JSON or zod message could quote the decrypted text.
      this.deps.logger.error({ itemId, error: err instanceof Error ? err.name : 'unknown' }, "plaid credentials couldn't be read");
      recordConnectionFailure(this.deps.db, conn, this.deps.clock.now(), PLAID_MESSAGES.unreadable, true);
      throw new AppError('integration_unavailable', PLAID_MESSAGES.unreadable);
    }
  }

  /** The connection, if it still holds the credentials `s` was opened with and the Item isn't removed. */
  private current(s: PlaidSession): ConnectionRow | undefined {
    const conn = this.deps.db.select().from(connections).where(eq(connections.id, s.connection.id)).get();
    if (!conn || conn.credentialsEnc !== s.connection.credentialsEnc || this.item(s.item.id)?.removedAt !== null) return undefined;
    return conn;
  }

  /** Any success sets `ok` and clears the backoff, unless a webhook set `needs_reconnect` while the call was out. */
  private recordSuccess(s: PlaidSession, openedStatus: ConnectionRow['status']): void {
    const conn = this.current(s);
    if (!conn) return;
    if (conn.status === 'needs_reconnect' && openedStatus !== 'needs_reconnect') return;
    const now = this.deps.clock.now();
    recordConnectionSuccess(this.deps.db, conn.id, now);
    this.deps.db.update(plaidItems).set({ backoffUntil: null }).where(eq(plaidItems.id, s.item.id)).run();
  }

  private recordFailure(s: PlaidSession, err: PlaidApiError | PlaidUnavailable | PlaidBadResponse, sideCall: boolean): void {
    const kind = classifyPlaidError(err);
    this.deps.logger.warn({ itemId: s.item.id, kind, sideCall, ...failureFacts(err) }, 'plaid request failed');
    if (sideCall && kind !== 'reconnect' && kind !== 'gone') return;
    const conn = this.current(s);
    if (!conn) return;
    const now = this.deps.clock.now();
    const code = err instanceof PlaidApiError ? err.errorCode : null;
    switch (kind) {
      case 'reconnect':
        recordConnectionFailure(this.deps.db, conn, now, RECONNECT_ERRORS[code ?? ''] ?? RECONNECT_ERRORS.ITEM_LOGIN_REQUIRED!, true);
        return;
      case 'gone':
        recordConnectionFailure(this.deps.db, conn, now, PLAID_MESSAGES.gone, true);
        return;
      case 'transient':
      case 'mutation': {
        const limited = err instanceof PlaidApiError && (err.status === 429 || err.errorType === 'RATE_LIMIT_EXCEEDED');
        recordConnectionFailure(this.deps.db, conn, now, limited ? 'Plaid was limiting requests.' : "Couldn't reach Plaid or the bank.", false);
        // The count just recorded: 5 minutes after the first, doubling, at most an hour.
        const failures = conn.consecutiveFailures + 1;
        const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_FIRST_MS * 2 ** Math.min(failures - 1, 20));
        this.deps.db.update(plaidItems).set({ backoffUntil: new Date(now.getTime() + wait) }).where(eq(plaidItems.id, s.item.id)).run();
        return;
      }
      default:
        recordConnectionFailure(
          this.deps.db, conn, now,
          err instanceof PlaidBadResponse ? "Plaid's answer wasn't in the expected format." : `Plaid refused a request${code ? ` (${code})` : ''}.`,
          false,
        );
    }
  }

  // ---- What webhooks report (Task 7's dispatch). Plain writes, not under the lock; a removed Item is left alone.

  /** `ITEM` `ERROR` or `USER_PERMISSION_REVOKED`: the admin needs to reconnect. */
  markNeedsReconnect(itemId: number, errorCode: string | null): void {
    const conn = this.liveConnection(itemId);
    if (!conn) return;
    recordConnectionFailure(this.deps.db, conn, this.deps.clock.now(), RECONNECT_ERRORS[errorCode ?? ''] ?? RECONNECT_ERRORS.ITEM_LOGIN_REQUIRED!, true);
  }

  /** `LOGIN_REPAIRED`: fixed without update mode. `last_success_at` doesn't move: nothing was fetched yet. */
  clearReconnect(itemId: number): void {
    const conn = this.liveConnection(itemId);
    if (!conn || conn.status !== 'needs_reconnect') return;
    this.deps.db.update(connections).set({ status: 'ok', consecutiveFailures: 0, updatedAt: this.deps.clock.now() }).where(eq(connections.id, conn.id)).run();
  }

  /** `NEW_ACCOUNTS_AVAILABLE`: Spend settings offers "Add accounts" until a reconnect clears it. */
  noteNewAccounts(itemId: number): void {
    this.setItem(itemId, { newAccountsAt: this.deps.clock.now() });
  }

  /** `PENDING_DISCONNECT`'s `disconnect_time`: "Reconnect before" that date. */
  noteDisconnectAt(itemId: number, disconnectTime: string | null): void {
    this.setItem(itemId, { disconnectAt: disconnectTime });
  }

  /** `CONSENT_UPDATED`'s `consent_expiration_time`. */
  setConsentExpiration(itemId: number, value: string | null): void {
    this.setItem(itemId, { consentExpirationTime: value });
  }

  /** The last webhook's code, for an admin reading the database. */
  setLastWebhookCode(itemId: number, code: string): void {
    this.setItem(itemId, { lastWebhookCode: code });
  }

  private setItem(itemId: number, values: Partial<Pick<PlaidItemRow, 'newAccountsAt' | 'disconnectAt' | 'consentExpirationTime' | 'lastWebhookCode'>>): void {
    this.deps.db.update(plaidItems).set({ ...values, updatedAt: this.deps.clock.now() }).where(and(eq(plaidItems.id, itemId), isNull(plaidItems.removedAt))).run();
  }

  private liveConnection(itemId: number): ConnectionRow | undefined {
    const item = this.item(itemId);
    if (!item || item.removedAt !== null || item.connectionId === null) return undefined;
    return this.deps.db.select().from(connections).where(eq(connections.id, item.connectionId)).get();
  }

  // ---- Removing (spec §12.2, the design's departure 9).

  /**
   * Removes a bank, under its lock (`opts.deadline`, epoch ms, bounds the wait: past it, a sync
   * holds the lock and it's refused with "That bank is busy syncing"): `/item/remove` first, best
   * effort (an Item Plaid already doesn't have counts as done), then one transaction deletes the
   * connection and any pending link for it, marks the Item and its cards removed, and keeps a
   * revocation Plaid didn't confirm for `retryRevocations`. The cards stay. What happens to the
   * Item's transactions (its own rows are the `plaid` rows of its accounts, wherever they are, so
   * an earlier, removed Item's rows on the same card are never touched):
   * - kept (`removed`): they stay, except its pending rows, which it will never post now: they're
   *   soft-deleted with `removed_at`, so the prune takes them.
   * - `deleteTransactions` (`removed_with_transactions`, the design's decision 9 as the owner
   *   settled it): its rows are hard-deleted, and what they had replaced comes back (see
   *   `restoreReplaced`).
   * A Savings connection's accounts are deleted with their balances and flows (`deleteTransactions`),
   * or kept and marked removed.
   * Refused with a mismatched key: the token couldn't be read to revoke it (`forgetForNewKey` is
   * for that).
   */
  remove(
    userId: number,
    itemId: number,
    opts: { deleteTransactions: boolean; deadline?: number },
  ): Promise<{ revoked: boolean; revocation: RemovalRevocation; deletedTransactions: number; restoredTransactions: number }> {
    if (this.keyMismatchNow) return Promise.reject(new AppError('integration_unavailable', PLAID_MESSAGES.keyMismatch));
    return this.lock.run(itemId, async () => {
      const item = this.item(itemId);
      if (!item || item.removedAt !== null) throw new AppError('not_found', PLAID_MESSAGES.notFound);
      const conn = item.connectionId === null ? undefined : this.deps.db.select().from(connections).where(eq(connections.id, item.connectionId)).get();
      let token: string | null = null;
      if (conn) {
        try {
          token = CredentialsSchema.parse(decryptCredentials(this.deps.keyring, conn)).accessToken;
        } catch (err) {
          this.deps.logger.warn({ itemId, error: err instanceof Error ? err.name : 'unknown' }, "plaid credentials couldn't be read to remove the item");
        }
      }
      // In what's left of the request; past it, the revocation is queued for the hourly retries.
      const failure = token === null ? null : await this.revoke(token, opts.deadline);
      const now = this.deps.clock.now();
      const counts = this.deps.db.transaction((tx) => {
        if (token !== null && failure !== null) this.queueRevocation(tx, userId, item.plaidItemId, token, now);
        // A token that can't be read can't be revoked, now or later: the lasting notice (given up
        // at once, nothing kept) tells the admin to end it at the bank or at my.plaid.com.
        if (conn && token === null) {
          tx.insert(pendingRevocations)
            .values({
              kind: 'plaid', ownerUserId: userId, accountId: item.plaidItemId, accountEmail: null, credentialsEnc: '',
              lastError: "The saved token couldn't be read.", lastAttemptAt: now, gaveUpAt: now, createdAt: now,
            })
            .run();
        }
        if (conn) tx.delete(connections).where(eq(connections.id, conn.id)).run();
        const accountIds = itemAccountIds(tx, item);
        tx.update(plaidItems)
          .set({
            connectionId: null, removedAt: now, removedReason: opts.deleteTransactions ? 'removed_with_transactions' : 'removed', backoffUntil: null, updatedAt: now,
          })
          .where(eq(plaidItems.id, itemId))
          .run();
        tx.update(cards).set({ removedAt: now, updatedAt: now }).where(and(eq(cards.plaidItemId, itemId), isNull(cards.removedAt))).run();
        tx.delete(plaidLinkPending).where(eq(plaidLinkPending.plaidItemId, itemId)).run();
        // A Savings connection's accounts (decision 14): deleted with their data, or kept and marked removed.
        if (opts.deleteTransactions) deleteSavingsData(tx, itemId);
        else markSavingsAccountsRemoved(tx, [itemId], now);
        if (!opts.deleteTransactions) return { deleted: 0, restored: 0, purged: 0, droppedPending: dropPending(tx, accountIds, now) };
        return { ...deleteOwnRows(tx, accountIds, now, () => loadCategorizer(this.deps.db)), droppedPending: 0 };
      });
      const revoked = token !== null && failure === null;
      const revocation: RemovalRevocation = revoked ? 'done' : token !== null ? 'waiting' : 'not_asked';
      this.deps.logger.info(
        {
          userId, itemId, revoked, waiting: token !== null && failure !== null, deletedTransactions: counts.deleted,
          restoredTransactions: counts.restored, purgedTransactions: counts.purged, droppedPending: counts.droppedPending,
        },
        'plaid item removed',
      );
      return { revoked, revocation, deletedTransactions: counts.deleted, restoredTransactions: counts.restored };
    }, { deadline: opts.deadline }).catch((err: unknown) => {
      throw err instanceof LockWaitTimeout ? new AppError('integration_unavailable', PLAID_MESSAGES.itemBusy) : err;
    });
  }

  /**
   * Null when Plaid removed the Item, or says it has no such Item already. Otherwise a plain line
   * for `last_error`, and the caller tries again later. The log has Plaid's code, never the token.
   */
  private async revoke(accessToken: string, deadline?: number): Promise<string | null> {
    try {
      await this.client.removeItem(accessToken, { deadline });
      return null;
    } catch (err) {
      // The Item or its token is gone at Plaid. Not INSTITUTION_NO_LONGER_SUPPORTED, though it's
      // `gone` elsewhere: that says nothing about whether the token was revoked.
      if (err instanceof PlaidApiError && (err.errorCode === 'ITEM_NOT_FOUND' || err.errorCode === 'INVALID_ACCESS_TOKEN')) return null;
      this.deps.logger.warn(failureFacts(err), 'plaid item removal failed');
      if (err instanceof PlaidApiError) return `Plaid answered HTTP ${err.status}${err.errorCode ? ` (${err.errorCode})` : ''}.`;
      if (err instanceof PlaidUnavailable) return "Couldn't reach Plaid.";
      if (err instanceof PlaidPastDeadline) return "Plaid didn't answer in time.";
      return "Plaid's answer wasn't in the expected format.";
    }
  }

  /** An access token to revoke later, bound to its `pending_revocations` row, with Plaid's `item_id` (which names the bank in the notice). */
  private queueRevocation(tx: DbOrTx, ownerUserId: number, plaidItemId: string, accessToken: string, now: Date): void {
    const row = tx.insert(pendingRevocations)
      .values({ kind: 'plaid', ownerUserId, accountId: plaidItemId, accountEmail: null, credentialsEnc: '', createdAt: now })
      .returning({ id: pendingRevocations.id })
      .get();
    tx.update(pendingRevocations)
      .set({ credentialsEnc: encryptSecret(this.deps.keyring, JSON.stringify({ accessToken }), familyRevocationAad('plaid', row.id)) })
      .where(eq(pendingRevocations.id, row.id))
      .run();
  }

  /**
   * The hourly `spend.plaidRevocations` job: `/item/remove` again for what a removal couldn't
   * finish. After REVOCATION_ATTEMPTS failures, or at once for a token that won't decrypt, retrying
   * stops: the token is wiped and the row stays, with `gave_up_at`, for the notice. Nothing here
   * can end a link in use: each access token is its own Item.
   */
  async retryRevocations(): Promise<{ total: number; failed: number; gaveUp: number }> {
    if (this.keyMismatchNow) return { total: 0, failed: 0, gaveUp: 0 };
    const rows = this.deps.db.select().from(pendingRevocations)
      .where(and(eq(pendingRevocations.kind, 'plaid'), isNull(pendingRevocations.gaveUpAt)))
      .orderBy(asc(pendingRevocations.id))
      .all();
    let failed = 0;
    let gaveUp = 0;
    for (const row of rows) {
      const result = await this.retryRevocation(row);
      if (result === 'failed') failed++;
      if (result === 'gave_up') gaveUp++;
    }
    return { total: rows.length, failed, gaveUp };
  }

  private async retryRevocation(row: PendingRevocationRow): Promise<'done' | 'failed' | 'gave_up'> {
    let token: string | null = null;
    try {
      token = CredentialsSchema.parse(JSON.parse(decryptSecret(this.deps.keyring, row.credentialsEnc, familyRevocationAad('plaid', row.id)))).accessToken;
    } catch (err) {
      this.deps.logger.error({ revocationId: row.id, error: err instanceof Error ? err.name : 'unknown' }, "a plaid token kept for removal couldn't be decrypted");
    }
    const attempts = row.attempts + 1;
    const now = this.deps.clock.now();
    const failure = token === null ? "The saved token couldn't be read." : await this.revoke(token);
    if (failure === null) {
      this.deps.db.delete(pendingRevocations).where(eq(pendingRevocations.id, row.id)).run();
      this.deps.logger.info({ revocationId: row.id, attempts }, 'plaid item removed after a retry');
      return 'done';
    }
    if (token === null || attempts >= REVOCATION_ATTEMPTS) {
      this.deps.db.update(pendingRevocations)
        .set({ attempts, lastError: failure, lastAttemptAt: now, gaveUpAt: now, credentialsEnc: '' })
        .where(eq(pendingRevocations.id, row.id))
        .run();
      this.deps.logger.error({ revocationId: row.id, attempts }, 'gave up removing a plaid item');
      return 'gave_up';
    }
    this.deps.db.update(pendingRevocations).set({ attempts, lastError: failure, lastAttemptAt: now }).where(eq(pendingRevocations.id, row.id)).run();
    return 'failed';
  }

  /**
   * For the System page: removals Plaid hasn't confirmed yet. A key mismatch is said once, by
   * `keyMismatchWarning` (keyCheck.ts), which names the banks when Plaid is configured.
   */
  warnings(): string[] {
    const out: string[] = [];
    const { n } = this.deps.db.select({ n: count() }).from(pendingRevocations)
      .where(and(eq(pendingRevocations.kind, 'plaid'), isNull(pendingRevocations.gaveUpAt)))
      .get()!;
    if (n > 0) {
      out.push(`Plaid didn't confirm ending ${n === 1 ? 'a removed bank connection' : `${n} removed bank connections`}. It's tried again every hour.`);
    }
    return out;
  }

  /**
   * Removals given up on, each a lasting notice naming the bank until an admin dismisses it. With
   * `purpose`, only that panel's (a row whose Item is gone counts as Spend's, as every one before
   * Savings was). The System page lists them all.
   */
  revocationNotices(purpose?: PlaidPurpose): { id: number; message: string }[] {
    return this.deps.db
      .select({ id: pendingRevocations.id, bank: plaidItems.institutionName, purpose: plaidItems.purpose })
      .from(pendingRevocations)
      .leftJoin(plaidItems, eq(plaidItems.plaidItemId, pendingRevocations.accountId))
      .where(and(eq(pendingRevocations.kind, 'plaid'), isNotNull(pendingRevocations.gaveUpAt)))
      .orderBy(asc(pendingRevocations.id))
      .all()
      .filter((r) => purpose === undefined || (r.purpose ?? 'spend') === purpose)
      .map((r) => {
        const bank = r.bank ?? 'the bank';
        return {
          id: r.id,
          message: `Plaid didn't confirm ending the dashboard's connection to ${bank} after it was removed, so ${bank} may still share data with Plaid for it. ` +
            `Remove the dashboard in ${bank}'s connected apps settings, or at my.plaid.com.`,
        };
      });
  }

  /** An admin dismissed a notice from `revocationNotices`. False when there was no such notice. */
  dismissRevocation(id: number): boolean {
    return this.deps.db.delete(pendingRevocations)
      .where(and(eq(pendingRevocations.id, id), eq(pendingRevocations.kind, 'plaid'), isNotNull(pendingRevocations.gaveUpAt)))
      .run().changes === 1;
  }

  /**
   * Part of "Reset links for a new key" (spec §14, the design's departure 10), only while the key
   * doesn't match: the access tokens can't be read, so they can't be revoked. Each Plaid
   * connection is deleted; each removal still waiting for Plaid becomes a given-up notice (no token
   * kept), and so does each Item forgotten, one per bank, saying to end the access at the bank or
   * my.plaid.com (review C-S-M2). The Items and their cards are marked removed
   * (`key_reset`), pending links dropped, and every transaction kept but the Items' pending ones
   * (soft-deleted, as in `remove`). The Items stay active at Plaid until they expire. Nothing runs meanwhile: every locked call is refused under the mismatch.
   */
  async forgetForNewKey(): Promise<{ forgotten: number }> {
    if (!this.keyMismatchNow) throw new AppError('conflict', 'TOKEN_ENCRYPTION_KEY matches the stored credentials, so there is nothing to reset.');
    const now = this.deps.clock.now();
    const forgotten = this.deps.db.transaction((tx) => {
      const items = tx.select().from(plaidItems).where(isNull(plaidItems.removedAt)).all();
      const active = items.map((r) => r.id);
      // Their pending rows will never post now (as in `remove` keeping transactions).
      dropPending(tx, items.flatMap((item) => itemAccountIds(tx, item)), now);
      // Their tokens can't be read, so Plaid can't be asked to end their access (review C-S-M2):
      // each forgotten bank gets the lasting notice saying to end it at the bank or my.plaid.com,
      // with no token kept, as does each removal still waiting for Plaid to confirm.
      const unreadable = "The key changed, so the saved token couldn't be read to end the bank's access.";
      for (const item of items) {
        const conn = item.connectionId === null ? undefined : tx.select().from(connections).where(eq(connections.id, item.connectionId)).get();
        // One notice per bank: a removal of it already waiting or given up on becomes or is that notice.
        const noticed = tx.select({ id: pendingRevocations.id }).from(pendingRevocations)
          .where(and(eq(pendingRevocations.kind, 'plaid'), eq(pendingRevocations.accountId, item.plaidItemId))).get();
        if (!conn || noticed) continue;
        tx.insert(pendingRevocations)
          .values({ kind: 'plaid', ownerUserId: conn.ownerUserId, accountId: item.plaidItemId, accountEmail: null, credentialsEnc: '', lastError: unreadable, lastAttemptAt: now, gaveUpAt: now, createdAt: now })
          .run();
      }
      tx.update(pendingRevocations)
        .set({ gaveUpAt: now, credentialsEnc: '', lastError: unreadable, lastAttemptAt: now })
        .where(and(eq(pendingRevocations.kind, 'plaid'), isNull(pendingRevocations.gaveUpAt)))
        .run();
      tx.delete(connections).where(eq(connections.kind, 'plaid')).run();
      tx.delete(plaidLinkPending).run();
      if (active.length > 0) {
        tx.update(plaidItems)
          .set({ connectionId: null, removedAt: now, removedReason: 'key_reset', backoffUntil: null, updatedAt: now })
          .where(inArray(plaidItems.id, active))
          .run();
        tx.update(cards).set({ removedAt: now, updatedAt: now }).where(and(inArray(cards.plaidItemId, active), isNull(cards.removedAt))).run();
        // Savings accounts leave the current views, their data kept (decision 14).
        markSavingsAccountsRemoved(tx, active, now);
      }
      return active.length;
    });
    this.deps.logger.warn({ forgotten }, 'plaid items forgotten for a new TOKEN_ENCRYPTION_KEY');
    return { forgotten };
  }
}
