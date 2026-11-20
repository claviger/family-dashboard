import { and, asc, eq, isNull } from 'drizzle-orm';
import type { Logger } from 'pino';
import { BANK_MESSAGES, PLAID_MESSAGES, PLAID_TRIAL_LIMIT } from '../../../shared/plaid.js';
import {
  SAVINGS_MESSAGES, type SavingsAccountPatch, type SavingsConnectionView, type SavingsPickChoice, type SavingsSettingsAccount, type SavingsSettingsView,
} from '../../../shared/savings.js';
import { AppError, loggableError } from '../../core/errors.js';
import { pendingRevocations, plaidItems, savingsAccounts, type PlaidItemAccount, type PlaidItemRow, type SavingsAccountRow } from '../../db/schema.js';
import { classifyPlaidError, PlaidApiError } from '../../integrations/plaid/client.js';
import { plaidAppError, type Plaid } from '../../integrations/plaid/plaid.js';
import { fixFor, shownError } from '../spend/banks.js';
import type { BankSync } from '../spend/plaidSync.js';
import { keptAccountsOf, type SavingsReadDeps } from './views.js';
import { accountKindOf } from './flows.js';
import { importProfilesOf, listSavingsImports } from './imports.js';
import { latestBalances } from './store.js';
import type { SavingsSync } from './sync.js';

/**
 * Savings settings (the Savings spec, "Access" and "Linking"; plan decisions 1, 9, 10 and 14),
 * admins only, with Plaid configured (the routes check both). Linking itself is the Link page
 * (`/connect/plaid/link?for=savings`), which comes back with `?bank=<id>`.
 *
 * - **The pick.** A new connection waits, unsynced, until every account it lists is decided: Show
 *   (a `savings_accounts` row, with a nickname) or Skip (marked on the Item's list; never stored or
 *   fetched). All in one request, under the Item's lock. The first pick runs the first sync in the
 *   request. A skipped account shown later asks for a full resync, as Spend's late attach does.
 * - **Rename and hide** are local: no Plaid call.
 * - **Refresh, Load accounts, Remove** are Spend's, through `SavingsSync` and `Plaid`, under one
 *   request budget. Remove's `deleteData` deletes the accounts with their balances and flows.
 *
 * Every action answers the whole `SavingsSettingsView`.
 */

/** What the settings view and the local changes need. `plaid` is null when Plaid isn't configured (plan decision 20). */
export interface SavingsViewDeps extends SavingsReadDeps {
  logger: Logger;
  plaid: Plaid | null;
}

/** The connection routes: Plaid configured. */
export interface SavingsSettingsDeps extends SavingsViewDeps {
  plaid: Plaid;
  bank: BankSync;
  savings: SavingsSync;
}

/** The accounts `/accounts/get` lists now (not the ones kept with `listed: false`). */
function listedAccounts(item: PlaidItemRow): PlaidItemAccount[] {
  return (item.accounts ?? []).filter((a) => a.listed !== false);
}

function accountState(a: PlaidItemAccount, row: SavingsAccountRow | undefined): SavingsSettingsAccount['state'] {
  if (row) return row.hiddenAt === null ? 'shown' : 'hidden';
  return a.skipped === true ? 'skipped' : 'waiting';
}

/**
 * What Settings says about the brokerage's Investments (decision 8): refused, with its fix
 * (`INVALID_PRODUCT` is the Plaid account's to turn on; the others are the institution not sharing it),
 * or a passing failure the next sync tries again. Null when it worked or wasn't tried yet.
 */
function investmentsMessage(item: PlaidItemRow): string | null {
  if (item.investmentsStatus === 'unavailable') {
    return item.investmentsErrorCode === 'INVALID_PRODUCT' ? SAVINGS_MESSAGES.investmentsNotEnabled : SAVINGS_MESSAGES.investmentsNotShared;
  }
  return item.investmentsErrorCode !== null ? SAVINGS_MESSAGES.investmentsRetry : null;
}

