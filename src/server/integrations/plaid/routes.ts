import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { secureHeaders } from 'hono/secure-headers';
import { z } from 'zod';
import { PLAID_LINK_ERRORS, PLAID_MESSAGES, PLAID_PURPOSES, PlaidLinkMetadataSchema, type PlaidLinkError, type PlaidPurpose } from '../../../shared/plaid.js';
import type { AppDeps, AppEnv } from '../../app.js';
import type { PlaidConfig } from '../../config.js';
import { AppError, loggableError, parseJson } from '../../core/errors.js';
import { clientIp, rateLimit } from '../../core/rateLimit.js';
import type { SavingsSync } from '../../panels/savings/sync.js';
import type { BankSync } from '../../panels/spend/plaidSync.js';
import { sessionHash } from '../google/routes.js';
import { PLAID_REQUEST_BUDGET_MS, PlaidLinkRefused, type Plaid } from './plaid.js';
import { PlaidKeyUnavailable } from './webhookVerify.js';

/** hono doesn't export the options type itself. */
export type SecureHeadersOptions = NonNullable<Parameters<typeof secureHeaders>[0]>;

/** The two pages Link runs on (research §3.3, §3.4). Only these responses get the Link CSP. */
export const PLAID_LINK_PAGES: readonly string[] = ['/connect/plaid/link', '/connect/plaid/oauth-return'];
/** Plaid's webhook bodies are small JSON; 256 KiB is far past any of them. */
export const WEBHOOK_BODY_LIMIT = 256 * 1024;
/** A CSP violation report is a few hundred bytes; a bigger one isn't read. */
export const CSP_REPORT_BODY_LIMIT = 16 * 1024;
/** Reports taken a minute from one address, and from everyone, so a flood can't fill the logs. */
export const CSP_REPORTS_PER_MINUTE = 20;
export const CSP_REPORTS_PER_MINUTE_ALL = 200;
/** Where the Link pages' report-only policy sends its reports. */
export const CSP_REPORT_PATH = '/csp-report';
/**
 * The budget of `exchange` and `updated` (`PLAID_REQUEST_BUDGET_MS`): `updated`'s wait for the
 * Item's lock (a sync may hold it) and every Plaid call either makes, before answering `busy`.
 * Well inside nginx's 60-second proxy timeout, so the Link page always gets an answer it can follow.
 */
export const LINK_LOCK_DEADLINE_MS = PLAID_REQUEST_BUDGET_MS;

/** Spend settings, where every link step ends (the design's departure 11). */
export function spendSettingsWith(params: { bank?: number; bankError?: PlaidLinkError } = {}): string {
  const q = new URLSearchParams({ tab: 'settings' });
  if (params.bank !== undefined) q.set('bank', String(params.bank));
  if (params.bankError !== undefined) q.set('bank_error', params.bankError);
  return `/spend?${q.toString()}`;
}

/** Savings settings, where a Savings link ends, with the same query keys as Spend settings (the Savings plan, decision 16). */
export function savingsSettingsWith(params: { bank?: number; bankError?: PlaidLinkError } = {}): string {
  const q = new URLSearchParams({ tab: 'settings' });
  if (params.bank !== undefined) q.set('bank', String(params.bank));
  if (params.bankError !== undefined) q.set('bank_error', params.bankError);
  return `/savings?${q.toString()}`;
}

/** The settings page a link of this purpose ends on. */
export function settingsPathFor(purpose: PlaidPurpose, params: { bank?: number; bankError?: PlaidLinkError } = {}): string {
  return purpose === 'savings' ? savingsSettingsWith(params) : spendSettingsWith(params);
}

/**
 * The CSP for the two Link pages (research §3.3, the design's departure 4), from the config so
 * Sandbox and the test fake get their own hosts. Scripts stay strict: our own bundle and the exact
 * `link-initialize.js` URL, no inline script. Link injects styles, so styles allow `'unsafe-inline'`
 * (the pages render no user data). Link's iframe and assets come from the script's origin, and its
 * page talks to the API's origin. On desktop and mobile web, Link opens the bank's OAuth sign-in
 * in a popup (research §3.4) and needs to keep its handle on it, so `Cross-Origin-Opener-Policy`
 * is `same-origin-allow-popups` here instead of the default `same-origin`, which would sever the
 * popup from the page. Everything else is as strict as every other response.
 *
 * Beside it, a narrower `Content-Security-Policy-Report-Only`: the same, without the CDN on
 * `default-src` (the tightening "Verify on first real link" suggests), reporting to
 * `/csp-report`. It blocks nothing; what it would have blocked shows in the `csp report` log
 * lines, which is how to tell whether the enforced policy can be narrowed (README).
 */
