/**
 * The Link page's decisions (spec §12.2, the design's departure 11), apart from the page itself
 * (link.ts) so they're unit-tested (linkFlow.test.ts) and type-checked with the server code. Pure,
 * and only type imports, so the page's bundle stays this file and link.ts.
 *
 * The page makes three calls to the server: one to start (a link token, or the same one again on
 * the OAuth return page), one when Link finishes (the exchange, or update mode's completion), or
 * one when the admin leaves Link. Each answer says where to go next.
 */

/** A call the page makes: a POST to `path` with a JSON `body`. */
export interface LinkCall {
  path: string;
  body: Record<string, unknown>;
}

/** Which panel a link is for. Mirrors `PLAID_PURPOSES` (shared/plaid.ts); this file keeps to type imports. */
export type LinkPurpose = 'spend' | 'savings';

/** The start's answer: the token Link opens with, the script to load, which finish call to make, and the panel it's for. */
export interface LinkStart {
  linkToken: string;
  scriptUrl: string;
  mode: 'new' | 'update';
  purpose: LinkPurpose;
}

/** The settings page each purpose goes back to, and the back link's words. */
export function backLink(purpose: LinkPurpose): { href: string; text: string } {
  return purpose === 'savings'
    ? { href: '/savings?tab=settings', text: 'Back to Savings settings' }
    : { href: '/spend?tab=settings', text: 'Back to Spend settings' };
}

/** Shown when even the way back can't be had: the page's link back to the purpose's settings is beside it. */
export function linkFailedMessage(purpose: LinkPurpose): string {
  return purpose === 'savings'
    ? "Couldn't start connecting the account. Go back to Savings settings and try again."
    : "Couldn't start connecting the bank. Go back to Spend settings and try again.";
}
/** Spend's, as before. */
export const LINK_FAILED_MESSAGE = linkFailedMessage('spend');

/**
 * Shown when the call after `onSuccess` got no readable answer (no answer, not JSON, or a 5xx with
 * nowhere to go, nginx's timeout page say): the server may have finished the exchange anyway, and
 * linking again would use another Trial connection.
 */
export function maybeFinishedMessage(purpose: LinkPurpose): string {
  return `This may have finished. Check ${purpose === 'savings' ? 'Savings' : 'Spend'} settings before trying again.`;
}
export const LINK_MAYBE_FINISHED_MESSAGE = maybeFinishedMessage('spend');

/** The purpose the page's own URL says (`?for=savings` on a new link); null when only the server knows (update mode, the OAuth return). */
export function purposeFromPage(pathname: string, search: string): LinkPurpose | null {
  if (pathname !== '/connect/plaid/link') return null;
  const params = new URLSearchParams(search);
  return params.get('item') === null && params.get('for') === 'savings' ? 'savings' : null;
}

/** A positive whole number as `?item=` carries it, and nothing else. */
const ITEM_ID = /^[1-9][0-9]{0,15}$/;

/**
 * The first call, from the page's path and query:
 * - `/connect/plaid/link` starts a new bank (a new Savings connection with `?for=savings`), or
 *   with `?item=ID` reconnects that bank (update mode; its own purpose decides), adding accounts
 *   with `&accounts=1`;
 * - `/connect/plaid/oauth-return` resumes the link this session started (research §3.4); the
 *   bank's `?oauth_state_id=` is for Link, not for the server.
 *
 * Null for anything else, and for an `item` that isn't an id: starting a new bank instead of the
 * reconnect the admin asked for would use one of the Trial's connections.
 */
export function startCall(pathname: string, search: string): LinkCall | null {
  if (pathname === '/connect/plaid/oauth-return') return { path: '/connect/plaid/resume', body: {} };
  if (pathname !== '/connect/plaid/link') return null;
  const params = new URLSearchParams(search);
  const item = params.get('item');
  if (item === null) return { path: '/connect/plaid/link-token', body: params.get('for') === 'savings' ? { purpose: 'savings' } : {} };
  if (!ITEM_ID.test(item)) return null;
  const itemId = Number(item);
  if (!Number.isSafeInteger(itemId)) return null;
  return { path: '/connect/plaid/link-token', body: params.get('accounts') === '1' ? { itemId, addAccounts: true } : { itemId } };
}

