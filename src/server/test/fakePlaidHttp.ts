import { randomUUID } from 'node:crypto';
import {
  FAKE_PLAID_ERRORS, type FakeAccount, type FakeAccountInput, type FakeInstitution, type FakeItem, type FakePlaid, type FakePlaidError, type FakePlaidPath, type FakeTransaction,
  type FakeInvestmentTransaction,
} from './fakePlaid.js';

/**
 * FakePlaid over HTTP, for Playwright (fakePlaidServer.ts starts it; this module is apart so Vitest
 * can drive it without a port, fakePlaidHttp.test.ts). Two origins on one port, as
 * playwright.config.ts sets them: the app calls the API at `PLAID_API_BASE_URL` (`apiOrigin`), and
 * the browser loads `link-initialize.js` from `PLAID_LINK_SCRIPT_URL` (`scriptOrigin`). The API
 * answers only on `apiOrigin` and the script only on `scriptOrigin`, so a wrong URL fails loudly.
 *
 * **The fake Link.** `/link/v2/stable/link-initialize.js` defines `window.Plaid.create(config)`,
 * returning `{ open, exit, destroy }` (research §3.2). `open()` posts the link token and
 * `receivedRedirectUri` to `/__fake/link/complete` on `apiOrigin`, not on its own origin: the Link
 * page's CSP allows `connect-src` to the API's origin only (routes.ts `plaidLinkHeaders`), and in
 * the e2e setup the two origins differ. The answer is the next configured result (a success by
 * default), and the script calls `onSuccess(public_token, metadata)` or `onExit(error, metadata)`,
 * or for an OAuth result sends the browser to the link token's `redirect_uri` with an
 * `?oauth_state_id=`, where the return page opens Link again and must pass exactly that URL as
 * `receivedRedirectUri`. Misuse (an unknown or used link token, a wrong `receivedRedirectUri`) ends
 * in `onExit` with the fake's own `FAKE_LINK_FAILED` code, which isn't Plaid's, and a console error.
 *
 * **Controls** (`/__fake/*`, on either origin, JSON bodies; an Item defaults to the newest one that
 * was exchanged and isn't removed, and an account to `accountId`, else `mask`, else the first):
 * - `GET health`; `GET items` (`{ itemsCreated, removals, items }`, each Item with its accounts,
 *   transactions, error code, webhook, consent expiration); `GET requests?path=` (bodies the API got);
 *   `GET count?path=&itemId=` (`{ count }`: how many calls reached that path, only that Item's with
 *   `itemId`, matched by its access token inside the fake, so no token leaves it);
 * - `POST link/next` queues the next Link result: `{ outcome: 'success', institution?, accounts? }`,
 *   `{ outcome: 'exit', error?: { error_type, error_code, error_message?, display_message? } | null, status? }`,
 *   or `{ outcome: 'oauth' }`. `GET link/sessions` lists each Link run: its mode, Item,
 *   `receivedRedirectUri`, outcome and `/link/token/create` body;
 * - `POST transactions/add` (`{ itemId?, accountId?, mask?, ...transaction fields }`),
 *   `transactions/modify` (`{ transactionId, changes }`), `transactions/remove` (`{ transactionId }`),
 *   `transactions/post` (`{ pendingId, posted?, removedFirst? }`), `transactions/churn`
 *   (`{ oldId, newId, changes?, removedFirst? }`): each answers the transaction;
 * - `POST liabilities` (`{ itemId?, accountId?, mask?, fields }`);
 * - `POST balances` (`{ itemId?, accountId?, mask?, current, available? }`), `investments/add`
 *   (`{ itemId?, accountId?, mask?, ...investment transaction fields }`, answers it),
 *   `items/investments` (`{ itemId?, supported }`), `investments-enabled` (`{ enabled }`): Savings;
 * - `POST items/break` (`{ itemId?, error? }`, an error name from FAKE_PLAID_ERRORS or a whole
 *   error; `ITEM_LOGIN_REQUIRED` by default), `items/repair`, `items/ready` (`{ ready, status? }`),
 *   `items/consent` (`{ consentExpirationTime }`);
 * - `POST fail` (`{ path, error, itemId? }`, or `{ path, drop: true, itemId? }`): the next call to that
 *   API path fails, or with `itemId`, that Item's next call to it (review C-M10);
 * - `POST delay` (`{ path, ms, itemId? }`, up to 60 000): the next call to that API path (or that
 *   Item's) waits that long, then is answered as usual (a slow Plaid);
 * - `POST reset-queues` (`{}`): drops every queued Link result, failure and delay, so a test starts
 *   with none left over from one that failed before using them. Items and logs stay;
 * - `POST webhook` (`{ payload, url?, itemId? }`): a signed webhook to `url`, else the Item's own
 *   webhook, else `webhookUrl`; `item_id` is filled in from the Item, and `environment` from the
 *   fake's, when the payload has none. The body is signed and sent byte for byte as
 *   `signWebhook` makes it. Answers `{ status }`, the app's HTTP status.
 *
 * The API itself is FakePlaid's, unchanged: the request's headers and body reach it as sent, and
 * its status and body go back as it answered them. A `dropNext` closes the connection unanswered.
 *
 * Everything is synthetic, and nothing here logs a token or a body.
 */

