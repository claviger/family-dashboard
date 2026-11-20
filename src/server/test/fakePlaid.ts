import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from 'node:crypto';

/**
 * An in-memory model of the slice of the Plaid API the app uses, for tests. It follows
 * docs/research/plaid-6b.md (§2 to §9, §11 "How the fake should behave") and the OpenAPI
 * components it cites:
 * - `/link/token/create` (new and update mode) and `completeLink`, which plays the admin finishing
 *   Link and returns `onSuccess`'s public token and metadata;
 * - `/item/public_token/exchange` (public tokens are single-use and expire after 30 minutes);
 * - `/item/get` (with a configurable `consent_expiration_time`), `/item/remove`, `/accounts/get`;
 * - `/transactions/sync` as an ordered change log per Item, with opaque cursors, `count` pages,
 *   `has_more`, `next_cursor: ""` while data isn't ready, and a one-shot
 *   `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`. Without a cursor it answers "the entire
 *   history" (research §5.1) as Plaid does: the Item's transactions as they stand, all in `added`,
 *   never the changes that led there; with one it answers the changes after it. Helpers add,
 *   modify, remove, post a pending transaction (removed plus an added one with
 *   `pending_transaction_id`, in either order, so a page can split them), and churn one;
 * - `/liabilities/get`, one credit entry per account that has one;
 * - `/webhook_verification_key/get`, serving its own signing keys by `kid` and any a test adds,
 *   and `signWebhook`, which signs a body the way Plaid does (research §7.1): an ES256 JWT in
 *   `Plaid-Verification` with `iat` and the SHA-256 of the exact body bytes. It signs with
 *   `node:crypto`, not `jose`, so the verifier isn't checked against the library it uses;
 * - injectable failures on the next calls to a path, or to a path for one Item: a Plaid error, a
 *   dropped connection, or no answer until the caller gives up.
 *
 * Every request must carry `PLAID-CLIENT-ID`, `PLAID-SECRET`, `Plaid-Version: 2020-09-14` and a
 * JSON `Content-Type`, checked before anything else, an injected Plaid error included. Wrong keys
 * get Plaid's `INVALID_API_KEYS`; the version and content type are the fake's own checks (Plaid
 * would use the Dashboard's default version), answered with `INVALID_HEADERS` so a missing one
 * fails loudly. Errors have Plaid's shape (OpenAPI `PlaidError`, research §8.1) and HTTP status:
 * 400 for Item and request errors, 429 for rate limits (`TRIAL_CONNECTION_LIMIT` too), 500 and 503
 * for Plaid's own.
 *
 * `/link/token/create` checks what research §2.1 and §2.4 say a request must and mustn't have: a
 * new Item's token needs `products`; an update-mode one (with `access_token`) must have none of the
 * product fields, and `account_filters` only with `update.account_selection_enabled`. Plaid says
 * "should be omitted", not "is rejected"; the fake refuses so the app's mistake shows. Update
 * mode's public token can't be exchanged (the access token doesn't change).
 *
 * `requests` records each call's path and JSON body for assertions. Credentials travel in headers,
 * which aren't recorded, and nothing here logs. Every institution, account, token and transaction
 * is synthetic.
 *
 * Use it as `fetch` in Vitest (`fake.fetch`).
 */

export const FAKE_PLAID_CLIENT_ID = 'fake-plaid-client-id';
export const FAKE_PLAID_SECRET = 'fake-plaid-secret';
const PLAID_VERSION = '2020-09-14';

export type FakePlaidPath =
  | '/link/token/create'
  | '/item/public_token/exchange'
  | '/item/get'
  | '/item/remove'
  | '/accounts/get'
  | '/transactions/sync'
  | '/liabilities/get'
  | '/investments/transactions/get'
  | '/webhook_verification_key/get';

/** A Plaid error as a test injects it: Plaid's HTTP status, `error_type` and `error_code`. */
export interface FakePlaidError {
  status: number;
  error_type: string;
  error_code: string;
}

/** The errors tests use most, with the HTTP status and type Plaid documents for each (research §8.2). */
export const FAKE_PLAID_ERRORS = {
  ITEM_LOGIN_REQUIRED: { status: 400, error_type: 'ITEM_ERROR', error_code: 'ITEM_LOGIN_REQUIRED' },
  ACCESS_NOT_GRANTED: { status: 400, error_type: 'ITEM_ERROR', error_code: 'ACCESS_NOT_GRANTED' },
  ITEM_NOT_FOUND: { status: 400, error_type: 'ITEM_ERROR', error_code: 'ITEM_NOT_FOUND' },
  NO_LIABILITY_ACCOUNTS: { status: 400, error_type: 'ITEM_ERROR', error_code: 'NO_LIABILITY_ACCOUNTS' },
  PRODUCT_NOT_READY: { status: 400, error_type: 'ITEM_ERROR', error_code: 'PRODUCT_NOT_READY' },
  INVALID_ACCESS_TOKEN: { status: 400, error_type: 'INVALID_INPUT', error_code: 'INVALID_ACCESS_TOKEN' },
  INVALID_PUBLIC_TOKEN: { status: 400, error_type: 'INVALID_INPUT', error_code: 'INVALID_PUBLIC_TOKEN' },
  INSTITUTION_DOWN: { status: 400, error_type: 'INSTITUTION_ERROR', error_code: 'INSTITUTION_DOWN' },
  INSTITUTION_REGISTRATION_REQUIRED: { status: 400, error_type: 'INSTITUTION_ERROR', error_code: 'INSTITUTION_REGISTRATION_REQUIRED' },
  INTERNAL_SERVER_ERROR: { status: 500, error_type: 'API_ERROR', error_code: 'INTERNAL_SERVER_ERROR' },
  PLANNED_MAINTENANCE: { status: 503, error_type: 'API_ERROR', error_code: 'PLANNED_MAINTENANCE' },
  TRANSACTIONS_SYNC_LIMIT: { status: 429, error_type: 'RATE_LIMIT_EXCEEDED', error_code: 'TRANSACTIONS_SYNC_LIMIT' },
  TRIAL_CONNECTION_LIMIT: { status: 429, error_type: 'RATE_LIMIT_EXCEEDED', error_code: 'TRIAL_CONNECTION_LIMIT' },
  TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION: {
    status: 400, error_type: 'TRANSACTIONS_ERROR', error_code: 'TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION',
  },
  PRODUCTS_NOT_SUPPORTED: { status: 400, error_type: 'ITEM_ERROR', error_code: 'PRODUCTS_NOT_SUPPORTED' },
  NO_INVESTMENT_ACCOUNTS: { status: 400, error_type: 'ITEM_ERROR', error_code: 'NO_INVESTMENT_ACCOUNTS' },
  INVALID_PRODUCT: { status: 400, error_type: 'INVALID_INPUT', error_code: 'INVALID_PRODUCT' },
  ADDITIONAL_CONSENT_REQUIRED: { status: 400, error_type: 'INVALID_INPUT', error_code: 'ADDITIONAL_CONSENT_REQUIRED' },
} as const satisfies Record<string, FakePlaidError>;

