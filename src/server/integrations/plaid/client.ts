import { z } from 'zod';
import { MAX_AMOUNT_CENTS } from '../../../shared/money.js';
import type { PlaidConfig } from '../../config.js';

/**
 * The Plaid API over plain `fetch` (no SDK: docs/research/plaid-6b.md §10), written against that
 * research and the OpenAPI `2020-09-14.yml` from plaid/plaid-openapi at commit `5c3745c`. HTTP and
 * nothing else: it knows nothing about the database and doesn't log.
 *
 * - Every call is a JSON POST with `PLAID-CLIENT-ID` and `PLAID-SECRET` in headers (research §1,
 *   the design's departure 1), never the body, set here and nowhere else, and `Plaid-Version`
 *   pinned so a Dashboard default can't change response shapes under us.
 * - Responses are checked with zod, only for the fields the app reads, each schema citing its
 *   OpenAPI component.
 * - A failure is a `PlaidApiError` (Plaid's `error_type`, `error_code` and `request_id`, never the
 *   body or its messages), a `PlaidUnavailable` (no answer, or too slow), or a `PlaidBadResponse`
 *   (a 2xx that isn't the documented shape). No message contains a token, a secret, or a body.
 * - A `/transactions/sync` entry that doesn't parse fails its whole page with `PlaidBadResponse`,
 *   never left out: the cursor would move past it, and that change would be lost for good. So the
 *   Item shows the error and the next sync asks for the same page again. To keep that rare, the
 *   fields the app doesn't depend on (`personal_finance_category`, `counterparties`, `logo_url`,
 *   `merchant_entity_id`, `original_description`) fall back to null when they're malformed, and a
 *   removed entry needs only its `transaction_id`. Accounts and liabilities are lists the app
 *   reads whole each time, so an entry there that doesn't parse is left out and counted.
 * - Only idempotent reads are retried, twice, at 1 and 2 seconds, and only for transient failures
 *   (research §8.3). The exchange, link tokens, and `/item/remove` never are.
 * - Every call takes an optional `deadline` (epoch ms, on the client's clock): a request's whole
 *   budget, passed down so the lock wait and every Plaid call it makes fit inside it. It caps each
 *   attempt's timeout and the retries. A call (or a retry) never starts with less than a second
 *   left, and an attempt cut off by that deadline rather than its own timeout is
 *   `PlaidPastDeadline`: the request ran out of time, which says nothing about Plaid's health.
 */

export type FetchFn = typeof fetch;

/** Research §1: the only version the API and the v51 SDK support. */
export const PLAID_VERSION = '2020-09-14';
/** `/transactions/sync`'s largest page (research §5.1). */
export const SYNC_PAGE_SIZE = 500;
/** Each attempt waits at most this long. Plaid documents no timeout of its own. */
export const REQUEST_TIMEOUT_MS = 20_000;
/** One call, retries and waits included, gives up after this. */
export const CALL_DEADLINE_MS = 45_000;
/**
 * The webhook key fetch runs while Plaid waits for the webhook's answer, which must come within 10
 * seconds (research §7.5): 5 seconds an attempt, and the whole fetch, a retry included, within 8.
 */
export const KEY_TIMEOUT_MS = 5_000;
export const KEY_DEADLINE_MS = 8_000;
/** Waits before the second and third attempts of a retried read. */
export const RETRY_WAITS_MS: readonly number[] = [1000, 2000];
/** A retry starts only if this much time is left for its attempt. */
const MIN_ATTEMPT_MS = 1000;

export type PlaidPath =
  | '/link/token/create'
  | '/item/public_token/exchange'
  | '/item/get'
  | '/item/remove'
  | '/accounts/get'
  | '/transactions/sync'
  | '/liabilities/get'
  | '/investments/transactions/get'
  | '/webhook_verification_key/get';

/** The reads that are safe to send again (research §8.3, JUDGMENT): the same request gets the same data. */
const RETRIED: ReadonlySet<PlaidPath> = new Set<PlaidPath>([
  '/transactions/sync', '/liabilities/get', '/accounts/get', '/item/get', '/webhook_verification_key/get', '/investments/transactions/get',
]);

