import { and, eq, isNull } from 'drizzle-orm';
import {
  BANK_MESSAGES, PLAID_MESSAGES, PLAID_TRIAL_LIMIT, type BankAccountView, type BankPickChoice, type BanksView, type BankView, type RemovedBankView,
} from '../../../shared/plaid.js';
import { CARD_NICKNAME_MAX, SPEND_MESSAGES, type CardOption } from '../../../shared/spend.js';
import { AppError, loggableError } from '../../core/errors.js';
import { cards, pendingRevocations, plaidItems, transactions, type CardRow, type PlaidItemAccount, type PlaidItemRow } from '../../db/schema.js';
import { classifyPlaidError, PlaidApiError } from '../../integrations/plaid/client.js';
import { PLAID_REQUEST_BUDGET_MS, plaidAppError, type Plaid, type PlaidItemView } from '../../integrations/plaid/plaid.js';
import type { BankSync } from './plaidSync.js';
import { cardOption, type SpendDeps } from './store.js';

/**
 * Spend settings' banks (spec §12.2, the design's departures 2, 3, 9 and 11): the bank list with
 * statuses and the Trial count, the pick step, Refresh, and Remove. Linking itself is on the Link
 * pages (integrations/plaid/routes.ts), which end here with `?bank=<id>`. Admins only, and only
 * with Plaid configured; the routes check both.
 *
 * **The pick.** A new Item waits, unsynced, until the admin decides every account it lists:
 * `attach` it to an existing card (one that isn't archived and isn't on another bank account
 * that's still linked; a card whose bank was removed can take a new one), `create` a new excluded
 * card for it, or `skip` it (its transactions are dropped by every sync). All waiting accounts are
 * decided in one request, under the Item's lock so no sync run interleaves. Saving the first pick
 * runs the first sync inside the request; a sync that fails doesn't fail the pick (the failure is
 * recorded on the connection, and the view shows it). A skipped account can be attached later:
 * that marks the Item for a full resync (`full_resync_at`), so the next sync, run at once, first
 * catches up from the stored cursor (applying removals Plaid queued since) and then pulls the
 * whole history again; upserts by `plaid_transaction_id` make that harmless (review C-S-I1).
 *
 * **Account ids that change.** An account the bank stopped sharing leaves its card on the Item as a
 * missing card (`missingCards`). If the bank lists it again under a new account id (a card
 * reissued, say), that id waits for the pick like any new account, and the pick may attach it to
 * the missing card, which is suggested when the last 4 match. The card moves to the new id, a
 * full resync follows (after catching up), and its rows replace the old id's posted rows (they're on no linked
 * account any more, so they're a candidate like an old bank's rows), so the history isn't doubled.
 * The old id's pending rows are soft-deleted with the repair, since it will never post them.
 *
 * **Accounts not loaded.** An Item whose `/accounts/get` failed after the exchange has no account
 * list, and the pick is refused until `load-accounts` (`Plaid.loadAccounts`) fetches it. The same
 * call is the first fix for transactions on an account the list doesn't have (the sync sets
 * `new_accounts_at` for those): an account new to the list then waits for the pick.
 *
 * **Deadlines.** A request has one budget, BANK_REQUEST_DEADLINE_MS, passed down as an absolute
 * deadline (`Plaid.requestDeadline`) to the lock waits and every Plaid call it makes. The pick's
 * lock wait and its sync share it; a sync page that can't finish inside it isn't asked for, the
 * sync is deferred (nothing applied, the cursor where it was), runs in the background
 * (`syncSoon`), and the view's `message` says so. Remove past it queues the revocation for the
 * hourly retries; a lock wait past it is "busy syncing", and Load accounts with no time left for
 * Plaid says Plaid took too long.
 *
 * Every route answers the whole `BanksView`, so the page needs no second request.
 */

/**
 * A request's whole budget (`PLAID_REQUEST_BUDGET_MS`): its wait for an Item's lock (a sync may be
 * running) and every Plaid call it makes, its own sync's pages included, before the sync goes on
 * in the background or, for Remove and Load accounts, the bank is "busy syncing". Well inside
 * nginx's 60-second proxy timeout.
 */
