import { useQuery } from '@tanstack/react-query';
import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import type { AdminUser } from '../../shared/api.js';
import type { ConnectionSummary } from '../../shared/integrations.js';
import { api } from '../api.js';
import type { ConnectionsState } from './labels.js';
import { useMe } from '../shell/useMe.js';
import { AccessGrid } from './AccessGrid.js';
import { calendarLinkOutcome, type CalendarLinkOutcome } from './calendarLink.js';
import { IntegrationsSection } from './IntegrationsSection.js';
import { SettingsSection } from './SettingsSection.js';
import { SystemSection } from './SystemSection.js';
import { UsersSection } from './UsersSection.js';

export function AdminPage() {
  const me = useMe().data!;
  const searchStr = useRouterState({ select: (s) => s.location.searchStr });
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  // Back from Google's consent page: the outcome is kept for this visit and taken out of the URL,
  // so a reload doesn't show it again. Only while the URL is still this page's: leaving for a page
  // with a query string (Manage banks goes to `/spend?tab=settings`) updates the location while
  // this page is still mounted, and must not be sent back here.
  const [outcome] = useState<CalendarLinkOutcome>(() => calendarLinkOutcome(searchStr));
  useEffect(() => {
    if (pathname === '/admin' && searchStr) void navigate({ to: '/admin', search: {}, replace: true });
  }, [pathname, searchStr, navigate]);
  const users = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => api<AdminUser[]>('/api/admin/users'),
    enabled: me.user.role === 'admin',
  });
  // Spec §5: admins see each person's Todoist status, but can't link or unlink for them, and each bank's status (managed in Spend settings).
  const connections = useQuery({
    queryKey: ['admin', 'connections'],
    queryFn: () => api<ConnectionSummary[]>('/api/admin/connections'),
    enabled: me.user.role === 'admin' && (me.features.todoist || me.features.plaid),
  });
  if (me.user.role !== 'admin') return <p>Only admins can see this page.</p>;
  if (users.error) return <p className="error">{users.error.message}</p>;
  if (!users.data) return <p className="muted">Loading…</p>;
  const state: ConnectionsState = connections.data
    ? { state: 'ready', connections: connections.data }
    : connections.error ? { state: 'error' } : { state: 'loading' };
  const todoist = me.features.todoist ? state : null;
  const banks = me.features.plaid ? state : null;
  return (
    <>
      <h2 className="page-title">Admin</h2>
      <UsersSection users={users.data} todoist={todoist} />
      <AccessGrid users={users.data} />
      <IntegrationsSection familyTimeZone={me.family.timeZone} outcome={outcome} banks={banks} />
      <SettingsSection />
      <SystemSection />
    </>
  );
}