/** Plaid answered with an error (OpenAPI `PlaidError`). `errorType` and `errorCode` are null when the body wasn't Plaid's error shape. */
export class PlaidApiError extends Error {
  constructor(
    readonly path: PlaidPath,
    readonly status: number,
    readonly errorType: string | null,
    readonly errorCode: string | null,
    readonly requestId: string | null,
  ) {
    super(`Plaid ${path} failed (HTTP ${status}${errorCode ? `, ${errorType ?? 'unknown type'} ${errorCode}` : ''}).`);
    this.name = 'PlaidApiError';
  }
}

/** No answer from Plaid: the connection failed, or the attempt timed out. */
export class PlaidUnavailable extends Error {
  constructor(readonly reason: 'network' | 'timeout') {
    super(reason === 'timeout' ? 'Plaid took too long to answer.' : "Couldn't reach Plaid.");
    this.name = 'PlaidUnavailable';
  }
}

/**
 * The request's deadline came before Plaid could answer: the call never started, or was cut off by
 * the deadline (not by its own timeout). Not Plaid's failure, so it's never recorded on a
 * connection; the caller defers, or says to try again. Classed `transient`. `sent`: it was cut
 * off after the request went out, so Plaid may have acted on it (review C-S-M4: an exchange then
 * counts against the Trial).
 */
export class PlaidPastDeadline extends Error {
  constructor(readonly path: PlaidPath, readonly sent = false) {
    super("There wasn't time left in the request to ask Plaid.");
    this.name = 'PlaidPastDeadline';
  }
}

/** For every call: the request's deadline (epoch ms on the client's clock), if it has one. */
export interface CallOptions {
  deadline?: number;
}

/** A 2xx whose body isn't JSON in the documented shape. */
export class PlaidBadResponse extends Error {
  constructor(readonly path: PlaidPath) {
    super(`Plaid's ${path} response wasn't in the expected format.`);
    this.name = 'PlaidBadResponse';
  }
}

/**
 * What a failure means for the app (research §8.2, the design's "Error states" and "Backoff"):
 * - `reconnect`: the admin can fix it in update mode.
 * - `gone`: the Item no longer works at Plaid; only removing it helps (`INSTITUTION_NO_LONGER_SUPPORTED` too).
 * - `trial_limit`: Plaid's Trial has no connections left. Permanent, never retried.
 * - `mutation`: `/transactions/sync` data changed mid-loop; restart the loop from the stored cursor.
 * - `transient`: try later (backoff): rate limits, `PRODUCT_NOT_READY`, institution and Plaid
 *   outages (other `INSTITUTION_*` codes), 5xx, and no answer.
 * - `other`: anything else, unknown codes included (new ones can appear without a version bump),
 *   and `INSTITUTION_REGISTRATION_REQUIRED` and `UNAUTHORIZED_INSTITUTION`.
 */
export type PlaidErrorClass = 'reconnect' | 'gone' | 'trial_limit' | 'mutation' | 'transient' | 'other';

const RECONNECT_CODES = new Set(['ITEM_LOGIN_REQUIRED', 'ACCESS_NOT_GRANTED', 'NO_ACCOUNTS', 'PASSWORD_RESET_REQUIRED', 'ITEM_LOCKED']);
const GONE_CODES = new Set(['ITEM_NOT_FOUND', 'INVALID_ACCESS_TOKEN', 'INSTITUTION_NO_LONGER_SUPPORTED']);
/**
 * Institution codes that waiting won't fix soon, so they're never retried or backed off: Plaid
 * hasn't registered us with the bank yet (research §3.5), or isn't authorized for it.
 */
const INSTITUTION_REFUSED_CODES = new Set(['INSTITUTION_REGISTRATION_REQUIRED', 'UNAUTHORIZED_INSTITUTION']);

