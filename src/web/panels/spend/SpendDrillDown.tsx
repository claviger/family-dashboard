import { Link, useSearch } from '@tanstack/react-router';
import { useMe } from '../../shell/useMe.js';
import { OverviewTab } from './OverviewTab.js';
import { SettingsTab } from './SettingsTab.js';
import { searchForView, spendViewFromSearch } from './spendSearch.js';

/**
 * The Spend drill-down (spec §12.12): the overview, and Spend settings for admins. Its state is in
 * the query string, `/spend?card=…&cycle=…` and `?tab=settings` (spec §7), so each view can be
 * linked to and the back button works.
 */
export function SpendDrillDown() {
  const isAdmin = useMe().data!.user.role === 'admin';
  const view = spendViewFromSearch(useSearch({ from: '/$panelId' }));
  const tab = isAdmin ? view.tab : 'overview';
  return (
    <div className="todo-drilldown">
      {isAdmin && (
        <nav aria-label="Spend views" className="chores-tabs">
          <Link
            to="/$panelId"
            params={{ panelId: 'spend' }}
            search={searchForView({ ...view, tab: 'overview' })}
            activeOptions={{ exact: true }}
            aria-current={tab === 'overview' ? 'page' : undefined}
          >
            Overview
          </Link>
          <Link
            to="/$panelId"
            params={{ panelId: 'spend' }}
            search={{ tab: 'settings' }}
            activeOptions={{ exact: true }}
            aria-current={tab === 'settings' ? 'page' : undefined}
          >
            Settings
          </Link>
        </nav>
      )}
      {tab === 'overview' ? <OverviewTab view={view} isAdmin={isAdmin} /> : <SettingsTab />}
    </div>
  );
}