/** The view every settings route answers. `message`: what the request left to the background, Plaid didn't confirm, or an import said. */
export function savingsSettingsView(deps: SavingsViewDeps, message: string | null = null): SavingsSettingsView {
  const rows = deps.db.select().from(savingsAccounts).where(isNull(savingsAccounts.removedAt)).all();
  const hand = deps.db.select().from(savingsAccounts).where(eq(savingsAccounts.source, 'manual')).orderBy(asc(savingsAccounts.id)).all();
  const latest = latestBalances(deps.db, hand.map((a) => a.id));
  // Without Plaid, Savings settings has no connections to show a linked account under, so it lists
  // only hand-added accounts' imports and saved settings (a linked account's come back with Plaid).
  const live = rows.filter((r) => deps.plaid !== null || r.source === 'manual').map((r) => r.id);
  const local = {
    serverNow: deps.clock.now().toISOString(),
    handAccounts: hand.map((a) => ({ id: a.id, nickname: a.nickname, kind: a.kind, hidden: a.hiddenAt !== null, removed: a.removedAt !== null, latest: latest.get(a.id) ?? null })),
    imports: listSavingsImports(deps.db, live),
    profiles: importProfilesOf(deps.db, live),
    message,
  };
  const plaid = deps.plaid;
  if (!plaid) return { plaidConfigured: false, keyMismatch: false, trial: null, connections: [], removed: [], notices: [], ...local };
  const items = plaid.items().filter((v) => v.item.purpose === 'savings');

  const connections: SavingsConnectionView[] = items.filter((v) => v.item.removedAt === null).map(({ item, connection }) => {
    const mine = new Map(rows.filter((r) => r.plaidItemId === item.id).map((r) => [r.plaidAccountId, r]));
    const accounts = listedAccounts(item).map((a): SavingsSettingsAccount => {
      const row = mine.get(a.accountId);
      return {
        accountId: a.accountId, name: a.name, officialName: a.officialName, mask: a.mask, type: a.type, subtype: a.subtype,
        state: accountState(a, row), savingsAccountId: row?.id ?? null, nickname: row?.nickname ?? null, showable: accountKindOf(a.type) !== null,
      };
    });
    return {
      id: item.id,
      institutionName: item.institutionName,
      status: connection?.status ?? 'error',
      lastError: connection ? shownError(connection) : PLAID_MESSAGES.notFound,
      fix: connection ? fixFor(item, connection) : 'remove',
      lastSuccessAt: connection?.lastSuccessAt?.toISOString() ?? null,
      lastSyncAt: item.lastSyncAt?.toISOString() ?? null,
      needsPick: item.pickedAt === null || accounts.some((a) => a.state === 'waiting'),
      picked: item.pickedAt !== null,
      accountsLoaded: item.accounts !== null,
      accounts,
      investments: { status: item.investmentsStatus ?? 'unknown', code: item.investmentsErrorCode, message: investmentsMessage(item) },
      consentExpiresAt: item.consentExpirationTime,
      disconnectAt: item.disconnectAt,
      newAccountsAt: item.newAccountsAt?.toISOString() ?? null,
    };
  });

  const outstanding = new Map(
    deps.db.select({ accountId: pendingRevocations.accountId, gaveUpAt: pendingRevocations.gaveUpAt }).from(pendingRevocations)
      .where(eq(pendingRevocations.kind, 'plaid')).all()
      .map((r) => [r.accountId, r.gaveUpAt === null ? ('waiting' as const) : ('not_asked' as const)]),
  );
  const gone = items.filter((v) => v.item.removedAt !== null).sort((a, b) => b.item.removedAt!.getTime() - a.item.removedAt!.getTime() || b.item.id - a.item.id);
  const kept = keptAccountsOf(deps.db, gone.map((v) => v.item.id));

  return {
    plaidConfigured: true,
    keyMismatch: plaid.keyMismatch,
    trial: { used: plaid.trialCount(), limit: PLAID_TRIAL_LIMIT },
    connections,
    removed: gone.map(({ item }) => ({
      id: item.id,
      institutionName: item.institutionName,
      removedAt: item.removedAt!.toISOString(),
      reason: item.removedReason ?? 'removed',
      revocation: outstanding.get(item.plaidItemId) ?? 'confirmed',
      accounts: kept.get(item.id)!,
    })),
    notices: plaid.revocationNotices('savings'),
    ...local,
  };
}

/** A settings route on a Spend bank is a 404, before anything asks Plaid. */
function requireSavingsItem(deps: SavingsSettingsDeps, itemId: number): void {
  const item = deps.plaid.item(itemId);
  if (item && item.purpose !== 'savings') throw new AppError('not_found', PLAID_MESSAGES.notFound);
}

interface PickResult {
  first: boolean;
  shown: number;
  skipped: number;
  /** Accounts shown after the first pick: their history is read again (full resync). */
  late: number;
}

