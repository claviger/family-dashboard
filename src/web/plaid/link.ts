import {
  afterSuccess, backLink, exitCall, linkFailedMessage, linkStartAnswer, nextFrom, purposeFromPage, startCall, successCall, type LinkCall, type LinkPurpose,
} from './linkFlow.js';
import '@fontsource-variable/eb-garamond/wght.css';
import '@fontsource-variable/figtree';
import './link.css';

/**
 * The Link page (spec §12.2, research §3, the design's departures 4 and 11): `/connect/plaid/link`
 * and `/connect/plaid/oauth-return`, the build's second entry (plaid-link.html). No React and no
 * inline script, because this page runs Plaid's unpinned script under a looser CSP: it asks the
 * server for a link token, loads `link-initialize.js` from the URL the server names (the exact URL
 * the page's CSP allows), opens Link, posts how it ended, and goes where the server says. The pick
 * step is in Spend settings, not here.
 *
 * Every call carries the CSRF header (`X-Requested-With: dashboard`) and the session cookie. A
 * refusal names where to go in `error.details.next`; if even that can't be had, the page says so
 * beside its link back to the settings of the link's panel (Spend's, or Savings' for a Savings link,
 * known from `?for=savings` or the start's answer). Tokens are never logged or kept in the page's storage.
 */

/** The slice of Link Web's API this page uses (research §3.2). */
interface PlaidLinkHandler {
  open(): void;
  exit(opts?: { force?: boolean }): void;
  destroy(): void;
}
interface PlaidCreateConfig {
  token: string;
  receivedRedirectUri?: string;
  onSuccess(publicToken: string, metadata: unknown): void;
  onExit(error: unknown, metadata: unknown): void;
}
declare global {
  interface Window {
    Plaid?: { create(config: PlaidCreateConfig): PlaidLinkHandler };
  }
}

const status = document.getElementById('link-status');
const back = document.getElementById('link-back');
let purpose: LinkPurpose = purposeFromPage(window.location.pathname, window.location.search) ?? 'spend';

/** The way back, by purpose: its link and words. */
function showBack(): void {
  if (!(back instanceof HTMLAnchorElement)) return;
  const { href, text } = backLink(purpose);
  back.href = href;
  back.textContent = text;
}
showBack();

function say(text: string): void {
  if (status) status.textContent = text;
}

/** The dead end: say so, and put focus on the way back. */
function fail(message: string = linkFailedMessage(purpose)): void {
  say(message);
  back?.focus();
}

/** Posts a call and returns its status and JSON (null when it isn't JSON), refusals included; null when there's no answer. */
async function post(call: LinkCall): Promise<{ ok: boolean; status: number; body: unknown } | null> {
  try {
    const res = await fetch(call.path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'X-Requested-With': 'dashboard', 'Content-Type': 'application/json' },
      body: JSON.stringify(call.body),
    });
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => null) };
  } catch {
    return null;
  }
}

/** Goes where an answer says to, or fails when it doesn't say. */
function follow(answer: { body: unknown } | null): void {
  const next = answer ? nextFrom(answer.body, window.location.origin) : null;
  if (next === null) return fail();
  window.location.assign(next);
}

/** After `onSuccess`: the server may have connected the bank even when its answer can't be read, so say so. */
function followSuccess(answer: { status: number; body: unknown } | null): void {
  const what = afterSuccess(answer, window.location.origin, purpose);
  if ('next' in what) return window.location.assign(what.next);
  fail(what.message);
}

/** Adds `link-initialize.js` the way Plaid says to load it: a script tag, never bundled (research §3.1). */
function loadScript(src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    script.addEventListener('load', () => resolve(), { once: true });
    script.addEventListener('error', () => reject(new Error('link script')), { once: true });
    document.head.appendChild(script);
  });
}

async function run(): Promise<void> {
  const start = startCall(window.location.pathname, window.location.search);
  if (!start) return fail();
  const answer = await post(start);
  if (!answer) return fail();
  const link = answer.ok ? linkStartAnswer(answer.body) : null;
  if (!link) return follow(answer);
  purpose = link.purpose;
  showBack();

  try {
    await loadScript(link.scriptUrl);
  } catch {
    return fail();
  }
  const Plaid = window.Plaid;
  if (!Plaid) return fail();

  // Link calls back once; a second callback (Plaid doesn't promise order) changes nothing.
  let finished = false;
  const finish = async (call: LinkCall, text: string, success: boolean) => {
    if (finished) return;
    finished = true;
    say(text);
    const answer = await post(call);
    if (success) followSuccess(answer);
    else follow(answer);
  };
  // Plaid's script is third-party: if it throws, the page says so instead of hanging.
  try {
    const handler = Plaid.create({
      token: link.linkToken,
      // Only after the bank's redirect, and exactly the URL the bank sent the browser to (research §3.4).
      ...(start.path === '/connect/plaid/resume' ? { receivedRedirectUri: window.location.href } : {}),
      onSuccess: (publicToken, metadata) => void finish(successCall(link.mode, publicToken, metadata), 'Saving the connection.', true),
      onExit: (error) => void finish(exitCall(error), `Going back to ${purpose === 'savings' ? 'Savings' : 'Spend'} settings.`, false),
    });
    say('Plaid is open. Finish connecting your bank there.');
    handler.open();
  } catch {
    fail();
  }
}

void run();
