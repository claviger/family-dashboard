import { createHash, randomBytes } from 'node:crypto';
import { and, eq, lte, ne } from 'drizzle-orm';
import type { SessionUser } from '../../shared/api.js';
import type { Clock } from '../core/clock.js';
import type { Db } from '../db/index.js';
import { sessions, users, type UserRow } from '../db/schema.js';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ROLL_INTERVAL_MS = 60 * 60 * 1000;

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function toSessionUser(u: UserRow): SessionUser {
  return { id: u.id, email: u.email, displayName: u.displayName, color: u.color, role: u.role };
}

export function createSession(db: Db, clock: Clock, userId: number): { token: string; expiresAt: Date } {
  const token = randomBytes(32).toString('base64url');
  const now = clock.now();
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  db.insert(sessions)
    .values({ idHash: hashToken(token), userId, createdAt: now, lastSeenAt: now, expiresAt })
    .run();
  return { token, expiresAt };
}

export function validateSession(
  db: Db,
  clock: Clock,
  token: string,
): { user: SessionUser; expiresAt: Date; renewed: boolean } | null {
  const idHash = hashToken(token);
  const row = db
    .select({ s: sessions, u: users })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .where(eq(sessions.idHash, idHash))
    .get();
  if (!row) return null;
  const now = clock.now();
  if (row.s.expiresAt.getTime() <= now.getTime() || !row.u.active) {
    db.delete(sessions).where(eq(sessions.idHash, idHash)).run();
    return null;
  }
  let expiresAt = row.s.expiresAt;
  let renewed = false;
  if (now.getTime() - row.s.lastSeenAt.getTime() >= ROLL_INTERVAL_MS) {
    expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
    db.update(sessions).set({ lastSeenAt: now, expiresAt }).where(eq(sessions.idHash, idHash)).run();
    renewed = true;
  }
  return { user: toSessionUser(row.u), expiresAt, renewed };
}

export function deleteSession(db: Db, token: string): void {
  db.delete(sessions).where(eq(sessions.idHash, hashToken(token))).run();
}

/** Every session of the user, except `keep` (a session token) when it's one of theirs. */
export function deleteUserSessions(db: Db, userId: number, keep?: string | null): void {
  db.delete(sessions)
    .where(keep ? and(eq(sessions.userId, userId), ne(sessions.idHash, hashToken(keep))) : eq(sessions.userId, userId))
    .run();
}

/** Returns the number of sessions deleted. */
export function deleteExpiredSessions(db: Db, clock: Clock): number {
  return db.delete(sessions).where(lte(sessions.expiresAt, clock.now())).run().changes;
}
