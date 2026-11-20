import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { openDb, type Db } from '../db/index.js';
import { sessions, users } from '../db/schema.js';
import { FakeClock } from '../core/clock.js';
import {
  createSession, deleteExpiredSessions, deleteSession, deleteUserSessions,
  SESSION_TTL_MS, validateSession,
} from './sessions.js';

let db: Db;
let clock: FakeClock;
let userId: number;

beforeEach(() => {
  ({ db } = openDb(':memory:'));
  clock = new FakeClock(new Date('2026-11-15T12:00:00Z'));
  userId = db.insert(users).values({
    email: 'a@example.com', displayName: 'A', color: '#378ADD', role: 'member', createdAt: clock.now(),
  }).returning({ id: users.id }).get().id;
});

describe('sessions', () => {
  it('creates a session that validates to its user, storing only a hash', () => {
    const { token, expiresAt } = createSession(db, clock, userId);
    expect(expiresAt.getTime()).toBe(clock.now().getTime() + SESSION_TTL_MS);
    const stored = db.select().from(sessions).all();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.idHash).not.toBe(token);
    const v = validateSession(db, clock, token);
    expect(v?.user).toEqual({ id: userId, email: 'a@example.com', displayName: 'A', color: '#378ADD', role: 'member' });
    expect(v?.renewed).toBe(false);
  });

  it('rejects unknown and expired tokens', () => {
    expect(validateSession(db, clock, 'nope')).toBeNull();
    const { token } = createSession(db, clock, userId);
    clock.advance(SESSION_TTL_MS + 1);
    expect(validateSession(db, clock, token)).toBeNull();
    expect(db.select().from(sessions).all()).toHaveLength(0);
  });

  it('rolls the expiry forward at most once an hour', () => {
    const { token } = createSession(db, clock, userId);
    clock.advance(30 * 60_000);
    expect(validateSession(db, clock, token)?.renewed).toBe(false);
    clock.advance(31 * 60_000);
    const v = validateSession(db, clock, token);
    expect(v?.renewed).toBe(true);
    expect(v?.expiresAt.getTime()).toBe(clock.now().getTime() + SESSION_TTL_MS);
  });

  it('rejects sessions of inactive users', () => {
    const { token } = createSession(db, clock, userId);
    db.update(users).set({ active: false }).where(eq(users.id, userId)).run();
    expect(validateSession(db, clock, token)).toBeNull();
  });

  it('deletes single, per-user, and expired sessions', () => {
    const a = createSession(db, clock, userId);
    deleteSession(db, a.token);
    expect(validateSession(db, clock, a.token)).toBeNull();

    createSession(db, clock, userId);
    createSession(db, clock, userId);
    deleteUserSessions(db, userId);
    expect(db.select().from(sessions).all()).toHaveLength(0);

    createSession(db, clock, userId);
    clock.advance(SESSION_TTL_MS + 1);
    expect(deleteExpiredSessions(db, clock)).toBe(1);
  });
});
