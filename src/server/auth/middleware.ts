import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppDeps, AppEnv } from '../app.js';
import type { Config } from '../config.js';
import { AppError } from '../core/errors.js';
import { validateSession } from './sessions.js';

export const SESSION_COOKIE = '__Host-session';

export function setSessionCookie(c: Context, token: string, expiresAt: Date): void {
  setCookie(c, SESSION_COOKIE, token, { httpOnly: true, secure: true, sameSite: 'Lax', path: '/', expires: expiresAt });
}

export function clearSessionCookie(c: Context): void {
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: true });
}

/** Loads the session (if any) into c.var.user and rolls the cookie when the session renews. */
export function sessionMiddleware(deps: AppDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    c.set('user', null);
    c.set('sessionToken', null);
    const token = getCookie(c, SESSION_COOKIE);
    if (token) {
      const v = validateSession(deps.db, deps.clock, token);
      if (v) {
        c.set('user', v.user);
        c.set('sessionToken', token);
        if (v.renewed) setSessionCookie(c, token, v.expiresAt);
      }
    }
    await next();
  };
}

export const requireUser: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (!c.get('user')) throw new AppError('unauthenticated', 'Sign in to continue.');
  await next();
};

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = c.get('user');
  if (!user) throw new AppError('unauthenticated', 'Sign in to continue.');
  if (user.role !== 'admin') throw new AppError('forbidden', 'Only admins can do that.');
  await next();
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Spec §15: every mutation needs X-Requested-With: dashboard and an Origin matching BASE_URL. */
export function csrfMiddleware(config: Config): MiddlewareHandler<AppEnv> {
  const origin = new URL(config.baseUrl).origin;
  return async (c, next) => {
    // Webhooks are signed; a browser's CSP violation report can't carry our header, and only logs.
    if (!SAFE_METHODS.has(c.req.method) && !c.req.path.startsWith('/webhooks/') && c.req.path !== '/csp-report') {
      if (c.req.header('x-requested-with') !== 'dashboard' || c.req.header('origin') !== origin) {
        throw new AppError('forbidden', 'Request blocked.');
      }
    }
    await next();
  };
}
