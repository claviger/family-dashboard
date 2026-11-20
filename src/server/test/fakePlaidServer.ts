import { serve } from '@hono/node-server';
import { FAKE_PLAID_CLIENT_ID, FAKE_PLAID_SECRET, FakePlaid } from './fakePlaid.js';
import { FakePlaidHttp } from './fakePlaidHttp.js';

/**
 * FakePlaid behind HTTP, for Playwright (playwright.config.ts starts it before the app). It serves
 * the Plaid API the app calls, a fake `link-initialize.js` that plays Plaid Link in the browser,
 * and the `/__fake/*` controls the e2e tests use to act "at the bank": choose how the next Link
 * run ends, add, change, post and churn transactions, set statements, break or repair an Item,
 * fail the next API call, and send a signed webhook to the app. fakePlaidHttp.ts lists them all.
 *
 * Two origins on one port, as playwright.config.ts sets PLAID_API_BASE_URL and
 * PLAID_LINK_SCRIPT_URL: the app (and the fake Link, under the Link page's `connect-src`) calls the
 * API at 127.0.0.1, and the browser loads the script from localhost. Each refuses the other's paths.
 *
 * Env: `FAKE_PLAID_PORT` (3103), `FAKE_PLAID_CLIENT_ID` and `FAKE_PLAID_SECRET` (the keys the app
 * must send, as its PLAID_CLIENT_ID and PLAID_SECRET), and `FAKE_PLAID_WEBHOOK_URL` (where a
 * webhook goes when neither the control nor the Item names a URL).
 *
 * Test-only: it's under src/server/test, which the production build excludes.
 */
const port = Number(process.env.FAKE_PLAID_PORT ?? 3103);
const fake = new FakePlaid(process.env.FAKE_PLAID_CLIENT_ID ?? FAKE_PLAID_CLIENT_ID, process.env.FAKE_PLAID_SECRET ?? FAKE_PLAID_SECRET);
const http = new FakePlaidHttp(fake, {
  apiOrigin: `http://127.0.0.1:${port}`,
  scriptOrigin: `http://localhost:${port}`,
  webhookUrl: process.env.FAKE_PLAID_WEBHOOK_URL ?? null,
});

serve({ fetch: http.handle, hostname: '127.0.0.1', port }, (info) => {
  process.stdout.write(`fake plaid listening on ${info.port}\n`);
});
