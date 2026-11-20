import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import type { AdminUser, CreateUserInput, Role, UpdateUserInput, UpdateUserResponse } from '../../shared/api.js';
import { PANEL_IDS, PANEL_TITLES, type PanelId } from '../../shared/panels.js';
import { api } from '../api.js';
import { Avatar } from '../shell/Avatar.js';
import { useMe } from '../shell/useMe.js';
import { todoistLabel, type ConnectionsState } from './labels.js';

/** `todoist` is the connections query when Todoist is configured, else null (and the column is hidden). */
export function UsersSection({ users, todoist }: { users: AdminUser[]; todoist: ConnectionsState | null }) {
  const qc = useQueryClient();
  const me = useMe();
  const [error, setError] = useState<string | null>(null);
  // Things a change did that the admin should know about, e.g. a Todoist link that a deactivation couldn't disconnect.
  const [warnings, setWarnings] = useState<string[]>([]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState({ displayName: '', email: '', color: '#000000' });
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ['admin', 'users'] }), qc.invalidateQueries({ queryKey: ['me'] })]);

  const create = useMutation({
    mutationFn: (input: CreateUserInput) => api('/api/admin/users', { method: 'POST', body: input }),
    onSuccess: refresh,
    onError: (e: Error) => setError(e.message),
  });
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: UpdateUserInput }) =>
      api<UpdateUserResponse | undefined>(`/api/admin/users/${id}`, { method: 'PATCH', body: patch }),
    onMutate: () => setWarnings([]),
    onSuccess: (res) => {
      setWarnings(res?.warnings ?? []);
      return refresh();
    },
    onError: (e: Error) => setError(e.message),
  });
  const pendingId = update.isPending ? update.variables.id : null;

  function startEdit(u: AdminUser) {
    setError(null);
    setDraft({ displayName: u.displayName, email: u.email, color: u.color });
    setEditingId(u.id);
  }

  function saveEdit(u: AdminUser) {
    const patch: UpdateUserInput = {};
    if (draft.displayName !== u.displayName) patch.displayName = draft.displayName;
    // Compared the way the server stores it: only a real change unbinds the Google account.
    const emailChanged = draft.email.trim().toLowerCase() !== u.email;
    if (emailChanged) patch.email = draft.email;
    if (draft.color.toLowerCase() !== u.color.toLowerCase()) patch.color = draft.color;
    if (Object.keys(patch).length === 0) {
      setEditingId(null);
      return;
    }
    if (emailChanged) {
      const question =
        u.id === me.data?.user.id
          ? "Change your email? You'll stay signed in here, but your other sessions will end, and next time you'll need to sign in with the Google account for the new address."
          : `Change ${u.displayName}'s email? They'll be signed out, and they'll need to sign in with the Google account for the new address.`;
      if (!window.confirm(question)) return;
    }
    setError(null);
    update.mutate({ id: u.id, patch }, { onSuccess: () => setEditingId(null) });
  }

  function toggleActive(u: AdminUser) {
    if (u.active && !window.confirm(`Deactivate ${u.displayName}? They'll be signed out.`)) return;
    setError(null);
    update.mutate({ id: u.id, patch: { active: !u.active } });
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    create.mutate(
      {
        email: String(form.get('email')),
        displayName: String(form.get('displayName')),
        color: String(form.get('color')),
        role: String(form.get('role')) as Role,
        panels: PANEL_IDS.filter((p) => form.get(`panel-${p}`) === 'on') as PanelId[],
      },
      { onSuccess: () => formEl.reset() },
    );
  }

  return (
    <section className="admin-section">
      <h2>Users</h2>
      {error && <p className="error" role="alert">{error}</p>}
      {warnings.map((w) => <p key={w} className="error notice" role="alert">{w}</p>)}
      <div className="table-wrap">
        <table>
          <thead>
            <tr><th>Name</th><th>Email</th><th>Role</th><th>Last sign-in</th>{todoist && <th>Todoist</th>}<th>Status</th></tr>
          </thead>
          <tbody>
            {users.map((u) => {
              const editing = editingId === u.id;
              const busy = pendingId === u.id;
              return (
                <tr key={u.id}>
                  <td>
                    {editing ? (
                      <input
                        aria-label={`Display name for ${u.displayName}`}
                        required
                        maxLength={60}
                        value={draft.displayName}
                        onChange={(e) => setDraft({ ...draft, displayName: e.target.value })}
                      />
                    ) : <span className="user-name"><Avatar person={u} />{u.displayName}</span>}
                  </td>
                  <td>
                    {editing ? (
                      <>
                        <input
                          type="email"
                          required
                          aria-label={`Email for ${u.displayName}`}
                          value={draft.email}
                          onChange={(e) => setDraft({ ...draft, email: e.target.value })}
                        />{' '}
                        <input
                          type="color"
                          aria-label={`Color for ${u.displayName}`}
                          value={draft.color}
                          onChange={(e) => setDraft({ ...draft, color: e.target.value })}
                        />
                      </>
                    ) : u.email}
                  </td>
                  <td>
                    <select
                      aria-label={`Role for ${u.displayName}`}
                      value={u.role}
                      disabled={busy}
                      onChange={(e) => { setError(null); update.mutate({ id: u.id, patch: { role: e.target.value as Role } }); }}
                    >
                      <option value="member">Member</option>
                      <option value="admin">Admin</option>
                    </select>
                  </td>
                  <td>{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'Never'}</td>
                  {todoist && <td>{todoistLabel(todoist, u.id, Date.now())}</td>}
                  <td>
                    {editing ? (
                      <>
                        <button type="button" className="primary" disabled={busy} onClick={() => saveEdit(u)}>Save</button>{' '}
                        <button type="button" disabled={busy} onClick={() => setEditingId(null)}>Cancel</button>
                      </>
                    ) : (
                      <>
                        <button type="button" disabled={busy} onClick={() => startEdit(u)}>Edit</button>{' '}
                        <button type="button" disabled={busy} onClick={() => toggleActive(u)}>
                          {u.active ? 'Deactivate' : 'Reactivate'}
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <form className="form-row" onSubmit={onSubmit}>
        <label>Email<input name="email" type="email" required placeholder="name@example.com" /></label>
        <label>Display name<input name="displayName" required maxLength={60} /></label>
        <label>Color<input name="color" type="color" defaultValue="#1D9E75" /></label>
        <label>
          Role
          <select name="role" defaultValue="member">
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </label>
        <fieldset className="panel-picks">
          <legend>Initial panels</legend>
          {PANEL_IDS.map((p) => (
            <label key={p} className="inline-check">
              <input type="checkbox" name={`panel-${p}`} aria-label={`Initial access: ${PANEL_TITLES[p]}`} />
              {PANEL_TITLES[p]}
            </label>
          ))}
        </fieldset>
        <button type="submit" className="primary" disabled={create.isPending}>Add user</button>
      </form>
    </section>
  );
}
