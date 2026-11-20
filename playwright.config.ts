import { defineConfig, devices } from '@playwright/test';

const BASE_URL = 'http://localhost:3100';
/** The fake Todoist (src/server/test/fakeTodoistServer.ts). */
const FAKE_TODOIST_PORT = 3101;
/** The fake Google OAuth and Calendar (src/server/test/fakeGoogleCalendarServer.ts). */
const FAKE_GOOGLE_PORT = 3102;
/** The fake Plaid API and Link (src/server/test/fakePlaidServer.ts). */
const FAKE_PLAID_PORT = 3103;
const TODOIST_CLIENT_ID = 'e2e-todoist';
/** The fake signs its webhooks with this, and the app checks them with it. */
const TODOIST_CLIENT_SECRET = 'e2e-todoist-secret';
/** The keys the fake Plaid insists on, and the app sends as its PLAID_CLIENT_ID and PLAID_SECRET. */
const PLAID_CLIENT_ID = 'e2e-plaid';
const PLAID_SECRET = 'e2e-plaid-secret';

export default defineConfig({
  testDir: 'e2e',
  use: { baseURL: BASE_URL },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] }, testIgnore: /(calendar|spend|plaid|savings)\.spec\.ts/ },
    { name: 'phone', use: { ...devices['Pixel 7'] }, testIgnore: /(calendar|spend|plaid|savings)\.spec\.ts/ },
    // The family has one calendar link, which every calendar test changes: they run one at a time,
    // beside everything else, at both sizes (calendar.spec.ts sets each size itself).
    { name: 'calendar', use: { ...devices['Desktop Chrome'] }, testMatch: /calendar\.spec\.ts/, workers: 1 },
    // Spend's categories and rules are the family's, so its tests run one at a time too, at both sizes.
    // So do the bank tests: they share them, and the one fake Plaid server, where each test finds its
    // own Item by its institution. And the Savings tests, which share the fake Plaid the same way.
    { name: 'spend', use: { ...devices['Desktop Chrome'] }, testMatch: /(spend|plaid|savings)\.spec\.ts/, workers: 1 },
  ],
  webServer: [
    {
      command: 'npx tsx src/server/test/fakeGoogleCalendarServer.ts',
      url: `http://127.0.0.1:${FAKE_GOOGLE_PORT}/__fake/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { FAKE_GOOGLE_PORT: String(FAKE_GOOGLE_PORT), FAKE_GOOGLE_CLIENT_ID: 'e2e', FAKE_GOOGLE_CLIENT_SECRET: 'e2e' },
    },
    {
      command: 'npx tsx src/server/test/fakeTodoistServer.ts',
      url: `http://127.0.0.1:${FAKE_TODOIST_PORT}/__fake/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        FAKE_TODOIST_PORT: String(FAKE_TODOIST_PORT),
        FAKE_TODOIST_CLIENT_ID: TODOIST_CLIENT_ID,
        FAKE_TODOIST_CLIENT_SECRET: TODOIST_CLIENT_SECRET,
        FAKE_TODOIST_WEBHOOK_URL: 'http://127.0.0.1:3100/webhooks/todoist',
      },
    },
    {
      command: 'npx tsx src/server/test/fakePlaidServer.ts',
      url: `http://127.0.0.1:${FAKE_PLAID_PORT}/__fake/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        FAKE_PLAID_PORT: String(FAKE_PLAID_PORT),
        FAKE_PLAID_CLIENT_ID: PLAID_CLIENT_ID,
        FAKE_PLAID_SECRET: PLAID_SECRET,
        // Each bank's own webhook URL (the app's, from its link token) comes first; this is the fallback.
        FAKE_PLAID_WEBHOOK_URL: 'http://127.0.0.1:3100/webhooks/plaid',
      },
    },
    {
      // Reset the DB here, not in globalSetup: Playwright starts webServer before globalSetup,
      // so on Windows the freshly opened SQLite file would be locked.
      command:
        "node -e \"require('fs').rmSync('e2e/.data',{recursive:true,force:true})\" && npm run build && node dist/server/index.js",
      url: `${BASE_URL}/healthz`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        NODE_ENV: 'test',
        ENABLE_TEST_LOGIN: 'true',
        BASE_URL,
        HOST: '127.0.0.1',
        PORT: '3100',
        DATA_DIR: 'e2e/.data',
        SESSION_SECRET: 'e2e-secret-'.padEnd(40, 'x'),
        BOOTSTRAP_ADMIN_EMAIL: 'admin@example.com',
        GOOGLE_CLIENT_ID: 'e2e',
        GOOGLE_CLIENT_SECRET: 'e2e',
        LOG_LEVEL: 'warn',
        TODOIST_CLIENT_ID,
        TODOIST_CLIENT_SECRET,
        // A fixed, test-only key: 32 bytes of 0x01.
        TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
        // Test-only overrides, accepted because NODE_ENV=test and BASE_URL is localhost. The app
        // calls the API itself (127.0.0.1); the browser visits the consent page (localhost).
        TODOIST_API_BASE_URL: `http://127.0.0.1:${FAKE_TODOIST_PORT}`,
        TODOIST_OAUTH_BASE_URL: `http://localhost:${FAKE_TODOIST_PORT}`,
        // The same for Google: the browser visits the consent page (localhost); the app calls the
        // token, revocation, and Calendar endpoints itself (127.0.0.1).
        GOOGLE_OAUTH_BASE_URL: `http://localhost:${FAKE_GOOGLE_PORT}`,
        GOOGLE_API_BASE_URL: `http://127.0.0.1:${FAKE_GOOGLE_PORT}`,
        // And for Plaid: the app calls the API itself (127.0.0.1); the browser loads Link's script
        // from localhost, so the Link page's CSP names two different origins, as it does with Plaid.
        PLAID_CLIENT_ID,
        PLAID_SECRET,
        PLAID_ENV: 'sandbox',
        PLAID_API_BASE_URL: `http://127.0.0.1:${FAKE_PLAID_PORT}`,
        PLAID_LINK_SCRIPT_URL: `http://localhost:${FAKE_PLAID_PORT}/link/v2/stable/link-initialize.js`,
      },
    },
  ],
});