/** An account as `/accounts/get` lists it (OpenAPI `AccountBase`), balances trimmed to the currency codes and the two amounts. */
export interface FakeAccount {
  account_id: string;
  name: string;
  official_name: string | null;
  mask: string | null;
  type: string;
  subtype: string | null;
  iso_currency_code: string | null;
  unofficial_currency_code: string | null;
  /** `balances.current`. 0 unless a test sets it, as before. */
  current: number | null;
  /** `balances.available`. */
  available: number | null;
}

export type FakeAccountInput = Partial<FakeAccount> & { name: string };

export interface FakeInstitution {
  institution_id: string;
  name: string;
}

/** The fields of OpenAPI `Transaction` the app reads. */
export interface FakeTransaction {
  transaction_id: string;
  account_id: string;
  amount: number;
  iso_currency_code: string | null;
  unofficial_currency_code: string | null;
  date: string;
  authorized_date: string | null;
  pending: boolean;
  pending_transaction_id: string | null;
  merchant_name: string | null;
  name: string;
  original_description: string | null;
  personal_finance_category: { primary: string; detailed: string; confidence_level: string | null; version: string } | null;
  merchant_entity_id: string | null;
  logo_url: string | null;
  counterparties: unknown[];
}

/** The fields of OpenAPI `InvestmentTransaction` the fake sends (research plaid-savings §3.2). Synthetic. */
export interface FakeInvestmentTransaction {
  investment_transaction_id: string;
  account_id: string;
  security_id: string | null;
  date: string;
  transaction_datetime: string | null;
  name: string;
  quantity: number;
  amount: number;
  price: number;
  fees: number | null;
  type: string | null;
  subtype: string | null;
  iso_currency_code: string | null;
  unofficial_currency_code: string | null;
}
export type FakeInvestmentTransactionInput = Partial<FakeInvestmentTransaction> & { account_id: string };

/** What `signWebhook` returns: the exact body to send and the headers Plaid would send with it. */
export interface SignedWebhook {
  body: string;
  headers: Record<string, string>;
}

/** Ways to sign a webhook wrongly, for the verifier's tests. */
export interface SignWebhookOptions {
  /** `iat` in Unix seconds. Default: the fake's `now`. */
  iat?: number;
  /** The header's `kid`. Default: the current key's. Signing still uses the current key. */
  kid?: string;
  /** The header's `alg`. Default `ES256`. `none` leaves the signature empty; anything else is still signed with ES256. */
  alg?: string;
  /** `request_body_sha256` as given instead of the body's. */
  bodySha256?: string;
  /** More claims (`exp`, `nbf`), or any claim replaced (a non-numeric `iat`). */
  claims?: Record<string, unknown>;
}

export type FakeTransactionInput = Partial<FakeTransaction> & { account_id: string };

/** OpenAPI `CreditCardLiability`. */
export interface FakeCreditLiability {
  account_id: string | null;
  aprs: unknown[];
  is_overdue: boolean | null;
  last_payment_amount: number | null;
  last_payment_date: string | null;
  last_statement_issue_date: string | null;
  last_statement_balance: number | null;
  minimum_payment_amount: number | null;
  next_payment_due_date: string | null;
}

/** OpenAPI `JWKPublicKey`. Tests add keys with `addWebhookKey`; the fake serves them by `kid`. */
export interface FakeWebhookKey {
  alg: string;
  crv: string;
  kid: string;
  kty: string;
  use?: string;
  x: string;
  y: string;
  created_at?: number;
  expired_at: number | null;
}

/** What `completeLink` returns: `onSuccess`'s arguments (Link Web, research §3.2). */
export interface FakeLinkResult {
  publicToken: string;
  metadata: {
    institution: FakeInstitution | null;
    accounts: { id: string; name: string; mask: string | null; type: string; subtype: string | null }[];
    link_session_id: string;
  };
}

type Change =
  | { kind: 'added' | 'modified'; tx: FakeTransaction }
  | { kind: 'removed'; tx: { transaction_id: string; account_id: string } };

/** One Item, for assertions. Change it through the helpers, not directly. */
export interface FakeItem {
  itemId: string;
  /** Null until the public token is exchanged. */
  accessToken: string | null;
  institution: FakeInstitution | null;
  accounts: FakeAccount[];
  /** The `webhook` its link token was created with. */
  webhook: string | null;
  consentExpirationTime: string | null;
  removed: boolean;
  /** An Item error every data call answers with until update mode (or `repairItem`) clears it. */
  error: FakePlaidError | null;
  /** The transactions as they stand now, by id. */
  readonly transactions: Map<string, FakeTransaction>;
  /** Every change, in order. A cursor is a position in it. */
  readonly log: Change[];
  /** False: `/transactions/sync` without a cursor answers empty with `next_cursor: ""` and `NOT_READY` (research §5.2). */
  ready: boolean;
  transactionsUpdateStatus: string;
  readonly liabilities: Map<string, FakeCreditLiability>;
  /** `/transactions/sync` calls answered so far, and the call numbers that fail with a mutation error. */
  syncCalls: number;
  readonly mutationAt: number[];
  /** Investment transactions as they stand, by id. */
  readonly investmentTransactions: Map<string, FakeInvestmentTransaction>;
  /** False: `/investments/transactions/get` answers PRODUCTS_NOT_SUPPORTED (Fidelity without Investments, or linked without it). */
  investmentsSupported: boolean;
}

interface LinkToken {
  body: Record<string, unknown>;
  itemId: string | null;
  expiresAt: number;
  used: boolean;
}

interface PublicToken {
  itemId: string;
  expiresAt: number;
  used: boolean;
  /** Update mode's `onSuccess` public token: there's nothing to exchange (research §2.4). */
  update: boolean;
}

/** A queued failure, for the next call to `path`; with `itemId`, only that Item's next call (review C-M10). */
type Failure = { path: FakePlaidPath; itemId?: string } & ({ kind: 'error'; error: FakePlaidError } | { kind: 'drop' } | { kind: 'hang' } | { kind: 'delay'; ms: number });