export function plaidLinkHeaders(config: Pick<PlaidConfig, 'apiBaseUrl' | 'linkScriptUrl'>): SecureHeadersOptions {
  const cdn = new URL(config.linkScriptUrl).origin;
  const api = new URL(config.apiBaseUrl).origin;
  const policy = {
    defaultSrc: ["'self'", cdn],
    scriptSrc: ["'self'", config.linkScriptUrl],
    styleSrc: ["'self'", "'unsafe-inline'"],
    styleSrcElem: ["'self'", "'unsafe-inline'"],
    styleSrcAttr: ["'unsafe-inline'"],
    imgSrc: ["'self'", 'data:', cdn],
    frameSrc: [cdn],
    connectSrc: ["'self'", api],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
  };
  return {
    contentSecurityPolicy: policy,
    contentSecurityPolicyReportOnly: { ...policy, defaultSrc: ["'self'"], reportUri: [CSP_REPORT_PATH] },
    crossOriginOpenerPolicy: 'same-origin-allow-popups',
    referrerPolicy: 'same-origin',
    xFrameOptions: 'DENY',
    strictTransportSecurity: false, // set by nginx
  };
}

const LinkTokenInputSchema = z.object({
  itemId: z.number({ error: 'Choose a bank to reconnect.' }).int().positive().optional(),
  addAccounts: z.boolean().optional(),
  purpose: z.enum(PLAID_PURPOSES, { error: 'Choose what to connect.' }).optional(),
});
const ExchangeInputSchema = z.object({
  publicToken: z.string({ error: "Plaid Link's answer is missing." }).min(1).max(500),
  metadata: PlaidLinkMetadataSchema,
}, { error: "Plaid Link's answer couldn't be read." });
const UpdatedInputSchema = z.object({ metadata: PlaidLinkMetadataSchema.optional() }, { error: "Plaid Link's answer couldn't be read." });
const ExitInputSchema = z.object({ errorCode: z.string().max(100).nullish() }, { error: "Plaid Link's answer couldn't be read." });

/** A link step's refusal, with where the Link page goes next (`details.next`): its purpose's settings with the `?bank_error=` code. */
function withNext(err: unknown, purpose: PlaidPurpose = 'spend'): unknown {
  if (err instanceof PlaidLinkRefused) return new AppError(err.code, err.message, { next: settingsPathFor(purpose, { bankError: err.link }) });
  return err;
}

type PlaidRouteDeps = AppDeps & { plaid: Plaid; bank: BankSync; savings: SavingsSync };

/** The signed-in admin and a hash of their session, or a refusal the Link page can follow. */
function admin(c: Context<AppEnv>): { userId: number; session: string } {
  const user = c.get('user');
  const token = c.get('sessionToken');
  if (!user || !token) throw new AppError('unauthenticated', 'Sign in to continue.', { next: '/' });
  if (user.role !== 'admin') throw new AppError('forbidden', PLAID_LINK_ERRORS.not_admin, { next: spendSettingsWith({ bankError: 'not_admin' }) });
  return { userId: user.id, session: sessionHash(token) };
}