export const BANK_REQUEST_DEADLINE_MS = PLAID_REQUEST_BUDGET_MS;

/** `last_webhook_code` (BankSync stores `TYPE:CODE`) of a login whose access was revoked at the bank. */
const PERMISSION_REVOKED = 'ITEM:USER_PERMISSION_REVOKED';

export interface BankDeps extends SpendDeps {
  plaid: Plaid;
  bank: BankSync;
}

/** A Plaid mask that fits a card's (2 to 4 letters or digits, like CardInputSchema's), or none. */
function cardMask(mask: string | null): string | null {
  return mask !== null && /^[0-9A-Za-z]{2,4}$/.test(mask) ? mask : null;
}

/**
 * A new card's nickname: Plaid's name for the account, within the nickname limit. Not its last 4:
 * the card keeps those in `mask`, and every place a card is named adds them (`cardName`).
 */
export function newCardName(account: Pick<PlaidItemAccount, 'name' | 'officialName'>): string {
  const name = account.name.replace(/\s+/g, ' ').trim() || account.officialName?.replace(/\s+/g, ' ').trim() || 'Bank card';
  return name.slice(0, CARD_NICKNAME_MAX).trimEnd();
}

/** On a bank account that's still linked: its Item removed would have set `removed_at`. */
const attachedLive = (c: CardRow) => c.plaidAccountId !== null && c.removedAt === null;

const byName = (a: CardRow, b: CardRow) => a.nickname.localeCompare(b.nickname) || a.id - b.id;

/**
 * The connection's last failure, if it still says something: when the status isn't ok, or when it
 * came after the last success (a success keeps the old message, spec §8).
 */
export function shownError(conn: NonNullable<PlaidItemView['connection']>): string | null {
  if (conn.lastError === null) return null;
  if (conn.status !== 'ok') return conn.lastError;
  const after = conn.lastErrorAt !== null && (conn.lastSuccessAt === null || conn.lastErrorAt.getTime() > conn.lastSuccessAt.getTime());
  return after ? conn.lastError : null;
}

/**
 * Update mode can't fix an Item Plaid no longer has, or credentials that won't decrypt: those are
 * removed and linked again. Access revoked at the bank (`USER_PERMISSION_REVOKED`) may come back
 * through update mode or may need a new link, so both are offered.
 */
export function fixFor(item: PlaidItemRow, conn: NonNullable<PlaidItemView['connection']>): BankView['fix'] {
  if (conn.status !== 'needs_reconnect') return null;
  if (conn.lastError === PLAID_MESSAGES.gone || conn.lastError === PLAID_MESSAGES.unreadable) return 'remove';
  return item.lastWebhookCode === PERMISSION_REVOKED ? 'reconnect_or_remove' : 'reconnect';
}

function accountState(a: PlaidItemAccount, card: CardRow | undefined): BankAccountView['state'] {
  if (card) return 'attached';
  return a.skipped === true ? 'skipped' : 'waiting';
}

/**
 * The accounts `/accounts/get` lists now. The Item's list also keeps the ones it stopped listing
 * (`listed: false`, plaid.ts `reloadedAccounts`), for their ids; those are never offered: a card
 * that still holds one shows as a missing card instead.
 */
function listedAccounts(item: PlaidItemRow): PlaidItemAccount[] {
  return (item.accounts ?? []).filter((a) => a.listed !== false);
}

/** Accounts that still need a decision: listed, not on a card, not skipped. */
function waitingAccounts(item: PlaidItemRow, onCards: Map<string, CardRow>): PlaidItemAccount[] {
  return listedAccounts(item).filter((a) => accountState(a, onCards.get(a.accountId)) === 'waiting');
}

/** The Item's cards that are still on it, by Plaid account id. */
function itemCards(all: readonly CardRow[], itemId: number): Map<string, CardRow> {
  return new Map(all.filter((c) => c.plaidItemId === itemId && attachedLive(c)).map((c) => [c.plaidAccountId!, c]));
}

