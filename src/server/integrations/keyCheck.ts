import { count, eq, isNull } from 'drizzle-orm';
import { decryptSecret, encryptSecret, type Keyring } from '../core/crypto.js';
import type { Db } from '../db/index.js';
import { calendarLinkPending, connections, pendingRevocations, settings } from '../db/schema.js';
import { decryptCredentials } from './connections.js';

const SETTING = 'token_key_check';
const PLAINTEXT = 'family-dashboard token key check';
const AAD = 'settings:token_key_check';

/**
 * Shown on the System page, and logged, when the key check fails. It names only the integrations
 * this install has configured (R4-M7): Google Calendar always, Todoist and Plaid's banks when
 * they're set up. With Plaid, it says what the reset costs: each bank linked again is another
 * Plaid Trial connection (the design's departure 10). Every integration's `warnings()` passes the
 * same flags, so the System page shows one line.
 */
export function keyMismatchWarning(configured: { todoist: boolean; plaid?: boolean }): string {
  const off = ['Google Calendar', ...(configured.todoist ? ['Todoist'] : []), ...(configured.plaid ? ['bank syncing through Plaid'] : [])];
  const after = [
    'an admin connects Google Calendar again',
    ...(configured.todoist ? ['everyone connects Todoist again'] : []),
    ...(configured.plaid ? ['an admin connects each bank again'] : []),
  ];
  const offText = off.length === 1 ? `${off[0]} is off` : `${off.slice(0, -1).join(', ')} and ${off.at(-1)} are off`;
  const afterText = after.length === 1 ? after[0] : `${after.slice(0, -1).join(', ')}, and ${after.at(-1)}`;
  const trial = configured.plaid ? ' Each bank linked again uses another Plaid Trial connection.' : '';
  return `TOKEN_ENCRYPTION_KEY doesn't match the stored credentials, so ${offText}. Put the original key back. ` +
    `If it is lost, use "Reset links for a new key" on the System page: then ${afterText}.${trial}`;
}

/**
 * Checks TOKEN_ENCRYPTION_KEY against a value encrypted with it before (spec §14). The first time,
 * it stores one. Afterwards, `mismatch` means the key changed: the app keeps running, but
 * integrations do nothing (`TodoistDeps.keyMismatch`) and write nothing, so restoring the right key
 * brings every link back instead of everyone having to reconnect.
 *
 * A changed key is only a mismatch while something is still encrypted with the old one: a
 * connection, tokens waiting to be revoked, or a calendar link waiting for its admin to pick a
 * calendar. With nothing left to lose, the new key simply
 * becomes the reference. If the old key is lost and links remain, an admin resets them
 * (`resetLinksForNewKey` in keyReset.ts), which ends in `resetTokenKeyCheck`.
 *
 * With no check stored yet but connections already there (the check row was lost, say, or the
 * database came from elsewhere), the key is tried on one of them first. If it doesn't decrypt,
 * that's a mismatch, and nothing is stored, so the wrong key can't become the reference.
 */
export function checkTokenKey(db: Db, keyring: Keyring): 'ok' | 'mismatch' {
  const stored = db.select().from(settings).where(eq(settings.key, SETTING)).get();
  if (!stored) {
    const existing = db.select().from(connections).limit(1).get();
    if (existing) {
      try {
        decryptCredentials(keyring, existing);
      } catch {
        return 'mismatch';
      }
    }
    storeCheck(db, keyring);
    return 'ok';
  }
  let matches = false;
  try {
    matches = decryptSecret(keyring, stored.value, AAD) === PLAINTEXT;
  } catch {
    matches = false;
  }
  if (matches) return 'ok';
  return resetTokenKeyCheck(db, keyring) ? 'ok' : 'mismatch';
}

/**
 * Makes `keyring` the reference key, but only when nothing is encrypted with any other key: no
 * connections, no tokens waiting to be revoked, and no calendar link waiting for a pick. Returns
 * false, and changes nothing, otherwise.
 */
export function resetTokenKeyCheck(db: Db, keyring: Keyring): boolean {
  const encrypted = db.select({ n: count() }).from(connections).get()!.n
    // A revocation given up on keeps no token (`gave_up_at`), only its warning.
    + db.select({ n: count() }).from(pendingRevocations).where(isNull(pendingRevocations.gaveUpAt)).get()!.n
    + db.select({ n: count() }).from(calendarLinkPending).get()!.n;
  if (encrypted > 0) return false;
  storeCheck(db, keyring);
  return true;
}

function storeCheck(db: Db, keyring: Keyring): void {
  const value = encryptSecret(keyring, PLAINTEXT, AAD);
  db.insert(settings).values({ key: SETTING, value }).onConflictDoUpdate({ target: settings.key, set: { value } }).run();
}