export function classifyPlaidError(err: unknown): PlaidErrorClass {
  if (err instanceof PlaidUnavailable || err instanceof PlaidPastDeadline) return 'transient';
  if (!(err instanceof PlaidApiError)) return 'other';
  const { errorCode: code, errorType: type, status } = err;
  // Its type is RATE_LIMIT_EXCEEDED, so it must be matched first, or it would be retried forever.
  if (code === 'TRIAL_CONNECTION_LIMIT') return 'trial_limit';
  if (code === 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION') return 'mutation';
  if (code && RECONNECT_CODES.has(code)) return 'reconnect';
  if (code && GONE_CODES.has(code)) return 'gone';
  if (code && INSTITUTION_REFUSED_CODES.has(code)) return 'other';
  if (
    type === 'RATE_LIMIT_EXCEEDED' || type === 'INSTITUTION_ERROR' || type === 'API_ERROR' || code === 'PRODUCT_NOT_READY'
    || code?.startsWith('INSTITUTION_') || status === 429 || status >= 500
  ) {
    return 'transient';
  }
  return 'other';
}

/**
 * A Plaid amount (dollars, a JSON number, research §1) as whole cents, read through its shortest
 * decimal text, so `4.1` is 410 and never 409.99999. More than two decimal places rounds to the
 * nearest cent, halves away from zero, with `rounded` set so the sync can count it. Null when it
 * isn't finite or is past `MAX_AMOUNT_CENTS` either way.
 */
export function plaidAmountCents(n: number): { cents: number; rounded: boolean } | null {
  if (!Number.isFinite(n)) return null;
  const text = String(n);
  if (/e/i.test(text)) return Math.abs(n) < 1 ? { cents: 0, rounded: true } : null;
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!m || m[2]!.length > 13) return null;
  const frac = m[3] ?? '';
  const rest = frac.slice(2);
  let cents = Number(m[2]) * 100 + Number(frac.slice(0, 2).padEnd(2, '0'));
  if (rest !== '' && rest[0]! >= '5') cents += 1;
  if (cents > MAX_AMOUNT_CENTS) return null;
  return { cents: cents === 0 ? 0 : m[1] === '-' ? -cents : cents, rounded: /[1-9]/.test(rest) };
}

/** Research plaid-savings §2.3: per account type, the subtypes Link offers (`all` for every one). */
export type AccountFilters = Partial<Record<'credit' | 'depository' | 'investment', { account_subtypes: string[] }>>;

/** `/link/token/create`'s request fields the app sends (research §2.1, §2.6). Credentials go in headers. */
export interface LinkTokenCreateRequest {
  client_name: string;
  language: string;
  country_codes: string[];
  user: { client_user_id: string };
  products?: string[];
  required_if_supported_products?: string[];
  transactions?: { days_requested: number };
  account_filters?: AccountFilters;
  webhook?: string;
  redirect_uri?: string;
  /** Update mode (research §2.4). */
  access_token?: string;
  update?: { account_selection_enabled: boolean };
}

/** OpenAPI `LinkTokenCreateResponse`. */
const LinkTokenCreateResponseSchema = z.object({ link_token: z.string().min(1), expiration: z.string() });

/** OpenAPI `ItemPublicTokenExchangeResponse`. */
const ItemPublicTokenExchangeResponseSchema = z.object({ access_token: z.string().min(1), item_id: z.string().min(1) });

/** OpenAPI `ItemGetResponse.item` (`ItemWithConsentFields`). `error` is the Item's current `PlaidError`, null when it has none. */
const ItemSchema = z.object({
  item_id: z.string().min(1),
  institution_id: z.string().nullish().transform((v) => v ?? null),
  institution_name: z.string().nullish().transform((v) => v ?? null),
  consent_expiration_time: z.string().nullish().transform((v) => v ?? null),
  error: z
    .object({ error_type: z.string().nullish().transform((v) => v ?? null), error_code: z.string().nullish().transform((v) => v ?? null) })
    .nullish()
    .transform((v) => v ?? null),
});
export type PlaidItem = z.infer<typeof ItemSchema>;
const ItemGetResponseSchema = z.object({ item: ItemSchema });

const nullable = <T extends z.ZodType>(schema: T) => schema.nullish().transform((v) => v ?? null);
/** A field the app doesn't depend on: null when it's missing or malformed, so it never fails a sync page. */
const optional = <T extends z.ZodType>(schema: T) => nullable(schema).catch(null);

