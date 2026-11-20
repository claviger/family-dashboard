import type { Context, MiddlewareHandler } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Clock } from './clock.js';
import { AppError } from './errors.js';

/** True for loopback and private-network addresses, i.e. a reverse proxy running next to the app. */
export function isTrustedProxy(addr: string): boolean {
  let a = addr.trim().toLowerCase();
  if (a.startsWith('::ffff:')) a = a.slice(7);
  if (a === '::1' || /^127\.\d+\.\d+\.\d+$/.test(a)) return true;
  if (/^10\.\d+\.\d+\.\d+$/.test(a) || /^192\.168\.\d+\.\d+$/.test(a)) return true;
  const m = /^172\.(\d+)\.\d+\.\d+$/.exec(a);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  return /^f[cd][0-9a-f]{2}:/.test(a); // fc00::/7
}

/**
 * nginx appends the real client address to X-Forwarded-For, so the last entry is the trustworthy one,
 * but only when the connection really comes from a proxy. Otherwise the header is client-controlled.
 */
export function clientIp(c: Context): string {
  const forwarded = c.req.header('x-forwarded-for')?.split(',').at(-1)?.trim();
  let remote: string | undefined;
  try {
    remote = getConnInfo(c).remote.address;
  } catch {
    return forwarded || 'unknown'; // no socket (app.request in tests)
  }
  if (remote && isTrustedProxy(remote)) return forwarded || remote;
  return remote ?? forwarded ?? 'unknown';
}

/**
 * `key` defaults to the client IP; a route behind a session can count per user instead.
 * `onLimited` can answer a limited request itself (a page the browser navigates to, say, which
 * should redirect rather than show JSON); when it returns nothing, the usual 429 error is thrown.
 */
export function rateLimit(opts: {
  windowMs: number;
  max: number;
  clock: Clock;
  key?: (c: Context) => string;
  onLimited?: (c: Context) => Response | undefined;
}): MiddlewareHandler {
  const hits = new Map<string, { start: number; count: number }>();
  return async (c, next) => {
    const key = opts.key?.(c) ?? clientIp(c);
    const now = opts.clock.now().getTime();
    const entry = hits.get(key);
    if (!entry || now - entry.start >= opts.windowMs) {
      if (hits.size > 10_000) hits.clear();
      hits.set(key, { start: now, count: 1 });
    } else if (++entry.count > opts.max) {
      const answer = opts.onLimited?.(c);
      if (answer) return answer;
      throw new AppError('rate_limited', 'Too many attempts. Wait a minute and try again.');
    }
    await next();
  };
}