/**
 * `/connect/plaid/*` (spec §12.2, the design's "Routes"), mounted only when Plaid is configured, so
 * without it every one is a 404.
 *
 * - `GET link` and `GET oauth-return` are the Link page (`plaidLinkHtml`, the second Vite entry),
 *   full page loads so the Link CSP comes with the HTML response and never applies to the SPA
 *   (research §3.3). Admins only: a signed-out visitor goes to `/`, anyone else gets a plain 403.
 *   `link` also needs `Sec-Fetch-Site` to be `same-origin` or `none` when it's sent, so another
 *   site can't open it in the admin's browser. The page reads `?item=` and `&accounts=1` itself.
 * - `POST link-token`, `resume`, `exchange`, `updated` and `exit` are the page's calls: behind the
 *   CSRF check (every POST is), admin only, and bound to the session that started the link
 *   (`Plaid` compares the session hash). A refusal is a JSON error whose `details.next` is where
 *   the page goes (its settings page, Spend's or Savings', with `?bank_error=`); success answers
 *   `{ next }` or the token. `link-token` takes `purpose` (`spend` by default, or `savings`; an
 *   update-mode link's Item decides). The token comes with its `mode` and `purpose`, so the OAuth
 *   return page, which only knows the session's pending link, knows whether to call `exchange`
 *   (new) or `updated` (update mode), and which settings page is the way back.
 *
 * The JSON calls are limited to 10 a minute per admin, like the calendar's link. Logs (in `Plaid`)
 * carry ids and Plaid's codes, never a link token or a public token.
 */
export function plaidConnectRoutes(deps: PlaidRouteDeps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const { plaid, bank, savings } = deps;
  const limited = rateLimit({
    windowMs: 60_000,
    max: 10,
    clock: deps.clock,
    key: (c) => {
      const user = (c as Context<AppEnv>).get('user');
      return user ? `user:${user.id}` : clientIp(c);
    },
  });

  const page = (c: Context<AppEnv>) => {
    const user = c.get('user');
    if (!user) return c.redirect('/', 302);
    if (user.role !== 'admin') return c.text(PLAID_LINK_ERRORS.not_admin, 403);
    // Starting a link is only ever a navigation from this site (Spend settings), or typed in. Not
    // the OAuth return, which the bank's site sends the browser to. Older browsers send nothing.
    const site = c.req.header('sec-fetch-site');
    if (c.req.path === '/connect/plaid/link' && site !== undefined && site !== 'same-origin' && site !== 'none') {
      return c.text(PLAID_MESSAGES.notFromHere, 403);
    }
    const html = deps.plaidLinkHtml();
    if (html === null) return c.text("The bank connection page isn't built. Run npm run build.", 503);
    // app.ts gives this response, and only this one, the Link CSP.
    c.set('plaidLinkPage', true);
    c.header('Cache-Control', 'no-store');
    return c.html(html);
  };
  for (const path of PLAID_LINK_PAGES) r.get(path.slice('/connect/plaid'.length), page);

  r.post('/link-token', limited, async (c) => {
    let purpose: PlaidPurpose = 'spend';
    try {
      const { userId, session } = admin(c);
      const input = await parseJson(c, LinkTokenInputSchema);
      purpose = input.itemId !== undefined ? (plaid.item(input.itemId)?.purpose ?? 'spend') : (input.purpose ?? 'spend');
      const started = await plaid.createLinkToken(userId, session, { itemId: input.itemId, addAccounts: input.addAccounts, purpose });
      return c.json({ linkToken: started.linkToken, scriptUrl: plaid.config.linkScriptUrl, mode: started.mode, purpose: started.purpose });
    } catch (err) {
      throw withNext(err, purpose);
    }
  });

  r.post('/resume', limited, (c) => {
    let purpose: PlaidPurpose = 'spend';
    try {
      const { userId, session } = admin(c);
      purpose = plaid.pendingPurpose(userId, session);
      const { linkToken, mode } = plaid.resume(userId, session);
      return c.json({ linkToken, scriptUrl: plaid.config.linkScriptUrl, mode, purpose });
    } catch (err) {
      throw withNext(err, purpose);
    }
  });

  r.post('/exchange', limited, async (c) => {
    let purpose: PlaidPurpose = 'spend';
    try {
      const { userId, session } = admin(c);
      // Read before the exchange claims (deletes) the pending link, so a refusal knows its way back.
      purpose = plaid.pendingPurpose(userId, session);
      const { publicToken, metadata } = await parseJson(c, ExchangeInputSchema);
      const { itemId } = await plaid.exchange(userId, session, publicToken, metadata, { deadline: plaid.requestDeadline() });
      // The Item waits for the pick, which its settings page opens (departure 2).
      return c.json({ next: settingsPathFor(purpose, { bank: itemId }) });
    } catch (err) {
      throw withNext(err, purpose);
    }
  });

  r.post('/updated', limited, async (c) => {
    let purpose: PlaidPurpose = 'spend';
    try {
      const { userId, session } = admin(c);
      purpose = plaid.pendingPurpose(userId, session);
      await parseJson(c, UpdatedInputSchema);
      // A sync holding the Item's lock past the deadline is refused as `busy`, back to settings.
      const { itemId } = await plaid.completeUpdate(userId, session, { deadline: plaid.requestDeadline() });
      const item = plaid.item(itemId);
      // Reconnected: catch up now, unless new accounts wait for the pick (then the pick syncs).
      if (item?.pickedAt) {
        if (item.purpose === 'savings') savings.syncSoon(itemId);
        else bank.syncSoon(itemId);
      }
      return c.json({ next: settingsPathFor(item?.purpose ?? purpose, { bank: itemId }) });
    } catch (err) {
      throw withNext(err, purpose);
    }
  });

  r.post('/exit', limited, async (c) => {
    let purpose: PlaidPurpose = 'spend';
    try {
      const { userId, session } = admin(c);
      purpose = plaid.pendingPurpose(userId, session);
      const { errorCode } = await parseJson(c, ExitInputSchema);
      const { error } = plaid.exit(userId, session, errorCode ?? null);
      return c.json({ next: settingsPathFor(purpose, { bankError: error }) });
    } catch (err) {
      throw withNext(err, purpose);
    }
  });

  return r;
}

