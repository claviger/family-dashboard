import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pino from 'pino';
import type { Hono } from 'hono';
import type { CreateUserInput } from '../../shared/api.js';
import type { TodoItem } from '../../shared/todo.js';
import { createApp, type AppDeps, type AppEnv } from '../app.js';
import { createUser } from '../admin/users.js';
import type { AuthorizationParams, GoogleOidc } from '../auth/google.js';
import type { GoogleClaims } from '../auth/identity.js';
import { createSession } from '../auth/sessions.js';
import { fakeGoogleEndpoints, type Config, type PlaidConfig } from '../config.js';
import { FakeClock } from '../core/clock.js';
import { singleKeyring } from '../core/crypto.js';
import { EventBus, type EventName } from '../core/events.js';
import { openDb, type Db } from '../db/index.js';
import { connections, todoistState } from '../db/schema.js';
import { encryptCredentials, insertFamilyConnection } from '../integrations/connections.js';
import { GoogleCalendar, type CalendarMeta } from '../integrations/google/calendar.js';
import { Plaid } from '../integrations/plaid/plaid.js';
import { Todoist } from '../integrations/todoist/todoist.js';
import type { NewTodo, TodoBackend, TodoChanges } from '../panels/todo/backend.js';
import { CalendarService } from '../panels/calendar/service.js';
import { SavingsSync } from '../panels/savings/sync.js';
import { BankSync } from '../panels/spend/plaidSync.js';
import { listenPanels } from '../panels/registry.js';
import { InternalTodoBackend } from '../panels/todo/internalBackend.js';
import { TodoService } from '../panels/todo/service.js';
import { FakeGoogleCalendar, SCOPES, type FakeCalendar, type FakeGoogleAccount } from './fakeGoogleCalendar.js';
import { FAKE_PLAID_CLIENT_ID, FAKE_PLAID_SECRET, FakePlaid } from './fakePlaid.js';
import { FakeTodoist, type FakeAccount } from './fakeTodoist.js';

export const TEST_BASE_URL = 'http://localhost:3000';

/** The test app's TOKEN_ENCRYPTION_KEY. */
export const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 9);

/**
 * Where the test app's calendar link and Calendar API go: the in-memory FakeGoogleCalendar
 * answers only on these origins (the consent page and issuer on one, the server's calls on the
 * other), so a mix-up between them fails.
 */
export const TEST_GOOGLE_OAUTH_ORIGIN = 'https://accounts.google.test';
export const TEST_GOOGLE_API_ORIGIN = 'https://api.google.test';

/**
 * The test app's Plaid keys and hosts when `plaid: true`: synthetic, and on `.test` origins the
 * in-memory FakePlaid answers (the API) or that only appear in the Link CSP (the script).
 */
export const TEST_PLAID_CONFIG: PlaidConfig = {
  clientId: FAKE_PLAID_CLIENT_ID,
  secret: FAKE_PLAID_SECRET,
  env: 'sandbox',
  apiBaseUrl: 'https://sandbox.plaid.test',
  linkScriptUrl: 'https://cdn.plaid.test/link/v2/stable/link-initialize.js',
};

/** What the test app serves as the Link page, unless a test passes its own. */
export const TEST_PLAID_LINK_HTML = '<!doctype html><title>Connect a bank</title><script type="module" src="/assets/plaid-link.js"></script>';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    baseUrl: TEST_BASE_URL,
    host: '127.0.0.1',
    port: 3000,
    dataDir: '',
    sessionSecret: 'test-secret-'.padEnd(40, 'x'),
    bootstrapAdminEmail: undefined,
    googleClientId: 'client-id',
    googleClientSecret: 'client-secret',
    googleEndpoints: fakeGoogleEndpoints(TEST_GOOGLE_OAUTH_ORIGIN, TEST_GOOGLE_API_ORIGIN),
    logLevel: 'silent',
    testLogin: false,
    todoist: null,
    plaid: null,
    tokenEncryptionKey: TEST_ENCRYPTION_KEY,
    ...overrides,
  };
}

export class FakeGoogle implements GoogleOidc {
  nextClaims: GoogleClaims = { sub: 'google-1', email: 'user@example.com', emailVerified: true };
  fail = false;
  authUrlFail = false;
  lastAuth: AuthorizationParams | undefined;
  lastExchange: (AuthorizationParams & { callbackUrl: URL }) | undefined;