/** OpenAPI `AccountBase`, with `AccountBalance` trimmed to the currency codes and the two amounts Savings reads. */
const AccountSchema = z.object({
  account_id: z.string().min(1),
  name: z.string(),
  official_name: z.string().nullish().transform((v) => v ?? null),
  mask: z.string().nullish().transform((v) => v ?? null),
  type: z.string(),
  subtype: z.string().nullish().transform((v) => v ?? null),
  balances: z.object({
    iso_currency_code: z.string().nullish().transform((v) => v ?? null),
    unofficial_currency_code: z.string().nullish().transform((v) => v ?? null),
    /** Research plaid-savings §5.1: the balance at the Item's last update. For investment accounts, the total value. */
    current: optional(z.number()),
    /** Research plaid-savings §5.1: for investment accounts, cash available to withdraw. Often null. */
    available: optional(z.number()),
  }),
});
export type PlaidAccount = z.infer<typeof AccountSchema>;
/** OpenAPI `AccountsGetResponse`. */
const AccountsGetResponseSchema = z.object({ accounts: z.array(z.unknown()) });

/** OpenAPI `PersonalFinanceCategory`. */
const PfcSchema = z.object({
  primary: z.string(),
  detailed: z.string(),
  confidence_level: nullable(z.string()),
  version: nullable(z.string()),
});

/**
 * OpenAPI `Transaction`, the fields the app reads (research spend-plaid-csv §3). `name` is
 * deprecated but still sent; it's the raw description.
 */
const TransactionSchema = z.object({
  transaction_id: z.string().min(1),
  account_id: z.string().min(1),
  amount: z.number(),
  iso_currency_code: nullable(z.string()),
  unofficial_currency_code: nullable(z.string()),
  date: z.string(),
  authorized_date: nullable(z.string()),
  pending: z.boolean(),
  pending_transaction_id: nullable(z.string()),
  merchant_name: nullable(z.string()),
  name: nullable(z.string()),
  original_description: optional(z.string()),
  personal_finance_category: optional(PfcSchema),
  merchant_entity_id: optional(z.string()),
  logo_url: optional(z.string()),
  counterparties: optional(z.array(z.unknown())),
});
export type PlaidTransaction = z.infer<typeof TransactionSchema>;

/** OpenAPI `RemovedTransaction`. Only the id is read; `account_id` is optional, so its absence never fails a page. */
const RemovedTransactionSchema = z.object({ transaction_id: z.string().min(1), account_id: z.string().optional() });
export type PlaidRemovedTransaction = z.infer<typeof RemovedTransactionSchema>;

/** OpenAPI `TransactionsSyncResponse`. */
const TransactionsSyncResponseSchema = z.object({
  added: z.array(z.unknown()),
  modified: z.array(z.unknown()),
  removed: z.array(z.unknown()),
  next_cursor: z.string(),
  has_more: z.boolean(),
  transactions_update_status: nullable(z.string()),
});

export interface TransactionsSyncPage {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: PlaidRemovedTransaction[];
  /** `""` while Plaid has no data yet (research §5.2): callers store null for it. */
  nextCursor: string;
  hasMore: boolean;
  transactionsUpdateStatus: string | null;
}

/** OpenAPI `CreditCardLiability`, the fields the app reads (research spend-plaid-csv §4). */
const CreditLiabilitySchema = z.object({
  account_id: nullable(z.string()),
  last_statement_issue_date: nullable(z.string()),
  last_statement_balance: nullable(z.number()),
  next_payment_due_date: nullable(z.string()),
  minimum_payment_amount: nullable(z.number()),
});
export type PlaidCreditLiability = z.infer<typeof CreditLiabilitySchema>;
/** OpenAPI `LiabilitiesGetResponse` (`LiabilitiesObject.credit` is nullable). */
const LiabilitiesGetResponseSchema = z.object({ liabilities: z.object({ credit: z.array(z.unknown()).nullish() }) });

/** `/investments/transactions/get`'s largest page (research plaid-savings §3.1). */
export const INVESTMENTS_PAGE_SIZE = 500;

/**
 * OpenAPI `InvestmentTransaction`, only the fields Savings reads (research plaid-savings §3.2).
 * `name`, `quantity`, `price` and `fees` are never read. `type` and `subtype` can be null when the
 * institution doesn't say.
 */