/**
 * `POST /webhooks/plaid` (spec §12.3, §15, the design's "Webhook status codes"). No session and no
 * CSRF check (the CSRF middleware skips `/webhooks/`): the `Plaid-Verification` signature is the
 * authentication. In this order, so each costs more only after the cheaper check passed: 600
 * requests a minute per IP, a 256 KiB body limit, the raw bytes read once, then the verification
 * over exactly those bytes.
 *
 * A bad, missing or stale signature, a wrong `alg` or a body hash mismatch is 401, which Plaid
 * doesn't retry. A key that can't be had now, a `kid` Plaid says it doesn't know included, is 503,
 * which Plaid retries. A verified
 * webhook is 200 at once (Plaid waits at most 10 seconds) and `BankSync` handles it after the
 * response. A replay (the same signing input again within the verifier's 5.5-minute window) is
 * also 200, so nobody retries it, and it's logged and not handled a second time, except that a
 * replayed `SYNC_UPDATES_AVAILABLE` or liabilities `DEFAULT_UPDATE` still asks for a sync, folded
 * into any pending one (`BankSync.handleReplayedWebhook`): a genuine webhook whose body and `iat`
 * second match an earlier one then never waits for the 6-hourly sync. If taking a
 * verified webhook fails, the answer is 503 and the delivery is forgotten by the replay set, so
 * Plaid's retry of the same JWT is handled. The client IP
 * goes to the verifier for its per-IP budget of key fetches. The log has the `kid`, the type and
 * the code, never the body.
 */
export function plaidWebhookRoutes(deps: PlaidRouteDeps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const { plaid, bank } = deps;
  r.use('*', rateLimit({ windowMs: 60_000, max: 600, clock: deps.clock }));
  r.post('/', bodyLimit({ maxSize: WEBHOOK_BODY_LIMIT, onError: (c) => c.body(null, 413) }), async (c) => {
    const body = new Uint8Array(await c.req.arrayBuffer());
    let result;
    try {
      result = await plaid.verifier.verify(body, c.req.raw.headers, clientIp(c));
    } catch (err) {
      if (err instanceof PlaidKeyUnavailable) {
        deps.logger.warn({ reason: err.reason, errorCode: err.errorCode }, "plaid webhook key couldn't be had; asked plaid to retry");
        return c.body(null, 503);
      }
      deps.logger.error(loggableError(err), 'plaid webhook verification failed');
      return c.body(null, 503);
    }
    if (!result.ok) {
      deps.logger.warn({ reason: result.reason, kid: result.kid }, 'plaid webhook refused');
      return c.body(null, 401);
    }
    const { payload } = result;
    const facts = {
      kid: result.kid,
      type: typeof payload.webhook_type === 'string' ? payload.webhook_type.slice(0, 64) : null,
      code: typeof payload.webhook_code === 'string' ? payload.webhook_code.slice(0, 64) : null,
    };
    if (result.replay) {
      // A replayed "new data" webhook still asks for a sync, folded into any pending one; every other code is dropped.
      deps.logger.warn(facts, 'plaid webhook replayed; not handled again');
      try {
        bank.receiveWebhook(payload, { replay: true });
      } catch (err) {
        deps.logger.error({ ...facts, ...loggableError(err) }, 'plaid replayed webhook not taken');
      }
      return c.body(null, 200);
    }
    try {
      deps.logger.info(facts, 'plaid webhook');
      bank.receiveWebhook(payload);
    } catch (err) {
      // Not handled, so Plaid must retry it, and its retry of this same JWT mustn't be a replay.
      plaid.verifier.forget(result.delivery);
      deps.logger.error({ ...facts, ...loggableError(err) }, 'plaid webhook not taken; asked plaid to retry');
      return c.body(null, 503);
    }
    return c.body(null, 200);
  });
  return r;
}