  async authorizationUrl(params: AuthorizationParams): Promise<string> {
    if (this.authUrlFail) throw new Error('discovery failed');
    this.lastAuth = params;
    return `https://accounts.example/authorize?state=${params.state}`;
  }

  async exchange(params: AuthorizationParams & { callbackUrl: URL }): Promise<GoogleClaims> {
    this.lastExchange = params;
    if (this.fail) throw new Error('exchange failed');
    return this.nextClaims;
  }
}

export interface TestApp extends AppDeps {
  app: Hono<AppEnv>;
  clock: FakeClock;
  google: FakeGoogle;
  /** Errors thrown by event handlers, in order. */
  eventErrors: { event: EventName; err: unknown }[];
  /** The fake Todoist behind `todoist` (always present; `todoist` is null unless `todoist: true`). */
  fakeTodoist: FakeTodoist;
  /** The fake Google (OAuth and Calendar) behind `calendar`. */
  fakeGoogleCalendar: FakeGoogleCalendar;
  /** The fake Plaid behind `plaid` (always present; `plaid` is null unless Plaid is configured). */
  fakePlaid: FakePlaid;
}

/**
 * `listen: false` leaves the panels' event handlers unsubscribed, for tests of the to-do layer on
 * its own. `todoist: true` configures Todoist against an in-memory FakeTodoist (`t.fakeTodoist`),
 * which shares the test clock. `keyMismatch: true` is a TOKEN_ENCRYPTION_KEY that failed the key check.
 * `fakeTodoist` shares another app's FakeTodoist, like two installs linked to the same accounts.
 * The Google Calendar link always runs against an in-memory FakeGoogleCalendar
 * (`t.fakeGoogleCalendar`, sharing the test clock), whose retries don't wait. `logger` replaces
 * the silent one, e.g. to check what's logged. `plaid: true` configures Plaid (TEST_PLAID_CONFIG)
 * against an in-memory FakePlaid (`t.fakePlaid`, sharing the test clock, retries not waiting), with
 * a BankSync and a SavingsSync over it; so does a `config.plaid` of a test's own. `plaidLinkHtml` replaces the stub
 * Link page (null: not built). `plaidRequestBudgetMs` shortens a request's Plaid budget, so a test
 * can overrun it for real.
 */
