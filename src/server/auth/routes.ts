import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { deleteCookie, getSignedCookie, setSignedCookie } from 'hono/cookie';
import { z } from 'zod';
import type { AppDeps, AppEnv } from '../app.js';
import { normalizeEmail } from '../core/email.js';
import { AppError, loggableError, parseJson } from '../core/errors.js';
import { rateLimit } from '../core/rateLimit.js';
import { users } from '../db/schema.js';
import { resolveGoogleIdentity } from './identity.js';
import { clearSessionCookie, setSessionCookie } from './middleware.js';
import { createSession, deleteSession } from './sessions.js';

const FLOW_COOKIE = '__Host-oauth-flow';

const FlowSchema = z.object({ state: z.string(), nonce: z.string(), codeVerifier: z.string() });

function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export function authRoutes(deps: AppDeps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  const redirectUri = new URL('/auth/google/callback', deps.config.baseUrl).href;

  r.use('/google/*', rateLimit({ windowMs: 60_000, max: 10, clock: deps.clock }));

  r.get('/google/start', async (c) => {
    const flow = { state: randomToken(), nonce: randomToken(), codeVerifier: randomToken() };
    await setSignedCookie(c, FLOW_COOKIE, JSON.stringify(flow), deps.config.sessionSecret, {
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: 600,
    });
    try {
      return c.redirect(await deps.google.authorizationUrl({ ...flow, redirectUri }), 302);
    } catch (err) {
      // Only the error's name and code, like every other error log here (`loggableError`).
      deps.logger.warn(loggableError(err), 'google authorization url failed');
      return c.redirect('/sign-in?error=failed', 302);
    }
  });

  r.get('/google/callback', async (c) => {
    const raw = await getSignedCookie(c, deps.config.sessionSecret, FLOW_COOKIE);
    deleteCookie(c, FLOW_COOKIE, { path: '/', secure: true });
    const flow = typeof raw === 'string' ? FlowSchema.safeParse(JSON.parse(raw)) : null;
    if (!flow?.success) return c.redirect('/sign-in?error=expired', 302);

    // Rebuild the callback URL from BASE_URL: behind nginx, c.req.url is the internal address.
    const callbackUrl = new URL(redirectUri);
    callbackUrl.search = new URL(c.req.url).search;

    let claims;
    try {
      claims = await deps.google.exchange({ ...flow.data, redirectUri, callbackUrl });
    } catch (err) {
      deps.logger.warn(loggableError(err), 'google sign-in failed');
      return c.redirect('/sign-in?error=failed', 302);
    }

    const result = resolveGoogleIdentity(deps.db, deps.clock, claims);
    if (!result.ok) return c.redirect(`/not-set-up?reason=${result.reason}`, 302);

    const oldToken = c.get('sessionToken');
    if (oldToken) deleteSession(deps.db, oldToken);
    const session = createSession(deps.db, deps.clock, result.user.id);
    setSessionCookie(c, session.token, session.expiresAt);
    return c.redirect('/', 302);
  });

  r.post('/logout', (c) => {
    const token = c.get('sessionToken');
    if (token) deleteSession(deps.db, token);
    clearSessionCookie(c);
    return c.body(null, 204);
  });

  if (deps.config.testLogin) {
    r.post('/test-login', async (c) => {
      const { email } = await parseJson(c, z.object({ email: z.string({ error: 'Enter an email address' }).email('Enter a valid email address') }));
      const user = deps.db.select().from(users).where(eq(users.email, normalizeEmail(email))).get();
      if (!user || !user.active) throw new AppError('not_found', 'No such user.');
      const session = createSession(deps.db, deps.clock, user.id);
      setSessionCookie(c, session.token, session.expiresAt);
      return c.body(null, 204);
    });
  }

  return r;
}
