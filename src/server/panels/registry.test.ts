import { describe, expect, it } from 'vitest';
import { PANEL_IDS } from '../../shared/panels.js';
import { addUser, call, cookieFor, makeTestApp } from '../test/helpers.js';
import { PANELS } from './registry.js';

describe('panel registry', () => {
  it('registers every panel id', () => {
    expect(PANELS.map((p) => p.id)).toEqual([...PANEL_IDS]);
  });

  it('requires a grant for each panel, even for admins', async () => {
    const t = makeTestApp();
    const admin = cookieFor(t.db, t.clock, addUser(t.db, t.clock, { email: 'admin@example.com', role: 'admin', panels: ['calendar'] }));
    const granted = await call(t.app, 'GET', '/api/panels/calendar/summary', { cookie: admin });
    expect(granted.status).toBe(200);
    expect(await granted.json()).toMatchObject({ events: [], freshness: { connected: false } });
    const denied = await call(t.app, 'GET', '/api/panels/spend/summary', { cookie: admin });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: { code: 'forbidden', message: "You don't have access to this panel." } });
  });

  it('requires a session', async () => {
    const t = makeTestApp();
    expect((await call(t.app, 'GET', '/api/panels/chores/summary')).status).toBe(401);
  });
});
