import { and, count, eq, isNull } from 'drizzle-orm';
import type { AppDeps } from '../app.js';
import { singleKeyring } from '../core/crypto.js';
import { AppError } from '../core/errors.js';
import { connections, pendingRevocations } from '../db/schema.js';
import { resetTokenKeyCheck } from './keyCheck.js';

/** What the reset did, for the System page's message. */
export interface ResetLinksResult {
  calendarDisconnected: boolean;
  todoistUnlinked: number;
  /** Plaid Items forgotten: each bank has to be connected again, and each new link is another Trial connection. */
  banksForgotten: number;
}

/**
 * "Reset links for a new key" on the System page (spec §14): the way back from a lost
 * TOKEN_ENCRYPTION_KEY, only while the key doesn't match. Nothing saved with the old key can be
 * read, used, or revoked, so:
 * 1. the family calendar's link is forgotten (`GoogleCalendar.forgetForNewKey`), and an admin
 *    connects it again;
 * 2. every bank is forgotten (`Plaid.forgetForNewKey`, the design's departure 10): its connection
 *    deleted, its removal still waiting for Plaid and the bank itself each a lasting notice to end
 *    the access at the bank or my.plaid.com, the Item and its cards marked removed, every transaction
 *    kept but their pending ones, which will never post now. The old Items stay active at Plaid
 *    until they expire, since their tokens can't be read to remove them;
 * 3. every Todoist link is dropped as on unlink, with to-dos kept in place
 *    (`Todoist.resetLinksForNewKey`), which also stores a check for the new key;
 * 4. without Todoist configured, the check is stored here.
 * Plaid and Todoist rows saved while that integration was configured, and it no longer is, refuse
 * the reset: those integrations aren't here to forget them. That's checked before anything is
 * deleted. Plaid goes before Todoist, because the new key's check is stored only once no
 * connection of any kind is left.
 */
export async function resetLinksForNewKey(deps: AppDeps): Promise<ResetLinksResult> {
  if (!deps.calendar.keyMismatch && !deps.todoist?.keyMismatch && !deps.plaid?.keyMismatch) {
    throw new AppError('conflict', 'TOKEN_ENCRYPTION_KEY matches the stored credentials, so there is nothing to reset.');
  }
  // Everything that would refuse the reset part-way is checked before anything is deleted, so a
  // refused reset never forgets the calendar link (R4-M1).
  if (!deps.plaid) {
    const plaid = deps.db.select({ n: count() }).from(connections).where(eq(connections.kind, 'plaid')).get()!.n
      + waitingRevocations(deps, 'plaid');
    // Banks linked before Plaid's keys were taken out of the config: they need the old key, or Plaid back.
    if (plaid > 0) {
      throw new AppError('conflict', 'Bank connections are still saved with the old key, so nothing was reset. Put the original key back, or set Plaid up again and retry.');
    }
  }
  if (!deps.todoist) {
    const todoist = deps.db.select({ n: count() }).from(connections).where(eq(connections.kind, 'todoist')).get()!.n
      + waitingRevocations(deps, 'todoist');
    // Todoist rows from before Todoist was turned off, say: they need the old key.
    if (todoist > 0) throw new AppError('conflict', 'Todoist links are still saved with the old key, so nothing was reset. Put the original key back, or set Todoist up again and retry.');
  }
  const { disconnected } = await deps.calendar.forgetForNewKey();
  const banksForgotten = deps.plaid?.keyMismatch ? (await deps.plaid.forgetForNewKey()).forgotten : 0;
  let unlinked = 0;
  if (deps.todoist) {
    unlinked = (await deps.todoist.resetLinksForNewKey()).unlinked;
  } else if (!resetTokenKeyCheck(deps.db, singleKeyring(deps.config.tokenEncryptionKey))) {
    // Only something saved while this ran, since everything else was checked above.
    throw new AppError('conflict', 'Something was saved with the old key while resetting. Try again.');
  }
  deps.calendar.clearKeyMismatch();
  deps.plaid?.clearKeyMismatch();
  deps.logger.warn({ calendarDisconnected: disconnected, todoistUnlinked: unlinked, banksForgotten }, 'links reset for a new TOKEN_ENCRYPTION_KEY');
  return { calendarDisconnected: disconnected, todoistUnlinked: unlinked, banksForgotten };
}

/** Revocations of `kind` still holding a token (one given up on keeps none). */
function waitingRevocations(deps: AppDeps, kind: 'todoist' | 'plaid'): number {
  return deps.db.select({ n: count() }).from(pendingRevocations).where(and(eq(pendingRevocations.kind, kind), isNull(pendingRevocations.gaveUpAt))).get()!.n;
}
