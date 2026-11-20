import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import type { SystemInfo } from '../../shared/api.js';
import { api } from '../api.js';
import { resetLinksConfirm } from './labels.js';
import { StuckTodos } from './StuckTodos.js';

export function SystemSection() {
  const qc = useQueryClient();
  const info = useQuery({ queryKey: ['admin', 'system'], queryFn: () => api<SystemInfo>('/api/admin/system') });
  const [resetMessage, setResetMessage] = useState<{ error: boolean; text: string } | null>(null);
  const messageRef = useRef<HTMLParagraphElement>(null);
  const reset = useMutation({
    mutationFn: () =>
      api<{ calendarDisconnected: boolean; todoistUnlinked: number; banksForgotten: number }>('/api/admin/integrations/reset-links', { method: 'POST' }),
    onSuccess: ({ calendarDisconnected, todoistUnlinked: n, banksForgotten }) =>
      setResetMessage({
        error: false,
        text: `Links reset.${calendarDisconnected ? ' Connect Google Calendar again in Integrations.' : ''}${
          n > 0 ? ` ${n === 1 ? '1 person needs' : `${n} people need`} to connect Todoist again.` : ''}${
          banksForgotten > 0 ? ' Connect each bank again in Spend settings.' : ''}`,
      }),
    onError: (err) => setResetMessage({ error: true, text: err.message }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['admin'] }),
  });
  const [dismissError, setDismissError] = useState<string | null>(null);
  const dismiss = useMutation({
    mutationFn: (id: number) => api<void>(`/api/admin/integrations/revocations/${id}/dismiss`, { method: 'POST' }),
    onMutate: () => setDismissError(null),
    onError: (err) => setDismissError(err.message),
    onSettled: () => qc.invalidateQueries({ queryKey: ['admin', 'system'] }),
  });
  // The button goes away once the links are reset, so focus moves to the message that replaces it.
  useEffect(() => {
    if (resetMessage) messageRef.current?.focus();
  }, [resetMessage]);

  if (info.error && !info.data) {
    return (
      <section className="admin-section">
        <h2>System</h2>
        <p className="error" role="alert">{info.error.message}</p>
        <button type="button" onClick={() => void info.refetch()}>Retry</button>
      </section>
    );
  }
  if (!info.data) return null;
  const { version, lastBackupAt, recentErrors, warnings, revocationNotices, keyMismatch, todoistConfigured, plaidConfigured } = info.data;
  return (
    <section className="admin-section">
      <h2>System</h2>
      {warnings.map((w) => <p key={w} className="error notice" role="alert">{w}</p>)}
      {revocationNotices.map((r) => (
        <div key={r.id} className="error notice" role="alert">
          <p>{r.message}</p>
          <button type="button" disabled={dismiss.isPending} onClick={() => dismiss.mutate(r.id)}>Dismiss</button>
        </div>
      ))}
      {dismissError && <p className="error" role="alert">{dismissError}</p>}
      {resetMessage && (
        <p ref={messageRef} tabIndex={-1} className={resetMessage.error ? 'error' : 'muted'} role={resetMessage.error ? 'alert' : 'status'}>
          {resetMessage.text}
        </p>
      )}
      {keyMismatch && (
        <div>
          <button
            type="button"
            disabled={reset.isPending}
            onClick={() => {
              if (!window.confirm(resetLinksConfirm({ todoist: todoistConfigured, plaid: plaidConfigured }))) return;
              setResetMessage(null);
              reset.mutate();
            }}
          >
            Reset links for a new key
          </button>
        </div>
      )}
      <p>Version {version} · Last backup {lastBackupAt ? new Date(lastBackupAt).toLocaleString() : 'not yet'}</p>
      {recentErrors.length === 0 ? (
        <p className="muted">No recent job errors.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Last seen</th><th>First seen</th><th>Job</th><th>Error</th></tr></thead>
            <tbody>
              {recentErrors.map((e) => (
                <tr key={e.job}>
                  <td>{new Date(e.occurredAt).toLocaleString()}</td>
                  <td>{e.firstOccurredAt ? new Date(e.firstOccurredAt).toLocaleString() : <span className="muted">Has run fine since</span>}</td>
                  <td>{e.job}</td>
                  <td>{e.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <StuckTodos />
    </section>
  );
}
