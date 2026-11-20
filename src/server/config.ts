import { z } from 'zod';
import { parseEncryptionKey } from './core/crypto.js';

const EnvSchema = z.object({
  BASE_URL: z.string().url(),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATA_DIR: z.string().default('/data'),
  SESSION_SECRET: z.string().min(32, 'must be at least 32 characters'),
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  NODE_ENV: z.string().default('production'),
  ENABLE_TEST_LOGIN: z.enum(['true', 'false']).default('false'),
  TODOIST_CLIENT_ID: z.string().optional(),
  TODOIST_CLIENT_SECRET: z.string().optional(),
  TOKEN_ENCRYPTION_KEY: z.string({ error: 'is required (generate one with `openssl rand -base64 32`)' }).min(1, 'is required (generate one with `openssl rand -base64 32`)'),
  // Test-only: point the Todoist client at a fake (see loadConfig).
  TODOIST_API_BASE_URL: z.string().url().optional(),
  TODOIST_OAUTH_BASE_URL: z.string().url().optional(),
  // Test-only: point the Google Calendar link and API at a fake (see loadConfig).
  GOOGLE_OAUTH_BASE_URL: z.string().url().optional(),
  GOOGLE_API_BASE_URL: z.string().url().optional(),
  PLAID_CLIENT_ID: z.string().optional(),
  PLAID_SECRET: z.string().optional(),
  // Never read as a secret: only so the refusal to start can name the rename (see loadConfig).
  PLAID_CLIENT_SECRET: z.string().optional(),
  PLAID_ENV: z.enum(['sandbox', 'production']).default('production'),
  // Test-only: point the Plaid API and Link script at the fake (see loadConfig).
  PLAID_API_BASE_URL: z.string().url().optional(),
  PLAID_LINK_SCRIPT_URL: z.string().url().optional(),
});

/** Todoist's real hosts (docs/research/todoist-api-v1.md §1): the API and token endpoint, and the consent page. */
export const TODOIST_API_BASE_URL = 'https://api.todoist.com';
export const TODOIST_OAUTH_BASE_URL = 'https://app.todoist.com';

/**
 * Where the Google Calendar link and API live (docs/research/google-calendar-v3.md §1, from
 * Google's discovery document, which the web-server guide hardcodes too).
 */
export interface GoogleEndpoints {
  /** The `iss` of Google's ID tokens. */
  issuer: string;
  /** The consent page the browser visits. */
  authorization: string;
  token: string;
  revocation: string;
  /** Calendar API v3. Requests go to `${calendarApi}/users/me/calendarList` and `${calendarApi}/calendars/...`. */
  calendarApi: string;
}

export const GOOGLE_ENDPOINTS: GoogleEndpoints = {
  issuer: 'https://accounts.google.com',
  authorization: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revocation: 'https://oauth2.googleapis.com/revoke',
  calendarApi: 'https://www.googleapis.com/calendar/v3',
};

/**
 * The fake's endpoints (src/server/test/fakeGoogleCalendar.ts): the consent page and the issuer on
 * `oauthBase`, which the browser visits, and the token, revocation, and Calendar endpoints on
 * `apiBase`, which the server calls. Tests only.
 */
export function fakeGoogleEndpoints(oauthBase: string, apiBase: string): GoogleEndpoints {
  const oauth = new URL(oauthBase).origin;
  const api = new URL(apiBase).origin;
  return {
    issuer: oauth,
    authorization: `${oauth}/o/oauth2/v2/auth`,
    token: `${api}/token`,
    revocation: `${api}/revoke`,
    calendarApi: `${api}/calendar/v3`,
  };
}

/**
 * Plaid's two environments (docs/research/plaid-6b.md §1). Trial uses production. Each has its
 * own secret, so PLAID_SECRET must be the one for PLAID_ENV.
 */
export const PLAID_API_BASE_URLS = {
  sandbox: 'https://sandbox.plaid.com',
  production: 'https://production.plaid.com',
} as const;