export function makeTestApp(
  opts: {
    config?: Partial<Config>; listen?: boolean; todoist?: boolean; plaid?: boolean; keyMismatch?: boolean; fakeTodoist?: FakeTodoist; logger?: pino.Logger;
    plaidLinkHtml?: string | null; plaidRequestBudgetMs?: number;
  } = {},
): TestApp {
  const { db, sqlite } = openDb(':memory:');
  const clock = new FakeClock(new Date('2026-11-15T12:00:00Z'));
  const google = new FakeGoogle();
  const eventErrors: TestApp['eventErrors'] = [];
  const events = new EventBus((event, err) => eventErrors.push({ event, err }));
  const fakeTodoist = opts.fakeTodoist ?? new FakeTodoist();
  fakeTodoist.now = () => clock.now().getTime();
  const logger = opts.logger ?? pino({ level: 'silent' });
  const config = testConfig({
    ...(opts.todoist
      ? { todoist: { clientId: fakeTodoist.clientId, clientSecret: fakeTodoist.clientSecret, apiBaseUrl: 'https://api.todoist.test', oauthBaseUrl: 'https://app.todoist.test' } }
      : {}),
    ...(opts.plaid ? { plaid: TEST_PLAID_CONFIG } : {}),
    ...opts.config,
  });
  // Each endpoint only on its own origin, so a client call on the wrong base URL fails.
  if (config.todoist) fakeTodoist.origins = { api: config.todoist.apiBaseUrl, oauth: config.todoist.oauthBaseUrl };
  const todoist = config.todoist
    ? new Todoist({
        db, clock, logger, config: config.todoist, keyring: singleKeyring(config.tokenEncryptionKey), fetch: fakeTodoist.fetch, keyMismatch: opts.keyMismatch,
        plaidConfigured: config.plaid !== null,
      })
    : null;
  const fakeGoogleCalendar = new FakeGoogleCalendar(config.googleClientId, config.googleClientSecret);
  fakeGoogleCalendar.origins = { oauth: new URL(config.googleEndpoints.authorization).origin, api: new URL(config.googleEndpoints.token).origin };
  fakeGoogleCalendar.now = () => clock.now().getTime();
  const calendar = new GoogleCalendar({
    db, clock, logger, keyring: singleKeyring(config.tokenEncryptionKey), fetch: fakeGoogleCalendar.fetch, keyMismatch: opts.keyMismatch, todoistConfigured: todoist !== null,
    plaidConfigured: config.plaid !== null,
    google: { clientId: config.googleClientId, clientSecret: config.googleClientSecret, endpoints: config.googleEndpoints },
    clientOptions: { sleep: async () => {} },
  });
  const fakePlaid = new FakePlaid(config.plaid?.clientId, config.plaid?.secret);
  fakePlaid.now = () => clock.now().getTime();
  if (config.plaid) fakePlaid.origin = new URL(config.plaid.apiBaseUrl).origin;
  const plaid = config.plaid
    ? new Plaid({
        db, clock, logger, keyring: singleKeyring(config.tokenEncryptionKey), fetch: fakePlaid.fetch, config: config.plaid, baseUrl: config.baseUrl,
        keyMismatch: opts.keyMismatch, clientOptions: { sleep: async () => {} }, requestBudgetMs: opts.plaidRequestBudgetMs,
      })
    : null;
  const linkHtml = opts.plaidLinkHtml === undefined ? TEST_PLAID_LINK_HTML : opts.plaidLinkHtml;
  const savings = plaid ? new SavingsSync({ db, clock, logger, plaid }) : null;
  const deps: AppDeps = {
    db,
    sqlite,
    clock,
    events,
    todos: new TodoService({ db, clock, events, todoist }),
    config,
    google,
    todoist,
    calendar,
    calendarEvents: new CalendarService({ db, clock, logger, provider: calendar }),
    plaid,
    bank: plaid ? new BankSync({ db, clock, logger, plaid, savings }) : null,
    savings,
    plaidLinkHtml: () => linkHtml,
    systemWarnings: [],
    logger,
    backupDir: mkdtempSync(join(tmpdir(), 'fd-backups-')),
    version: 'test',
  };
  if (opts.listen !== false) listenPanels(deps); // e.g. the Chores panel's to-do event handlers
  return { ...deps, clock, google, eventErrors, fakeTodoist, fakeGoogleCalendar, fakePlaid, app: createApp(deps) };
}

/**
 * Links the family calendar as if `userId` (an admin) had finished the consent page and picked
 * `calendar` (by default a new "Family" calendar of a new Google account): a connection with fresh
 * tokens for every scope the link asks for.
 */
export function linkCalendarForTest(
  t: TestApp,
  userId: number,
  opts: { account?: FakeGoogleAccount; calendar?: FakeCalendar; scopes?: string[] } = {},
): { account: FakeGoogleAccount; calendar: FakeCalendar } {
  const account = opts.account ?? t.fakeGoogleCalendar.createAccount({ email: 'family@example.com' });
  const calendar = opts.calendar ?? t.fakeGoogleCalendar.addCalendar(account, { summary: 'Family', timeZone: 'America/Los_Angeles' });
  const tokens = t.fakeGoogleCalendar.grant(account, opts.scopes ?? ['openid', 'email', SCOPES.events, SCOPES.calendarList]);
  const now = t.clock.now();
  const meta: CalendarMeta = { account: account.email, accountId: account.sub, calendarId: calendar.id, calendarName: calendar.summary, calendarTimeZone: calendar.timeZone };
  t.db.transaction((tx) =>
    insertFamilyConnection(tx, singleKeyring(t.config.tokenEncryptionKey), { kind: 'google_calendar', ownerUserId: userId, meta, now }, {
      refreshToken: tokens.refresh_token, accessToken: tokens.access_token, expiresAt: now.getTime() + tokens.expires_in * 1000,
    }),
  );
  return { account, calendar };
}

/**
 * Links `userId` to a fake Todoist account (a new one by default) as if they had finished the
 * OAuth flow: a connection with fresh tokens and an empty sync state, so the next sync is full.
 */
