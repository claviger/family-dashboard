import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path, { join } from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { mountStatic } from './static.js';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'fd-static-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>app</title>');
  writeFileSync(join(dir, 'assets', 'app-abc.js'), 'console.log(1)');
  const rel = path.relative(process.cwd(), dir).split(path.sep).join('/');
  const app = new Hono();
  app.get('/healthz', (c) => c.text('ok'));
  mountStatic(app, rel);
  return app;
}

describe('mountStatic', () => {
  it('serves assets as immutable', async () => {
    const res = await setup().request('/assets/app-abc.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=31536000, immutable');
  });

  it('returns a plain 404 for a missing asset', async () => {
    const res = await setup().request('/assets/missing.js');
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('<title>');
  });

  it('falls back to index.html with no-cache for client routes', async () => {
    const res = await setup().request('/admin');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>app</title>');
    expect(res.headers.get('Cache-Control')).toBe('no-cache');
  });

  it('leaves /healthz to the app', async () => {
    expect(await (await setup().request('/healthz')).text()).toBe('ok');
  });
});
