import type Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';
import { openDb, type Db } from '../db/index.js';
import { FakeClock } from '../core/clock.js';
import { AppError } from '../core/errors.js';
import { createSession, validateSession } from '../auth/sessions.js';
import { createUser, getGrants, getUser, listUsers, setGrant, updateUser } from './users.js';

let db: Db;
let sqlite: Database.Database;
let clock: FakeClock;

const base = { displayName: 'Person', color: '#378ADD', role: 'member' as const, panels: [] };

beforeEach(() => {
  ({ db, sqlite } = openDb(':memory:'));
  clock = new FakeClock(new Date('2026-11-15T12:00:00Z'));
});

function expectAppError(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(AppError);
    expect((e as AppError).code).toBe(code);
    return;
  }
  throw new Error('expected AppError');
}

describe('createUser', () => {
  it('normalizes email, stores grants, and rejects duplicates', () => {
    const id = createUser(db, clock, { ...base, email: ' Kid@Example.com ', panels: ['chores', 'todo'] });
    expect(getUser(db, id)?.email).toBe('kid@example.com');
    expect(getGrants(db, id)).toEqual(['todo', 'chores']);
    expectAppError(() => createUser(db, clock, { ...base, email: 'kid@example.com' }), 'conflict');
  });
});

describe('updateUser', () => {
  it('refuses to demote or deactivate the last active admin', () => {
    const admin = createUser(db, clock, { ...base, email: 'admin@example.com', role: 'admin' });
    expectAppError(() => updateUser(db, admin, { role: 'member' }), 'validation');
    expectAppError(() => updateUser(db, admin, { active: false }), 'validation');
    const second = createUser(db, clock, { ...base, email: 'admin2@example.com', role: 'admin' });
    updateUser(db, admin, { role: 'member' });
    expect(getUser(db, admin)?.role).toBe('member');
    expectAppError(() => updateUser(db, second, { active: false }), 'validation');
  });

  it('clears the Google binding when the email changes', () => {
    const id = createUser(db, clock, { ...base, email: 'old@example.com' });
    sqlite.prepare('update users set google_sub = ? where id = ?').run('sub-1', id);
    updateUser(db, id, { email: 'new@example.com' });
    const u = getUser(db, id)!;
    expect(u.email).toBe('new@example.com');
    expect(u.googleSub).toBeNull();
  });

  it('ends sessions when the email changes, since the old Google account opened them', () => {
    const id = createUser(db, clock, { ...base, email: 'old@example.com' });
    const { token } = createSession(db, clock, id);
    updateUser(db, id, { email: 'new@example.com' });
    expect(validateSession(db, clock, token)).toBeNull();
  });

  it("keeps the session that changed the email when it's the user's own, and ends their others", () => {
    // An admin who mistypes their own address must not be locked out: the person holding this
    // session is the one making the change.
    createUser(db, clock, { ...base, email: 'other-admin@example.com', role: 'admin' });
    const id = createUser(db, clock, { ...base, email: 'me@example.com', role: 'admin' });
    const here = createSession(db, clock, id);
    const elsewhere = createSession(db, clock, id);
    updateUser(db, id, { email: 'me-new@example.com' }, { keepSession: here.token });
    expect(validateSession(db, clock, here.token)).not.toBeNull();
    expect(validateSession(db, clock, elsewhere.token)).toBeNull();
    // Deactivating ends every session, the kept one included.
    updateUser(db, id, { active: false }, { keepSession: here.token });
    expect(validateSession(db, clock, here.token)).toBeNull();
  });

  it("doesn't keep another user's session just because the admin passed theirs", () => {
    const admin = createUser(db, clock, { ...base, email: 'admin@example.com', role: 'admin' });
    const id = createUser(db, clock, { ...base, email: 'kid@example.com' });
    const adminSession = createSession(db, clock, admin);
    const theirs = createSession(db, clock, id);
    updateUser(db, id, { email: 'kid-new@example.com' }, { keepSession: adminSession.token });
    expect(validateSession(db, clock, theirs.token)).toBeNull();
    expect(validateSession(db, clock, adminSession.token)).not.toBeNull();
  });

  it('keeps sessions when the email is only written differently, or other fields change', () => {
    const id = createUser(db, clock, { ...base, email: 'kid@example.com' });
    const { token } = createSession(db, clock, id);
    updateUser(db, id, { email: ' Kid@Example.com ', displayName: 'Kid', color: '#000000' });
    expect(validateSession(db, clock, token)).not.toBeNull();
  });

  it('ends sessions when a user is deactivated', () => {
    createUser(db, clock, { ...base, email: 'admin@example.com', role: 'admin' });
    const id = createUser(db, clock, { ...base, email: 'kid@example.com' });
    const { token } = createSession(db, clock, id);
    updateUser(db, id, { active: false });
    expect(validateSession(db, clock, token)).toBeNull();
  });

  it('throws not_found for a missing user', () => {
    expectAppError(() => updateUser(db, 999, { displayName: 'X' }), 'not_found');
  });
});

describe('grants and listing', () => {
  it('toggles grants idempotently and lists users with panels', () => {
    const id = createUser(db, clock, { ...base, email: 'kid@example.com' });
    setGrant(db, id, 'spend', true);
    setGrant(db, id, 'spend', true);
    setGrant(db, id, 'calendar', true);
    expect(getGrants(db, id)).toEqual(['calendar', 'spend']);
    setGrant(db, id, 'spend', false);
    const [listed] = listUsers(db);
    expect(listed).toMatchObject({ id, email: 'kid@example.com', active: true, lastLoginAt: null, panels: ['calendar'] });
  });
});