export interface FakePlaidHttpOptions {
  /** Where the app calls the API (`PLAID_API_BASE_URL`), and where the fake Link calls back. */
  apiOrigin: string;
  /** Where the browser loads `link-initialize.js` (`PLAID_LINK_SCRIPT_URL`'s origin). */
  scriptOrigin: string;
  /** Where `POST /__fake/webhook` sends a webhook when neither the call nor the Item names one. */
  webhookUrl?: string | null;
}

/** Link's `onExit` error (research §3.2): a Plaid error's fields. */
export interface FakeLinkError {
  error_type: string;
  error_code: string;
  error_message?: string;
  display_message?: string | null;
}

/** How the next Link run ends, as `POST /__fake/link/next` sets it. */
export type FakeLinkResultConfig =
  | { outcome: 'success'; institution?: FakeInstitution | null; accounts?: FakeAccountInput[] }
  | { outcome: 'exit'; error?: FakeLinkError | null; status?: string | null }
  | { outcome: 'oauth' };

/** One Link run, for `GET /__fake/link/sessions`. */
export interface FakeLinkSession {
  mode: 'new' | 'update';
  /** The Item reconnected, or the new one once Link made it (null until then). */
  itemId: string | null;
  receivedRedirectUri: string | null;
  outcome: 'success' | 'exit' | 'oauth' | 'failed';
  linkTokenRequest: Record<string, unknown>;
}

export const FAKE_LINK_SCRIPT_PATH = '/link/v2/stable/link-initialize.js';

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'POST', 'access-control-allow-headers': 'content-type' };

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function linkScript(completeUrl: string): string {
  return `// The fake Plaid Link (src/server/test/fakePlaidHttp.ts). Test-only.
(() => {
  const completeUrl = ${JSON.stringify(completeUrl)};
  const failed = (message) => ({ error_type: 'FAKE_LINK', error_code: 'FAKE_LINK_FAILED', error_message: message, display_message: null });
  window.Plaid = {
    create(config) {
      let state = 'ready';
      const end = (fn) => {
        if (state !== 'open') return;
        state = 'done';
        fn();
      };
      return {
        open() {
          if (state !== 'ready') return;
          state = 'open';
          fetch(completeUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ linkToken: config.token, receivedRedirectUri: config.receivedRedirectUri ?? null }),
          })
            .then(async (res) => {
              const body = await res.json().catch(() => null);
              if (!res.ok || !body) throw new Error((body && body.error) || 'HTTP ' + res.status);
              return body;
            })
            .then((r) => {
              if (r.outcome === 'success') end(() => config.onSuccess(r.publicToken, r.metadata));
              else if (r.outcome === 'redirect') end(() => window.location.assign(r.url));
              else end(() => config.onExit(r.error ?? null, r.metadata));
            })
            .catch((err) => {
              console.error('fake Plaid Link: ' + err.message);
              end(() => config.onExit(failed(err.message), { institution: null, status: null, link_session_id: null }));
            });
        },
        exit() {
          end(() => config.onExit(null, { institution: null, status: null, link_session_id: null }));
        },
        destroy() {
          state = 'destroyed';
        },
      };
    },
  };
})();
`;
}

export class FakePlaidHttp {
  /** Results for the next Link runs, in order. Empty: a success with the fake's defaults. */
  readonly linkResults: FakeLinkResultConfig[] = [];
  readonly linkSessions: FakeLinkSession[] = [];
  /** Link tokens sent to the bank, with the exact URL the bank sends the browser back to. */
  private readonly oauth = new Map<string, string>();
  private readonly script: string;