/** Checks every choice, then saves them all in one transaction. Runs under the Item's lock. */
function savePick(deps: SavingsSettingsDeps, itemId: number, choices: readonly SavingsPickChoice[]): PickResult {
  return deps.db.transaction((tx) => {
    const item = tx.select().from(plaidItems).where(eq(plaidItems.id, itemId)).get();
    if (!item || item.removedAt !== null || item.purpose !== 'savings') throw new AppError('not_found', PLAID_MESSAGES.notFound);
    if (item.accounts === null) throw new AppError('conflict', SAVINGS_MESSAGES.loadAccountsFirst);
    const onItem = new Map(tx.select().from(savingsAccounts).where(and(eq(savingsAccounts.plaidItemId, itemId), isNull(savingsAccounts.removedAt))).all().map((r) => [r.plaidAccountId, r]));
    const listed = new Map(listedAccounts(item).map((a) => [a.accountId, a]));

    for (const c of choices) {
      const a = listed.get(c.accountId);
      if (!a) throw new AppError('not_found', SAVINGS_MESSAGES.accountNotListed);
      if (onItem.has(c.accountId)) throw new AppError('conflict', SAVINGS_MESSAGES.accountDecided);
      if (c.action === 'show' && accountKindOf(a.type) === null) throw new AppError('validation', SAVINGS_MESSAGES.notShowable);
    }
    const chosen = new Set(choices.map((c) => c.accountId));
    const waiting = [...listed.values()].filter((a) => !onItem.has(a.accountId) && a.skipped !== true);
    if (waiting.some((a) => !chosen.has(a.accountId))) throw new AppError('validation', SAVINGS_MESSAGES.decideEvery);
    for (const c of choices) {
      if (c.action !== 'show') continue;
      // Plaid's account ids belong to one Item; one shown from an earlier connection would be its data's key.
      if (tx.select({ id: savingsAccounts.id }).from(savingsAccounts).where(eq(savingsAccounts.plaidAccountId, c.accountId)).get()) {
        throw new AppError('conflict', SAVINGS_MESSAGES.accountIdInUse);
      }
    }

    const now = deps.clock.now();
    const result: PickResult = { first: item.pickedAt === null, shown: 0, skipped: 0, late: 0 };
    const accounts = new Map(item.accounts.map((a) => [a.accountId, a]));
    for (const c of choices) {
      const a = listed.get(c.accountId)!;
      const { skipped: wasSkipped, ...plain } = a;
      if (c.action === 'skip') {
        accounts.set(a.accountId, { ...plain, skipped: true });
        result.skipped++;
        continue;
      }
      accounts.set(a.accountId, plain);
      tx.insert(savingsAccounts).values({
        plaidItemId: itemId, plaidAccountId: a.accountId, nickname: c.nickname, kind: accountKindOf(a.type)!, mask: a.mask, isoCurrencyCode: a.isoCurrencyCode,
        createdAt: now, updatedAt: now,
      }).run();
      result.shown++;
      if (item.pickedAt !== null && wasSkipped === true) result.late++;
    }
    tx.update(plaidItems)
      .set({
        accounts: item.accounts.map((a) => accounts.get(a.accountId)!),
        pickedAt: item.pickedAt ?? now,
        // Decision 9: a cash account shown late needs its Transactions history again (Spend's rule, review C-S-I1).
        fullResyncAt: result.late > 0 ? now : item.fullResyncAt,
        updatedAt: now,
      })
      .where(eq(plaidItems.id, itemId))
      .run();
    return result;
  });
}

/**
 * Saves the pick, then, for the first pick or a newly shown account, runs a sync in the request
 * (reason `pick`, ignoring the backoff). Its failure is recorded on the connection and shown in the
 * view; it doesn't undo the pick. Past the request's deadline it goes on in the background.
 */
export async function pickSavingsAccounts(deps: SavingsSettingsDeps, userId: number, itemId: number, choices: readonly SavingsPickChoice[]): Promise<SavingsSettingsView> {
  requireSavingsItem(deps, itemId);
  const deadline = deps.plaid.requestDeadline();
  let result: PickResult;
  try {
    result = await deps.plaid.underLock(itemId, () => savePick(deps, itemId, choices), { deadline });
  } catch (err) {
    throw plaidAppError(err, 'savings');
  }
  deps.logger.info({ userId, itemId, ...result }, 'savings accounts picked');
  let message: string | null = null;
  if (result.first || result.shown > 0) {
    try {
      const out = await deps.savings.syncItem(itemId, { reason: 'pick', ignoreBackoff: true, deadline });
      if (out.status === 'skipped') deps.logger.info({ itemId, reason: out.reason }, 'savings first sync after the pick skipped');
      if (out.status === 'deferred') {
        deps.savings.syncSoon(itemId);
        message = SAVINGS_MESSAGES.pickDeferred;
      }
    } catch (err) {
      const facts = err instanceof PlaidApiError ? { errorCode: err.errorCode } : { kind: classifyPlaidError(err), ...loggableError(err) };
      deps.logger.warn({ itemId, ...facts }, 'savings sync after the pick failed; the pick is saved');
    }
  }
  return savingsSettingsView(deps, message);
}