const InvestmentTransactionSchema = z.object({
  investment_transaction_id: z.string().min(1),
  account_id: z.string().min(1),
  security_id: nullable(z.string()),
  date: z.string(),
  amount: z.number(),
  type: nullable(z.string()),
  subtype: nullable(z.string()),
  iso_currency_code: nullable(z.string()),
  unofficial_currency_code: nullable(z.string()),
});
export type PlaidInvestmentTransaction = z.infer<typeof InvestmentTransactionSchema>;
/** OpenAPI `InvestmentsTransactionsGetResponse`, the two fields read. */
const InvestmentsTransactionsGetResponseSchema = z.object({
  investment_transactions: z.array(z.unknown()),
  total_investment_transactions: z.number().int().nonnegative(),
});

/** OpenAPI `JWKPublicKey` (research §7.1). `use` and `created_at` aren't read, so they're optional. */
const JwkSchema = z.object({
  alg: z.string(),
  crv: z.string(),
  kid: z.string(),
  kty: z.string(),
  use: z.string().optional(),
  x: z.string(),
  y: z.string(),
  created_at: z.number().optional(),
  expired_at: nullable(z.number()),
});
export type PlaidWebhookKey = z.infer<typeof JwkSchema>;
/** OpenAPI `WebhookVerificationKeyGetResponse`. */
const WebhookVerificationKeyGetResponseSchema = z.object({ key: JwkSchema });

/** OpenAPI `PlaidError`, only the codes, never the messages. */
const PlaidErrorSchema = z.object({ error_type: z.string().optional(), error_code: z.string().optional(), request_id: z.string().optional() });

/** Every entry of a list, or PlaidBadResponse if any doesn't parse (a sync page must never skip one). */
function all<T>(path: PlaidPath, schema: z.ZodType<T>, list: unknown[]): T[] {
  const items: T[] = [];
  for (const raw of list) {
    const r = schema.safeParse(raw);
    if (!r.success) throw new PlaidBadResponse(path);
    items.push(r.data);
  }
  return items;
}

/** Entries of a list that parse, and a count of those that didn't. */
function keep<T>(schema: z.ZodType<T>, list: unknown[]): { items: T[]; skipped: number } {
  const items: T[] = [];
  let skipped = 0;
  for (const raw of list) {
    const r = schema.safeParse(raw);
    if (r.success) items.push(r.data);
    else skipped++;
  }
  return { items, skipped };
}

function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

export interface PlaidClientOptions {
  /** Waits between retries. Tests pass one that doesn't wait. */
  sleep?: (ms: number) => Promise<void>;
  /** The clock deadlines are measured on. Tests pass a fake one. */
  now?: () => number;
  retryWaitsMs?: readonly number[];
  timeoutMs?: number;
  callDeadlineMs?: number;
  keyTimeoutMs?: number;
  keyDeadlineMs?: number;
}

export class PlaidClient {
  /** The keys, the secret included, in a JS private field, so no inspect, JSON or spread shows them. */
  readonly #cfg: Pick<PlaidConfig, 'clientId' | 'secret' | 'apiBaseUrl'>;
  readonly #fetchFn: FetchFn;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly retryWaitsMs: readonly number[];
  private readonly timeoutMs: number;
  private readonly callDeadlineMs: number;
  private readonly keyTimeoutMs: number;
  private readonly keyDeadlineMs: number;

  constructor(cfg: Pick<PlaidConfig, 'clientId' | 'secret' | 'apiBaseUrl'>, fetchFn: FetchFn, opts: PlaidClientOptions = {}) {
    this.#cfg = { clientId: cfg.clientId, secret: cfg.secret, apiBaseUrl: cfg.apiBaseUrl };
    this.#fetchFn = fetchFn;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
    this.retryWaitsMs = opts.retryWaitsMs ?? RETRY_WAITS_MS;
    this.timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.callDeadlineMs = opts.callDeadlineMs ?? CALL_DEADLINE_MS;
    this.keyTimeoutMs = opts.keyTimeoutMs ?? KEY_TIMEOUT_MS;
    this.keyDeadlineMs = opts.keyDeadlineMs ?? KEY_DEADLINE_MS;
  }