/** Plaid Link's script. It must be loaded from cdn.plaid.com, never bundled (research §3.1). */
export const PLAID_LINK_SCRIPT_URL = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';

export interface PlaidConfig {
  clientId: string;
  secret: string;
  env: 'sandbox' | 'production';
  /** Every Plaid API call is a POST to a path here, e.g. `${apiBaseUrl}/transactions/sync`. */
  apiBaseUrl: string;
  /** The exact `link-initialize.js` URL the Link pages load and their CSP allows. */
  linkScriptUrl: string;
}

export interface TodoistConfig {
  clientId: string;
  clientSecret: string;
  /** `/api/v1/sync`, `/api/v1/revoke`, and `/oauth/access_token` live here. */
  apiBaseUrl: string;
  /** `/oauth/authorize` (the consent page the browser visits) lives here. */
  oauthBaseUrl: string;
}

export interface Config {
  baseUrl: string;
  host: string;
  port: number;
  dataDir: string;
  sessionSecret: string;
  bootstrapAdminEmail: string | undefined;
  googleClientId: string;
  googleClientSecret: string;
  /** Google's endpoints for the calendar link and the Calendar API. Sign-in uses discovery (auth/google.ts). */
  googleEndpoints: GoogleEndpoints;
  logLevel: string;
  testLogin: boolean;
  /** Null when TODOIST_CLIENT_ID and TODOIST_CLIENT_SECRET are unset: every Todoist route and control is hidden. */
  todoist: TodoistConfig | null;
  /** Null when PLAID_CLIENT_ID and PLAID_SECRET are unset: every Plaid route and control is hidden (spec §3.4). */
  plaid: PlaidConfig | null;
  /**
   * TOKEN_ENCRYPTION_KEY, decoded. Always required: Google Calendar can be linked on every
   * instance, since it uses the Google client every instance has.
   */
  tokenEncryptionKey: Buffer;
}

