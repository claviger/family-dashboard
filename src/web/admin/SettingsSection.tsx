import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import type { FamilySettings } from '../../shared/api.js';
import { api } from '../api.js';

const ZONES: string[] = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];

export function SettingsSection() {
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['admin', 'settings'], queryFn: () => api<FamilySettings>('/api/admin/settings') });
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const save = useMutation({
    mutationFn: (s: FamilySettings) => api('/api/admin/settings', { method: 'PUT', body: s }),
    onSuccess: () => {
      setMessage({ ok: true, text: 'Settings saved' });
      return Promise.all([qc.invalidateQueries({ queryKey: ['admin', 'settings'] }), qc.invalidateQueries({ queryKey: ['me'] })]);
    },
    onError: (e: Error) => setMessage({ ok: false, text: e.message }),
  });

  if (settings.error && !settings.data) {
    return (
      <section className="admin-section">
        <h2>Family settings</h2>
        <p className="error" role="alert">{settings.error.message}</p>
        <button type="button" onClick={() => void settings.refetch()}>Retry</button>
      </section>
    );
  }
  if (!settings.data) return null;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    save.mutate({ name: String(form.get('name')), timeZone: String(form.get('timeZone')) });
  }

  return (
    <section className="admin-section">
      <h2>Family settings</h2>
      <form className="form-row" onSubmit={onSubmit}>
        <label>Family name<input name="name" required maxLength={80} defaultValue={settings.data.name} /></label>
        <label>
          Time zone
          <input name="timeZone" required list="time-zones" defaultValue={settings.data.timeZone} />
          <datalist id="time-zones">{ZONES.map((z) => <option key={z} value={z} />)}</datalist>
        </label>
        <button type="submit" className="primary" disabled={save.isPending}>Save settings</button>
      </form>
      <div role="status" className="muted">{message?.ok ? message.text : ''}</div>
      {message && !message.ok && <p className="error" role="alert">{message.text}</p>}
    </section>
  );
}