  /** Research §2. A new Item's token lasts 4 hours, an update-mode one 30 minutes. Never retried: the admin can click again. */
  async createLinkToken(req: LinkTokenCreateRequest, opts: CallOptions = {}): Promise<{ linkToken: string; expiration: string }> {
    const body = this.parse('/link/token/create', LinkTokenCreateResponseSchema, await this.call('/link/token/create', { ...req }, opts));
    return { linkToken: body.link_token, expiration: body.expiration };
  }

  /**
   * Research §4.1. A public token is single-use, so this is never retried: after a lost answer, a
   * second try would get an error instead of the token (UNVERIFIED which).
   */
  async exchangePublicToken(publicToken: string, opts: CallOptions = {}): Promise<{ accessToken: string; itemId: string }> {
    const body = this.parse(
      '/item/public_token/exchange',
      ItemPublicTokenExchangeResponseSchema,
      await this.call('/item/public_token/exchange', { public_token: publicToken }, opts),
    );
    return { accessToken: body.access_token, itemId: body.item_id };
  }

  /** Research §4.2: the institution and `consent_expiration_time`, which the exchange doesn't return. */
  async getItem(accessToken: string, opts: CallOptions = {}): Promise<PlaidItem> {
    return this.parse('/item/get', ItemGetResponseSchema, await this.call('/item/get', { access_token: accessToken }, opts)).item;
  }

  /** Research §9. Revokes the access token. On a Trial it doesn't free a connection. Never retried here: the caller queues it. */
  async removeItem(accessToken: string, opts: CallOptions = {}): Promise<void> {
    this.parse('/item/remove', z.object({}), await this.call('/item/remove', { access_token: accessToken }, opts));
  }

  /** Research §4.3: the Item's active accounts, cached by Plaid and free. Accounts that don't parse are counted, not returned. */
  async getAccounts(accessToken: string, opts: CallOptions = {}): Promise<{ accounts: PlaidAccount[]; skipped: number }> {
    const body = this.parse('/accounts/get', AccountsGetResponseSchema, await this.call('/accounts/get', { access_token: accessToken }, opts));
    const { items, skipped } = keep(AccountSchema, body.accounts);
    return { accounts: items, skipped };
  }

  /**
   * One page of `/transactions/sync` (research §5): from `cursor` (null for the whole history, and
   * never `""`), `count` at most 500, with PFC v2 asked for. Following `has_more`, and restarting
   * on a mutation, is the caller's loop. An entry that doesn't parse fails the page (see the top).
   */
  async syncTransactions(accessToken: string, req: { cursor: string | null; count?: number }, opts: CallOptions = {}): Promise<TransactionsSyncPage> {
    const request: Record<string, unknown> = { access_token: accessToken };
    if (req.cursor !== null && req.cursor !== '') request.cursor = req.cursor;
    request.count = req.count ?? SYNC_PAGE_SIZE;
    request.options = { personal_finance_category_version: 'v2' };
    const body = this.parse('/transactions/sync', TransactionsSyncResponseSchema, await this.call('/transactions/sync', request, opts));
    return {
      added: all('/transactions/sync', TransactionSchema, body.added),
      modified: all('/transactions/sync', TransactionSchema, body.modified),
      removed: all('/transactions/sync', RemovedTransactionSchema, body.removed),
      nextCursor: body.next_cursor,
      hasMore: body.has_more,
      transactionsUpdateStatus: body.transactions_update_status,
    };
  }

  /**
   * Research §6: every credit card's liabilities in one call, without `account_ids` (asking for an
   * id Plaid no longer has is an error). `NO_LIABILITY_ACCOUNTS` comes back as a PlaidApiError.
   */
  async getLiabilities(accessToken: string, opts: CallOptions = {}): Promise<{ credit: PlaidCreditLiability[]; skipped: number }> {
    const body = this.parse('/liabilities/get', LiabilitiesGetResponseSchema, await this.call('/liabilities/get', { access_token: accessToken }, opts));
    const { items, skipped } = keep(CreditLiabilitySchema, body.liabilities.credit ?? []);
    return { credit: items, skipped };
  }

