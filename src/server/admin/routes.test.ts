import { beforeEach, describe, expect, it } from 'vitest';
import type { SystemInfo } from '../../shared/api.js';
import { recordJobError } from '../core/jobs.js';
import { pendingRevocations, plaidItems } from '../db/schema.js';
import { addUser, call, cookieFor, makeTestApp, type TestApp } from '../test/helpers.js';

let t: TestApp;
let admin: string;
let member: string;
let memberId: number;

beforeEach(() => {
  t = makeTestApp();
  admin = cookieFor(t.db, t.clock, addUser(t.db, t.clock, { email: 'admin@example.com', displayName: 'Admin', role: 'admin' }));
  memberId = addUser(t.db, t.clock, { email: 'kid@example.com', displayName: 'Kid' });
  member = cookieFor(t.db, t.clock, memberId);
});

describe('admin routes', () => {
  it('are forbidden to members', async () => {
    const res = await call(t.app, 'GET', '/api/admin/users', { cookie: member });
    expect(res.status).toBe(403);
  });

  it('list, create, and update users', async () => {
    const created = await call(t.app, 'POST', '/api/admin/users', {
      cookie: admin,
      body: { email: 'wife@example.com', displayName: 'Wife', color: '#D4537E', role: 'admin', panels: ['calendar'] },
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: number };

    const dup = await call(t.app, 'POST', '/api/admin/users', {
      cookie: admin,
      body: { email: 'WIFE@example.com', displayName: 'Again', color: '#D4537E', role: 'member' },
    });
    expect(dup.status).toBe(409);

    const patched = await call(t.app, 'PATCH', `/api/admin/users/${id}`, { cookie: admin, body: { displayName: 'Jordan' } });
    expect(patched.status).toBe(204);

    const list = (await (await call(t.app, 'GET', '/api/admin/users', { cookie: admin })).json()) as { displayName: string; panels: string[] }[];
    expect(list.map((u) => u.displayName)).toEqual(['Admin', 'Jordan', 'Kid']);
    expect(list[1]!.panels).toEqual(['calendar']);
  });

  it('validates input and unknown ids', async () => {
    const bad = await call(t.app, 'POST', '/api/admin/users', { cookie: admin, body: { email: 'nope' } });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({
      error: {
        code: 'validation',
        message: 'Enter a valid email address; Enter a display name; Pick a color; Pick a role: admin or member',
      },
    });
    const missing = await call(t.app, 'PATCH', '/api/admin/users/999', { cookie: admin, body: { displayName: 'X' } });
    expect(missing.status).toBe(404);
    const junkId = await call(t.app, 'PATCH', '/api/admin/users/abc', { cookie: admin, body: { displayName: 'X' } });
    expect(junkId.status).toBe(404);
    // Number() reads these as 1, which is a real user.
    for (const id of ['0x1', '1e0', '1.0']) {
      const res = await call(t.app, 'PATCH', `/api/admin/users/${id}`, { cookie: admin, body: { displayName: 'X' } });
      expect(res.status, id).toBe(404);
    }
  });

  it('toggles panel grants', async () => {
    const on = await call(t.app, 'PUT', `/api/admin/users/${memberId}/panels/chores`, { cookie: admin, body: { enabled: true } });
    expect(on.status).toBe(204);
    const me = (await (await call(t.app, 'GET', '/api/me', { cookie: member })).json()) as { panels: string[] };
    expect(me.panels).toEqual(['chores']);
    const badPanel = await call(t.app, 'PUT', `/api/admin/users/${memberId}/panels/games`, { cookie: admin, body: { enabled: true } });
    expect(badPanel.status).toBe(404);
  });

  it('reads and writes family settings and notifies listeners', async () => {
    let notified = 0;
    t.onFamilySettingsChanged = () => notified++;
    const { createApp } = await import('../app.js');
    const app = createApp(t);
    const put = await call(app, 'PUT', '/api/admin/settings', { cookie: admin, body: { name: 'The Smiths', timeZone: 'America/Los_Angeles' } });
    expect(put.status).toBe(204);
    expect(notified).toBe(1);
    const get = await call(app, 'GET', '/api/admin/settings', { cookie: admin });
    expect(await get.json()).toEqual({ name: 'The Smiths', timeZone: 'America/Los_Angeles' });
    const bad = await call(app, 'PUT', '/api/admin/settings', { cookie: admin, body: { name: 'X', timeZone: 'Mars/Base' } });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: { code: 'validation', message: 'Pick a time zone from the list' } });
  });

  it('reports system info', async () => {
    recordJobError(t, 'db.backup', 'disk full');
    const res = await call(t.app, 'GET', '/api/admin/system', { cookie: admin });
    expect(await res.json()).toEqual({
      version: 'test',
      lastBackupAt: null,
      recentErrors: [{ job: 'db.backup', message: 'disk full', occurredAt: '2026-11-15T12:00:00.000Z', firstOccurredAt: '2026-11-15T12:00:00.000Z' }],
      warnings: [],
      revocationNotices: [],
      keyMismatch: false,
      todoistConfigured: t.todoist !== null,
      plaidConfigured: false,
    });
  });

  it("lists a calendar's and a bank's given-up revocations, and dismisses either from one route", async () => {
    const p = makeTestApp({ plaid: true });
    const adminId = addUser(p.db, p.clock, { email: 'admin@example.com', role: 'admin' });
    const cookie = cookieFor(p.db, p.clock, adminId);
    const kid = cookieFor(p.db, p.clock, addUser(p.db, p.clock, { email: 'kid@example.com' }));
    const now = p.clock.now();
    // Synthetic rows as each integration leaves them after giving up: no token, gave_up_at set.
    const calendarRow = p.db.insert(pendingRevocations).values({ kind: 'google_calendar', ownerUserId: adminId, accountId: 'sub-1', accountEmail: 'family@example.com', credentialsEnc: '', gaveUpAt: now, createdAt: now }).returning().get();
    p.db.insert(plaidItems).values({ plaidItemId: 'item-synthetic-1', institutionName: 'Example Bank', removedAt: now, removedReason: 'removed', createdAt: now, updatedAt: now }).run();
    const bankRow = p.db.insert(pendingRevocations).values({ kind: 'plaid', ownerUserId: adminId, accountId: 'item-synthetic-1', credentialsEnc: '', gaveUpAt: now, createdAt: now }).returning().get();
    const system = async () => (await (await call(p.app, 'GET', '/api/admin/system', { cookie })).json()) as SystemInfo;
    expect((await system()).revocationNotices).toEqual([
      { id: calendarRow.id, message: expect.stringContaining('family@example.com') },
      { id: bankRow.id, message: expect.stringContaining('Example Bank') },
    ]);
    expect((await system()).plaidConfigured).toBe(true);
    const dismiss = (id: number | string, c = cookie, csrf = true) => call(p.app, 'POST', `/api/admin/integrations/revocations/${id}/dismiss`, { cookie: c, csrf });
    expect((await dismiss(bankRow.id, kid)).status).toBe(403);
    expect((await dismiss(bankRow.id, cookie, false)).status).toBe(403);
    expect((await dismiss('x')).status).toBe(404);
    expect((await dismiss(bankRow.id)).status).toBe(204);
    expect((await dismiss(bankRow.id)).status).toBe(404);
    expect((await dismiss(calendarRow.id)).status).toBe(204);
    expect((await system()).revocationNotices).toEqual([]);
  });
});
