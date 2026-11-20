import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from './db/index.js';
import { FakeClock } from './core/clock.js';
import { getGrants, listUsers } from './admin/users.js';
import { bootstrap, getFamilySettings, setFamilySettings } from './settings.js';

let db: Db;
const clock = new FakeClock(new Date('2026-11-15T12:00:00Z'));

beforeEach(() => {
  ({ db } = openDb(':memory:'));
});

describe('bootstrap', () => {
  it('creates the first admin with every panel and default settings', () => {
    const result = bootstrap(db, clock, { adminEmail: 'Alex@Example.com', defaultTimeZone: 'America/Los_Angeles' });
    expect(result.createdAdmin).toBe(true);
    const [admin] = listUsers(db);
    expect(admin).toMatchObject({ email: 'alex@example.com', displayName: 'alex', role: 'admin' });
    expect(getGrants(db, admin!.id)).toEqual(['calendar', 'todo', 'chores', 'spend', 'savings']);
    expect(getFamilySettings(db)).toEqual({ name: 'Our family', timeZone: 'America/Los_Angeles' });
  });

  it('does nothing to users when some already exist, and keeps existing settings', () => {
    bootstrap(db, clock, { adminEmail: 'a@example.com', defaultTimeZone: 'UTC' });
    setFamilySettings(db, { name: 'The Smiths', timeZone: 'Europe/London' });
    const again = bootstrap(db, clock, { adminEmail: 'b@example.com', defaultTimeZone: 'UTC' });
    expect(again.createdAdmin).toBe(false);
    expect(listUsers(db)).toHaveLength(1);
    expect(getFamilySettings(db)).toEqual({ name: 'The Smiths', timeZone: 'Europe/London' });
  });

  it('creates no admin without a bootstrap email', () => {
    expect(bootstrap(db, clock, { defaultTimeZone: 'UTC' }).createdAdmin).toBe(false);
    expect(listUsers(db)).toHaveLength(0);
  });
});
