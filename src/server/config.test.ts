import { describe, expect, it } from 'vitest';
import { GOOGLE_ENDPOINTS, loadConfig, PLAID_API_BASE_URLS, PLAID_LINK_SCRIPT_URL } from './config.js';

const key = Buffer.alloc(32, 7).toString('base64');
const env = {
  BASE_URL: 'https://dashboard.example.com',
  SESSION_SECRET: 's'.repeat(32),
  GOOGLE_CLIENT_ID: 'id',
  GOOGLE_CLIENT_SECRET: 'secret',
  TOKEN_ENCRYPTION_KEY: key,
};

describe('loadConfig', () => {
  it('applies defaults', () => {
    expect(loadConfig(env)).toEqual({
      baseUrl: 'https://dashboard.example.com',
      host: '127.0.0.1',
      port: 3000,
      dataDir: '/data',
      sessionSecret: 's'.repeat(32),
      bootstrapAdminEmail: undefined,
      googleClientId: 'id',
      googleClientSecret: 'secret',
      googleEndpoints: {
        issuer: 'https://accounts.google.com',
        authorization: 'https://accounts.google.com/o/oauth2/v2/auth',
        token: 'https://oauth2.googleapis.com/token',
        revocation: 'https://oauth2.googleapis.com/revoke',
        calendarApi: 'https://www.googleapis.com/calendar/v3',
      },
      logLevel: 'info',
      testLogin: false,
      todoist: null,
      plaid: null,
      tokenEncryptionKey: Buffer.alloc(32, 7),
    });
  });

  it('reports every missing variable', () => {
    expect(() => loadConfig({})).toThrow(/BASE_URL[\s\S]*SESSION_SECRET[\s\S]*GOOGLE_CLIENT_ID[\s\S]*TOKEN_ENCRYPTION_KEY/);
  });

  it('always requires a well-formed TOKEN_ENCRYPTION_KEY, since Google Calendar can always be linked', () => {
    expect(() => loadConfig({ ...env, TOKEN_ENCRYPTION_KEY: undefined })).toThrow(/TOKEN_ENCRYPTION_KEY: is required/);
    expect(() => loadConfig({ ...env, TOKEN_ENCRYPTION_KEY: '' })).toThrow(/TOKEN_ENCRYPTION_KEY: is required/);
    expect(() => loadConfig({ ...env, TOKEN_ENCRYPTION_KEY: 'c2hvcnQ=' })).toThrow(/32 bytes/);
  });

  it("uses Google's real endpoints for the calendar link unless a test points them at the fake", () => {
    expect(loadConfig(env).googleEndpoints).toEqual(GOOGLE_ENDPOINTS);
    const test = {
      ...env, NODE_ENV: 'test', BASE_URL: 'http://localhost:3100',
      GOOGLE_OAUTH_BASE_URL: 'http://localhost:3102/', GOOGLE_API_BASE_URL: 'http://127.0.0.1:3102',
    };
    expect(loadConfig(test).googleEndpoints).toEqual({
      issuer: 'http://localhost:3102',
      authorization: 'http://localhost:3102/o/oauth2/v2/auth',
      token: 'http://127.0.0.1:3102/token',
      revocation: 'http://127.0.0.1:3102/revoke',
      calendarApi: 'http://127.0.0.1:3102/calendar/v3',
    });
    expect(() => loadConfig({ ...test, NODE_ENV: 'production' })).toThrow(/GOOGLE_OAUTH_BASE_URL and GOOGLE_API_BASE_URL are for tests only/);
    expect(() => loadConfig({ ...test, BASE_URL: 'https://dashboard.example.com' })).toThrow(/for tests only/);
    expect(() => loadConfig({ ...test, GOOGLE_API_BASE_URL: undefined })).toThrow(/both GOOGLE_OAUTH_BASE_URL and GOOGLE_API_BASE_URL/);
    for (const url of ['https://evil.example', 'http://localhost.evil.example', 'ftp://localhost:3102', 'http://10.0.0.5:3102']) {
      expect(() => loadConfig({ ...test, GOOGLE_OAUTH_BASE_URL: url })).toThrow(/localhost/);
      expect(() => loadConfig({ ...test, GOOGLE_API_BASE_URL: url })).toThrow(/localhost/);
    }
  });

  it('allows test login only in test mode on localhost', () => {
    const test = { ...env, ENABLE_TEST_LOGIN: 'true', NODE_ENV: 'test', BASE_URL: 'http://localhost:3100' };
    expect(loadConfig(test).testLogin).toBe(true);
    expect(() => loadConfig({ ...test, NODE_ENV: 'production' })).toThrow(/ENABLE_TEST_LOGIN/);
    expect(() => loadConfig({ ...test, BASE_URL: 'https://dashboard.example.com' })).toThrow(/ENABLE_TEST_LOGIN/);
  });

  it('treats empty strings as unset', () => {
    expect(loadConfig({ ...env, BOOTSTRAP_ADMIN_EMAIL: '' }).bootstrapAdminEmail).toBeUndefined();
  });

  it('requires https unless the host is localhost or 127.0.0.1', () => {
    expect(() => loadConfig({ ...env, BASE_URL: 'http://dashboard.example.com' })).toThrow(/BASE_URL must use https/);
    expect(loadConfig({ ...env, BASE_URL: 'http://localhost:5173' }).baseUrl).toBe('http://localhost:5173');
    expect(loadConfig({ ...env, BASE_URL: 'http://127.0.0.1:5173' }).baseUrl).toBe('http://127.0.0.1:5173');
  });

  it('rejects an invalid log level', () => {
    expect(() => loadConfig({ ...env, LOG_LEVEL: 'loud' })).toThrow(/LOG_LEVEL/);
    expect(loadConfig({ ...env, LOG_LEVEL: 'debug' }).logLevel).toBe('debug');
  });

  describe('Todoist', () => {
    const todoistEnv = { ...env, TODOIST_CLIENT_ID: 'td-id', TODOIST_CLIENT_SECRET: 'td-secret' };

    it('is off unless both client values are set, and needs both or neither', () => {
      expect(loadConfig(env).todoist).toBeNull();
      expect(() => loadConfig({ ...env, TODOIST_CLIENT_ID: 'td-id' })).toThrow(/both TODOIST_CLIENT_ID and TODOIST_CLIENT_SECRET/);
      expect(() => loadConfig({ ...env, TODOIST_CLIENT_SECRET: 'td-secret' })).toThrow(/both TODOIST_CLIENT_ID and TODOIST_CLIENT_SECRET/);
    });

    it("uses Todoist's real hosts", () => {
      const config = loadConfig(todoistEnv);
      expect(config.todoist).toEqual({
        clientId: 'td-id',
        clientSecret: 'td-secret',
        apiBaseUrl: 'https://api.todoist.com',
        oauthBaseUrl: 'https://app.todoist.com',
      });
      expect(config.tokenEncryptionKey.equals(Buffer.alloc(32, 7))).toBe(true);
    });

    it('allows the fake-Todoist URLs only in test mode on localhost', () => {
      const test = {
        ...todoistEnv,
        NODE_ENV: 'test',
        BASE_URL: 'http://localhost:3100',
        TODOIST_API_BASE_URL: 'http://localhost:3101/',
        TODOIST_OAUTH_BASE_URL: 'http://localhost:3101',
      };
      expect(loadConfig(test).todoist).toMatchObject({ apiBaseUrl: 'http://localhost:3101', oauthBaseUrl: 'http://localhost:3101' });
      expect(() => loadConfig({ ...test, NODE_ENV: 'production' })).toThrow(/for tests only/);
      expect(() => loadConfig({ ...test, BASE_URL: 'https://dashboard.example.com' })).toThrow(/for tests only/);
      expect(() => loadConfig({ ...todoistEnv, TODOIST_OAUTH_BASE_URL: 'https://evil.example' })).toThrow(/for tests only/);
    });

    it('accepts only http(s) URLs on localhost or 127.0.0.1 for the fake, even in test mode', () => {
      const test = { ...todoistEnv, NODE_ENV: 'test', BASE_URL: 'http://localhost:3100' };
      expect(loadConfig({ ...test, TODOIST_API_BASE_URL: 'http://127.0.0.1:3101' }).todoist?.apiBaseUrl).toBe('http://127.0.0.1:3101');
      for (const url of ['https://evil.example', 'http://localhost.evil.example', 'ftp://localhost:3101', 'http://10.0.0.5:3101']) {
        expect(() => loadConfig({ ...test, TODOIST_API_BASE_URL: url })).toThrow(/localhost/);
        expect(() => loadConfig({ ...test, TODOIST_OAUTH_BASE_URL: url })).toThrow(/localhost/);
      }
    });
  });

  describe('Plaid', () => {
    // Synthetic values: not real Plaid keys.
    const plaidEnv = { ...env, PLAID_CLIENT_ID: 'plaid-id', PLAID_SECRET: 'plaid-secret' };

    it('is off unless both values are set, and needs both or neither', () => {
      expect(loadConfig(env).plaid).toBeNull();
      expect(() => loadConfig({ ...env, PLAID_CLIENT_ID: 'plaid-id' })).toThrow(/both PLAID_CLIENT_ID and PLAID_SECRET/);
      expect(() => loadConfig({ ...env, PLAID_SECRET: 'plaid-secret' })).toThrow(/both PLAID_CLIENT_ID and PLAID_SECRET/);
    });

    it('names the rename when PLAID_CLIENT_SECRET is set instead of PLAID_SECRET, and never reads it', () => {
      const wrongName = { ...env, PLAID_CLIENT_ID: 'plaid-id', PLAID_CLIENT_SECRET: 'plaid-secret' };
      expect(() => loadConfig(wrongName)).toThrow(/both PLAID_CLIENT_ID and PLAID_SECRET[\s\S]*PLAID_CLIENT_SECRET isn't read: rename it to PLAID_SECRET\./);
      expect(() => loadConfig({ ...env, PLAID_CLIENT_ID: 'plaid-id' })).not.toThrow(/PLAID_CLIENT_SECRET/);
      // Both names set: PLAID_SECRET is the one used.
      expect(loadConfig({ ...plaidEnv, PLAID_CLIENT_SECRET: 'other' }).plaid?.secret).toBe('plaid-secret');
      expect(loadConfig({ ...env, PLAID_CLIENT_SECRET: 'plaid-secret' }).plaid).toBeNull();
    });

    it('defaults to production, and PLAID_ENV picks the API host', () => {
      expect(loadConfig(plaidEnv).plaid).toEqual({
        clientId: 'plaid-id',
        secret: 'plaid-secret',
        env: 'production',
        apiBaseUrl: 'https://production.plaid.com',
        linkScriptUrl: 'https://cdn.plaid.com/link/v2/stable/link-initialize.js',
      });
      expect(loadConfig({ ...plaidEnv, PLAID_ENV: 'sandbox' }).plaid).toMatchObject({ env: 'sandbox', apiBaseUrl: 'https://sandbox.plaid.com' });
      expect(PLAID_API_BASE_URLS).toEqual({ sandbox: 'https://sandbox.plaid.com', production: 'https://production.plaid.com' });
      expect(PLAID_LINK_SCRIPT_URL).toBe('https://cdn.plaid.com/link/v2/stable/link-initialize.js');
      expect(() => loadConfig({ ...plaidEnv, PLAID_ENV: 'development' })).toThrow(/PLAID_ENV/);
    });

    it('allows the fake-Plaid URLs only in test mode on localhost', () => {
      const test = {
        ...plaidEnv,
        NODE_ENV: 'test',
        BASE_URL: 'http://localhost:3100',
        PLAID_ENV: 'sandbox',
        PLAID_API_BASE_URL: 'http://127.0.0.1:3103/',
        PLAID_LINK_SCRIPT_URL: 'http://localhost:3103/link/v2/stable/link-initialize.js',
      };
      expect(loadConfig(test).plaid).toEqual({
        clientId: 'plaid-id',
        secret: 'plaid-secret',
        env: 'sandbox',
        apiBaseUrl: 'http://127.0.0.1:3103',
        linkScriptUrl: 'http://localhost:3103/link/v2/stable/link-initialize.js',
      });
      expect(() => loadConfig({ ...test, NODE_ENV: 'production' })).toThrow(/PLAID_API_BASE_URL and PLAID_LINK_SCRIPT_URL are for tests only/);
      expect(() => loadConfig({ ...test, BASE_URL: 'https://dashboard.example.com' })).toThrow(/for tests only/);
      expect(() => loadConfig({ ...plaidEnv, PLAID_API_BASE_URL: 'http://localhost:3103' })).toThrow(/for tests only/);
      expect(() => loadConfig({ ...plaidEnv, PLAID_LINK_SCRIPT_URL: 'http://localhost:3103/link.js' })).toThrow(/for tests only/);
    });

    it('accepts only http(s) URLs on localhost or 127.0.0.1 for the fake, even in test mode', () => {
      const test = { ...plaidEnv, NODE_ENV: 'test', BASE_URL: 'http://localhost:3100' };
      for (const url of ['https://evil.example', 'http://localhost.evil.example', 'ftp://localhost:3103', 'http://10.0.0.5:3103']) {
        expect(() => loadConfig({ ...test, PLAID_API_BASE_URL: url })).toThrow(/PLAID_API_BASE_URL must be an http or https URL on localhost/);
        expect(() => loadConfig({ ...test, PLAID_LINK_SCRIPT_URL: url })).toThrow(/PLAID_LINK_SCRIPT_URL must be an http or https URL on localhost/);
      }
    });
  });
});