export function linkTodoistForTest(t: TestApp, userId: number, account: FakeAccount = t.fakeTodoist.createAccount()): FakeAccount {
  const tokens = t.fakeTodoist.grant(account);
  const now = t.clock.now();
  const creds = { accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: now.getTime() + tokens.expires_in * 1000 };
  t.db.insert(connections)
    .values({
      kind: 'todoist',
      scope: 'user',
      ownerUserId: userId,
      credentialsEnc: encryptCredentials(singleKeyring(TEST_ENCRYPTION_KEY), { kind: 'todoist', scope: 'user', ownerUserId: userId }, creds),
      createdAt: now,
      updatedAt: now,
    })
    .run();
  t.db.insert(todoistState).values({ userId, todoistUserId: account.id, createdAt: now, updatedAt: now }).run();
  return account;
}

export function addUser(db: Db, clock: FakeClock, overrides: Partial<CreateUserInput> = {}): number {
  return createUser(db, clock, {
    email: 'user@example.com',
    displayName: 'User',
    color: '#378ADD',
    role: 'member',
    panels: [],
    ...overrides,
  });
}

export function cookieFor(db: Db, clock: FakeClock, userId: number): string {
  return `__Host-session=${createSession(db, clock, userId).token}`;
}

/** Sends a request like the web client does: CSRF headers on mutations unless `csrf: false`. */
export function call(
  app: Hono<AppEnv>,
  method: string,
  path: string,
  opts: { cookie?: string; body?: unknown; csrf?: boolean } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers.cookie = opts.cookie;
  if (method !== 'GET' && opts.csrf !== false) {
    headers['x-requested-with'] = 'dashboard';
    headers.origin = TEST_BASE_URL;
  }
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  return Promise.resolve(
    app.request(path, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
  );
}

/**
 * A TodoBackend that fails and otherwise behaves like the internal one. It stands in for Todoist
 * being down, which the internal backend never is. `failing` is true (every call fails), false, or
 * the names of the methods that fail, e.g. `new Set(['remove'])`.
 *
 * Calls to the methods in `stalled` never return, like a server that crashes while the call is in
 * flight: what's in the database then is what a restart would find.
 */
export class FlakyTodoBackend implements TodoBackend {
  readonly kind = 'internal' as const;
  failing: boolean | ReadonlySet<keyof TodoBackend> = true;
  stalled: ReadonlySet<keyof TodoBackend> = new Set();
  constructor(private readonly inner: TodoBackend) {}
  private async run<T>(method: keyof TodoBackend, fn: () => Promise<T>): Promise<T> {
    if (this.stalled.has(method)) return new Promise<T>(() => {});
    if (this.failing === true || (this.failing instanceof Set && this.failing.has(method))) throw new Error('Todoist is unavailable');
    return fn();
  }
  listOpen(ownerId: number): Promise<TodoItem[]> { return this.run('listOpen', () => this.inner.listOpen(ownerId)); }
  listCompletedSince(ownerId: number, since: Date): Promise<TodoItem[]> {
    return this.run('listCompletedSince', () => this.inner.listCompletedSince(ownerId, since));
  }
  get(ownerId: number, id: number): Promise<TodoItem | null> { return this.run('get', () => this.inner.get(ownerId, id)); }
  findByChoreOccurrence(ownerId: number, occurrenceId: number): Promise<TodoItem | null> {
    return this.run('findByChoreOccurrence', () => this.inner.findByChoreOccurrence(ownerId, occurrenceId));
  }
  create(ownerId: number, todo: NewTodo): Promise<TodoItem> { return this.run('create', () => this.inner.create(ownerId, todo)); }
  update(ownerId: number, id: number, changes: TodoChanges): Promise<TodoItem> {
    return this.run('update', () => this.inner.update(ownerId, id, changes));
  }
  complete(ownerId: number, id: number, at: Date): Promise<TodoItem | null> { return this.run('complete', () => this.inner.complete(ownerId, id, at)); }
  reopen(ownerId: number, id: number): Promise<TodoItem | null> { return this.run('reopen', () => this.inner.reopen(ownerId, id)); }
  remove(ownerId: number, id: number): Promise<TodoItem> { return this.run('remove', () => this.inner.remove(ownerId, id)); }
}

/** Routes every list in `t` through a FlakyTodoBackend, which starts out failing as given (default: everything). */
export function useFlakyTodos(t: TestApp, failing: FlakyTodoBackend['failing'] = true): FlakyTodoBackend {
  const flaky = new FlakyTodoBackend(new InternalTodoBackend(t));
  flaky.failing = failing;
  t.todos.backendFor = () => flaky;
  return flaky;
}