export function loadConfig(env: Record<string, string | undefined>): Config {
  const parsed = EnvSchema.safeParse(
    Object.fromEntries(Object.entries(env).map(([k, v]) => [k, v === '' ? undefined : v])),
  );
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  const baseUrl = new URL(e.BASE_URL).origin;
  const { protocol, hostname } = new URL(baseUrl);
  if (protocol !== 'https:' && hostname !== 'localhost' && hostname !== '127.0.0.1') {
    throw new Error('BASE_URL must use https (http is allowed only for localhost).');
  }
  const testMode = e.NODE_ENV === 'test' && new URL(baseUrl).hostname === 'localhost';
  const testLogin = e.ENABLE_TEST_LOGIN === 'true';
  if (testLogin && !testMode) {
    throw new Error('ENABLE_TEST_LOGIN requires NODE_ENV=test and a localhost BASE_URL.');
  }
  if ((e.TODOIST_API_BASE_URL || e.TODOIST_OAUTH_BASE_URL) && !testMode) {
    throw new Error('TODOIST_API_BASE_URL and TODOIST_OAUTH_BASE_URL are for tests only: they require NODE_ENV=test and a localhost BASE_URL.');
  }
  if ((e.GOOGLE_OAUTH_BASE_URL || e.GOOGLE_API_BASE_URL) && !testMode) {
    throw new Error('GOOGLE_OAUTH_BASE_URL and GOOGLE_API_BASE_URL are for tests only: they require NODE_ENV=test and a localhost BASE_URL.');
  }
  if ((e.PLAID_API_BASE_URL || e.PLAID_LINK_SCRIPT_URL) && !testMode) {
    throw new Error('PLAID_API_BASE_URL and PLAID_LINK_SCRIPT_URL are for tests only: they require NODE_ENV=test and a localhost BASE_URL.');
  }
  if (!e.GOOGLE_OAUTH_BASE_URL !== !e.GOOGLE_API_BASE_URL) {
    throw new Error('Set both GOOGLE_OAUTH_BASE_URL and GOOGLE_API_BASE_URL, or neither.');
  }
  // They point at the fakes the tests run next to the app, never at another host: tokens and the
  // client secrets are sent there.
  const testUrls = [
    ['TODOIST_API_BASE_URL', e.TODOIST_API_BASE_URL],
    ['TODOIST_OAUTH_BASE_URL', e.TODOIST_OAUTH_BASE_URL],
    ['GOOGLE_OAUTH_BASE_URL', e.GOOGLE_OAUTH_BASE_URL],
    ['GOOGLE_API_BASE_URL', e.GOOGLE_API_BASE_URL],
    ['PLAID_API_BASE_URL', e.PLAID_API_BASE_URL],
    ['PLAID_LINK_SCRIPT_URL', e.PLAID_LINK_SCRIPT_URL],
  ] as const;
  for (const [name, value] of testUrls) {
    if (!value) continue;
    const url = new URL(value);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1')) {
      throw new Error(`${name} must be an http or https URL on localhost or 127.0.0.1.`);
    }
  }
  if (!e.TODOIST_CLIENT_ID !== !e.TODOIST_CLIENT_SECRET) {
    throw new Error('Set both TODOIST_CLIENT_ID and TODOIST_CLIENT_SECRET, or neither.');
  }
  const todoist: TodoistConfig | null = e.TODOIST_CLIENT_ID && e.TODOIST_CLIENT_SECRET
    ? {
        clientId: e.TODOIST_CLIENT_ID,
        clientSecret: e.TODOIST_CLIENT_SECRET,
        apiBaseUrl: new URL(e.TODOIST_API_BASE_URL ?? TODOIST_API_BASE_URL).origin,
        oauthBaseUrl: new URL(e.TODOIST_OAUTH_BASE_URL ?? TODOIST_OAUTH_BASE_URL).origin,
      }
    : null;
  if (!e.PLAID_CLIENT_ID !== !e.PLAID_SECRET) {
    // No alias: a deploy that used the other name fails here with the fix in the message.
    const hint = e.PLAID_CLIENT_ID && e.PLAID_CLIENT_SECRET ? " PLAID_CLIENT_SECRET isn't read: rename it to PLAID_SECRET." : '';
    throw new Error(`Set both PLAID_CLIENT_ID and PLAID_SECRET, or neither.${hint}`);
  }
  const plaid: PlaidConfig | null = e.PLAID_CLIENT_ID && e.PLAID_SECRET
    ? {
        clientId: e.PLAID_CLIENT_ID,
        secret: e.PLAID_SECRET,
        env: e.PLAID_ENV,
        apiBaseUrl: new URL(e.PLAID_API_BASE_URL ?? PLAID_API_BASE_URLS[e.PLAID_ENV]).origin,
        // The whole URL, not the origin: the Link pages' CSP allows exactly this script.
        linkScriptUrl: new URL(e.PLAID_LINK_SCRIPT_URL ?? PLAID_LINK_SCRIPT_URL).href,
      }
    : null;
  const googleEndpoints = e.GOOGLE_OAUTH_BASE_URL && e.GOOGLE_API_BASE_URL
    ? fakeGoogleEndpoints(e.GOOGLE_OAUTH_BASE_URL, e.GOOGLE_API_BASE_URL)
    : GOOGLE_ENDPOINTS;
  const tokenEncryptionKey = parseEncryptionKey(e.TOKEN_ENCRYPTION_KEY);
  return {
    baseUrl,
    host: e.HOST,
    port: e.PORT,
    dataDir: e.DATA_DIR,
    sessionSecret: e.SESSION_SECRET,
    bootstrapAdminEmail: e.BOOTSTRAP_ADMIN_EMAIL,
    googleClientId: e.GOOGLE_CLIENT_ID,
    googleClientSecret: e.GOOGLE_CLIENT_SECRET,
    googleEndpoints,
    logLevel: e.LOG_LEVEL,
    testLogin,
    todoist,
    plaid,
    tokenEncryptionKey,
  };
}
