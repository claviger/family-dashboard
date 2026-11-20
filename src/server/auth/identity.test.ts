import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/index.js';
import { FakeClock } from '../core/clock.js';
import { createUser, getUser, updateUser } from '../admin/users.js';
import { resolveGoogleIdentity } from './identity.js';

let db: Db;
const clock = new FakeClock(new Date('2026-11-15T12:00:00Z'));
let id: number;

beforeEach(() => {
  ({ db } = openDb(':memory:'));
  createUser(db, clock, { email: 'admin@example.com', displayName: 'Admin', color: '#378ADD', role: 'admin', panels: [] });
  id = createUser(db, clock, { email: 'kid@example.com', displayName: 'Kid', color: '#378ADD', role: 'member', panels: [] });
});

describe('resolveGoogleIdentity', () => {
  it('binds the Google account on first sign-in and records the login time', () => {
    const r = resolveGoogleIdentity(db, clock, { sub: 'g-1', email: 'KID@example.com', emailVerified: true });
    expect(r).toEqual({ ok: true, user: expect.objectContaining({ id, email: 'kid@example.com' }) });
    const u = getUser(db, id)!;
    expect(u.googleSub).toBe('g-1');
    expect(u.lastLoginAt?.toISOString()).toBe('2026-11-15T12:00:00.000Z');
  });

  it('finds a bound user by account id even if their Google email changed', () => {
    resolveGoogleIdentity(db, clock, { sub: 'g-1', email: 'kid@example.com', emailVerified: true });
    const r = resolveGoogleIdentity(db, clock, { sub: 'g-1', email: 'renamed@gmail.com', emailVerified: true });
    expect(r.ok).toBe(true);
  });

  it('rejects unverified emails, unknown people, mismatched accounts, and inactive users', () => {
    expect(resolveGoogleIdentity(db, clock, { sub: 'g-1', email: 'kid@example.com', emailVerified: false }))
      .toEqual({ ok: false, reason: 'unverified' });
    expect(resolveGoogleIdentity(db, clock, { sub: 'g-9', email: 'stranger@example.com', emailVerified: true }))
      .toEqual({ ok: false, reason: 'not_provisioned' });
    resolveGoogleIdentity(db, clock, { sub: 'g-1', email: 'kid@example.com', emailVerified: true });
    expect(resolveGoogleIdentity(db, clock, { sub: 'g-2', email: 'kid@example.com', emailVerified: true }))
      .toEqual({ ok: false, reason: 'account_mismatch' });
    updateUser(db, id, { active: false });
    expect(resolveGoogleIdentity(db, clock, { sub: 'g-1', email: 'kid@example.com', emailVerified: true }))
      .toEqual({ ok: false, reason: 'not_provisioned' });
  });
});
