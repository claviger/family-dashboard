import { serve } from '@hono/node-server';
import { FakeTodoist } from './fakeTodoist.js';

/**
 * FakeTodoist behind HTTP, for Playwright (playwright.config.ts starts it before the app). It
 * serves the consent page (which approves at once and sends the browser back), the token, sync,
 * and revoke endpoints, and the `/__fake/*` controls the e2e tests use to act "in Todoist":
 * add a task in a project (with a signed `item:added` webhook), complete a task (which also
 * delivers a signed `item:completed` webhook to the app), and revoke an account's tokens. Every authorization creates a fresh account, so tests can't see each other's tasks.
 * The consent page answers only on the OAuth origin, and the rest only on the API origin.
 *
 * Test-only: it's under src/server/test, which the production build excludes.
 */
const port = Number(process.env.FAKE_TODOIST_PORT ?? 3101);
const fake = new FakeTodoist(process.env.FAKE_TODOIST_CLIENT_ID ?? 'e2e-todoist', process.env.FAKE_TODOIST_CLIENT_SECRET ?? 'e2e-todoist-secret');
fake.webhookUrl = process.env.FAKE_TODOIST_WEBHOOK_URL ?? null;
// Two origins on one port, as playwright.config.ts sets TODOIST_API_BASE_URL and
// TODOIST_OAUTH_BASE_URL: the app calls the API at 127.0.0.1, and the browser visits the consent
// page at localhost. Each refuses the other's paths.
fake.origins = { api: `http://127.0.0.1:${port}`, oauth: `http://localhost:${port}` };

serve({ fetch: (req) => fake.handle(req), hostname: '127.0.0.1', port }, (info) => {
  process.stdout.write(`fake todoist listening on ${info.port}\n`);
});
