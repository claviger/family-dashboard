import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { AdminUser } from '../../shared/api.js';
import { PANEL_IDS, PANEL_TITLES, type PanelId } from '../../shared/panels.js';
import { useState } from 'react';
import { api } from '../api.js';

export function AccessGrid({ users }: { users: AdminUser[] }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const toggle = useMutation({
    mutationFn: ({ userId, panelId, enabled }: { userId: number; panelId: PanelId; enabled: boolean }) =>
      api(`/api/admin/users/${userId}/panels/${panelId}`, { method: 'PUT', body: { enabled } }),
    onError: (e: Error) => setError(e.message),
    onSettled: () =>
      Promise.all([qc.invalidateQueries({ queryKey: ['admin', 'users'] }), qc.invalidateQueries({ queryKey: ['me'] })]),
  });

  return (
    <section className="admin-section">
      <h2>Panel access</h2>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>User</th>{PANEL_IDS.map((p) => <th key={p}>{PANEL_TITLES[p]}</th>)}</tr>
          </thead>
          <tbody>
            {users.filter((u) => u.active).map((u) => (
              <tr key={u.id}>
                <td>{u.displayName}</td>
                {PANEL_IDS.map((p) => (
                  <td key={p} className="checkbox-cell">
                    <input
                      type="checkbox"
                      aria-label={`${PANEL_TITLES[p]} for ${u.displayName}`}
                      checked={u.panels.includes(p)}
                      onChange={(e) => { setError(null); toggle.mutate({ userId: u.id, panelId: p, enabled: e.target.checked }); }}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
