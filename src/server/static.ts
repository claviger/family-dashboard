import { serveStatic } from '@hono/node-server/serve-static';
import type { Hono } from 'hono';
import path from 'node:path';

const IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * Serves built web assets, then falls back to index.html for client-side routes.
 * `webDir` is relative to the process cwd and uses forward slashes.
 * A missing `/assets/*` file is a plain 404 (never index.html); hashed assets are immutable.
 */
export function mountStatic(app: Hono<any>, webDir: string): void {
  app.use('/assets/*', async (c, next) => {
    await next();
    if (c.res.status === 200) c.res.headers.set('Cache-Control', IMMUTABLE);
  });
  app.use('/assets/*', serveStatic({ root: webDir }));
  app.all('/assets/*', (c) => c.text('Not found', 404));
  app.get('*', async (c, next) => {
    const p = c.req.path;
    // /connect/ and /webhooks/ are never client routes: an integration that isn't configured is a 404 there.
    if (p.startsWith('/api/') || p.startsWith('/auth/') || p.startsWith('/connect/') || p.startsWith('/webhooks/') || p === '/healthz') return next();
    const file = await serveStatic({ root: webDir })(c, async () => {});
    if (file) return file;
    const index = await serveStatic({ path: path.posix.join(webDir, 'index.html') })(c, next);
    if (index instanceof Response && index.status === 200) index.headers.set('Cache-Control', 'no-cache');
    return index;
  });
}