/** The start's answer, or null when it isn't one. The script URL must be http(s). No `purpose` is Spend's. */
export function linkStartAnswer(body: unknown): LinkStart | null {
  if (body === null || typeof body !== 'object') return null;
  const { linkToken, scriptUrl, mode, purpose: given } = body as Record<string, unknown>;
  if (typeof linkToken !== 'string' || linkToken === '' || typeof scriptUrl !== 'string') return null;
  if (mode !== 'new' && mode !== 'update') return null;
  const purpose = given === undefined ? 'spend' : given;
  if (purpose !== 'spend' && purpose !== 'savings') return null;
  let url: URL;
  try {
    url = new URL(scriptUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  return { linkToken, scriptUrl, mode, purpose };
}

/**
 * Link's `onSuccess` metadata trimmed to what the server reads (`PlaidLinkMetadataSchema` in
 * shared/plaid.ts): Link adds fields over time, and the server has no use for them. Missing masks
 * and subtypes become null. Anything that isn't shaped like Link's metadata is passed on as it is,
 * for the server to refuse.
 */
export function plainMetadata(metadata: unknown): unknown {
  if (metadata === null || typeof metadata !== 'object') return metadata;
  const m = metadata as Record<string, unknown>;
  if (!Array.isArray(m.accounts)) return m;
  const inst = m.institution as Record<string, unknown> | null | undefined;
  return {
    institution: inst && typeof inst === 'object' ? { institution_id: inst.institution_id, name: inst.name } : null,
    accounts: m.accounts.map((a: unknown) => {
      const acct = (a ?? {}) as Record<string, unknown>;
      return { id: acct.id, name: acct.name, mask: acct.mask ?? null, type: acct.type, subtype: acct.subtype ?? null };
    }),
    ...(m.link_session_id !== undefined ? { link_session_id: m.link_session_id } : {}),
  };
}

/**
 * The call after `onSuccess`: a new bank's public token is exchanged; update mode has nothing to
 * exchange (the access token doesn't change, research §2.4), so it only says it's done.
 */
export function successCall(mode: LinkStart['mode'], publicToken: string, metadata: unknown): LinkCall {
  if (mode === 'update') return { path: '/connect/plaid/updated', body: { metadata: plainMetadata(metadata) } };
  return { path: '/connect/plaid/exchange', body: { publicToken, metadata: plainMetadata(metadata) } };
}

/** The call after `onExit`, with Link's `error_code` when there is one (the server maps it to a message). */
export function exitCall(error: unknown): LinkCall {
  const code = error && typeof error === 'object' ? (error as Record<string, unknown>).error_code : null;
  return { path: '/connect/plaid/exit', body: { errorCode: typeof code === 'string' && code.length <= 100 ? code : null } };
}

/**
 * Where to go after an answer: a success's `next`, or a refusal's `error.details.next` (Spend
 * settings with `?bank_error=`, or `/` when signed out). Only a path on this site is followed: it
 * must start with `/`, and resolved the way the browser will resolve it (which drops tabs and
 * newlines, and reads `\` as `/`), its origin must be `origin`, the page's own. What's returned is
 * that resolved path. Null means the page shows `LINK_FAILED_MESSAGE` instead.
 */
export function nextFrom(body: unknown, origin: string): string | null {
  if (body === null || typeof body !== 'object') return null;
  const b = body as { next?: unknown; error?: { details?: { next?: unknown } | null } | null };
  const next = b.next !== undefined ? b.next : b.error?.details?.next;
  if (typeof next !== 'string' || !next.startsWith('/')) return null;
  let url: URL;
  try {
    url = new URL(next, origin);
  } catch {
    return null;
  }
  if (url.origin !== origin) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Plaid's part is done but the app refused to keep it (review C-M2), with the app's own message when it gave one. */
export function notSavedMessage(serverMessage: string | null): string {
  return `Plaid finished, but the dashboard couldn't save the connection${serverMessage ? `: ${serverMessage}` : '.'}`;
}

/** The app's refusal message, if the body has one short enough to be the app's own plain line. */
function refusalMessage(body: unknown): string | null {
  const message = (body as { error?: { message?: unknown } | null } | null)?.error?.message;
  return typeof message === 'string' && message.trim() !== '' && message.length <= 300 ? message.trim() : null;
}

/**
 * What to do with the answer to the call after `onSuccess`: go where it says (`next`), or else:
 * - when it can't be read (no answer, not JSON, a 5xx with nowhere to go), or it's a 2xx without a
 *   `next` it can follow, the bank may already be connected (`LINK_MAYBE_FINISHED_MESSAGE`);
 * - an app refusal (a 4xx) with nowhere to go says Plaid finished but the dashboard couldn't save
 *   the connection, with the server's message (review C-M2).
 * `purpose` names the settings page to check.
 */
export function afterSuccess(answer: { status: number; body: unknown } | null, origin: string, purpose: LinkPurpose = 'spend'): { next: string } | { message: string } {
  const maybe = { message: maybeFinishedMessage(purpose) };
  if (answer === null || answer.body === null) return maybe;
  const next = nextFrom(answer.body, origin);
  if (next !== null) return { next };
  if (answer.status >= 500 || (answer.status >= 200 && answer.status < 300)) return maybe;
  return { message: notSavedMessage(refusalMessage(answer.body)) };
}