/** The Item's cards whose account isn't on its list any more. The pick may move a new account onto one. */
function missingCardsOf(item: PlaidItemRow, onCards: Map<string, CardRow>): CardRow[] {
  const listed = new Set(listedAccounts(item).map((a) => a.accountId));
  return [...onCards.values()].filter((c) => !listed.has(c.plaidAccountId!)).sort(byName);
}

/**
 * The card to suggest for an account that isn't attached: the Item's one missing card with the same
 * last 4 (the account's id changed), else the one attachable card with them (spec §12.2), else none.
 */
function suggestedCard(mask: string | null, missing: readonly CardRow[], attachable: readonly CardRow[]): number | null {
  if (mask === null) return null;
  for (const list of [missing, attachable]) {
    const same = list.filter((c) => c.mask !== null && c.mask === mask);
    if (same.length === 1) return same[0]!.id;
    if (same.length > 1) return null;
  }
  return null;
}

/** The view every bank route answers. `message` is a plain line about what the request did in the background. */
export function banksView(deps: BankDeps, message: string | null = null): BanksView {
  const allCards = deps.db.select().from(cards).all();
  const attachable = allCards.filter((c) => c.archivedAt === null && !attachedLive(c)).sort(byName);
  const items = deps.plaid.items().filter((v) => v.item.purpose === 'spend');

  const banks: BankView[] = items
    .filter((v) => v.item.removedAt === null)
    .map(({ item, connection }) => {
      const onCards = itemCards(allCards, item.id);
      const missing = missingCardsOf(item, onCards);
      const accounts = listedAccounts(item).map((a): BankAccountView => {
        const card = onCards.get(a.accountId);
        return {
          accountId: a.accountId, name: a.name, officialName: a.officialName, mask: a.mask, subtype: a.subtype,
          state: accountState(a, card),
          card: card ? cardOption(card) : null,
          suggestedCardId: card ? null : suggestedCard(a.mask, missing, attachable),
        };
      });
      return {
        id: item.id,
        institutionName: item.institutionName,
        // A live Item always has its connection; without one, say so as a failure.
        status: connection?.status ?? 'error',
        lastError: connection ? shownError(connection) : PLAID_MESSAGES.notFound,
        fix: connection ? fixFor(item, connection) : 'remove',
        lastSuccessAt: connection?.lastSuccessAt?.toISOString() ?? null,
        lastSyncAt: item.lastSyncAt?.toISOString() ?? null,
        needsPick: item.pickedAt === null || accounts.some((a) => a.state === 'waiting'),
        picked: item.pickedAt !== null,
        accountsLoaded: item.accounts !== null,
        accounts,
        missingCards: missing.map(cardOption),
        consentExpiresAt: item.consentExpirationTime,
        disconnectAt: item.disconnectAt,
        newAccountsAt: item.newAccountsAt?.toISOString() ?? null,
      };
    });

  // Removals Plaid hasn't confirmed, by Plaid's item id: still retried, or given up on.
  const outstanding = new Map(
    deps.db.select({ accountId: pendingRevocations.accountId, gaveUpAt: pendingRevocations.gaveUpAt }).from(pendingRevocations)
      .where(eq(pendingRevocations.kind, 'plaid')).all()
      .map((r) => [r.accountId, r.gaveUpAt === null ? 'waiting' as const : 'not_asked' as const]),
  );
  const removed: RemovedBankView[] = items
    .filter((v) => v.item.removedAt !== null)
    .sort((a, b) => b.item.removedAt!.getTime() - a.item.removedAt!.getTime() || b.item.id - a.item.id)
    .map(({ item }) => ({
      id: item.id,
      institutionName: item.institutionName,
      removedAt: item.removedAt!.toISOString(),
      reason: item.removedReason ?? 'removed',
      revocation: outstanding.get(item.plaidItemId) ?? 'confirmed',
      cards: allCards.filter((c) => c.plaidItemId === item.id).sort(byName).map(cardOption),
    }));

  return {
    configured: true,
    keyMismatch: deps.plaid.keyMismatch,
    serverNow: deps.clock.now().toISOString(),
    trial: { used: deps.plaid.trialCount(), limit: PLAID_TRIAL_LIMIT },
    banks,
    removed,
    attachableCards: attachable.map((c): CardOption => cardOption(c)),
    notices: deps.plaid.revocationNotices('spend'),
    message,
  };
}

