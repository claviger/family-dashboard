import { serve } from '@hono/node-server';
import { FakeGoogleCalendar } from './fakeGoogleCalendar.js';

/**
 * FakeGoogleCalendar behind HTTP, for Playwright (playwright.config.ts starts it before the app).
 * The consent page approves at once, always as the family's Google account, which owns "Family"
 * and can make changes to "Kids", but only read "Holidays" and see "Work" without private details
 * (so those two must not be offered). The `/__fake/*` controls let a test act "in Google": add an
 * event, edit one (a new etag, for the conflict test), list what's stored, see revocations, and
 * remove an account's access (so the link needs reconnecting).
 *
 * Two origins on one port, as playwright.config.ts sets GOOGLE_OAUTH_BASE_URL and
 * GOOGLE_API_BASE_URL: the browser visits the consent page at localhost, and the app calls the
 * token, revocation, and Calendar endpoints at 127.0.0.1. Each refuses the other's paths.
 *
 * Test-only: it's under src/server/test, which the production build excludes.
 */
const port = Number(process.env.FAKE_GOOGLE_PORT ?? 3102);
const fake = new FakeGoogleCalendar(process.env.FAKE_GOOGLE_CLIENT_ID ?? 'e2e', process.env.FAKE_GOOGLE_CLIENT_SECRET ?? 'e2e');
fake.origins = { oauth: `http://localhost:${port}`, api: `http://127.0.0.1:${port}` };

const family = fake.createAccount({ email: 'family@example.com' });
fake.addCalendar(family, { summary: 'Family', timeZone: process.env.FAKE_GOOGLE_TIME_ZONE ?? 'America/Los_Angeles' });
const friends = fake.createAccount({ email: 'friends@example.com' });
fake.share(fake.addCalendar(friends, { summary: 'Kids' }), family, 'writer');
fake.share(fake.addCalendar(friends, { summary: 'Holidays' }), family, 'reader');
fake.share(fake.addCalendar(friends, { summary: 'Work' }), family, 'writerWithoutPrivateAccess');
fake.nextAccount = family;

serve({ fetch: (req) => fake.handle(req), hostname: '127.0.0.1', port }, (info) => {
  process.stdout.write(`fake google listening on ${info.port}\n`);
});
