import { randomBytes } from 'node:crypto';
import { count, eq, sql } from 'drizzle-orm';
import type { FamilySettings } from '../shared/api.js';
import { PANEL_IDS } from '../shared/panels.js';
import { createUser } from './admin/users.js';
import type { Clock } from './core/clock.js';
import { normalizeEmail } from './core/email.js';
import type { Db } from './db/index.js';
import { settings, users } from './db/schema.js';

const DEFAULT_FAMILY_NAME = 'Our family';

function getSetting(db: Db, key: string): string | null {
  return db.select().from(settings).where(eq(settings.key, key)).get()?.value ?? null;
}

function setSetting(db: Db, key: string, value: string): void {
  db.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
}

export function getFamilySettings(db: Db): FamilySettings {
  return {
    name: getSetting(db, 'family_name') ?? DEFAULT_FAMILY_NAME,
    timeZone: getSetting(db, 'time_zone') ?? 'UTC',
  };
}

export function setFamilySettings(db: Db, value: FamilySettings): void {
  setSetting(db, 'family_name', value.name);
  setSetting(db, 'time_zone', value.timeZone);
}

/**
 * This install's random id, made the first time it's asked for and kept in settings. Calendar
 * attribution is written as `<install id>:<user id>` (spec §9.5), so an event added from another
 * install of the dashboard on the same calendar, whose user ids mean other people, isn't credited
 * to someone here.
 */
export function getInstallId(db: Db): string {
  const existing = getSetting(db, 'install_id');
  if (existing) return existing;
  db.insert(settings).values({ key: 'install_id', value: randomBytes(8).toString('hex') }).onConflictDoNothing().run();
  return getSetting(db, 'install_id')!;
}

/**
 * When an admin last started a Google Calendar link (epoch ms by the app's clock), or null. Kept
 * in settings so revocation retries still hold off after a restart in the middle of a link (C-M5).
 */
export function getCalendarLinkStartedAt(db: Db): number | null {
  const value = Number(getSetting(db, 'calendar_link_started_at'));
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function setCalendarLinkStartedAt(db: Db, ms: number): void {
  setSetting(db, 'calendar_link_started_at', String(ms));
}

/**
 * Plaid's `user.client_user_id` for this install (docs/research/plaid-6b.md §2.1): 16 random bytes,
 * made on first use and kept. Plaid says it must not be personal information, and a local user id
 * means nothing outside this database, so it's neither (the phase 4 review's rule).
 */
export function getPlaidClientUserId(db: Db): string {
  const existing = getSetting(db, 'plaid_client_user_id');
  if (existing) return existing;
  db.insert(settings).values({ key: 'plaid_client_user_id', value: randomBytes(16).toString('hex') }).onConflictDoNothing().run();
  return getSetting(db, 'plaid_client_user_id')!;
}

/**
 * How many Plaid Items this install has created (spec §12.2): raised on each successful exchange,
 * never lowered, since removing an Item doesn't give a Trial connection back (research §9).
 * Plaid's Dashboard homepage has the real count if this ever drifts.
 */
export function getPlaidItemsCreated(db: Db): number {
  const value = Number(getSetting(db, 'plaid_items_created'));
  return Number.isInteger(value) && value > 0 ? value : 0;
}

/** One more Plaid Item, in a single statement so two exchanges can't both read the old count. */
export function notePlaidItemCreated(db: Db): void {
  db.insert(settings)
    .values({ key: 'plaid_items_created', value: '1' })
    .onConflictDoUpdate({ target: settings.key, set: { value: sql`cast(cast(${settings.value} as integer) + 1 as text)` } })
    .run();
}

/**
 * Runs at startup. Fills in missing settings and, when the users table is
 * empty, creates the bootstrap admin with every panel granted.
 */
export function bootstrap(
  db: Db,
  clock: Clock,
  opts: { adminEmail?: string; defaultTimeZone: string },
): { createdAdmin: boolean } {
  if (getSetting(db, 'family_name') === null) setSetting(db, 'family_name', DEFAULT_FAMILY_NAME);
  if (getSetting(db, 'time_zone') === null) setSetting(db, 'time_zone', opts.defaultTimeZone);

  const userCount = db.select({ n: count() }).from(users).get()!.n;
  if (userCount > 0 || !opts.adminEmail) return { createdAdmin: false };

  const email = normalizeEmail(opts.adminEmail);
  createUser(db, clock, {
    email,
    displayName: email.split('@')[0] ?? email,
    color: '#378ADD',
    role: 'admin',
    panels: [...PANEL_IDS],
  });
  return { createdAdmin: true };
}