interface PickResult {
  first: boolean;
  attached: number;
  created: number;
  skipped: number;
  /** Attachments to one of the Item's missing cards (an account id that changed). */
  repaired: number;
}

/**
 * A bank route on a Savings connection is a 404, before anything asks Plaid or takes the Item's
 * lock (the Savings plan, decision 1). A missing Item is left to the route's own check.
 */
function requireSpendItem(deps: BankDeps, itemId: number): void {
  const item = deps.plaid.item(itemId);
  if (item && item.purpose !== 'spend') throw new AppError('not_found', PLAID_MESSAGES.notFound);
}

/** Checks every choice, then saves them all with the Item in one transaction. Runs under the Item's lock. */
function savePick(deps: BankDeps, itemId: number, choices: readonly BankPickChoice[]): PickResult {
  return deps.db.transaction((tx) => {
    const item = tx.select().from(plaidItems).where(eq(plaidItems.id, itemId)).get();
    if (!item || item.removedAt !== null || item.purpose !== 'spend') throw new AppError('not_found', PLAID_MESSAGES.notFound);
    if (item.accounts === null) throw new AppError('conflict', BANK_MESSAGES.loadAccountsFirst);
    const allCards = tx.select().from(cards).all();
    const onCards = itemCards(allCards, itemId);
    const listed = new Map(listedAccounts(item).map((a) => [a.accountId, a]));
    const missing = new Set(missingCardsOf(item, onCards).map((c) => c.id));

    for (const c of choices) {
      if (!listed.has(c.accountId)) throw new AppError('not_found', BANK_MESSAGES.accountNotListed);
      if (onCards.has(c.accountId)) throw new AppError('conflict', BANK_MESSAGES.accountAttached);
    }
    const chosen = new Set(choices.map((c) => c.accountId));
    if (waitingAccounts(item, onCards).some((a) => !chosen.has(a.accountId))) throw new AppError('validation', BANK_MESSAGES.decideEvery);
    const targets = choices.flatMap((c) => (c.action === 'attach' ? [c.cardId] : []));
    if (new Set(targets).size !== targets.length) throw new AppError('validation', BANK_MESSAGES.cardTwice);
    for (const cardId of targets) {
      const card = allCards.find((c) => c.id === cardId);
      if (!card) throw new AppError('validation', SPEND_MESSAGES.cardNotFound);
      if (card.archivedAt !== null) throw new AppError('validation', SPEND_MESSAGES.cardArchived);
      // The Item's own missing card can take the account: that's how a changed account id is repaired.
      if (attachedLive(card) && !missing.has(card.id)) throw new AppError('conflict', BANK_MESSAGES.cardTaken);
    }
    // Plaid's account ids belong to one Item, so another card holding one (a removed bank's) should
    // never happen; whether ids are ever reused across Items is in "Verify on first real link". If
    // it does, the pick is refused rather than taking the id from that card, whose rows are
    // recognized by it.
    for (const c of choices) {
      if (c.action === 'skip') continue;
      const holder = allCards.find((x) => x.plaidAccountId === c.accountId && !(c.action === 'attach' && x.id === c.cardId));
      if (holder) {
        deps.logger.warn({ itemId, cardId: holder.id, holderItemId: holder.plaidItemId }, 'plaid account id already on another card; pick refused');
        throw new AppError('conflict', BANK_MESSAGES.accountIdInUse);
      }
    }

    const now = deps.clock.now();
    const result: PickResult = { first: item.pickedAt === null, attached: 0, created: 0, skipped: 0, repaired: 0 };
    // The whole list, unlisted accounts included: the pick changes only listed ones.
    const accounts = new Map(item.accounts.map((a) => [a.accountId, a]));
    for (const c of choices) {
      const a = listed.get(c.accountId)!;
      const { skipped: _drop, ...plain } = a;
      if (c.action === 'skip') {
        accounts.set(a.accountId, { ...plain, skipped: true });
        result.skipped++;
        continue;
      }
      accounts.set(a.accountId, plain);
      const plaid = {
        plaidItemId: itemId, plaidAccountId: a.accountId, plaidName: a.name, plaidOfficialName: a.officialName, plaidType: a.type, plaidSubtype: a.subtype,
        removedAt: null, updatedAt: now,
      };
      if (c.action === 'attach') {
        const card = allCards.find((x) => x.id === c.cardId)!;
        if (missing.has(card.id)) {
          result.repaired++;
          // The old id will never post its pending rows: soft-deleted for the prune, as for a
          // removed bank (`dropPending`), so a posted row under the new id with another amount (a
          // tip, say) doesn't sit beside one.
          tx.update(transactions)
            .set({ deletedAt: now, removedAt: now, updatedAt: now })
            .where(and(eq(transactions.source, 'plaid'), eq(transactions.pending, true), isNull(transactions.deletedAt), eq(transactions.plaidAccountId, card.plaidAccountId!)))
            .run();
        }
        tx.update(cards)
          .set({ ...plaid, mask: card.mask ?? cardMask(a.mask), isoCurrencyCode: a.isoCurrencyCode ?? card.isoCurrencyCode })
          .where(eq(cards.id, card.id))
          .run();
        result.attached++;
      } else {
        // Excluded until the admin includes it, like every new card (spec §12.2).
        tx.insert(cards)
          .values({ ...plaid, nickname: newCardName(a), mask: cardMask(a.mask), included: false, usualClosingDay: null, isoCurrencyCode: a.isoCurrencyCode, createdAt: now })
          .run();
        result.created++;
      }
    }
    const attachedAny = result.attached + result.created > 0;
    tx.update(plaidItems)
      .set({
        accounts: item.accounts.map((a) => accounts.get(a.accountId)!),
        pickedAt: item.pickedAt ?? now,
        // Departure 2: an account attached after the cursor moved on needs its history again. The
        // cursor itself stays: the next sync brings the Item current from it before the full resync,
        // so removals Plaid queued since aren't lost (review C-S-I1).
        fullResyncAt: attachedAny ? now : item.fullResyncAt,
        updatedAt: now,
      })
      .where(eq(plaidItems.id, itemId))
      .run();
    return result;
  });
}

