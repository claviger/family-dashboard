import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie';
import { z } from 'zod';
import { CALENDAR_LINK_ERRORS, type CalendarLinkError } from '../../../shared/calendar.js';
import type { AppDeps, AppEnv } from '../../app.js';
import { AppError, loggableError } from '../../core/errors.js';
import { clientIp, rateLimit } from '../../core/rateLimit.js';
import { GoogleApiError } from './calendarClient.js';
import { GoogleOAuthError, GoogleOAuthUnavailable, pkceChallenge } from './oauth.js';

/** Separate from sign-in's `__Host-oauth-flow` and Todoist's, so no flow can overwrite another. */
const FLOW_COOKIE = '__Host-gcal-flow';
const FlowSchema = z.object({ state: z.string(), nonce: z.string(), codeVerifier: z.string(), userId: z.number(), session: z.string() });

/** How long the OAuth callback may take, in all (the plan's 45 seconds per request). */
const CALLBACK_DEADLINE_MS = 45_000;

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The session token's SHA-256: what binds a flow cookie and a pending pick to the session. */
export function sessionHash(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function adminWith(error: CalendarLinkError): string {
  return `/admin?calendar_error=${error}`;
}

/**
 * `/connect/google-calendar/*` (spec §8, §9.1), modeled on Todoist's flow:
 * - `POST start` (behind the CSRF check, so another site can't start a link) is for admins only.
 *   It puts `state`, a nonce, a PKCE verifier, the user id, and a hash of the session token in a
 *   signed, 10-minute `__Host-` cookie, and answers with Google's consent page, which the page
 *   then visits.
 * - `callback` accepts the result only for the same admin in the same session with a matching
 *   `state`, then exchanges the code (openid-client checks `state` and the ID token's nonce
 *   again), checks the granted scopes, lists the calendars, and saves the tokens for the admin to
 *   pick one on /admin (`?calendar=choose`), all within 45 seconds of the callback's start.
 *   Failures, running out of time included, come back as `?calendar_error=<code>`.
 * Limited to 10 a minute per signed-in admin. Logs carry OAuth error codes and HTTP kinds, never
 * the code, the verifier, or a token.
 */
export function calendarConnectRoutes(deps: AppDeps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const { calendar } = deps;
  const redirectUri = new URL('/connect/google-calendar/callback', deps.config.baseUrl).href;
  r.use('*', rateLimit({
    windowMs: 60_000,
    max: 10,
    clock: deps.clock,
    key: (c) => {
      const user = (c as Context<AppEnv>).get('user');
      return user ? `user:${user.id}` : clientIp(c);
    },
    onLimited: (c) => (c.req.path.endsWith('/callback') ? c.redirect(adminWith('rate_limited'), 302) : undefined),
  }));

  r.post('/start', async (c) => {
    const user = c.get('user');
    const session = c.get('sessionToken');
    if (!user || !session) throw new AppError('unauthenticated', 'Sign in to continue.');
    if (user.role !== 'admin') throw new AppError('forbidden', CALENDAR_LINK_ERRORS.not_admin);
    if (calendar.keyMismatch) throw new AppError('integration_unavailable', CALENDAR_LINK_ERRORS.key_mismatch);
    const flow = { state: randomToken(), nonce: randomToken(), codeVerifier: randomToken(), userId: user.id, session: sessionHash(session) };
    await setSignedCookie(c, FLOW_COOKIE, JSON.stringify(flow), deps.config.sessionSecret, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', maxAge: 600 });
    // Until the callback says which account this is, a revocation retry could end its grant (R2-M5).
    calendar.noteLinkStarted();
    return c.json({ url: calendar.oauth.authorizationUrl({ state: flow.state, nonce: flow.nonce, codeChallenge: pkceChallenge(flow.codeVerifier), redirectUri }) });
  });

  r.get('/callback', async (c) => {
    // One limit for the whole callback, nginx's 60 seconds in mind: the wait for the calendar's
    // lock, the code exchange, and listing the calendars all stop at it (R4-M2).
    const deadline = Date.now() + CALLBACK_DEADLINE_MS;
    const raw = await getSignedCookie(c, deps.config.sessionSecret, FLOW_COOKIE);
    deleteCookie(c, FLOW_COOKIE, { path: '/', secure: true });
    let flow: z.infer<typeof FlowSchema> | null = null;
    try {
      const parsed = typeof raw === 'string' ? FlowSchema.safeParse(JSON.parse(raw)) : null;
      flow = parsed?.success ? parsed.data : null;
    } catch {
      flow = null;
    }
    const user = c.get('user');
    const session = c.get('sessionToken');
    const state = c.req.query('state') ?? '';
    if (!flow || !user || !session || flow.userId !== user.id || !sameText(flow.session, sessionHash(session)) || !sameText(flow.state, state)) {
      return c.redirect(adminWith('expired'), 302);
    }
    // The role is read fresh with the session: someone demoted on the consent page can't finish.
    if (user.role !== 'admin') return c.redirect(adminWith('not_admin'), 302);
    const oauthError = c.req.query('error');
    if (oauthError) {
      // Google's error codes aren't secret (access_denied, ...).
      deps.logger.warn({ userId: user.id, oauthError }, 'google calendar authorization was not granted');
      return c.redirect(adminWith(oauthError === 'access_denied' ? 'denied' : 'failed'), 302);
    }
    if (!c.req.query('code')) return c.redirect(adminWith('failed'), 302);
    // Checked before the code is exchanged, so no token is issued that couldn't be stored.
    if (calendar.keyMismatch) return c.redirect(adminWith('key_mismatch'), 302);
    // Rebuilt from BASE_URL: behind nginx, the request URL is the internal address.
    const callbackUrl = new URL(redirectUri);
    callbackUrl.search = new URL(c.req.url).search;
    let result;
    try {
      // The exchange and saving the pick happen under the calendar's lock (`completeLink`).
      result = await calendar.completeLink(user.id, flow.session, { callbackUrl, state: flow.state, nonce: flow.nonce, codeVerifier: flow.codeVerifier, redirectUri }, { deadline });
    } catch (err) {
      deps.logger.warn(
        {
          userId: user.id,
          ...loggableError(err),
          oauthError: err instanceof GoogleOAuthError ? err.code : undefined,
          kind: err instanceof GoogleOAuthUnavailable || err instanceof GoogleApiError ? err.kind : undefined,
          status: err instanceof GoogleOAuthError || err instanceof GoogleApiError ? err.status : undefined,
          reason: err instanceof GoogleApiError ? err.reason : err instanceof GoogleOAuthUnavailable ? err.code : undefined,
        },
        'google calendar link failed',
      );
      // Listing the calendars is the first Calendar API call: the API may not be on yet (C-M2).
      return c.redirect(adminWith(err instanceof GoogleApiError && err.kind === 'api_disabled' ? 'api_disabled' : 'failed'), 302);
    }
    if (result !== 'ok') return c.redirect(adminWith(result), 302);
    return c.redirect('/admin?calendar=choose', 302);
  });

  return r;
}
