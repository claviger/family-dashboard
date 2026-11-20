import { Hono, type MiddlewareHandler } from 'hono';
import type { PanelId } from '../../shared/panels.js';
import type { AppDeps, AppEnv } from '../app.js';
import { getGrants } from '../admin/users.js';
import { AppError } from '../core/errors.js';
import type { JobDef } from '../core/jobs.js';
import { calendarPanel } from './calendar/index.js';
import { choresPanel } from './chores/index.js';
import { savingsPanel } from './savings/index.js';
import { spendPanel } from './spend/index.js';
import { todoPanel } from './todo/index.js';

export interface PanelModule {
  id: PanelId;
  /** Routes mounted at /api/panels/<id>. Access is checked before they run. */
  router: (deps: AppDeps) => Hono<AppEnv>;
  jobs?: (deps: AppDeps) => JobDef[];
  /** Admin-only routes mounted at /api/admin/panels/<id>, e.g. for the System page. */
  adminRouter?: (deps: AppDeps) => Hono<AppEnv>;
  /** Subscribes to the event bus. Returns a function that unsubscribes. */
  listen?: (deps: AppDeps) => () => void;
}

export const PANELS: PanelModule[] = [
  calendarPanel,
  todoPanel,
  choresPanel,
  spendPanel,
  savingsPanel,
];

export function requirePanel(deps: AppDeps, panelId: PanelId): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const user = c.get('user');
    if (!user) throw new AppError('unauthenticated', 'Sign in to continue.');
    if (!getGrants(deps.db, user.id).includes(panelId)) {
      throw new AppError('forbidden', "You don't have access to this panel.");
    }
    await next();
  };
}

export function panelRoutes(deps: AppDeps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  for (const panel of PANELS) {
    const sub = new Hono<AppEnv>();
    sub.use('*', requirePanel(deps, panel.id));
    sub.route('/', panel.router(deps));
    r.route(`/${panel.id}`, sub);
  }
  return r;
}

/** Each panel's admin router, under /api/admin/panels. The admin routes have checked the role. */
export function panelAdminRoutes(deps: AppDeps): Hono<AppEnv> {
  const r = new Hono<AppEnv>();
  for (const panel of PANELS) if (panel.adminRouter) r.route(`/${panel.id}`, panel.adminRouter(deps));
  return r;
}

export function panelJobs(deps: AppDeps): JobDef[] {
  return PANELS.flatMap((p) => p.jobs?.(deps) ?? []);
}

/** Subscribes every panel to the event bus once. Call it once per AppDeps, before serving requests. */
export function listenPanels(deps: AppDeps): () => void {
  const offs = PANELS.map((p) => p.listen?.(deps) ?? (() => {}));
  return () => offs.forEach((off) => off());
}
