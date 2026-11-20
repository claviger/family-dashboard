import { Link, useSearch } from '@tanstack/react-router';
import { useMe } from '../../shell/useMe.js';
import { BoardTab } from './BoardTab.js';
import { HistoryTab } from './HistoryTab.js';
import { ManageTab } from './ManageTab.js';

type TabId = 'board' | 'history' | 'manage';

const TABS: { id: TabId; label: string; adminOnly: boolean }[] = [
  { id: 'board', label: 'Board', adminOnly: false },
  { id: 'history', label: 'History', adminOnly: false },
  { id: 'manage', label: 'Manage', adminOnly: true },
];

/**
 * Drill-down (chore board spec, "Chores page") with three views: Board (the default), History, and
 * Manage (admins only). The view is `?tab=` in the URL, so each can be linked to and the back button
 * works (spec §7); an unknown or old value (`?tab=chores`, `?tab=open`) shows the Board.
 */
export function ChoresDrillDown() {
  const me = useMe().data!;
  const isAdmin = me.user.role === 'admin';
  const search = useSearch({ from: '/$panelId' });
  const tabs = TABS.filter((t) => isAdmin || !t.adminOnly);
  const tab: TabId = tabs.find((t) => t.id === search.tab)?.id ?? 'board';

  return (
    <div className="todo-drilldown">
      <nav aria-label="Chores views" className="chores-tabs">
        {tabs.map((t) => (
          <Link
            key={t.id}
            to="/$panelId"
            params={{ panelId: 'chores' }}
            search={t.id === 'board' ? {} : { tab: t.id }}
            // Exact, so the Board's empty search doesn't also count as active on the other tabs.
            activeOptions={{ exact: true }}
            aria-current={tab === t.id ? 'page' : undefined}
          >
            {t.label}
          </Link>
        ))}
      </nav>
      {tab === 'board' && <BoardTab />}
      {tab === 'history' && <HistoryTab />}
      {tab === 'manage' && <ManageTab />}
    </div>
  );
}
