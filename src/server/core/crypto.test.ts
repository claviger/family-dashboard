import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  connectionAad, decryptSecret, DecryptError, encryptSecret, familyRevocationAad, parseEncryptionKey, pendingLinkAad, revocationAad, singleKeyring,
} from './crypto.js';

const ring = singleKeyring(randomBytes(32));
const aad = connectionAad('todoist', 'user', 7);

/** Replaces one dot-separated part of a ciphertext (0 version, 1 IV, 2 ciphertext, 3 tag). */
function withPart(value: string, index: number, change: (b: Buffer) => Buffer): string {
  const parts = value.split('.');
  parts[index] = change(Buffer.from(parts[index]!, 'base64url')).toString('base64url');
  return parts.join('.');
}
const flipFirst = (b: Buffer) => {
  const c = Buffer.from(b);
  c[0] = c[0]! ^ 1;
  return c;
};

describe('encryptSecret / decryptSecret', () => {
  it('round-trips, with a version prefix and a fresh IV each time', () => {
    const a = encryptSecret(ring, '{"accessToken":"abc"}', aad);
    const b = encryptSecret(ring, '{"accessToken":"abc"}', aad);
    expect(a).toMatch(/^v1\./);
    expect(a).not.toBe(b);
    expect(a).not.toContain('abc');
    expect(decryptSecret(ring, a, aad)).toBe('{"accessToken":"abc"}');
  });

  it("won't decrypt a value moved to another connection's row, another kind, or between user and family scope", () => {
    const value = encryptSecret(ring, 'secret', aad);
    expect(() => decryptSecret(ring, value, connectionAad('todoist', 'user', 8))).toThrow(DecryptError);
    expect(() => decryptSecret(ring, value, connectionAad('google_calendar', 'user', 7))).toThrow(DecryptError);
    expect(() => decryptSecret(ring, value, connectionAad('todoist', 'family', 7))).toThrow(DecryptError);
    // Unchanged for user connections, so values stored before the scope was added still decrypt.
    expect(aad).toBe('connections:todoist:user:7');
  });

  it('binds the family calendar to its row, and keeps pending revocations and pending links apart', () => {
    expect(connectionAad('google_calendar', 'family', 3)).toBe('connections:google_calendar:family:3');
    const aads = [
      connectionAad('google_calendar', 'family', 3), connectionAad('google_calendar', 'user', 3), revocationAad('google_calendar', 3),
      familyRevocationAad('google_calendar', 3), pendingLinkAad(3),
    ];
    expect(new Set(aads).size).toBe(aads.length);
    const value = encryptSecret(ring, 'refresh', aads[0]!);
    for (const other of aads.slice(1)) expect(() => decryptSecret(ring, value, other)).toThrow(DecryptError);
  });

  it('rejects a truncated tag, a tampered tag or IV, and an IV that is not 12 bytes', () => {
    const value = encryptSecret(ring, 'secret', aad);
    expect(() => decryptSecret(ring, withPart(value, 3, (b) => b.subarray(0, 15)), aad)).toThrow(DecryptError);
    expect(() => decryptSecret(ring, withPart(value, 3, (b) => b.subarray(0, 4)), aad)).toThrow(DecryptError);
    expect(() => decryptSecret(ring, withPart(value, 3, flipFirst), aad)).toThrow(DecryptError);
    expect(() => decryptSecret(ring, withPart(value, 1, flipFirst), aad)).toThrow(DecryptError);
    expect(() => decryptSecret(ring, withPart(value, 1, (b) => Buffer.concat([b, Buffer.alloc(4)])), aad)).toThrow(DecryptError);
    expect(() => decryptSecret(ring, withPart(value, 1, (b) => b.subarray(0, 8)), aad)).toThrow(DecryptError);
  });

  it('rejects a wrong key, a tampered value, an unknown version, and garbage, without leaking the plaintext', () => {
    const value = encryptSecret(ring, 'secret', aad);
    expect(() => decryptSecret(singleKeyring(randomBytes(32)), value, aad)).toThrow(DecryptError);
    const parts = value.split('.');
    const flipped = Buffer.from(parts[2]!, 'base64url');
    flipped[0] = flipped[0]! ^ 1;
    expect(() => decryptSecret(ring, [parts[0], parts[1], flipped.toString('base64url'), parts[3]].join('.'), aad)).toThrow(DecryptError);
    expect(() => decryptSecret(ring, value.replace(/^v1/, 'v2'), aad)).toThrow(/version 2/);
    expect(() => decryptSecret(ring, 'not-a-ciphertext', aad)).toThrow(DecryptError);
    try {
      decryptSecret(singleKeyring(randomBytes(32)), value, aad);
    } catch (err) {
      expect(String(err)).not.toContain('secret');
    }
  });
});

describe('parseEncryptionKey', () => {
  it('accepts 32 bytes of base64, with or without padding', () => {
    const key = randomBytes(32);
    expect(parseEncryptionKey(key.toString('base64')).equals(key)).toBe(true);
    expect(parseEncryptionKey(key.toString('base64').replace(/=+$/, '')).equals(key)).toBe(true);
  });

  it('rejects the wrong length and text that is not base64', () => {
    expect(() => parseEncryptionKey(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
    expect(() => parseEncryptionKey('this is not base64 at all, not even close!!')).toThrow(/32 bytes/);
  });
});
