import { Link, useSearch } from '@tanstack/react-router';
import { useMe } from '../../shell/useMe.js';
import { OverviewTab } from './OverviewTab.js';
import { savingsViewFromSearch, searchForSavingsView } from './savingsSearch.js';
import { SettingsTab } from './SettingsTab.js';

/**
 * The Savings drill-down: Overview (the month's breakdown and the graph) for everyone with the
 * panel, Settings for admins (the Savings spec, "Access", "Linking"). State is in the query
 * string: `?month=` and `?tab=settings` (main spec §7).
 */
export function SavingsDrillDown() {
  const me = useMe().data!;
  const isAdmin = me.user.role === 'admin';
  const view = savingsViewFromSearch(useSearch({ from: '/$panelId' }));
  const tab = isAdmin ? view.tab : 'overview';
  return (
    <div className="todo-drilldown">
      {isAdmin && (
        <nav aria-label="Savings views" className="chores-tabs">
          <Link
            to="/$panelId"
            params={{ panelId: 'savings' }}
            search={searchForSavingsView({ ...view, tab: 'overview' })}
            activeOptions={{ exact: true }}
            aria-current={tab === 'overview' ? 'page' : undefined}
          >
            Overview
          </Link>
          <Link to="/$panelId" params={{ panelId: 'savings' }} search={{ tab: 'settings' }} activeOptions={{ exact: true }} aria-current={tab === 'settings' ? 'page' : undefined}>
            Settings
          </Link>
        </nav>
      )}
      {tab === 'overview' ? <OverviewTab month={view.month} timeZone={me.family.timeZone} /> : <SettingsTab plaidConfigured={me.features.plaid} />}
    </div>
  );
}
