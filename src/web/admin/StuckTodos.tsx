import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { StuckTodo } from '../../shared/chores.js';
import { api } from '../api.js';
import { dismissConfirm } from './labels.js';

const KIND_LABELS: Record<StuckTodo['kind'], string> = {
  create: 'Add to-do',
  remove: 'Remove to-do',
  complete: 'Complete to-do',
};

/**
 * Chore to-do changes that hit the retry cap (spec §11.5, §14). They're no longer retried or
 * reported as a job error; an admin retries (it starts over) or dismisses each one.
 */
export function StuckTodos() {
  const qc = useQueryClient();
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const stuck = useQuery({ queryKey: ['admin', 'stuck'], queryFn: () => api<StuckTodo[]>('/api/admin/panels/chores/stuck') });
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['admin'] }), qc.invalidateQueries({ queryKey: ['chores'] })]);
  const path = (s: StuckTodo) => `/api/admin/panels/chores/stuck/${s.kind}/${s.id}`;
  const retry = useMutation({
    mutationFn: (s: StuckTodo) => api<{ ok: boolean }>(`${path(s)}/retry`, { method: 'POST' }),
    onSuccess: ({ ok }, s) =>
      setMessage(ok ? { error: false, text: `Done: ${s.title}.` } : { error: true, text: `${s.title} still failed. It will keep retrying.` }),
    onError: (err) => setMessage({ error: true, text: err.message }),
    onSettled: refresh,
  });
  const dismiss = useMutation({
    mutationFn: (s: StuckTodo) => api<void>(`${path(s)}/dismiss`, { method: 'POST' }),
    onSuccess: (_, s) => setMessage({ error: false, text: `Dismissed: ${s.title}.` }),
    onError: (err) => setMessage({ error: true, text: err.message }),
    onSettled: refresh,
  });
  const busy = retry.isPending || dismiss.isPending;

  if (stuck.error) return <p className="error">{stuck.error.message}</p>;
  if (!stuck.data) return null;
  return (
    <>
      <h3>Stuck chore to-dos</h3>
      {message && <p className={message.error ? 'error' : 'muted'} role={message.error ? 'alert' : 'status'}>{message.text}</p>}
      {stuck.data.length === 0 ? (
        <p className="muted">None. Chore to-dos that keep failing show up here after 12 tries.</p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Change</th><th>Chore</th><th>Whose list</th><th>Last error</th><th>Stuck since</th><th>Actions</th></tr></thead>
            <tbody>
              {stuck.data.map((s) => (
                <tr key={`${s.kind}-${s.id}`}>
                  <td>{KIND_LABELS[s.kind]}</td>
                  <td>{s.title}{s.dueDate ? <span className="muted"> · due {s.dueDate}</span> : null}</td>
                  <td>{s.owner?.displayName ?? 'Nobody'}</td>
                  <td>{s.lastError ?? <span className="muted">Unknown</span>}</td>
                  <td>{new Date(s.stuckSince).toLocaleString()}</td>
                  <td>
                    <button type="button" aria-label={`Retry ${s.title}`} disabled={busy} onClick={() => { setMessage(null); retry.mutate(s); }}>Retry</button>{' '}
                    <button type="button" aria-label={`Dismiss ${s.title}`} disabled={busy} onClick={() => {
                        if (!window.confirm(dismissConfirm(s))) return;
                        setMessage(null);
                        dismiss.mutate(s);
                      }}>Dismiss</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