/** A CSP directive name, as browsers report it, or null. */
function directiveOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.trim().split(/\s+/)[0] ?? '';
  return /^[a-z-]{1,40}$/.test(name) ? name : null;
}

/** A blocked URL as its origin only, or the keyword a browser reports instead of a URL (`inline`, `eval`, `data`...). */
function blockedOf(value: unknown): string {
  if (typeof value !== 'string' || value === '') return 'other';
  if (/^[a-z-]{1,20}$/.test(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'wss:') return url.origin;
    if (url.protocol === 'data:' || url.protocol === 'blob:') return url.protocol.slice(0, -1);
  } catch {
    // Not a URL.
  }
  return 'other';
}

/** A page's path only: never its query, which can hold the bank's OAuth state. */
function pathOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  try {
    const path = new URL(value).pathname;
    return path.length <= 200 ? path : null;
  } catch {
    return null;
  }
}

/**
 * `POST /csp-report` (the Link pages' report-only policy, `plaidLinkHeaders`). Anyone can POST
 * here, so: no CSRF check (a browser's report can't carry our header), 20 reports a minute per
 * address and 200 in all, a 16 KiB body limit, and only three facts logged per report: the
 * directive, the blocked URL's origin (or the browser's keyword for it), and the page's path.
 * Never the query, the sample, or the policy. Both report shapes are read: `report-uri`'s
 * `{ "csp-report": {...} }` and the Reporting API's list of `csp-violation`s. Always 204.
 */
export function cspReportRoutes(deps: Pick<AppDeps, 'clock' | 'logger'>): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  r.use('*', rateLimit({ windowMs: 60_000, max: CSP_REPORTS_PER_MINUTE_ALL, clock: deps.clock, key: () => 'all' }));
  r.use('*', rateLimit({ windowMs: 60_000, max: CSP_REPORTS_PER_MINUTE, clock: deps.clock }));
  r.post('/', bodyLimit({ maxSize: CSP_REPORT_BODY_LIMIT, onError: (c) => c.body(null, 413) }), async (c) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await c.req.text());
    } catch {
      return c.body(null, 204);
    }
    const reports: { directive: unknown; blocked: unknown; page: unknown }[] = [];
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const old = (parsed as Record<string, unknown>)['csp-report'];
      if (old !== null && typeof old === 'object') {
        const o = old as Record<string, unknown>;
        reports.push({ directive: o['effective-directive'] ?? o['violated-directive'], blocked: o['blocked-uri'], page: o['document-uri'] });
      }
    } else if (Array.isArray(parsed)) {
      for (const entry of parsed.slice(0, 10)) {
        if (entry === null || typeof entry !== 'object' || (entry as { type?: unknown }).type !== 'csp-violation') continue;
        const body = (entry as { body?: unknown }).body;
        if (body === null || typeof body !== 'object') continue;
        const b = body as Record<string, unknown>;
        reports.push({ directive: b.effectiveDirective, blocked: b.blockedURL, page: b.documentURL });
      }
    }
    for (const rep of reports) {
      deps.logger.warn({ directive: directiveOf(rep.directive) ?? 'unknown', blocked: blockedOf(rep.blocked), page: pathOf(rep.page) }, 'csp report');
    }
    return c.body(null, 204);
  });
  return r;
}
