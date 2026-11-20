import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import type { MeResponse } from '../../shared/api.js';
import { api } from '../api.js';
import { Avatar } from './Avatar.js';
import { clearStoredDrafts, confirmDiscardUnsaved } from '../unsavedChanges.js';

export function Layout({ me, children }: { me: MeResponse; children: ReactNode }) {
  const today = new Intl.DateTimeFormat(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: me.family.timeZone,
  }).format(new Date());

  async function signOut() {
    // Before the logout request: a page's unsaved changes (Spend's picks) are asked about first.
    if (!confirmDiscardUnsaved()) return;
    try {
      await api('/auth/logout', { method: 'POST' });
    } finally {
      clearStoredDrafts();
      window.location.href = '/';
    }
  }

  return (
    <div className="page">
      <header className="topbar">
        <Link to="/" className="brand">
          <h1>{me.family.name}</h1>
        </Link>
        <span className="muted">{today}</span>
        <nav className="topbar-actions" aria-label="Account">
          {me.user.role === 'admin' && <Link to="/admin">Admin</Link>}
          <Link to="/settings">Settings</Link>
          <Avatar person={me.user} size="md" />
          <button type="button" onClick={signOut}>Sign out</button>
        </nav>
      </header>
      <main>{children}</main>
    </div>
  );
}
