import { and, asc, eq, isNotNull } from 'drizzle-orm';
import type { ConnectionStatus, ConnectionSummary } from '../../shared/integrations.js';
import { connectionAad, decryptSecret, encryptSecret, type Keyring } from '../core/crypto.js';
import type { Db } from '../db/index.js';
import { connections, plaidItems, users, type ConnectionRow } from '../db/schema.js';

/**
 * The `connections` table (spec §8), shared by every integration: Todoist (one per user), the
 * family's Google Calendar (exactly one), and Plaid in phase 6. Credentials are encrypted with the
 * row's kind, scope, and owner (user connections) or row id (family connections) as AAD, decrypted
 * only in the server, and never returned or logged.
 */

export type ConnectionKind = ConnectionRow['kind'];

/** A database handle or a transaction on it. */
export type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/** Spec §8: 3 failures in a row (that aren't authorization failures) set `error`. */
export const FAILURES_BEFORE_ERROR = 3;

export function getUserConnection(db: DbOrTx, kind: ConnectionKind, userId: number): ConnectionRow | undefined {
  return db
    .select()
    .from(connections)
    .where(and(eq(connections.kind, kind), eq(connections.scope, 'user'), eq(connections.ownerUserId, userId)))
    .get();
}

/** The one connection of a kind that belongs to the family (spec §8: one Google Calendar). */
export function getFamilyConnection(db: DbOrTx, kind: ConnectionKind): ConnectionRow | undefined {
  return db
    .select()
    .from(connections)
    .where(and(eq(connections.kind, kind), eq(connections.scope, 'family')))
    .get();
}

/**
 * The row a value is encrypted for: its AAD (`connectionAad`). A user connection is bound to its
 * owner; a family connection to its row id, so it needs `id`.
 */
export type ConnectionOwner = Pick<ConnectionRow, 'kind' | 'scope' | 'ownerUserId'> & { id?: number };

function aadFor(owner: ConnectionOwner): string {
  if (owner.scope === 'user') return connectionAad(owner.kind, 'user', owner.ownerUserId);
  if (owner.id === undefined) throw new Error('A family connection is encrypted for its row: insert the row first.');
  return connectionAad(owner.kind, 'family', owner.id);
}

export function encryptCredentials(keyring: Keyring, owner: ConnectionOwner, value: unknown): string {
  return encryptSecret(keyring, JSON.stringify(value), aadFor(owner));
}

/** Throws DecryptError (core/crypto.ts) when the key changed or the value was moved or damaged. */
export function decryptCredentials(keyring: Keyring, row: ConnectionRow): unknown {
  return JSON.parse(decryptSecret(keyring, row.credentialsEnc, aadFor(row))) as unknown;
}

/**
 * Inserts a family connection and writes its credentials, bound to the new row's id: the row goes
 * in with an empty value, then gets its ciphertext. Both happen in a transaction of its own (a
 * savepoint inside the caller's, when there is one), so a failure in between never leaves a row
 * without credentials (R1-M3).
 */
export function insertFamilyConnection(
  db: DbOrTx,
  keyring: Keyring,
  row: { kind: ConnectionKind; ownerUserId: number; meta: Record<string, unknown>; now: Date },
  credentials: unknown,
): ConnectionRow {
  return (db as Db).transaction((tx) => {
    const inserted = tx
      .insert(connections)
      .values({ kind: row.kind, scope: 'family', ownerUserId: row.ownerUserId, credentialsEnc: '', meta: row.meta, lastSuccessAt: row.now, createdAt: row.now, updatedAt: row.now })
      .returning()
      .get();
    const credentialsEnc = encryptCredentials(keyring, inserted, credentials);
    tx.update(connections).set({ credentialsEnc }).where(eq(connections.id, inserted.id)).run();
    return { ...inserted, credentialsEnc };
  });
}

/** Any success sets `ok` (spec §8). */
export function recordConnectionSuccess(db: DbOrTx, id: number, now: Date): void {
  db.update(connections)
    .set({ status: 'ok', consecutiveFailures: 0, lastSuccessAt: now, updatedAt: now })
    .where(eq(connections.id, id))
    .run();
}

/**
 * An authorization failure sets `needs_reconnect` at once; anything else sets `error` after
 * FAILURES_BEFORE_ERROR in a row (spec §8). `message` is shown to people, so it must be plain and
 * must never contain a token or a raw response body.
 */
export function recordConnectionFailure(db: DbOrTx, row: ConnectionRow, now: Date, message: string, auth: boolean): ConnectionStatus {
  const failures = auth ? row.consecutiveFailures : row.consecutiveFailures + 1;
  const status: ConnectionStatus =
    auth || row.status === 'needs_reconnect' ? 'needs_reconnect' : failures >= FAILURES_BEFORE_ERROR ? 'error' : row.status;
  db.update(connections)
    .set({ status, consecutiveFailures: failures, lastError: message, lastErrorAt: now, updatedAt: now })
    .where(eq(connections.id, row.id))
    .run();
  return status;
}

/** Every connection, with its owner's name, for the admin page (spec §5). No credentials. */
export function listConnectionSummaries(db: Db): ConnectionSummary[] {
  // A bank linked through Plaid waits, unsynced, until the admin chooses its cards or accounts (`picked_at` null).
  const items = new Map(
    db.select({ connectionId: plaidItems.connectionId, pickedAt: plaidItems.pickedAt, purpose: plaidItems.purpose }).from(plaidItems).where(isNotNull(plaidItems.connectionId)).all()
      .map((i) => [i.connectionId!, { waiting: i.pickedAt === null, purpose: i.purpose }]),
  );
  return db
    .select({
      id: connections.id,
      kind: connections.kind,
      scope: connections.scope,
      ownerUserId: connections.ownerUserId,
      ownerName: users.displayName,
      meta: connections.meta,
      status: connections.status,
      lastSuccessAt: connections.lastSuccessAt,
      lastError: connections.lastError,
      lastErrorAt: connections.lastErrorAt,
    })
    .from(connections)
    .innerJoin(users, eq(users.id, connections.ownerUserId))
    .orderBy(asc(connections.kind), asc(users.displayName))
    .all()
    .map(({ meta, ...c }) => ({
      ...c,
      account: connectionAccount(meta),
      lastSuccessAt: c.lastSuccessAt?.toISOString() ?? null,
      lastErrorAt: c.lastErrorAt?.toISOString() ?? null,
      ...(c.kind === 'plaid' ? { waitingForCards: items.get(c.id)?.waiting ?? false, plaidPurpose: items.get(c.id)?.purpose ?? 'spend' } : {}),
    }));
}

/**
 * `meta.account`: who the connection is signed in as, as the provider names it. A Plaid connection
 * has no account name, so it's the bank's (`meta.institutionName`), for the admin page's list.
 */
export function connectionAccount(meta: Record<string, unknown>): string | null {
  if (typeof meta.account === 'string') return meta.account;
  return typeof meta.institutionName === 'string' ? meta.institutionName : null;
}