  /**
   * One page of `/investments/transactions/get` (research plaid-savings §3): the window
   * `startDate`..`endDate` (YYYY-MM-DD), newest first, `count` at most 500 from `offset`. An entry
   * that doesn't parse is counted, not returned: the window is read again every sync, so nothing
   * is lost for good the way a skipped `/transactions/sync` entry would be. `PRODUCTS_NOT_SUPPORTED`
   * and the like come back as PlaidApiError.
   */
  async getInvestmentTransactions(
    accessToken: string,
    req: { startDate: string; endDate: string; count?: number; offset?: number },
    opts: CallOptions = {},
  ): Promise<{ transactions: PlaidInvestmentTransaction[]; total: number; skipped: number }> {
    const body = this.parse('/investments/transactions/get', InvestmentsTransactionsGetResponseSchema, await this.call('/investments/transactions/get', {
      access_token: accessToken,
      start_date: req.startDate,
      end_date: req.endDate,
      options: { count: req.count ?? INVESTMENTS_PAGE_SIZE, offset: req.offset ?? 0 },
    }, opts));
    const { items, skipped } = keep(InvestmentTransactionSchema, body.investment_transactions);
    return { transactions: items, total: body.total_investment_transactions, skipped };
  }

  /** Research §7.1: the JWK for a webhook's `kid`. The `kid` comes from the webhook, so callers limit how often this runs. */
  async getWebhookVerificationKey(keyId: string): Promise<PlaidWebhookKey> {
    const body = this.parse(
      '/webhook_verification_key/get',
      WebhookVerificationKeyGetResponseSchema,
      await this.call('/webhook_verification_key/get', { key_id: keyId }),
    );
    return body.key;
  }

  private parse<T>(path: PlaidPath, schema: z.ZodType<T>, json: unknown): T {
    const r = schema.safeParse(json);
    if (!r.success) throw new PlaidBadResponse(path);
    return r.data;
  }

  /**
   * One call, with retries for idempotent reads after a transient failure. Each attempt has its own
   * timeout, and nothing goes past the call's deadline, or the request's (`opts.deadline`) when
   * that's sooner. Under the request's deadline, an attempt starts only with a second left for it,
   * and an attempt the deadline cut short is `PlaidPastDeadline`. A retry starts only when its
   * wait and a second for the attempt fit before the deadline.
   */
  private async call(path: PlaidPath, body: Record<string, unknown>, opts: CallOptions = {}): Promise<unknown> {
    const isKey = path === '/webhook_verification_key/get';
    const attemptMs = isKey ? this.keyTimeoutMs : this.timeoutMs;
    const own = this.now() + (isKey ? this.keyDeadlineMs : this.callDeadlineMs);
    const requestDeadline = opts.deadline;
    const deadline = requestDeadline === undefined ? own : Math.min(own, requestDeadline);
    for (let attempt = 0; ; attempt++) {
      const left = deadline - this.now();
      if (requestDeadline !== undefined && requestDeadline - this.now() < MIN_ATTEMPT_MS) throw new PlaidPastDeadline(path);
      // Shortened by the request's deadline: a timeout then is the request's, not Plaid's.
      const capped = requestDeadline !== undefined && requestDeadline - this.now() < attemptMs;
      try {
        return await this.once(path, body, Math.max(1, Math.min(attemptMs, left)));
      } catch (err) {
        if (capped && err instanceof PlaidUnavailable && err.reason === 'timeout') throw new PlaidPastDeadline(path, true);
        const wait = this.retryWaitsMs[attempt];
        if (!RETRIED.has(path) || wait === undefined || classifyPlaidError(err) !== 'transient') throw err;
        if (wait + MIN_ATTEMPT_MS > deadline - this.now()) throw err;
        await this.sleep(wait);
      }
    }
  }

  private async once(path: PlaidPath, body: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    let res: Response;
    let text: string;
    try {
      res = await this.#fetchFn(new URL(path, this.#cfg.apiBaseUrl).href, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'plaid-client-id': this.#cfg.clientId,
          'plaid-secret': this.#cfg.secret,
          'plaid-version': PLAID_VERSION,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await res.text();
    } catch (err) {
      throw new PlaidUnavailable(isTimeout(err) ? 'timeout' : 'network');
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const e = PlaidErrorSchema.safeParse(json);
      const facts = e.success ? e.data : {};
      throw new PlaidApiError(path, res.status, facts.error_type ?? null, facts.error_code ?? null, facts.request_id ?? null);
    }
    if (json === undefined) throw new PlaidBadResponse(path);
    return json;
  }
}
