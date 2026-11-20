import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * Encryption of stored credentials (spec §8): AES-256-GCM with a random 12-byte IV per value and
 * a key-version prefix, so a new key can be added later without breaking values encrypted under
 * the old one.
 *
 * The additional authenticated data (AAD) names the row a value belongs to (see `connectionAad`),
 * so a ciphertext copied into another connection's row fails to decrypt instead of handing one
 * user's token to another.
 *
 * Plaintexts are secrets: never log them, and never put them in an error message.
 */

/** The keys the app can decrypt with, by version, and the version new values are encrypted with. */
export interface Keyring {
  currentVersion: number;
  keys: ReadonlyMap<number, Buffer>;
}

/** Phase 4 has one key, version 1. Rotation would add a second version here. */
export function singleKeyring(key: Buffer): Keyring {
  return { currentVersion: 1, keys: new Map([[1, key]]) };
}

/** A value that can't be decrypted: wrong or missing key, wrong AAD, or a damaged value. The message never contains secrets. */
export class DecryptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptError';
  }
}

const IV_BYTES = 12;
const TAG_BYTES = 16;
const FORMAT = /^v(\d+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]*)\.([A-Za-z0-9_-]+)$/;

/** `v<version>.<iv>.<ciphertext>.<tag>`, each part base64url. */
export function encryptSecret(ring: Keyring, plaintext: string, aad: string): string {
  const key = ring.keys.get(ring.currentVersion);
  if (!key) throw new Error(`No encryption key for version ${ring.currentVersion}`);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v${ring.currentVersion}.${iv.toString('base64url')}.${ciphertext.toString('base64url')}.${tag.toString('base64url')}`;
}

export function decryptSecret(ring: Keyring, value: string, aad: string): string {
  const m = FORMAT.exec(value);
  if (!m) throw new DecryptError('Stored credentials are in an unknown format.');
  const key = ring.keys.get(Number(m[1]));
  if (!key) throw new DecryptError(`No key for credential version ${m[1]}.`);
  const iv = Buffer.from(m[2]!, 'base64url');
  const tag = Buffer.from(m[4]!, 'base64url');
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new DecryptError('Stored credentials are damaged.');
  try {
    // authTagLength pins the tag at 16 bytes in Node itself too, so a shortened tag can never be
    // accepted (GCM allows shorter tags, which are easier to forge), even without the check above.
    const decipher = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(Buffer.from(m[3]!, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new DecryptError("Stored credentials couldn't be decrypted with the current key.");
  }
}

/**
 * The AAD for a connection's credentials: its kind and scope, and who or what the value is bound
 * to, so a value can't move between rows, kinds, or scopes.
 * - A user connection (Todoist) is bound to its owner: `connections:<kind>:user:<owner id>`, as
 *   before the scope was a parameter.
 * - A family connection (Google Calendar) is bound to its row: `connections:<kind>:family:<row id>`.
 *   Any admin can reconnect it (spec §8), which changes `owner_user_id`; binding to the row means
 *   that never breaks decryption. Insert the row first, then write its credentials, in one
 *   transaction (`insertFamilyConnection`).
 */
export function connectionAad(kind: string, scope: 'user' | 'family', ownerOrRowId: number): string {
  return `connections:${kind}:${scope}:${ownerOrRowId}`;
}

/**
 * The AAD for tokens kept to be revoked after an unlink (`pending_revocations`): a different
 * prefix from `connectionAad`, so neither table's values can be swapped into the other. Todoist's
 * rows are bound to their owner; the family calendar's to the row (`familyRevocationAad`).
 */
export function revocationAad(kind: string, ownerUserId: number): string {
  return `pending_revocations:${kind}:user:${ownerUserId}`;
}

export function familyRevocationAad(kind: string, rowId: number): string {
  return `pending_revocations:${kind}:family:${rowId}`;
}

/**
 * The AAD for a Google Calendar link waiting for its admin to pick a calendar
 * (`calendar_link_pending`), one row per admin.
 */
export function pendingLinkAad(userId: number): string {
  return `calendar_link_pending:${userId}`;
}

/**
 * Parses TOKEN_ENCRYPTION_KEY: exactly 32 bytes, base64 (what `openssl rand -base64 32` prints).
 * Strict: Buffer.from() would quietly skip characters that aren't base64.
 */
export function parseEncryptionKey(raw: string): Buffer {
  const text = raw.trim();
  const key = Buffer.from(text, 'base64');
  if (key.length !== 32 || key.toString('base64').replace(/=+$/, '') !== text.replace(/=+$/, '')) {
    throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded (generate one with `openssl rand -base64 32`).');
  }
  return key;
}
