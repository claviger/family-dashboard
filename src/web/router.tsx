import { createRootRoute, createRoute, createRouter, Outlet, useRouterState } from '@tanstack/react-router';
import { AdminPage } from './admin/AdminPage.js';
import { ApiError } from './api.js';
import { DrillDown } from './shell/DrillDown.js';
import { Home } from './shell/Home.js';
import { Layout } from './shell/Layout.js';
import { NotSetUp } from './shell/NotSetUp.js';
import { parsePanelSearch, stringifyPanelSearch, validatePanelSearch } from './panelSearch.js';
import { SettingsPage } from './settings/SettingsPage.js';
import { SignIn } from './shell/SignIn.js';
import { useMe } from './shell/useMe.js';

const PUBLIC_PATHS = new Set(['/sign-in', '/not-set-up']);

function Root() {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const me = useMe();
  if (PUBLIC_PATHS.has(path)) return <Outlet />;
  if (me.isPending) return <p className="center-page muted">Loading…</p>;
  if (me.error instanceof ApiError && me.error.status === 401) return <SignIn />;
  if (me.error) {
    return (
      <main className="center-page">
        <p>Couldn't load the dashboard.</p>
        <button type="button" onClick={() => me.refetch()}>Retry</button>
      </main>
    );
  }
  return (
    <Layout me={me.data}>
      <Outlet />
    </Layout>
  );
}

const rootRoute = createRootRoute({ component: Root });
const routeTree = rootRoute.addChildren([
  // The home cards keep their own state in the query string too, such as the Calendar card's open event (`?calendarEvent=`).
  createRoute({ getParentRoute: () => rootRoute, path: '/', component: Home, validateSearch: validatePanelSearch }),
  createRoute({ getParentRoute: () => rootRoute, path: '/sign-in', component: SignIn }),
  createRoute({ getParentRoute: () => rootRoute, path: '/not-set-up', component: NotSetUp }),
  createRoute({ getParentRoute: () => rootRoute, path: '/admin', component: AdminPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/settings', component: SettingsPage }),
  createRoute({ getParentRoute: () => rootRoute, path: '/$panelId', component: DrillDown, validateSearch: validatePanelSearch }),
]);

/**
 * Search params are read and written by `parsePanelSearch` and `stringifyPanelSearch`. Scroll
 * restoration is on, so Back and Forward return to where each page was (closing a dialog with
 * Back doesn't jump to the top). It's kept per history entry, so a new page still opens at the
 * top, unless its navigate passes `resetScroll: false`, as opening a dialog or changing a filter does.
 */
export const router = createRouter({ routeTree, parseSearch: parsePanelSearch, stringifySearch: stringifyPanelSearch, scrollRestoration: true });

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