  constructor(readonly fake: FakePlaid, readonly opts: FakePlaidHttpOptions) {
    fake.origin = opts.apiOrigin;
    this.script = linkScript(`${opts.apiOrigin}/__fake/link/complete`);
  }

  /**
   * The fetch handler, for `@hono/node-server`'s `serve` (which passes the Node response as
   * `env.outgoing`, used to drop a connection) or called directly in Vitest.
   */
  readonly handle = async (req: Request, env?: { outgoing?: { destroy(): void } }): Promise<Response> => {
    const url = new URL(req.url);
    if (url.pathname === FAKE_LINK_SCRIPT_PATH) {
      if (url.origin !== this.opts.scriptOrigin || req.method !== 'GET') return new Response('Not found', { status: 404 });
      return new Response(this.script, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' } });
    }
    if (url.pathname.startsWith('/__fake/')) {
      try {
        return await this.control(req, url);
      } catch (err) {
        // A control the test misused, or a FakePlaid helper's refusal: the message says which.
        return json({ error: err instanceof Error ? err.message : String(err) }, 400, CORS);
      }
    }
    try {
      return await this.fake.handle(req);
    } catch (err) {
      // `dropNext`: the fake throws as fetch would. Over HTTP, close the connection without an
      // answer so the app's fetch fails the same way, not with the server's 500.
      env?.outgoing?.destroy();
      throw err;
    }
  };

  private async control(req: Request, url: URL): Promise<Response> {
    const path = url.pathname.slice('/__fake/'.length);
    if (path === 'health') return json({ ok: true });
    if (req.method === 'OPTIONS' && path === 'link/complete') return new Response(null, { status: 204, headers: CORS });
    if (req.method === 'GET') {
      if (path === 'items') {
        return json({ itemsCreated: this.fake.itemsCreated, removals: this.fake.removals, items: [...this.fake.items.values()].map(itemView) });
      }
      if (path === 'requests') {
        const only = url.searchParams.get('path');
        return json(this.fake.requests.filter((r) => only === null || r.path === only));
      }
      if (path === 'link/sessions') return json(this.linkSessions);
      if (path === 'count') {
        const only = url.searchParams.get('path');
        if (only === null) throw new Error('path is required.');
        const itemId = url.searchParams.get('itemId');
        return json({ count: this.fake.count(only as FakePlaidPath, itemId ?? undefined) });
      }
      return json({ error: 'Not found' }, 404);
    }
    if (req.method !== 'POST') return json({ error: 'Not found' }, 404);
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new Error('The body must be a JSON object.');

    switch (path) {
      case 'link/complete':
        return json(this.completeLink(body), 200, CORS);
      case 'link/next': {
        const outcome = body.outcome;
        if (outcome !== 'success' && outcome !== 'exit' && outcome !== 'oauth') throw new Error('outcome must be success, exit or oauth.');
        this.linkResults.push(body as unknown as FakeLinkResultConfig);
        return json({ queued: this.linkResults.length });
      }
      case 'transactions/add': {
        const { itemId, accountId, mask, ...fields } = body;
        const item = this.pickItem(itemId);
        const account = typeof fields.account_id === 'string' ? fields.account_id : pickAccount(item, accountId, mask).account_id;
        return json(this.fake.addTransaction(item.itemId, { ...(fields as Partial<FakeTransaction>), account_id: account }));
      }
      case 'transactions/modify':
        return json(this.fake.modifyTransaction(str(body.transactionId, 'transactionId'), obj(body.changes)));
      case 'transactions/remove':
        this.fake.removeTransaction(str(body.transactionId, 'transactionId'));
        return json({ ok: true });
      case 'transactions/post':
        return json(this.fake.postPending(str(body.pendingId, 'pendingId'), obj(body.posted), removedFirst(body)));
      case 'transactions/churn':
        return json(this.fake.churn(str(body.oldId, 'oldId'), str(body.newId, 'newId'), obj(body.changes), removedFirst(body)));
      case 'liabilities': {
        const item = this.pickItem(body.itemId);
        this.fake.setLiability(item.itemId, pickAccount(item, body.accountId, body.mask).account_id, obj(body.fields));
        return json({ ok: true });
      }
      case 'balances': {
        const item = this.pickItem(body.itemId);
        if (body.current !== null && typeof body.current !== 'number') throw new Error('current must be a number or null.');
        if (body.available !== undefined && body.available !== null && typeof body.available !== 'number') throw new Error('available must be a number or null.');
        this.fake.setBalance(item.itemId, pickAccount(item, body.accountId, body.mask).account_id, {
          current: body.current, ...(body.available !== undefined ? { available: body.available } : {}),
        });
        return json({ ok: true });
      }
      case 'investments/add': {
        const { itemId, accountId, mask, ...fields } = body;
        const item = this.pickItem(itemId);
        const account = typeof fields.account_id === 'string' ? fields.account_id : pickAccount(item, accountId, mask).account_id;
        return json(this.fake.addInvestmentTransaction(item.itemId, { ...(fields as Partial<FakeInvestmentTransaction>), account_id: account }));
      }
      case 'items/investments':
        if (typeof body.supported !== 'boolean') throw new Error('supported must be true or false.');
        this.fake.setInvestmentsSupported(this.pickItem(body.itemId).itemId, body.supported);
        return json({ ok: true });
      case 'investments-enabled':
        if (typeof body.enabled !== 'boolean') throw new Error('enabled must be true or false.');
        this.fake.investmentsEnabled = body.enabled;
        return json({ ok: true });
      case 'items/break':
        this.fake.breakItem(this.pickItem(body.itemId).itemId, body.error === undefined ? undefined : plaidError(body.error));
        return json({ ok: true });
      case 'items/repair':
        this.fake.repairItem(this.pickItem(body.itemId).itemId);
        return json({ ok: true });
      case 'items/ready':
        if (typeof body.ready !== 'boolean') throw new Error('ready must be true or false.');
        this.fake.setReady(this.pickItem(body.itemId).itemId, body.ready, typeof body.status === 'string' ? body.status : undefined);
        return json({ ok: true });
      case 'items/consent':
        if (body.consentExpirationTime !== null && typeof body.consentExpirationTime !== 'string') throw new Error('consentExpirationTime must be a string or null.');
        this.fake.setConsentExpiration(this.pickItem(body.itemId).itemId, body.consentExpirationTime);
        return json({ ok: true });
      case 'delay': {
        const ms = body.ms;
        if (typeof ms !== 'number' || !Number.isInteger(ms) || ms < 0 || ms > 60_000) throw new Error('ms must be a whole number of milliseconds, at most 60000.');
        this.fake.delayNext(str(body.path, 'path') as FakePlaidPath, ms, this.failureTarget(body.itemId));
        return json({ ok: true });
      }
      case 'reset-queues': {
        const linkResults = this.linkResults.splice(0).length;
        return json({ cleared: { linkResults, failures: this.fake.clearFailures() } });
      }
      case 'fail': {
        const apiPath = str(body.path, 'path') as FakePlaidPath;
        const target = this.failureTarget(body.itemId);
        if (body.drop === true) this.fake.dropNext(apiPath, target);
        else this.fake.failNext(apiPath, plaidError(body.error), target);
        return json({ ok: true });
      }
      case 'webhook': {
        const payload = obj(body.payload);
        const item = this.findItem(body.itemId);
        if (payload.item_id === undefined) {
          if (!item) throw new Error('No item_id: pass one in the payload, or link a bank first.');
          payload.item_id = item.itemId;
        }
        // Every Plaid webhook names its environment (research §7.4).
        if (payload.environment === undefined) payload.environment = this.fake.env;
        const target = typeof body.url === 'string' ? body.url : (item?.webhook ?? this.opts.webhookUrl ?? null);
        if (!target) throw new Error('No webhook URL: pass url, or link a bank first.');
        const res = await this.fake.fireWebhook(target, payload);
        return json({ status: res.status });
      }
      default:
        return json({ error: 'Not found' }, 404);
    }
  }

  /** What the fake Link gets back for `open()`. */
  private completeLink(body: Record<string, unknown>): Record<string, unknown> {
    const linkToken = str(body.linkToken, 'linkToken');
    const received = typeof body.receivedRedirectUri === 'string' ? body.receivedRedirectUri : null;
    const lt = this.fake.linkToken(linkToken);
    if (!lt) throw new Error('The fake Plaid did not issue that link token.');
    const session: FakeLinkSession = { mode: lt.itemId ? 'update' : 'new', itemId: lt.itemId, receivedRedirectUri: received, outcome: 'failed', linkTokenRequest: lt.body };
    this.linkSessions.push(session);
    if (!lt.usable) throw new Error('That link token was already used or has expired.');

    // Back from the bank: Link must be opened again with exactly the URL the bank sent (research §3.4).
    const expected = this.oauth.get(linkToken);
    if (expected !== undefined || received !== null) {
      if (received !== expected) throw new Error(expected === undefined ? 'receivedRedirectUri was passed, but Link never went to the bank.' : 'receivedRedirectUri is not the URL the bank sent the browser to.');
      this.oauth.delete(linkToken);
    }

    const result = this.linkResults.shift() ?? { outcome: 'success' };
    session.outcome = result.outcome;
    if (result.outcome === 'oauth') {
      if (typeof lt.body.redirect_uri !== 'string') throw new Error('The link token has no redirect_uri to come back to.');
      const back = new URL(lt.body.redirect_uri);
      back.search = new URLSearchParams({ oauth_state_id: randomUUID() }).toString();
      this.oauth.set(linkToken, back.href);
      return { outcome: 'redirect', url: back.href };
    }
    if (result.outcome === 'exit') {
      const institution = lt.itemId ? this.fake.item(lt.itemId).institution : null;
      return { outcome: 'exit', error: result.error ?? null, metadata: { institution, status: result.status ?? null, link_session_id: `session-${randomUUID()}` } };
    }
    const { publicToken, metadata } = this.fake.completeLink(linkToken, {
      ...(result.institution !== undefined ? { institution: result.institution } : {}),
      ...(result.accounts !== undefined ? { accounts: result.accounts } : {}),
    });
    // A new Item is the newest one: completeLink just made it.
    session.itemId = lt.itemId ?? [...this.fake.items.keys()].at(-1) ?? null;
    return { outcome: 'success', publicToken, metadata };
  }

  /** The named Item, or the newest exchanged one that isn't removed; null when there's none. */
  /** `fail` and `delay` take an optional `itemId`: only that Item's next call. Absent, any Item's (not the newest). */
  private failureTarget(itemId: unknown): { itemId?: string } {
    return itemId === undefined ? {} : { itemId: str(itemId, 'itemId') };
  }

  private findItem(itemId: unknown): FakeItem | null {
    if (itemId !== undefined) return this.fake.item(str(itemId, 'itemId'));
    return [...this.fake.items.values()].filter((i) => i.accessToken !== null && !i.removed).at(-1) ?? null;
  }

  private pickItem(itemId: unknown): FakeItem {
    const item = this.findItem(itemId);
    if (!item) throw new Error('No linked bank yet.');
    return item;
  }
}

function itemView(item: FakeItem): Record<string, unknown> {
  return {
    itemId: item.itemId,
    institution: item.institution,
    accounts: item.accounts,
    removed: item.removed,
    exchanged: item.accessToken !== null,
    error: item.error?.error_code ?? null,
    webhook: item.webhook,
    consentExpirationTime: item.consentExpirationTime,
    ready: item.ready,
    transactions: [...item.transactions.values()],
    investmentTransactions: [...item.investmentTransactions.values()],
    investmentsSupported: item.investmentsSupported,
  };
}

function pickAccount(item: FakeItem, accountId: unknown, mask: unknown): FakeAccount {
  const account = typeof accountId === 'string'
    ? item.accounts.find((a) => a.account_id === accountId)
    : typeof mask === 'string' ? item.accounts.find((a) => a.mask === mask) : item.accounts[0];
  if (!account) throw new Error('No such account on that bank.');
  return account;
}

function plaidError(value: unknown): FakePlaidError {
  if (typeof value === 'string' && Object.hasOwn(FAKE_PLAID_ERRORS, value)) return FAKE_PLAID_ERRORS[value as keyof typeof FAKE_PLAID_ERRORS];
  const e = value as Partial<FakePlaidError> | null;
  if (e && typeof e === 'object' && typeof e.status === 'number' && typeof e.error_type === 'string' && typeof e.error_code === 'string') {
    return { status: e.status, error_type: e.error_type, error_code: e.error_code };
  }
  throw new Error(`error must be one of ${Object.keys(FAKE_PLAID_ERRORS).join(', ')}, or { status, error_type, error_code }.`);
}

function str(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') throw new Error(`${name} is required.`);
  return value;
}

/** A JSON object from a control's body, copied; `{}` when it's left out. Its fields are the test's to get right. */
function obj<T extends object = Record<string, unknown>>(value: unknown): T {
  if (value === undefined) return {} as T;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object.');
  return { ...(value as T) };
}

function removedFirst(body: Record<string, unknown>): { removedFirst?: boolean } {
  return typeof body.removedFirst === 'boolean' ? { removedFirst: body.removedFirst } : {};
}