/**
 * Saves the pick for every waiting account (and any skipped account the admin now attaches), then,
 * for the first pick or a new attachment, runs a sync in the request (reason `pick`, ignoring the
 * backoff). That sync's failure is recorded on the connection by `withItem` and shown in the view;
 * it doesn't undo the pick. The lock wait and the sync share one request deadline: a sync past it
 * goes on in the background, and the view's `message` is "Saved. Syncing in the background."
 * Refused under a key mismatch (`underLock`), and before the accounts are loaded.
 */
export async function pickAccounts(deps: BankDeps, userId: number, itemId: number, choices: readonly BankPickChoice[]): Promise<BanksView> {
  requireSpendItem(deps, itemId);
  const deadline = deps.plaid.requestDeadline();
  let result: PickResult;
  try {
    result = await deps.plaid.underLock(itemId, () => savePick(deps, itemId, choices), { deadline });
  } catch (err) {
    throw plaidAppError(err);
  }
  deps.logger.info({ userId, itemId, ...result }, 'plaid accounts picked');
  let message: string | null = null;
  if (result.first || result.attached + result.created > 0) {
    try {
      const out = await deps.bank.syncItem(itemId, { reason: 'pick', ignoreBackoff: true, deadline });
      if (out.status === 'skipped') deps.logger.info({ itemId, reason: out.reason }, 'plaid first sync after the pick skipped');
      // Past the request's deadline nothing was applied: the run goes on in the background.
      if (out.status === 'deferred') {
        deps.bank.syncSoon(itemId);
        deps.logger.info({ userId, itemId }, 'plaid sync after the pick deferred');
        message = BANK_MESSAGES.pickDeferred;
      }
    } catch (err) {
      const facts = err instanceof PlaidApiError ? { errorCode: err.errorCode } : { kind: classifyPlaidError(err), ...loggableError(err) };
      deps.logger.warn({ itemId, ...facts }, 'plaid sync after the pick failed; the pick is saved');
    }
  }
  return banksView(deps, message);
}

