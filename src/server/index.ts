import { serve } from '@hono/node-server';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path, { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, type AppDeps } from './app.js';
import { createGoogleOidc } from './auth/google.js';
import { loadConfig, type Config } from './config.js';
import { systemClock } from './core/clock.js';
import { loggableError } from './core/errors.js';
import { singleKeyring } from './core/crypto.js';
import { EventBus } from './core/events.js';
import { startScheduler } from './core/jobs.js';
import { createLogger } from './core/logger.js';
import { openDb } from './db/index.js';
import { GoogleCalendar } from './integrations/google/calendar.js';
import { checkTokenKey, keyMismatchWarning } from './integrations/keyCheck.js';
import { Plaid } from './integrations/plaid/plaid.js';
import { Todoist } from './integrations/todoist/todoist.js';
import { todoistUnconfiguredWarning } from './integrations/todoistUnconfigured.js';
import { platformJobs } from './jobs.js';
import { CalendarService } from './panels/calendar/service.js';
import { SavingsSync } from './panels/savings/sync.js';
import { BankSync } from './panels/spend/plaidSync.js';
import { listenPanels, panelJobs } from './panels/registry.js';
import { TodoService } from './panels/todo/service.js';
import { bootstrap, getFamilySettings } from './settings.js';
import { mountStatic } from './static.js';

// Everything we create (database, backups, WAL files) must be private to this user.
process.umask(0o077);

let config: Config;
try {
  config = loadConfig(process.env);
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}
`);
  process.exit(1);
}
const logger = createLogger(config.logLevel);

// dist/server/index.js → repo root is two levels up; built web assets are in dist/web.
const rootDir = fileURLToPath(new URL('../../', import.meta.url));
const version = (JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')) as { version: string }).version;
// serveStatic expects forward slashes, even on Windows.
const webDir =
  path.relative(process.cwd(), fileURLToPath(new URL('../web', import.meta.url))).split(path.sep).join('/') || '.';

mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
mkdirSync(join(config.dataDir, 'backups'), { recursive: true, mode: 0o700 });
const dbPath = join(config.dataDir, 'dashboard.db');
const { db, sqlite } = openDb(dbPath);
chmodSync(dbPath, 0o600);

const { createdAdmin } = bootstrap(db, systemClock, {
  adminEmail: config.bootstrapAdminEmail,
  defaultTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
});
if (createdAdmin) logger.info({ email: config.bootstrapAdminEmail }, 'created bootstrap admin');

let stopScheduler: () => Promise<void> = async () => {};
// Only the error's name and code: a Drizzle error quotes the query's values (task titles).
const events = new EventBus((event, err) => logger.error({ event, ...loggableError(err) }, 'event handler failed'));
// loadConfig always requires TOKEN_ENCRYPTION_KEY. A key that doesn't match the stored check
// doesn't stop the app: integrations go quiet and the System page says why.
const keyring = singleKeyring(config.tokenEncryptionKey);
const keyMismatch = checkTokenKey(db, keyring) === 'mismatch';
if (keyMismatch) logger.error(keyMismatchWarning({ todoist: config.todoist !== null, plaid: config.plaid !== null }));
const todoist = config.todoist
  ? new Todoist({ db, clock: systemClock, logger, config: config.todoist, keyring, fetch, keyMismatch, plaidConfigured: config.plaid !== null })
  : null;
// Before any sync, on every start: drop mirror rows an older version kept from projects other than
// the Inbox (the owner's change request of 2026-11-16). A failure is logged and the site starts
// anyway; it's tried again on the next start, and syncs drop such rows as they see them meanwhile.
try {
  todoist?.cleanUpOutOfScopeRows();
} catch (err) {
  logger.error(loggableError(err), "couldn't drop todoist rows from outside the inbox");
}
const calendar = new GoogleCalendar({
  db, clock: systemClock, logger, keyring, fetch, keyMismatch, todoistConfigured: todoist !== null, plaidConfigured: config.plaid !== null,
  google: { clientId: config.googleClientId, clientSecret: config.googleClientSecret, endpoints: config.googleEndpoints },
});
const plaid = config.plaid
  ? new Plaid({ db, clock: systemClock, logger, keyring, fetch, config: config.plaid, baseUrl: config.baseUrl, keyMismatch })
  : null;
const savings = plaid ? new SavingsSync({ db, clock: systemClock, logger, plaid }) : null;
const bank = plaid ? new BankSync({ db, clock: systemClock, logger, plaid, savings }) : null;
// The Link page is the build's second entry (vite.config.ts). Read once, when first asked for: a
// server started without a build (tests, dev) answers 503 there instead of failing to start.
const plaidLinkPath = fileURLToPath(new URL('../web/plaid-link.html', import.meta.url));
let plaidLinkPage: string | null = null;
function plaidLinkHtml(): string | null {
  if (plaidLinkPage === null && existsSync(plaidLinkPath)) plaidLinkPage = readFileSync(plaidLinkPath, 'utf8');
  return plaidLinkPage;
}
// Todoist turned off after people linked: their lists look empty, but nothing is lost. Refusing to
// start would take the whole site down, so the System page says so instead.
const todoistOff = todoist ? null : todoistUnconfiguredWarning(db);
if (todoistOff) logger.error(todoistOff);
const deps: AppDeps = {
  db,
  sqlite,
  clock: systemClock,
  events,
  todos: new TodoService({ db, clock: systemClock, events, todoist }),
  config,
  google: createGoogleOidc(config),
  todoist,
  calendar,
  calendarEvents: new CalendarService({ db, clock: systemClock, logger, provider: calendar }),
  plaid,
  bank,
  savings,
  plaidLinkHtml,
  // The integrations' own warnings carry a key mismatch, and clear once an admin resets the links.
  systemWarnings: todoistOff ? [todoistOff] : [],
  logger,
  backupDir: join(config.dataDir, 'backups'),
  version,
  onFamilySettingsChanged: () => scheduleJobs(),
};

listenPanels(deps);

function scheduleJobs(): void {
  void stopScheduler();
  stopScheduler = startScheduler(deps, [...platformJobs(deps), ...panelJobs(deps)], getFamilySettings(db).timeZone);
}

const app = createApp(deps);

mountStatic(app, webDir);

scheduleJobs();
const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  logger.info({ host: info.address, port: info.port, version }, 'family dashboard listening');
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');
  setTimeout(() => {
    logger.error('shutdown timed out; forcing exit');
    process.exit(1);
  }, 8000).unref();
  server.close();
  (server as { closeAllConnections?: () => void }).closeAllConnections?.();
  await stopScheduler();
  // Webhook syncs still running finish first, so a run's changes and cursor are saved together.
  await bank?.idle();
  await savings?.idle();
  sqlite.close();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