/** Rename or hide (decision 10). Local only. */
export function updateSavingsAccount(deps: SavingsViewDeps, accountId: number, patch: SavingsAccountPatch): SavingsSettingsView {
  const row = deps.db.select().from(savingsAccounts).where(eq(savingsAccounts.id, accountId)).get();
  if (!row || row.removedAt !== null) throw new AppError('not_found', SAVINGS_MESSAGES.accountNotFound);
  const now = deps.clock.now();
  deps.db.update(savingsAccounts)
    .set({
      ...(patch.nickname !== undefined ? { nickname: patch.nickname } : {}),
      ...(patch.hidden !== undefined ? { hiddenAt: patch.hidden ? (row.hiddenAt ?? now) : null } : {}),
      updatedAt: now,
    })
    .where(eq(savingsAccounts.id, accountId))
    .run();
  return savingsSettingsView(deps);
}

/** Refresh: a sync now, ignoring the backoff. A failure is the request's error, in plain words. */
export async function refreshSavingsConnection(deps: SavingsSettingsDeps, userId: number, itemId: number): Promise<SavingsSettingsView> {
  requireSavingsItem(deps, itemId);
  let out;
  try {
    out = await deps.savings.syncItem(itemId, { reason: 'refresh', ignoreBackoff: true, deadline: deps.plaid.requestDeadline() });
  } catch (err) {
    throw plaidAppError(err, 'savings');
  }
  if (out.status === 'skipped') {
    switch (out.reason) {
      case 'removed':
        throw new AppError('not_found', PLAID_MESSAGES.notFound);
      case 'not_picked':
        throw new AppError('conflict', SAVINGS_MESSAGES.pickFirst);
      case 'needs_reconnect': {
        const view = savingsSettingsView(deps).connections.find((c) => c.id === itemId);
        throw new AppError('integration_unavailable', view?.fix === 'remove' ? (view.lastError ?? PLAID_MESSAGES.gone) : SAVINGS_MESSAGES.reconnect);
      }
      default:
        throw new AppError('integration_unavailable', PLAID_MESSAGES.busy);
    }
  }
  if (out.status === 'deferred') {
    deps.savings.syncSoon(itemId);
    deps.logger.info({ userId, itemId }, 'savings refresh deferred');
    return savingsSettingsView(deps, SAVINGS_MESSAGES.refreshDeferred);
  }
  deps.logger.info({ userId, itemId, snapshots: out.counts.snapshots, flowsAdded: out.counts.flowsAdded }, 'savings connection refreshed');
  return savingsSettingsView(deps);
}

/** Load accounts: `/item/get` and `/accounts/get` again; a new account waits for the pick. */
export async function loadSavingsAccounts(deps: SavingsSettingsDeps, userId: number, itemId: number): Promise<SavingsSettingsView> {
  requireSavingsItem(deps, itemId);
  try {
    await deps.plaid.loadAccounts(userId, itemId, { deadline: deps.plaid.requestDeadline() });
  } catch (err) {
    throw plaidAppError(err, 'savings');
  }
  return savingsSettingsView(deps);
}

/** Remove (decision 14): Spend's removal; `deleteData` deletes the accounts with their balances and flows. */
export async function removeSavingsConnection(deps: SavingsSettingsDeps, userId: number, itemId: number, opts: { deleteData: boolean }): Promise<SavingsSettingsView> {
  requireSavingsItem(deps, itemId);
  let revocation;
  try {
    ({ revocation } = await deps.plaid.remove(userId, itemId, { deleteTransactions: opts.deleteData, deadline: deps.plaid.requestDeadline() }));
  } catch (err) {
    throw plaidAppError(err, 'savings');
  }
  const message = revocation === 'waiting' ? BANK_MESSAGES.removeUnconfirmed : revocation === 'not_asked' ? BANK_MESSAGES.removeNotAsked : null;
  return savingsSettingsView(deps, message);
}