/** Refresh: sync now (the design's "Refresh from Plaid"), ignoring the backoff. A failure is the request's error, in plain words. */
export async function refreshBank(deps: BankDeps, userId: number, itemId: number): Promise<BanksView> {
  requireSpendItem(deps, itemId);
  let out;
  try {
    out = await deps.bank.syncItem(itemId, { reason: 'refresh', ignoreBackoff: true, deadline: deps.plaid.requestDeadline() });
  } catch (err) {
    throw plaidAppError(err);
  }
  if (out.status === 'skipped') {
    switch (out.reason) {
      case 'removed':
        throw new AppError('not_found', PLAID_MESSAGES.notFound);
      case 'not_picked':
        throw new AppError('conflict', BANK_MESSAGES.pickFirst);
      case 'needs_reconnect': {
        const view = banksView(deps).banks.find((b) => b.id === itemId);
        throw new AppError('integration_unavailable', view?.fix === 'remove' ? (view.lastError ?? PLAID_MESSAGES.gone) : PLAID_MESSAGES.reconnect);
      }
      default:
        throw new AppError('integration_unavailable', PLAID_MESSAGES.busy);
    }
  }
  if (out.status === 'deferred') {
    // Past the request's deadline nothing was applied: the run goes on in the background.
    deps.bank.syncSoon(itemId);
    deps.logger.info({ userId, itemId }, 'plaid bank refresh deferred');
    return banksView(deps, BANK_MESSAGES.refreshDeferred);
  }
  deps.logger.info({ userId, itemId, added: out.counts.added, modified: out.counts.modified, removed: out.counts.removed }, 'plaid bank refreshed');
  return banksView(deps);
}

/**
 * Remove: revoke first, then the bank and its cards are marked removed (`Plaid.remove`); with
 * `deleteTransactions`, its own rows go and what they had replaced comes back. A sync holding the
 * lock past the request's deadline: "That bank is busy syncing". When Plaid didn't confirm the
 * revocation (it's retried hourly), or was never asked (a token that can't be read), the view's
 * `message` says so.
 */
export async function removeBank(deps: BankDeps, userId: number, itemId: number, opts: { deleteTransactions: boolean }): Promise<BanksView> {
  requireSpendItem(deps, itemId);
  let revocation;
  try {
    ({ revocation } = await deps.plaid.remove(userId, itemId, { ...opts, deadline: deps.plaid.requestDeadline() }));
  } catch (err) {
    throw plaidAppError(err);
  }
  // Removed here either way; the answer says when Plaid's access may not be ended yet (review G4-I4).
  const message = revocation === 'waiting' ? BANK_MESSAGES.removeUnconfirmed : revocation === 'not_asked' ? BANK_MESSAGES.removeNotAsked : null;
  return banksView(deps, message);
}

/**
 * Load accounts: `/item/get` and `/accounts/get` again (`Plaid.loadAccounts`), for a bank whose
 * accounts couldn't be fetched after linking, or one with transactions for an account its list
 * doesn't have. An account new to the list then waits for the pick.
 */
export async function loadBankAccounts(deps: BankDeps, userId: number, itemId: number): Promise<BanksView> {
  requireSpendItem(deps, itemId);
  try {
    await deps.plaid.loadAccounts(userId, itemId, { deadline: deps.plaid.requestDeadline() });
  } catch (err) {
    throw plaidAppError(err);
  }
  return banksView(deps);
}
