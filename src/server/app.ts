import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import type { Logger } from 'pino';
import type { MeResponse, SessionUser } from '../shared/api.js';
import { adminRoutes } from './admin/routes.js';
import { getGrants } from './admin/users.js';
import type { GoogleOidc } from './auth/google.js';
import { csrfMiddleware, requireAdmin, requireUser, sessionMiddleware } from './auth/middleware.js';
import { authRoutes } from './auth/routes.js';
import type { Config } from './config.js';
import type { Clock } from './core/clock.js';
import { errorHandler } from './core/errors.js';
import type { EventBus } from './core/events.js';
import type { Db } from './db/index.js';
import { listConnectionSummaries } from './integrations/connections.js';
import { calendarConnectRoutes } from './integrations/google/routes.js';
import type { GoogleCalendar } from './integrations/google/calendar.js';
import type { Plaid } from './integrations/plaid/plaid.js';
import { CSP_REPORT_PATH, cspReportRoutes, plaidConnectRoutes, plaidLinkHeaders, plaidWebhookRoutes, type SecureHeadersOptions } from './integrations/plaid/routes.js';
import type { CalendarService } from './panels/calendar/service.js';
import type { SavingsSync } from './panels/savings/sync.js';
import type { BankSync } from './panels/spend/plaidSync.js';
import { todoistConnectRoutes, todoistLinkRoutes, todoistWebhookRoutes } from './integrations/todoist/routes.js';
import type { Todoist } from './integrations/todoist/todoist.js';
import { panelRoutes } from './panels/registry.js';
import type { TodoService } from './panels/todo/service.js';
import { getFamilySettings } from './settings.js';

export interface AppDeps {
  db: Db;
  sqlite: Database.Database;
  clock: Clock;
  /** In-process event bus shared by every panel (spec §3.3). */
  events: EventBus;
  /** The one TodoService. Built from db, clock, and events; panels call it instead of touching todos directly. */
  todos: TodoService;
  config: Config;
  google: GoogleOidc;
  /** The Todoist integration, or null when TODOIST_CLIENT_ID/SECRET aren't set (spec §3.4). */
  todoist: Todoist | null;
  /** The family's Google Calendar link (spec §9). Always there: it uses the sign-in Google client. */
  calendar: GoogleCalendar;
  /** The Calendar panel's reads and writes, through `calendar`. One per app, so windows being fetched are shared. */
  calendarEvents: CalendarService;
  /** The Plaid integration, or null when PLAID_CLIENT_ID/PLAID_SECRET aren't set (spec §3.4). */
  plaid: Plaid | null;
  /** Spend's sync loop, statements and webhooks over `plaid`; null exactly when `plaid` is. */
  bank: BankSync | null;
  /** The Savings panel's sync over `plaid`; null exactly when `plaid` is. */
  savings: SavingsSync | null;
  /** The built Link page (`dist/web/plaid-link.html`), or null when it isn't built. Tests pass a stub. */
  plaidLinkHtml: () => string | null;
  /** Problems an admin must fix, for the System page, e.g. a TOKEN_ENCRYPTION_KEY that doesn't match. */
  systemWarnings: string[];
  logger: Logger;
  backupDir: string;
  version: string;
  /** Called after an admin saves family settings, e.g. to reschedule jobs in the new time zone. */
  onFamilySettingsChanged?: () => void;
}

export type AppEnv = {
  Variables: {
    user: SessionUser | null;
    sessionToken: string | null;
    /** Set by the Plaid Link pages' handler: this response gets the Link CSP instead of the strict one. */
    plaidLinkPage?: boolean;
  };
};

/** Every response's headers but the Plaid Link pages' (spec §15). */
const STRICT_HEADERS: SecureHeadersOptions = {
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'"],
    imgSrc: ["'self'", 'data:'],
    connectSrc: ["'self'"],
    objectSrc: ["'none'"],
    baseUri: ["'self'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
  },
  referrerPolicy: 'same-origin',
  xFrameOptions: 'DENY',
  strictTransportSecurity: false, // set by nginx
};

export function createApp(deps: AppDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.onError(errorHandler(deps.logger));
  app.notFound((c) =>
    c.req.path.startsWith('/api/')
      ? c.json({ error: { code: 'not_found', message: 'Not found.' } }, 404)
      : c.text('Not found', 404),
  );

  // Spec §15. Set after the handler, so every response gets it, 404s, errors and the SPA fallback
  // included. Only the two Plaid Link pages, when they really serve the page, get the Link CSP
  // instead (the design's departure 4); without Plaid there is none.
  const strictHeaders = secureHeaders(STRICT_HEADERS);
  const linkHeaders = deps.plaid ? secureHeaders(plaidLinkHeaders(deps.plaid.config)) : null;
  app.use('*', async (c, next) => {
    await next();
    await (linkHeaders && c.get('plaidLinkPage') === true ? linkHeaders : strictHeaders)(c, async () => {});
  });
  app.use('*', sessionMiddleware(deps));
  app.use('*', csrfMiddleware(deps.config));

  app.get('/healthz', (c) => {
    deps.sqlite.prepare('select 1').get();
    return c.json({ ok: true });
  });

  app.route('/auth', authRoutes(deps));
  app.route('/connect/google-calendar', calendarConnectRoutes(deps));
  // Spec §3.4: without TODOIST_CLIENT_ID/SECRET, every Todoist route is a 404.
  const { todoist } = deps;
  if (todoist) {
    app.route('/connect/todoist', todoistConnectRoutes({ ...deps, todoist }));
    app.route('/webhooks/todoist', todoistWebhookRoutes({ ...deps, todoist }));
  }
  // The same for Plaid without PLAID_CLIENT_ID/PLAID_SECRET.
  const { plaid, bank, savings } = deps;
  if (plaid && bank && savings) {
    app.route('/connect/plaid', plaidConnectRoutes({ ...deps, plaid, bank, savings }));
    app.route('/webhooks/plaid', plaidWebhookRoutes({ ...deps, plaid, bank, savings }));
    // Only the Link pages send reports here.
    app.route(CSP_REPORT_PATH, cspReportRoutes(deps));
  }

  const api = new Hono<AppEnv>();
  api.use('*', requireUser);
  api.get('/me', (c) => {
    const user = c.get('user')!;
    const body: MeResponse = {
      user,
      panels: getGrants(deps.db, user.id),
      family: getFamilySettings(deps.db),
      features: { todoist: deps.todoist !== null, plaid: deps.plaid !== null },
    };
    return c.json(body);
  });
  api.get('/admin/connections', requireAdmin, (c) => c.json(listConnectionSummaries(deps.db)));
  api.route('/admin', adminRoutes(deps));
  if (todoist) api.route('/todoist', todoistLinkRoutes({ ...deps, todoist }));
  api.route('/panels', panelRoutes(deps));
  app.route('/api', api);

  return app;
}
