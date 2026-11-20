import { and, asc, count, eq } from 'drizzle-orm';
import type { AdminUser, CreateUserInput, UpdateUserInput } from '../../shared/api.js';
import { orderPanels, type PanelId } from '../../shared/panels.js';
import { deleteUserSessions } from '../auth/sessions.js';
import type { Clock } from '../core/clock.js';
import { normalizeEmail } from '../core/email.js';
import { AppError } from '../core/errors.js';
import type { Db } from '../db/index.js';
import { panelGrants, users, type UserRow } from '../db/schema.js';

export function getUser(db: Db, id: number): UserRow | undefined {
  return db.select().from(users).where(eq(users.id, id)).get();
}

function assertEmailFree(db: Db, email: string): void {
  if (db.select({ id: users.id }).from(users).where(eq(users.email, email)).get()) {
    throw new AppError('conflict', 'A user with that email already exists.');
  }
}

function countActiveAdmins(db: Db): number {
  return db
    .select({ n: count() })
    .from(users)
    .where(and(eq(users.role, 'admin'), eq(users.active, true)))
    .get()!.n;
}

export function createUser(db: Db, clock: Clock, input: CreateUserInput): number {
  const email = normalizeEmail(input.email);
  assertEmailFree(db, email);
  return db.transaction((tx) => {
    const { id } = tx
      .insert(users)
      .values({
        email,
        displayName: input.displayName,
        color: input.color,
        role: input.role,
        active: true,
        createdAt: clock.now(),
      })
      .returning({ id: users.id })
      .get();
    for (const panelId of new Set(input.panels)) {
      tx.insert(panelGrants).values({ userId: id, panelId }).run();
    }
    return id;
  });
}

/** `keepSession`: the caller's session token, kept on an email change when it belongs to this user. */
export function updateUser(db: Db, id: number, patch: UpdateUserInput, opts: { keepSession?: string | null } = {}): void {
  const current = getUser(db, id);
  if (!current) throw new AppError('not_found', 'User not found.');

  const nextRole = patch.role ?? current.role;
  const nextActive = patch.active ?? current.active;
  const losesAdmin = current.role === 'admin' && current.active && (nextRole !== 'admin' || !nextActive);
  if (losesAdmin && countActiveAdmins(db) <= 1) {
    throw new AppError('validation', 'There must be at least one active admin.');
  }

  const values: Partial<typeof users.$inferInsert> = {};
  if (patch.email !== undefined) {
    const email = normalizeEmail(patch.email);
    if (email !== current.email) {
      assertEmailFree(db, email);
      values.email = email;
      values.googleSub = null;
    }
  }
  if (patch.displayName !== undefined) values.displayName = patch.displayName;
  if (patch.color !== undefined) values.color = patch.color;
  if (patch.role !== undefined) values.role = patch.role;
  if (patch.active !== undefined) values.active = patch.active;

  if (Object.keys(values).length > 0) {
    db.update(users).set(values).where(eq(users.id, id)).run();
  }
  // Deactivating ends every session. A new email clears the Google binding, so the sessions the old
  // Google account opened end too (security scan finding F2), except the one making the change when
  // it's the user's own: that person is here, and a mistyped address mustn't lock them out.
  if (patch.active === false) deleteUserSessions(db, id);
  else if (values.email !== undefined) deleteUserSessions(db, id, opts.keepSession);
}

export function getGrants(db: Db, userId: number): PanelId[] {
  const rows = db.select({ panelId: panelGrants.panelId }).from(panelGrants).where(eq(panelGrants.userId, userId)).all();
  return orderPanels(rows.map((r) => r.panelId as PanelId));
}

export function setGrant(db: Db, userId: number, panelId: PanelId, enabled: boolean): void {
  if (!getUser(db, userId)) throw new AppError('not_found', 'User not found.');
  if (enabled) {
    db.insert(panelGrants).values({ userId, panelId }).onConflictDoNothing().run();
  } else {
    db.delete(panelGrants).where(and(eq(panelGrants.userId, userId), eq(panelGrants.panelId, panelId))).run();
  }
}

export function listUsers(db: Db): AdminUser[] {
  const rows = db.select().from(users).orderBy(asc(users.displayName)).all();
  return rows.map((u) => ({
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    color: u.color,
    role: u.role,
    active: u.active,
    lastLoginAt: u.lastLoginAt ? u.lastLoginAt.toISOString() : null,
    panels: getGrants(db, u.id),
  }));
}
