import { describe, expect, it } from 'vitest';
import { singleKeyring, type Keyring } from '../core/crypto.js';
import { openDb, type Db } from '../db/index.js';
import { calendarLinkPending, connections, pendingRevocations, settings, users } from '../db/schema.js';
import { encryptCredentials } from './connections.js';
import { checkTokenKey, keyMismatchWarning } from './keyCheck.js';

const NOW = new Date('2026-11-15T12:00:00Z');

function addUserRow(db: Db, email = 'kid@example.com'): number {
  return db.insert(users).values({ email, displayName: 'Kid', color: '#378ADD', role: 'member', createdAt: NOW }).returning({ id: users.id }).get().id;
}

function addConnection(db: Db, keyring: Keyring): void {
  const userId = addUserRow(db, `kid-${Math.random()}@example.com`);
  db.insert(connections).values({
    kind: 'todoist', scope: 'user', ownerUserId: userId, createdAt: NOW, updatedAt: NOW,
    credentialsEnc: encryptCredentials(keyring, { kind: 'todoist', scope: 'user', ownerUserId: userId }, { accessToken: 'at' }),
  }).run();
}

describe('checkTokenKey', () => {
  it('stores a check value the first time, then matches the same key', () => {
    const { db } = openDb(':memory:');
    const key = singleKeyring(Buffer.alloc(32, 3));
    expect(checkTokenKey(db, key)).toBe('ok');
    const stored = db.select().from(settings).all().find((s) => s.key === 'token_key_check')!;
    expect(stored.value).toMatch(/^v1\./);
    expect(checkTokenKey(db, key)).toBe('ok');
  });

  it('refuses another key while credentials are stored, and keeps the stored value, so the right key still matches', () => {
    const { db } = openDb(':memory:');
    const right = singleKeyring(Buffer.alloc(32, 3));
    expect(checkTokenKey(db, right)).toBe('ok');
    addConnection(db, right);
    expect(checkTokenKey(db, singleKeyring(Buffer.alloc(32, 4)))).toBe('mismatch');
    expect(checkTokenKey(db, right)).toBe('ok');
  });

  it('takes a new key when nothing is encrypted with the old one: no connections, and no tokens waiting to be revoked', () => {
    const { db } = openDb(':memory:');
    const old = singleKeyring(Buffer.alloc(32, 3));
    const next = singleKeyring(Buffer.alloc(32, 4));
    expect(checkTokenKey(db, old)).toBe('ok');
    expect(checkTokenKey(db, next)).toBe('ok');
    expect(checkTokenKey(db, next)).toBe('ok');
    expect(checkTokenKey(db, old)).toBe('ok'); // and back again: still nothing to lose

    const userId = addUserRow(db);
    db.insert(pendingRevocations).values({ kind: 'todoist', ownerUserId: userId, credentialsEnc: 'v1.x', createdAt: new Date() }).run();
    expect(checkTokenKey(db, next)).toBe('mismatch');
  });

  it("doesn't count a revocation given up on, which keeps no token, only its warning (R2-I3)", () => {
    const { db } = openDb(':memory:');
    expect(checkTokenKey(db, singleKeyring(Buffer.alloc(32, 3)))).toBe('ok');
    const userId = addUserRow(db);
    db.insert(pendingRevocations).values({ kind: 'google_calendar', ownerUserId: userId, credentialsEnc: '', gaveUpAt: NOW, createdAt: NOW }).run();
    expect(checkTokenKey(db, singleKeyring(Buffer.alloc(32, 4)))).toBe('ok');
  });

  it('counts a calendar link waiting for its admin to pick a calendar as something encrypted', () => {
    const { db } = openDb(':memory:');
    const old = singleKeyring(Buffer.alloc(32, 3));
    expect(checkTokenKey(db, old)).toBe('ok');
    const userId = addUserRow(db);
    db.insert(calendarLinkPending).values({ userId, sessionHash: 'h', credentialsEnc: 'v1.x', calendars: [], createdAt: NOW, expiresAt: NOW }).run();
    expect(checkTokenKey(db, singleKeyring(Buffer.alloc(32, 4)))).toBe('mismatch');
  });

  it("with no check stored yet but connections that exist, tests the key on one, and stores nothing if it doesn't fit", () => {
    const { db } = openDb(':memory:');
    const right = singleKeyring(Buffer.alloc(32, 3));
    addConnection(db, right);
    expect(checkTokenKey(db, singleKeyring(Buffer.alloc(32, 4)))).toBe('mismatch');
    expect(db.select().from(settings).all()).toEqual([]);
    expect(checkTokenKey(db, right)).toBe('ok');
    expect(db.select().from(settings).all()).toHaveLength(1);
  });
});

describe('keyMismatchWarning (R4-M7)', () => {
  it('names only the integrations this install has configured', () => {
    expect(keyMismatchWarning({ todoist: true })).toContain('so Google Calendar and Todoist are off');
    expect(keyMismatchWarning({ todoist: true })).toContain('and everyone connects Todoist again');
    const calendarOnly = keyMismatchWarning({ todoist: false });
    expect(calendarOnly).toContain('so Google Calendar is off');
    expect(calendarOnly).not.toContain('Todoist');
    expect(calendarOnly).toContain('then an admin connects Google Calendar again.');
    expect(calendarOnly + keyMismatchWarning({ todoist: true })).not.toMatch(/—/);
  });

  it("names the banks, and what linking them again costs, when Plaid is configured (the design's departure 10)", () => {
    expect(keyMismatchWarning({ todoist: false, plaid: false })).toBe(keyMismatchWarning({ todoist: false }));
    expect(keyMismatchWarning({ todoist: false, plaid: true })).toBe(
      "TOKEN_ENCRYPTION_KEY doesn't match the stored credentials, so Google Calendar and bank syncing through Plaid are off. Put the original key back. " +
        'If it is lost, use "Reset links for a new key" on the System page: then an admin connects Google Calendar again, and an admin connects each bank again. ' +
        'Each bank linked again uses another Plaid Trial connection.',
    );
    const all = keyMismatchWarning({ todoist: true, plaid: true });
    expect(all).toContain('so Google Calendar, Todoist and bank syncing through Plaid are off.');
    expect(all).toContain('then an admin connects Google Calendar again, everyone connects Todoist again, and an admin connects each bank again.');
    expect(all).not.toMatch(/—/);
  });
});
