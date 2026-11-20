import { eq } from 'drizzle-orm';
import type { SessionUser } from '../../shared/api.js';
import type { Clock } from '../core/clock.js';
import { normalizeEmail } from '../core/email.js';
import type { Db } from '../db/index.js';
import { users } from '../db/schema.js';
import { toSessionUser } from './sessions.js';

export interface GoogleClaims {
  sub: string;
  email: string;
  emailVerified: boolean;
}

export type IdentityResult =
  | { ok: true; user: SessionUser }
  | { ok: false; reason: 'unverified' | 'not_provisioned' | 'account_mismatch' };

/** Spec §4: match by bound Google account ID, then by unbound email; bind on success. */
export function resolveGoogleIdentity(db: Db, clock: Clock, claims: GoogleClaims): IdentityResult {
  if (!claims.emailVerified) return { ok: false, reason: 'unverified' };

  let user = db.select().from(users).where(eq(users.googleSub, claims.sub)).get();
  if (!user) {
    const byEmail = db.select().from(users).where(eq(users.email, normalizeEmail(claims.email))).get();
    if (!byEmail) return { ok: false, reason: 'not_provisioned' };
    if (byEmail.googleSub !== null && byEmail.googleSub !== claims.sub) {
      return { ok: false, reason: 'account_mismatch' };
    }
    user = byEmail;
  }
  if (!user.active) return { ok: false, reason: 'not_provisioned' };

  db.update(users).set({ googleSub: claims.sub, lastLoginAt: clock.now() }).where(eq(users.id, user.id)).run();
  return { ok: true, user: toSessionUser(user) };
}