/** Which calls a queued failure is for: `itemId` limits it to one Item's. */
export interface FailureTarget {
  itemId?: string;
}

const PATHS = new Set<string>([
  '/link/token/create', '/item/public_token/exchange', '/item/get', '/item/remove', '/accounts/get', '/transactions/sync',
  '/liabilities/get', '/webhook_verification_key/get', '/investments/transactions/get',
]);

function hex(bytes = 12): string {
  return randomBytes(bytes).toString('hex');
}

function b64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function isoSeconds(ms: number): string {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * A place in an Item's change log, and, while the first full history is being paged, how far into
 * that history (`snapshot`, null after it). Opaque to the app.
 */
interface Cursor {
  itemId: string;
  pos: number;
  snapshot: number | null;
  /** In the middle of a pagination run: the log's length when the run began (for `strictMutation`). */
  runLog: number | null;
}

function encodeCursor(itemId: string, pos: number, snapshot: number | null = null, runLog: number | null = null): string {
  return Buffer.from(JSON.stringify({
    i: itemId, p: pos, ...(snapshot === null ? {} : { s: snapshot }), ...(runLog === null ? {} : { l: runLog }), n: hex(4),
  })).toString('base64url');
}

function decodeCursor(cursor: string): Cursor | null {
  try {
    const v = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { i?: unknown; p?: unknown; s?: unknown; l?: unknown };
    const nat = (x: unknown): x is number => Number.isInteger(x) && (x as number) >= 0;
    if (typeof v.i !== 'string' || !nat(v.p) || (v.s !== undefined && !nat(v.s)) || (v.l !== undefined && !nat(v.l))) return null;
    return { itemId: v.i, pos: v.p, snapshot: v.s === undefined ? null : (v.s as number), runLog: v.l === undefined ? null : (v.l as number) };
  } catch {
    return null;
  }
}

/** The transactions as they stood after the first `pos` changes, ordered by their last change. */
function snapshotAt(log: readonly Change[], pos: number): FakeTransaction[] {
  const state = new Map<string, FakeTransaction>();
  for (const change of log.slice(0, pos)) {
    // Re-inserting moves a changed transaction to the end: the order is by last change.
    state.delete(change.tx.transaction_id);
    if (change.kind !== 'removed') state.set(change.tx.transaction_id, change.tx);
  }
  return [...state.values()];
}

export class FakePlaid {
  /** Every request that reached a known path: its path and JSON body. Never headers. */
  readonly requests: { path: FakePlaidPath; body: Record<string, unknown> }[] = [];
  readonly items = new Map<string, FakeItem>();
  readonly webhookKeys = new Map<string, FakeWebhookKey>();
  /** Access tokens issued by the exchange: the Trial counts these (research §9). */
  itemsCreated = 0;
  /** Items `/item/remove` was called for, in order. */
  readonly removals: string[] = [];
  /** `sandbox` or `production`: the prefix of the tokens it issues. */
  env = 'sandbox';
  /** When set, only this origin answers; anything else is a 404, so a wrong base URL fails loudly. */
  origin: string | null = null;
  now: () => number = () => Date.now();
  /**
   * When set, the exchange answers `TRIAL_CONNECTION_LIMIT` once this many access tokens have been
   * issued (`itemsCreated`), as Plaid's Trial does at 10 (research §9).
   */
  trialLimit: number | null = null;
  /**
   * Opt-in: `/transactions/sync` answers `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION` when the
   * Item's change log grew since the pagination run began (the page that started it, from no
   * cursor or a cursor that ended a run), as Plaid can (research §5.2). Off, a change made mid-run
   * is just delivered later, which most tests want.
   */
  strictMutation = false;
  /**
   * Called for each request to a known path once it's recorded, before anything else: an answer
   * returned is sent instead of the fake's own (an odd page, say), and it can change the fake's
   * state between one page and the next. Synthetic answers only.
   */
  intercept: ((path: FakePlaidPath, body: Record<string, unknown>) => Response | undefined) | null = null;
  /**
   * False: this client hasn't got Investments (research plaid-savings §8): a link token asking for
   * it, in any product list, and every `/investments/transactions/get`, answer INVALID_PRODUCT.
   */
  investmentsEnabled = true;

  private readonly failures: Failure[] = [];
  private signingKey: { kid: string; privateKey: KeyObject } | null = null;
  private readonly linkTokens = new Map<string, LinkToken>();
  private readonly publicTokens = new Map<string, PublicToken>();
  private readonly accessTokens = new Map<string, string>();

  constructor(
    readonly clientId = FAKE_PLAID_CLIENT_ID,
    readonly secret = FAKE_PLAID_SECRET,
  ) {}

  /** Drop-in `fetch` for PlaidClient. */
  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => this.handle(new Request(input, init));

  /** The body of the last request to `path`, or undefined. */
  lastBody(path: FakePlaidPath): Record<string, unknown> | undefined {
    return this.requests.filter((r) => r.path === path).at(-1)?.body;
  }

  /** How many requests reached `path`; with `itemId`, only those whose access token is that Item's. */
  count(path: FakePlaidPath, itemId?: string): number {
    return this.requests.filter((r) => r.path === path && (itemId === undefined || this.accessTokens.get(String(r.body.access_token)) === itemId)).length;
  }

  /** The next call to `path` (with `itemId`, that Item's next) gets this Plaid error. Calls queue in order. */
  failNext(path: FakePlaidPath, error: FakePlaidError, target: FailureTarget = {}): void {
    this.failures.push({ path, kind: 'error', error, ...this.target(target) });
  }

  /** The next call to `path` (or that Item's) fails as if the connection dropped (`fetch` rejects). */
  dropNext(path: FakePlaidPath, target: FailureTarget = {}): void {
    this.failures.push({ path, kind: 'drop', ...this.target(target) });
  }

  /** The next call to `path` (or that Item's) never answers: it rejects only when the caller's signal aborts (a timeout). */
  hangNext(path: FakePlaidPath, target: FailureTarget = {}): void {
    this.failures.push({ path, kind: 'hang', ...this.target(target) });
  }

  /** The next call to `path` (or that Item's) waits `ms` first (or until the caller's signal aborts), then is answered as usual. */
  delayNext(path: FakePlaidPath, ms: number, target: FailureTarget = {}): void {
    this.failures.push({ path, kind: 'delay', ms, ...this.target(target) });
  }

  /** An Item a failure is for must be one the fake has, so a typo can't make a failure that never fires. */
  private target(t: FailureTarget): { itemId?: string } {
    if (t.itemId === undefined) return {};
    this.item(t.itemId);
    return { itemId: t.itemId };
  }

  /** The Item a call is for: by its access token, or for the exchange, its public token. Null for a new link token. */
  private callItemId(body: Record<string, unknown>): string | null {
    if (typeof body.access_token === 'string') return this.accessTokens.get(body.access_token) ?? null;
    if (typeof body.public_token === 'string') return this.publicTokens.get(body.public_token)?.itemId ?? null;
    return null;
  }

  /** Drops every queued failure, drop, hang and delay: a test starts with none left over from another. Says how many there were. */
  clearFailures(): number {
    return this.failures.splice(0).length;
  }

  /**
   * The admin finishing Link with a link token: returns what `onSuccess` gets. In new mode it makes
   * an Item that isn't usable until its public token is exchanged; in update mode it clears the
   * Item's error and, when `accounts` is given, replaces its accounts (BofA's Account Select is
   * always on in update mode, research §2.4). Throws for an unknown, used, or expired link token.
   */
  completeLink(linkToken: string, opts: { institution?: FakeInstitution | null; accounts?: FakeAccountInput[] } = {}): FakeLinkResult {
    const lt = this.linkTokens.get(linkToken);
    if (!lt) throw new Error('FakePlaid: unknown link token');
    if (lt.used) throw new Error('FakePlaid: link token already used');
    if (lt.expiresAt <= this.now()) throw new Error('FakePlaid: link token expired');
    lt.used = true;
    let item: FakeItem;
    if (lt.itemId) {
      item = this.items.get(lt.itemId)!;
      if (opts.accounts) item.accounts = opts.accounts.map((a) => this.account(a));
      if (opts.institution !== undefined) item.institution = opts.institution;
      item.error = null;
    } else {
      item = this.newItem(opts.institution === undefined ? { institution_id: 'ins_fake_1', name: 'Example Bank' } : opts.institution, opts.accounts);
      item.webhook = typeof lt.body.webhook === 'string' ? lt.body.webhook : null;
      item.investmentsSupported = this.linkAskedForInvestments(lt.body);
    }
    const publicToken = `public-${this.env}-${hex()}`;
    this.publicTokens.set(publicToken, { itemId: item.itemId, expiresAt: this.now() + 30 * 60_000, used: false, update: lt.itemId !== null });
    return {
      publicToken,
      metadata: {
        institution: item.institution ? { ...item.institution } : null,
        accounts: item.accounts.map((a) => ({ id: a.account_id, name: a.name, mask: a.mask, type: a.type, subtype: a.subtype })),
        link_session_id: `session-${hex(8)}`,
      },
    };
  }

  /**
   * What a link token was made with, for the fake Link (fakePlaidHttp.ts): the `/link/token/create`
   * body, the Item in update mode (null for a new one), and whether Link can still finish with it.
   * Undefined for a token the fake didn't issue.
   */
  linkToken(linkToken: string): { body: Record<string, unknown>; itemId: string | null; usable: boolean } | undefined {
    const lt = this.linkTokens.get(linkToken);
    if (!lt) return undefined;
    return { body: structuredClone(lt.body), itemId: lt.itemId, usable: !lt.used && lt.expiresAt > this.now() };
  }

  /** An Item that has been through Link and the exchange, for tests that start after linking. */
  createItem(
    opts: { institution?: FakeInstitution | null; accounts?: FakeAccountInput[]; webhook?: string | null; investments?: boolean } = {},
  ): FakeItem & { accessToken: string } {
    const item = this.newItem(opts.institution === undefined ? { institution_id: 'ins_fake_1', name: 'Example Bank' } : opts.institution, opts.accounts);
    item.webhook = opts.webhook ?? null;
    item.investmentsSupported = opts.investments ?? true;
    item.accessToken = this.issueAccessToken(item.itemId);
    return item as FakeItem & { accessToken: string };
  }

  item(itemId: string): FakeItem {
    const item = this.items.get(itemId);
    if (!item) throw new Error(`FakePlaid: no Item ${itemId}`);
    return item;
  }

  setConsentExpiration(itemId: string, value: string | null): void {
    this.item(itemId).consentExpirationTime = value;
  }

  /** Puts the Item in an error state (`ITEM_LOGIN_REQUIRED` by default) until update mode or `repairItem`. */
  breakItem(itemId: string, error: FakePlaidError = FAKE_PLAID_ERRORS.ITEM_LOGIN_REQUIRED): void {
    this.item(itemId).error = error;
  }

  repairItem(itemId: string): void {
    this.item(itemId).error = null;
  }

  /** While not ready, sync answers empty with `next_cursor: ""` (research §5.2). */
  setReady(itemId: string, ready: boolean, status = ready ? 'HISTORICAL_UPDATE_COMPLETE' : 'NOT_READY'): void {
    const item = this.item(itemId);
    item.ready = ready;
    item.transactionsUpdateStatus = status;
  }

  /**
   * The `pageIndex`-th `/transactions/sync` call for this Item from now on (0 is the next one)
   * fails once with `TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION`, and the log is left as it is.
   */
  failMutationOnce(itemId: string, pageIndex: number): void {
    const item = this.item(itemId);
    item.mutationAt.push(item.syncCalls + pageIndex);
  }

  /** A new transaction at the bank, logged as `added`. Defaults are synthetic. */
  addTransaction(itemId: string, fields: FakeTransactionInput): FakeTransaction {
    const item = this.item(itemId);
    if (!item.accounts.some((a) => a.account_id === fields.account_id)) throw new Error('FakePlaid: account not on that Item');
    const tx: FakeTransaction = {
      transaction_id: `tx-${hex()}`,
      amount: 12.34,
      iso_currency_code: 'USD',
      unofficial_currency_code: null,
      date: '2026-11-01',
      authorized_date: null,
      pending: false,
      pending_transaction_id: null,
      merchant_name: null,
      name: 'SYNTHETIC MERCHANT',
      original_description: null,
      personal_finance_category: { primary: 'FOOD_AND_DRINK', detailed: 'FOOD_AND_DRINK_COFFEE', confidence_level: 'VERY_HIGH', version: 'v2' },
      merchant_entity_id: null,
      logo_url: null,
      counterparties: [],
      ...fields,
    };
    if (item.transactions.has(tx.transaction_id)) throw new Error('FakePlaid: transaction id already used');
    item.transactions.set(tx.transaction_id, tx);
    item.log.push({ kind: 'added', tx: structuredClone(tx) });
    return tx;
  }

  /** The bank changed a transaction: logged as `modified` with its new state. */
  modifyTransaction(transactionId: string, changes: Partial<Omit<FakeTransaction, 'transaction_id'>>): FakeTransaction {
    const { item, tx } = this.find(transactionId);
    Object.assign(tx, changes);
    item.log.push({ kind: 'modified', tx: structuredClone(tx) });
    return tx;
  }

  /** The transaction is gone: logged as `removed`, with only its id and account (research §5.2). */
  removeTransaction(transactionId: string): void {
    const { item, tx } = this.find(transactionId);
    item.transactions.delete(transactionId);
    item.log.push({ kind: 'removed', tx: { transaction_id: tx.transaction_id, account_id: tx.account_id } });
  }

  /**
   * A pending transaction posts (research spend-plaid-csv §3): the pending one is `removed` and a
   * new posted one is `added` with `pending_transaction_id` naming it. `removedFirst: false` logs
   * the added one first, since Plaid doesn't promise an order or a page.
   */
  postPending(pendingId: string, posted: Partial<FakeTransaction> = {}, opts: { removedFirst?: boolean } = {}): FakeTransaction {
    const { item, tx: pending } = this.find(pendingId);
    if (!pending.pending) throw new Error('FakePlaid: that transaction is not pending');
    const next: FakeTransaction = {
      ...structuredClone(pending),
      ...posted,
      transaction_id: posted.transaction_id ?? `tx-${hex()}`,
      pending: false,
      pending_transaction_id: pendingId,
    };
    this.replace(item, pending, next, opts.removedFirst ?? true);
    return next;
  }

  /**
   * Churn (research §5.3): the bank changed a transaction so much that Plaid removes it and adds
   * it again under a new id, with no link between the two.
   */
  churn(oldId: string, newId: string, changes: Partial<Omit<FakeTransaction, 'transaction_id'>> = {}, opts: { removedFirst?: boolean } = {}): FakeTransaction {
    const { item, tx: old } = this.find(oldId);
    const next: FakeTransaction = { ...structuredClone(old), pending_transaction_id: null, ...changes, transaction_id: newId };
    this.replace(item, old, next, opts.removedFirst ?? true);
    return next;
  }

  /** The account's `liabilities.credit` entry. Unset fields are null, as Plaid sends them when the bank doesn't. */
  setLiability(itemId: string, accountId: string, fields: Partial<Omit<FakeCreditLiability, 'account_id'>>): void {
    this.item(itemId).liabilities.set(accountId, {
      account_id: accountId, aprs: [], is_overdue: null, last_payment_amount: null, last_payment_date: null, last_statement_issue_date: null,
      last_statement_balance: null, minimum_payment_amount: null, next_payment_due_date: null, ...fields,
    });
  }

  /** The account's balances, as `/accounts/get` lists them. */
  setBalance(itemId: string, accountId: string, balances: { current: number | null; available?: number | null }): void {
    const account = this.item(itemId).accounts.find((a) => a.account_id === accountId);
    if (!account) throw new Error('FakePlaid: account not on that Item');
    account.current = balances.current;
    if (balances.available !== undefined) account.available = balances.available;
  }

  /** An investment transaction at the brokerage. Defaults are synthetic: a $100 cash deposit. */
  addInvestmentTransaction(itemId: string, fields: FakeInvestmentTransactionInput): FakeInvestmentTransaction {
    const item = this.item(itemId);
    if (!item.accounts.some((a) => a.account_id === fields.account_id)) throw new Error('FakePlaid: account not on that Item');
    const tx: FakeInvestmentTransaction = {
      investment_transaction_id: `itx-${hex()}`, security_id: null, date: '2026-11-01', transaction_datetime: null, name: 'SYNTHETIC INVESTMENT ACTIVITY',
      quantity: 0, amount: -100, price: 0, fees: null, type: 'cash', subtype: 'deposit', iso_currency_code: 'USD', unofficial_currency_code: null, ...fields,
    };
    if (item.investmentTransactions.has(tx.investment_transaction_id)) throw new Error('FakePlaid: investment transaction id already used');
    item.investmentTransactions.set(tx.investment_transaction_id, tx);
    return tx;
  }

  /** Plaid cancelled it: it's gone from every later answer. */
  removeInvestmentTransaction(id: string): void {
    for (const item of this.items.values()) if (item.investmentTransactions.delete(id)) return;
    throw new Error(`FakePlaid: no investment transaction ${id}`);
  }

  setInvestmentsSupported(itemId: string, supported: boolean): void {
    this.item(itemId).investmentsSupported = supported;
  }

  addWebhookKey(key: FakeWebhookKey): void {
    this.webhookKeys.set(key.kid, key);
  }

  /** The `kid` webhooks are signed with now. The first key is made on first use. */
  get webhookKid(): string {
    return this.currentSigningKey().kid;
  }

  /**
   * Plaid starts signing with a new key (research §7.2). The old one is still served by its `kid`,
   * with `expired_at` set when `expirePrevious` is given (Unix seconds; `true` means now).
   */
  rotateKey(opts: { expirePrevious?: boolean | number } = {}): string {
    const previous = this.signingKey;
    this.signingKey = null;
    if (previous && opts.expirePrevious !== undefined && opts.expirePrevious !== false) {
      this.expireKey(previous.kid, opts.expirePrevious === true ? Math.floor(this.now() / 1000) : opts.expirePrevious);
    }
    return this.webhookKid;
  }

  /** Sets a served key's `expired_at` (Unix seconds). */
  expireKey(kid: string, expiredAt: number): void {
    const key = this.webhookKeys.get(kid);
    if (!key) throw new Error('FakePlaid: no such webhook key');
    key.expired_at = expiredAt;
  }

  /**
   * A webhook as Plaid sends it: the body (JSON with 2-space indents, as Plaid's are, unless a
   * string is given, which is sent byte for byte) and a `Plaid-Verification` JWT over it.
   */
  signWebhook(payload: unknown, opts: SignWebhookOptions = {}): SignedWebhook {
    const body = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
    const key = this.currentSigningKey();
    const alg = opts.alg ?? 'ES256';
    const header = { alg, kid: opts.kid ?? key.kid, typ: 'JWT' };
    const claims = {
      iat: opts.iat ?? Math.floor(this.now() / 1000),
      request_body_sha256: opts.bodySha256 ?? createHash('sha256').update(body, 'utf8').digest('hex'),
      ...opts.claims,
    };
    const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
    // JWS ES256 signatures are raw r || s, which node:crypto calls ieee-p1363.
    const signature = alg === 'none' ? '' : sign('sha256', Buffer.from(input), { key: key.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
    return { body, headers: { 'Content-Type': 'application/json', 'Plaid-Verification': `${input}.${signature}` } };
  }

  /** Sends a signed webhook to `url` over HTTP, as Plaid would (for the Playwright server and its tests). */
  fireWebhook(url: string, payload: unknown, opts: SignWebhookOptions = {}): Promise<Response> {
    const { body, headers } = this.signWebhook(payload, opts);
    return fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(10_000) });
  }

  private currentSigningKey(): { kid: string; privateKey: KeyObject } {
    if (this.signingKey) return this.signingKey;
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = publicKey.export({ format: 'jwk' });
    const kid = randomUUID();
    this.webhookKeys.set(kid, {
      alg: 'ES256', crv: 'P-256', kid, kty: 'EC', use: 'sig', x: jwk.x!, y: jwk.y!, created_at: Math.floor(this.now() / 1000), expired_at: null,
    });
    this.signingKey = { kid, privateKey };
    return this.signingKey;
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if ((this.origin && url.origin !== this.origin) || req.method !== 'POST' || !PATHS.has(url.pathname)) return new Response('Not found', { status: 404 });
    const path = url.pathname as FakePlaidPath;
    let body: Record<string, unknown>;
    try {
      const parsed: unknown = await req.json();
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
      body = parsed as Record<string, unknown>;
    } catch {
      return this.error({ status: 400, error_type: 'INVALID_REQUEST', error_code: 'INVALID_BODY' });
    }
    this.requests.push({ path, body: structuredClone(body) });
    const intercepted = this.intercept?.(path, body);
    if (intercepted) return intercepted;

    // A dropped or unanswered request never reaches Plaid, so it fails before any check. An
    // injected Plaid error is Plaid's answer, so it comes only after the credentials pass.
    const callItem = this.callItemId(body);
    const i = this.failures.findIndex((f) => f.path === path && (f.itemId === undefined || f.itemId === callItem));
    let failure = i >= 0 ? this.failures[i]! : null;
    if (failure && failure.kind === 'delay') {
      this.failures.splice(i, 1);
      const { ms } = failure;
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, ms);
        req.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(req.signal.reason);
        }, { once: true });
      });
      // Then answered as usual: a failure queued behind it is for a later call.
      failure = null;
    } else if (failure && failure.kind !== 'error') {
      this.failures.splice(i, 1);
      if (failure.kind === 'drop') throw new TypeError('fetch failed');
      return new Promise<Response>((_, reject) => {
        if (req.signal.aborted) reject(req.signal.reason);
        req.signal.addEventListener('abort', () => reject(req.signal.reason), { once: true });
      });
    }

    if (req.headers.get('plaid-client-id') !== this.clientId || req.headers.get('plaid-secret') !== this.secret) {
      return this.error({ status: 400, error_type: 'INVALID_INPUT', error_code: 'INVALID_API_KEYS' });
    }
    if (req.headers.get('plaid-version') !== PLAID_VERSION || !req.headers.get('content-type')?.startsWith('application/json')) {
      return this.error({ status: 400, error_type: 'INVALID_REQUEST', error_code: 'INVALID_HEADERS' });
    }
    if (failure) {
      this.failures.splice(i, 1);
      return this.error(failure.error);
    }

    switch (path) {
      case '/link/token/create':
        return this.linkTokenCreate(body);
      case '/item/public_token/exchange':
        return this.exchange(body);
      case '/item/get':
        return this.withItem(body, { allowError: true }, (item) => json({ item: this.itemJson(item), status: null, request_id: this.requestId() }));
      case '/item/remove':
        return this.withItem(body, { allowError: true }, (item) => {
          item.removed = true;
          this.removals.push(item.itemId);
          return json({ request_id: this.requestId() });
        });
      case '/accounts/get':
        return this.withItem(body, {}, (item) => json({ accounts: this.accountsJson(item), item: this.itemJson(item), request_id: this.requestId() }));
      case '/transactions/sync':
        return this.withItem(body, {}, (item) => this.sync(item, body));
      case '/investments/transactions/get':
        return this.withItem(body, {}, (item) => this.investmentTransactions(item, body));
      case '/liabilities/get':
        return this.withItem(body, {}, (item) => {
          const credit = item.accounts.flatMap((a) => (item.liabilities.has(a.account_id) ? [structuredClone(item.liabilities.get(a.account_id)!)] : []));
          if (credit.length === 0) return this.error(FAKE_PLAID_ERRORS.NO_LIABILITY_ACCOUNTS);
          return json({
            accounts: this.accountsJson(item), item: this.itemJson(item), liabilities: { credit, mortgage: null, student: null }, request_id: this.requestId(),
          });
        });
      case '/webhook_verification_key/get': {
        const key = typeof body.key_id === 'string' ? this.webhookKeys.get(body.key_id) : undefined;
        // UNVERIFIED: what Plaid answers for a key id it doesn't know. The fake says the field is invalid.
        if (!key) return this.error({ status: 400, error_type: 'INVALID_REQUEST', error_code: 'INVALID_FIELD' });
        return json({ key: { ...key }, request_id: this.requestId() });
      }
    }
  }

  private linkTokenCreate(body: Record<string, unknown>): Response {
    const user = body.user as { client_user_id?: unknown } | undefined;
    if (typeof body.client_name !== 'string' || typeof body.language !== 'string' || !Array.isArray(body.country_codes) || typeof user?.client_user_id !== 'string') {
      return this.error({ status: 400, error_type: 'INVALID_REQUEST', error_code: 'MISSING_FIELDS' });
    }
    let itemId: string | null = null;
    if (body.access_token !== undefined) {
      // Update mode (research §2.4): no products and no product fields; the account filter only
      // with Account Select on.
      if (body.products !== undefined || body.required_if_supported_products !== undefined || body.transactions !== undefined) {
        return this.error({ status: 400, error_type: 'INVALID_REQUEST', error_code: 'INVALID_FIELD' });
      }
      const update = body.update as { account_selection_enabled?: unknown } | undefined;
      if (body.account_filters !== undefined && update?.account_selection_enabled !== true) {
        return this.error({ status: 400, error_type: 'INVALID_REQUEST', error_code: 'INVALID_FIELD' });
      }
      const found = this.lookup(body.access_token);
      if ('error' in found) return this.error(found.error);
      itemId = found.item.itemId;
    } else if (!Array.isArray(body.products) || body.products.length === 0) {
      return this.error({ status: 400, error_type: 'INVALID_REQUEST', error_code: 'MISSING_FIELDS' });
    } else if (body.update !== undefined) {
      return this.error({ status: 400, error_type: 'INVALID_REQUEST', error_code: 'INVALID_FIELD' });
    }
    if (!this.investmentsEnabled && this.linkAskedForInvestments(body)) return this.error(FAKE_PLAID_ERRORS.INVALID_PRODUCT);
    // A link token for a new Item lasts 4 hours, one for update mode 30 minutes (research §2.5).
    const expiresAt = this.now() + (itemId ? 30 * 60_000 : 4 * 3600_000);
    const linkToken = `link-${this.env}-${hex()}`;
    this.linkTokens.set(linkToken, { body: structuredClone(body), itemId, expiresAt, used: false });
    return json({ link_token: linkToken, expiration: isoSeconds(expiresAt), request_id: this.requestId() });
  }

  private exchange(body: Record<string, unknown>): Response {
    const pt = typeof body.public_token === 'string' ? this.publicTokens.get(body.public_token) : undefined;
    if (!pt || pt.used || pt.update || pt.expiresAt <= this.now()) return this.error(FAKE_PLAID_ERRORS.INVALID_PUBLIC_TOKEN);
    if (this.trialLimit !== null && this.itemsCreated >= this.trialLimit) return this.error(FAKE_PLAID_ERRORS.TRIAL_CONNECTION_LIMIT);
    pt.used = true;
    const accessToken = this.issueAccessToken(pt.itemId);
    return json({ access_token: accessToken, item_id: pt.itemId, request_id: this.requestId() });
  }

  /**
   * One page. Without a cursor (or with `""`, which the fake reads the same way; UNVERIFIED for
   * Plaid, research "UNVERIFIED list"), it starts "the entire history": the transactions as they
   * stood at that moment, `count` at a time, all in `added`, ordered by their last change, with no
   * `modified` or `removed` and nothing a later change replaced. That snapshot is pinned to its
   * place in the log, so changes made while it's paged arrive after it, as changes. With a log
   * cursor, it's the next `count` changes after it, folded so each transaction appears once with
   * its latest state (in `added` if this page has its add, `removed` if its last change is a
   * removal, else `modified`), ordered by its last change.
   */
  private sync(item: FakeItem, body: Record<string, unknown>): Response {
    const count = body.count === undefined ? 100 : body.count;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 500) {
      return this.error({ status: 400, error_type: 'INVALID_REQUEST', error_code: 'INVALID_FIELD' });
    }
    let cursor: Cursor | null = null;
    if (typeof body.cursor === 'string' && body.cursor !== '') {
      cursor = decodeCursor(body.cursor);
      if (!cursor || cursor.itemId !== item.itemId || cursor.pos > item.log.length) {
        return this.error({ status: 400, error_type: 'INVALID_REQUEST', error_code: 'INVALID_FIELD' });
      }
    } else if (body.cursor !== undefined && body.cursor !== '') {
      return this.error({ status: 400, error_type: 'INVALID_REQUEST', error_code: 'INVALID_FIELD' });
    }
    const call = item.syncCalls++;
    const m = item.mutationAt.indexOf(call);
    if (m >= 0) {
      item.mutationAt.splice(m, 1);
      return this.error(FAKE_PLAID_ERRORS.TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION);
    }
    if (this.strictMutation && cursor?.runLog != null && item.log.length !== cursor.runLog) {
      return this.error(FAKE_PLAID_ERRORS.TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION);
    }
    // The log's length when this run began, carried in the cursors of its pages that have more.
    const runLog = cursor?.runLog ?? item.log.length;
    const base = { accounts: this.accountsJson(item), request_id: this.requestId(), transactions_update_status: item.transactionsUpdateStatus };
    // Before the first data, there's no cursor to give (research §5.2).
    if (!item.ready && cursor === null) return json({ ...base, added: [], modified: [], removed: [], next_cursor: '', has_more: false });

    if (cursor === null || cursor.snapshot !== null) {
      const pos = cursor?.pos ?? item.log.length;
      const offset = cursor?.snapshot ?? 0;
      const all = snapshotAt(item.log, pos);
      const page = all.slice(offset, offset + count).map((tx) => structuredClone(tx));
      const done = offset + page.length >= all.length;
      const hasMore = !done || pos < item.log.length;
      return json({
        ...base,
        added: page,
        modified: [],
        removed: [],
        next_cursor: encodeCursor(item.itemId, pos, done ? null : offset + page.length, hasMore ? runLog : null),
        has_more: hasMore,
      });
    }

    const pos = cursor.pos;
    const changes = item.log.slice(pos, pos + count);
    const last = new Map<string, { index: number; change: Change; addedHere: boolean }>();
    changes.forEach((change, index) => {
      const id = change.tx.transaction_id;
      const addedHere = (last.get(id)?.addedHere ?? false) || change.kind === 'added';
      last.delete(id);
      last.set(id, { index, change, addedHere });
    });
    const added: unknown[] = [];
    const modified: unknown[] = [];
    const removed: unknown[] = [];
    for (const { change, addedHere } of last.values()) {
      if (change.kind === 'removed') removed.push({ ...change.tx });
      else (addedHere ? added : modified).push(structuredClone(change.tx));
    }
    const next = pos + changes.length;
    const hasMore = next < item.log.length;
    return json({ ...base, added, modified, removed, next_cursor: encodeCursor(item.itemId, next, null, hasMore ? runLog : null), has_more: hasMore });
  }

  /** Whether a link token asked for Investments in any of its product lists. */
  private linkAskedForInvestments(body: Record<string, unknown>): boolean {
    return ['products', 'required_if_supported_products', 'optional_products', 'additional_consented_products']
      .some((k) => Array.isArray(body[k]) && (body[k] as unknown[]).includes('investments'));
  }

  /**
   * Research plaid-savings §3: the transactions dated in `start_date`..`end_date`, newest first (by
   * date, then id), `options.count` (1 to 500, default 100) from `options.offset`, with the total in
   * the window. Not enabled for the client: INVALID_PRODUCT; not on the Item: PRODUCTS_NOT_SUPPORTED.
   */
  private investmentTransactions(item: FakeItem, body: Record<string, unknown>): Response {
    if (!this.investmentsEnabled) return this.error(FAKE_PLAID_ERRORS.INVALID_PRODUCT);
    if (!item.investmentsSupported) return this.error(FAKE_PLAID_ERRORS.PRODUCTS_NOT_SUPPORTED);
    const date = /^\d{4}-\d{2}-\d{2}$/;
    if (typeof body.start_date !== 'string' || typeof body.end_date !== 'string' || !date.test(body.start_date) || !date.test(body.end_date) || body.start_date > body.end_date) {
      return this.error({ status: 400, error_type: 'INVALID_REQUEST', error_code: 'INVALID_FIELD' });
    }
    const options = (body.options ?? {}) as { count?: unknown; offset?: unknown };
    const count = options.count ?? 100;
    const offset = options.offset ?? 0;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 500 || typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) {
      return this.error({ status: 400, error_type: 'INVALID_REQUEST', error_code: 'INVALID_FIELD' });
    }
    const start = body.start_date;
    const end = body.end_date;
    const all = [...item.investmentTransactions.values()]
      .filter((t) => t.date >= start && t.date <= end)
      .sort((a, b) => b.date.localeCompare(a.date) || b.investment_transaction_id.localeCompare(a.investment_transaction_id));
    return json({
      accounts: this.accountsJson(item), item: this.itemJson(item), securities: [], request_id: this.requestId(),
      investment_transactions: all.slice(offset, offset + count).map((t) => structuredClone(t)),
      total_investment_transactions: all.length,
    });
  }

  private withItem(body: Record<string, unknown>, opts: { allowError?: boolean }, fn: (item: FakeItem) => Response): Response {
    const found = this.lookup(body.access_token);
    if ('error' in found) return this.error(found.error);
    if (found.item.error && !opts.allowError) return this.error(found.item.error);
    return fn(found.item);
  }

  private lookup(accessToken: unknown): { item: FakeItem } | { error: FakePlaidError } {
    if (typeof accessToken !== 'string') return { error: { status: 400, error_type: 'INVALID_REQUEST', error_code: 'MISSING_FIELDS' } };
    const itemId = this.accessTokens.get(accessToken);
    if (!itemId) return { error: FAKE_PLAID_ERRORS.INVALID_ACCESS_TOKEN };
    const item = this.items.get(itemId)!;
    if (item.removed) return { error: FAKE_PLAID_ERRORS.ITEM_NOT_FOUND };
    return { item };
  }

  private newItem(institution: FakeInstitution | null, accounts?: FakeAccountInput[]): FakeItem {
    const item: FakeItem = {
      itemId: `item-${hex()}`,
      accessToken: null,
      institution,
      accounts: (accounts ?? [{ name: 'Example Rewards Card', mask: '1111' }]).map((a) => this.account(a)),
      webhook: null,
      consentExpirationTime: null,
      removed: false,
      error: null,
      transactions: new Map(),
      log: [],
      ready: true,
      transactionsUpdateStatus: 'HISTORICAL_UPDATE_COMPLETE',
      liabilities: new Map(),
      syncCalls: 0,
      mutationAt: [],
      investmentTransactions: new Map(),
      investmentsSupported: true,
    };
    this.items.set(item.itemId, item);
    return item;
  }

  private account(a: FakeAccountInput): FakeAccount {
    return {
      account_id: a.account_id ?? `acct-${hex()}`,
      name: a.name,
      official_name: a.official_name ?? null,
      mask: a.mask === undefined ? null : a.mask,
      type: a.type ?? 'credit',
      subtype: a.subtype === undefined ? 'credit card' : a.subtype,
      iso_currency_code: a.iso_currency_code === undefined ? 'USD' : a.iso_currency_code,
      unofficial_currency_code: a.unofficial_currency_code ?? null,
      current: a.current === undefined ? 0 : a.current,
      available: a.available ?? null,
    };
  }

  private issueAccessToken(itemId: string): string {
    const accessToken = `access-${this.env}-${hex()}`;
    this.accessTokens.set(accessToken, itemId);
    this.items.get(itemId)!.accessToken = accessToken;
    this.itemsCreated++;
    return accessToken;
  }

  private find(transactionId: string): { item: FakeItem; tx: FakeTransaction } {
    for (const item of this.items.values()) {
      const tx = item.transactions.get(transactionId);
      if (tx) return { item, tx };
    }
    throw new Error(`FakePlaid: no transaction ${transactionId}`);
  }

  private replace(item: FakeItem, old: FakeTransaction, next: FakeTransaction, removedFirst: boolean): void {
    if (item.transactions.has(next.transaction_id)) throw new Error('FakePlaid: transaction id already used');
    const removal: Change = { kind: 'removed', tx: { transaction_id: old.transaction_id, account_id: old.account_id } };
    const addition: Change = { kind: 'added', tx: structuredClone(next) };
    item.transactions.delete(old.transaction_id);
    item.transactions.set(next.transaction_id, next);
    item.log.push(...(removedFirst ? [removal, addition] : [addition, removal]));
  }

  private itemJson(item: FakeItem): Record<string, unknown> {
    return {
      item_id: item.itemId,
      institution_id: item.institution?.institution_id ?? null,
      institution_name: item.institution?.name ?? null,
      webhook: item.webhook,
      error: item.error ? this.errorBody(item.error) : null,
      available_products: [],
      billed_products: ['transactions', 'liabilities'],
      products: ['transactions', 'liabilities'],
      consented_products: ['transactions', 'liabilities'],
      consent_expiration_time: item.consentExpirationTime,
      update_type: 'background',
    };
  }

  private accountsJson(item: FakeItem): unknown[] {
    return item.accounts.map((a) => ({
      account_id: a.account_id,
      balances: { available: a.available, current: a.current, limit: null, iso_currency_code: a.iso_currency_code, unofficial_currency_code: a.unofficial_currency_code },
      mask: a.mask,
      name: a.name,
      official_name: a.official_name,
      type: a.type,
      subtype: a.subtype,
    }));
  }

  /** OpenAPI `PlaidError`, with the fields research §8.1 lists. The messages are synthetic and not for programs. */
  private errorBody(e: FakePlaidError): Record<string, unknown> {
    return {
      error_type: e.error_type,
      error_code: e.error_code,
      error_code_reason: null,
      error_message: 'Synthetic error from the fake Plaid.',
      display_message: null,
      request_id: this.requestId(),
      causes: [],
      documentation_url: 'https://plaid.com/docs/errors/',
      suggested_action: null,
    };
  }

  private error(e: FakePlaidError): Response {
    return json(this.errorBody(e), e.status);
  }

  private requestId(): string {
    return hex(8);
  }
}
