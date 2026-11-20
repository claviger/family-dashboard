import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { DecryptError, singleKeyring } from '../core/crypto.js';
import { openDb, type Db } from '../db/index.js';
import { connections, users } from '../db/schema.js';
import { addUser, makeTestApp } from '../test/helpers.js';
import { linkSavingsForTest } from '../test/savingsFixtures.js';
import { decryptCredentials, encryptCredentials, getFamilyConnection, insertFamilyConnection, listConnectionSummaries } from './connections.js';

const NOW = new Date('2026-11-15T12:00:00Z');
const ring = singleKeyring(Buffer.alloc(32, 5));

function addAdmin(db: Db, email: string): number {
  return db.insert(users).values({ email, displayName: email, color: '#378ADD', role: 'admin', createdAt: NOW }).returning({ id: users.id }).get().id;
}

describe('family connections', () => {
  it('are bound to their row, so another admin reconnecting (a new owner) still decrypts', () => {
    const { db } = openDb(':memory:');
    const grant = addAdmin(db, 'alex@example.com');
    const jordan = addAdmin(db, 'jordan@example.com');
    const row = db.transaction((tx) =>
      insertFamilyConnection(tx, ring, { kind: 'google_calendar', ownerUserId: grant, meta: { calendarId: 'family' }, now: NOW }, { refreshToken: 'rt-1' }),
    );
    expect(getFamilyConnection(db, 'google_calendar')).toMatchObject({ id: row.id, scope: 'family', ownerUserId: grant });
    expect(decryptCredentials(ring, getFamilyConnection(db, 'google_calendar')!)).toEqual({ refreshToken: 'rt-1' });

    db.update(connections).set({ ownerUserId: jordan }).where(eq(connections.id, row.id)).run();
    expect(decryptCredentials(ring, getFamilyConnection(db, 'google_calendar')!)).toEqual({ refreshToken: 'rt-1' });
  });

  it("won't decrypt a family value copied into a user row, or into another family row", () => {
    const { db } = openDb(':memory:');
    const grant = addAdmin(db, 'alex@example.com');
    const family = db.transaction((tx) =>
      insertFamilyConnection(tx, ring, { kind: 'google_calendar', ownerUserId: grant, meta: {}, now: NOW }, { refreshToken: 'rt-1' }),
    );
    expect(() => decryptCredentials(ring, { ...family, scope: 'user' })).toThrow(DecryptError);
    expect(() => decryptCredentials(ring, { ...family, id: family.id + 1 })).toThrow(DecryptError);
  });

  it('inserts the row and its credentials together, even when the caller forgot a transaction (R1-M3)', () => {
    const { db } = openDb(':memory:');
    const grant = addAdmin(db, 'alex@example.com');
    // Credentials that can't be serialized: the encryption step throws after the insert.
    expect(() => insertFamilyConnection(db, ring, { kind: 'google_calendar', ownerUserId: grant, meta: {}, now: NOW }, { n: 1n })).toThrow();
    expect(getFamilyConnection(db, 'google_calendar')).toBeUndefined();
    // Inside the caller's transaction it nests, and a later failure there still rolls it back.
    expect(() => db.transaction((tx) => {
      insertFamilyConnection(tx, ring, { kind: 'google_calendar', ownerUserId: grant, meta: {}, now: NOW }, { refreshToken: 'rt-1' });
      throw new Error('later step failed');
    })).toThrow('later step failed');
    expect(getFamilyConnection(db, 'google_calendar')).toBeUndefined();
    const row = insertFamilyConnection(db, ring, { kind: 'google_calendar', ownerUserId: grant, meta: {}, now: NOW }, { refreshToken: 'rt-2' });
    expect(decryptCredentials(ring, getFamilyConnection(db, 'google_calendar')!)).toEqual({ refreshToken: 'rt-2' });
    expect(row.credentialsEnc).not.toBe('');
  });

  it('needs the row id to encrypt a family value', () => {
    expect(() => encryptCredentials(ring, { kind: 'google_calendar', scope: 'family', ownerUserId: 1 }, {})).toThrow(/insert the row first/);
  });
});

describe('connection summaries', () => {
  it('say which panel each Plaid connection is for', () => {
    const t = makeTestApp({ plaid: true });
    const admin = addUser(t.db, t.clock, { email: 'alex@example.com', role: 'admin' });
    linkSavingsForTest(t, admin);
    expect(listConnectionSummaries(t.db).filter((c) => c.kind === 'plaid').map((c) => [c.plaidPurpose, c.waitingForCards])).toEqual([['savings', false]]);
  });
});
