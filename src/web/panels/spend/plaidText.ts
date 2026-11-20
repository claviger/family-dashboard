import { BANK_MESSAGES, pfcLabel, type BankAccountView, type BankPickChoice, type BankView, type BanksView, type RemovedBankView } from '../../../shared/plaid.js';
import { BANK_STALE_AFTER_MS, type BankFreshness, type CardOption, type CategoryRef } from '../../../shared/spend.js';
import { formatAgo, isStale } from '../../freshness.js';
import { cardName, instantDate, updatedLine } from './format.js';

/**
 * Text and small decisions for Spend's banks and the Plaid category mapping (spec §12.2, §12.7,
 * the design's departures 2, 3, 9 and 11). Pure, so it's unit-tested (plaidText.test.ts) and
 * type-checked with the server code.
 */

/** The Link page. Always a full page load (it runs under its own CSP), never a router link. */
export const CONNECT_BANK_PATH = '/connect/plaid/link';

/** Reconnect: Link in update mode for this bank. */
export function reconnectHref(itemId: number): string {
  return `${CONNECT_BANK_PATH}?item=${itemId}`;
}

/** Add accounts: update mode with Account Select, after Plaid says the login has new accounts. */
export function addAccountsHref(itemId: number): string {
  return `${CONNECT_BANK_PATH}?item=${itemId}&accounts=1`;
}

/** A bank as people read it. Plaid nearly always names the institution; when it didn't, "Bank". */
export function bankName(bank: { institutionName: string | null }): string {
  return bank.institutionName?.trim() || 'Bank';
}

/** An account as the pick and the bank list show it: "Plaid Gold Card ·1234". */
export function accountLabel(a: Pick<BankAccountView, 'name' | 'mask'>): string {
  return cardName({ nickname: a.name, mask: a.mask });
}

/**
 * The Trial count (departure 3): shown, never enforced here. At the limit it warns that another
 * link will fail while the install is still on the Trial; Plaid's own refusal is the real stop.
 * `removed` names what was removed: Spend's banks, or Savings' connections.
 */
export function trialLines(trial: BanksView['trial'], removed: 'banks' | 'connections' = 'banks'): { used: string; warning: string | null } {
  const used = `${trial.used} of ${trial.limit} Plaid Trial connections used. Removed ${removed} still count.`;
  const warning = trial.used >= trial.limit ? `Plaid's Trial allows ${trial.limit}. If you're still on the Trial, linking another will fail.` : null;
  return { used, warning };
}

/** One line about where a bank stands, by the server's clock. */
export function bankStatusLine(bank: Pick<BankView, 'status' | 'needsPick' | 'lastSyncAt'>, now: number): string {
  const synced = bank.lastSyncAt ? `last synced ${formatAgo(bank.lastSyncAt, now)}` : 'not synced yet';
  if (bank.status === 'needs_reconnect') return `Needs reconnecting, ${synced}`;
  if (bank.status === 'error') return `Sync failing, ${synced}`;
  if (bank.needsPick && bank.lastSyncAt === null) return 'Waiting for you to choose cards';
  return bank.lastSyncAt ? `Synced ${formatAgo(bank.lastSyncAt, now)}` : 'Not synced yet';
}

/** A Plaid date-time (consent end, PENDING_DISCONNECT) as a date on the family's calendar, or null if it doesn't read as one. */
export function plaidDate(iso: string | null, timeZone: string): string | null {
  if (iso === null || Number.isNaN(Date.parse(iso))) return null;
  return instantDate(iso, timeZone);
}

/**
 * The cards the pick offers an account, and the groups it shows them in: first the bank's own
 * missing cards (a card whose account the bank stopped sharing: when the bank gives that account a
 * new id, attaching the new one to its old card repairs it), then every attachable card.
 */
export function pickTargets(bank: Pick<BankView, 'missingCards'>, attachable: readonly CardOption[]): { missing: CardOption[]; existing: CardOption[] } {
  const missing = [...bank.missingCards];
  const ids = new Set(missing.map((c) => c.id));
  return { missing, existing: attachable.filter((c) => !ids.has(c.id)) };
}

/**
 * The notice for a card the bank didn't share when it was last reconnected or loaded. When an
 * account waits for a card, it can be put on this one: that's how an account whose id the bank
 * changed is repaired.
 */
export function missingCardLine(name: string, card: CardOption, canPick: boolean): string {
  const base = `${name} didn't share ${cardName(card)} when it was last reconnected. The card keeps its history.`;
  return canPick ? `${base} If the bank gave its account a new number, choose this card for it in Choose cards.` : base;
}

/** A bank whose account list couldn't be fetched after linking: the pick waits for Load accounts. */
export function notLoadedLine(name: string): string {
  return `The dashboard couldn't get the list of accounts from ${name} yet. Load them, then choose cards.`;
}

/**
 * When the login has accounts the dashboard doesn't know (Plaid said so, or a sync saw one): Load
 * accounts picks up what the login already shares (an account whose id changed, say); Add
 * accounts opens Plaid to share more.
 */
export function newAccountsLine(name: string): string {
  return `${name} has accounts the dashboard doesn't have yet. Load accounts picks up the ones it already shares, and Add accounts opens Plaid to share more.`;
}

/** Access was turned off at the bank (USER_PERMISSION_REVOKED): either fix works, so both are offered. */
export function revokedLine(name: string): string {
  return `Access to ${name} was turned off at the bank. Reconnect to turn it back on, or remove the bank and connect it again.`;
}

/** The status line after Load accounts: whether anything now waits for a card. */
export function loadedLine(name: string, waiting: number): string {
  if (waiting === 0) return `Loaded the accounts from ${name}. Nothing new needs a card.`;
  return `Loaded the accounts from ${name}. Choose a card for ${waiting === 1 ? 'the new account' : `the ${waiting} new accounts`}.`;
}

/** What a bank change is, for the lines about it: which one, on which bank (by name), and for the pick, what was sent. */
export type BankChange =
  | { kind: 'pick'; bankId: number; name: string; choices: readonly BankPickChoice[] }
  | { kind: 'refresh' | 'load' | 'remove'; bankId: number; name: string };

/**
 * The status line as a bank change starts (review G4-I2). Each can take a while: the pick and
 * Refresh sync, Remove waits for Plaid, and Load accounts asks Plaid twice.
 */
export function progressLine(v: Pick<BankChange, 'kind' | 'name'>): string {
  switch (v.kind) {
    case 'pick':
      return `Saving the cards for ${v.name} and syncing…`;
    case 'refresh':
      return `Refreshing ${v.name}…`;
    case 'remove':
      return `Removing ${v.name}…`;
    case 'load':
      return `Loading the accounts for ${v.name}…`;
  }
}

/** The Remove dialog's own line while Remove is out, when it can't be cancelled (review G4-C1). */
export function removingLine(name: string): string {
  return `Removing ${name}. This can take up to a minute while Plaid confirms.`;
}

/** Removed here, with the server's line about Plaid not having confirmed it (review G4-I4). */
export function removedUnconfirmedLine(name: string, deleteTransactions: boolean, message: string): string {
  const kept = deleteTransactions ? 'Its transactions from the bank were deleted, and any rows they had replaced are back.' : 'Its cards keep their transactions.';
  return `Removed ${name} here. ${kept} ${message}`;
}

export const NO_ANSWER = "The server didn't answer in time.";

/** A removed bank whose removal Plaid hasn't confirmed yet (review C-W-I2): in its Removed banks row, and after an unanswered Remove. */
export const revocationWaitingLine = "Plaid hasn't confirmed it ended access yet. The dashboard retries every hour.";

/** How long after an unanswered change that doesn't show yet the page looks once more (review C-M1). */
export const RECHECK_AFTER_MS = 45_000;

/** Whether one choice the pick sent shows in the bank now: attached to that card, attached (a new card), or skipped. */
function choiceShows(bank: BankView, c: BankPickChoice): boolean {
  const a = bank.accounts.find((x) => x.accountId === c.accountId);
  if (!a) return false;
  if (c.action === 'skip') return a.state === 'skipped';
  if (c.action === 'create') return a.state === 'attached';
  return a.state === 'attached' && a.card?.id === c.cardId;
}

/**
 * A bank change whose answer never came (review G4-I1: no connection, or a gateway's 502, 503 or
 * 504 that isn't the app's own answer): it may or may not have happened, so the page fetches the
 * bank list again and says what that shows. `done` when the list shows the change made (or the
 * bank gone), so the page treats it as a success. The pick is judged by what was sent (review
 * C-W-I1): each choice must show, so attaching an account that was skipped isn't taken as saved
 * while it still shows as skipped. Otherwise the change may still be finishing: the line says to
 * check again in a minute before trying again, and the page looks once more by itself after
 * RECHECK_AFTER_MS (review C-M1); that second look (`final`) says to try again. After a Remove, a
 * bank Plaid hasn't confirmed ending (review C-W-I2) says so. `before` is the bank as the page
 * showed it when the change was sent; `after` the list now, or null when it couldn't be fetched.
 */
export function unknownOutcome(v: BankChange, before: BankView | undefined, after: BanksView | null, opts: { final?: boolean } = {}): { done: boolean; message: string } {
  if (after === null) {
    return { done: false, message: "The server didn't answer in time, and the bank list couldn't be loaded to check what changed. Reload the page." };
  }
  const bank = after.banks.find((b) => b.id === v.bankId);
  const say = (done: boolean, line: string) => ({ done, message: `${NO_ANSWER} ${line}` });
  const notYet = (line: string, finalLine: string) => say(false, opts.final ? finalLine : `${line} Check again in a minute before trying again.`);
  if (v.kind === 'remove') {
    if (bank) return notYet(`${v.name} doesn't show as removed yet.`, `${v.name} still shows as connected. Try again.`);
    const waiting = after.removed.find((r) => r.id === v.bankId)?.revocation === 'waiting';
    return say(true, `${v.name} now shows as removed.${waiting ? ` ${revocationWaitingLine}` : ''}`);
  }
  if (!bank) return say(true, `${v.name} isn't connected anymore.`);
  switch (v.kind) {
    case 'pick':
      return bank.picked && v.choices.every((c) => choiceShows(bank, c))
        ? say(true, `The cards for ${v.name} now show as saved.`)
        : notYet(`The cards for ${v.name} don't show as saved yet.`, `${v.name} still needs its cards chosen. Try again.`);
    case 'refresh':
      return bank.lastSyncAt !== null && bank.lastSyncAt !== (before?.lastSyncAt ?? null)
        ? say(true, `${v.name} has synced since you pressed Refresh.`)
        : notYet(`${v.name} doesn't show a newer sync yet.`, `${v.name} doesn't show a newer sync yet. Try again.`);
    case 'load': {
      const loaded = before && before.accountsLoaded
        ? bank.newAccountsAt !== before.newAccountsAt || bank.accounts.length !== before.accounts.length
        : bank.accountsLoaded;
      return loaded
        ? say(true, `The accounts from ${v.name} now show as loaded.`)
        : notYet(`The accounts from ${v.name} don't show as loaded yet.`, `The accounts from ${v.name} don't show as loaded yet. Try again.`);
    }
  }
}

/** How often, and for how long, the bank list is fetched again while a sync runs out of sight (review G4-M5). */
export const BANK_POLL_MS = 5_000;
export const BANK_POLL_FOR_MS = 120_000;

/** A picked bank that has never synced: its first sync is running, or failed and is waiting to be tried again. */
export function wantsPoll(view: BanksView | undefined): boolean {
  return view?.banks.some((b) => b.picked && b.lastSyncAt === null) ?? false;
}

/** `refetchInterval` for the bank list: every 5 seconds for 2 minutes from `since`, then not at all. */
export function bankPollInterval(since: number | null, now: number): number | false {
  return since !== null && now - since < BANK_POLL_FOR_MS ? BANK_POLL_MS : false;
}

/** A pick or Refresh whose sync ran past the request's deadline: the server's own line ("Saved. Syncing in the background."), with the bank. */
export function deferredLine(name: string, message: string): string {
  return `${name}: ${message}`;
}

/**
 * The Remove dialog's hint for "Also delete its transactions" (decision 9, departure 9): only the
 * bank's own rows go, and the rows they had replaced (CSV rows, or an earlier connection's) come
 * back with what was set by hand. CSV rows from an import that was undone stay gone.
 */
export function removeHint(name: string): string {
  return `Only the transactions that came from ${name} are deleted. Rows they had replaced, from CSV files or an earlier connection to the bank, come back, with any category, person or note set by hand. Rows from a CSV import that was undone don't come back.`;
}

/** The status line after Remove. */
export function removedLine(name: string, deleteTransactions: boolean): string {
  return deleteTransactions
    ? `Removed ${name}. Its transactions from the bank were deleted, and any rows they had replaced are back.`
    : `Removed ${name}. Its cards keep their transactions.`;
}

/** A removed bank in the list, by how it was removed: kept transactions, deleted them, or a key reset (spec §14). */
export function removedBankLines(r: Pick<RemovedBankView, 'reason' | 'removedAt' | 'cards'>, timeZone: string): { when: string; cards: string | null } {
  const date = instantDate(r.removedAt, timeZone);
  const names = r.cards.map(cardName).join(', ');
  if (r.reason === 'removed_with_transactions') {
    return { when: `Removed ${date}, with its transactions`, cards: r.cards.length > 0 ? `Its cards stay, without the bank's transactions: ${names}.` : null };
  }
  return {
    when: r.reason === 'key_reset' ? `Disconnected by the key reset ${date}` : `Removed ${date}`,
    cards: r.cards.length > 0 ? `Its cards keep their history: ${names}.` : null,
  };
}

/** The accounts the pick shows: every one not on a card. Skipped ones can be attached later (departure 2). */
export function pickableAccounts(bank: Pick<BankView, 'accounts'>): BankAccountView[] {
  return bank.accounts.filter((a) => a.state !== 'attached');
}

/** A pick select's value: undecided, a new card, skip, or an existing card. */
export type PickValue = '' | 'create' | 'skip' | `card:${number}`;

/**
 * Where the pick starts: a skipped account stays skipped; a waiting one gets the card the server
 * suggests by its last 4 (one of `cards`, the pick's choices: the bank's missing cards and the
 * attachable ones), unless an earlier account already took that card, and is undecided otherwise,
 * so nothing is attached without the admin seeing it.
 */
export function initialPick(accounts: readonly BankAccountView[], cards: readonly CardOption[]): Record<string, PickValue> {
  const taken = new Set<number>();
  const out: Record<string, PickValue> = {};
  for (const a of accounts) {
    if (a.state === 'skipped') out[a.accountId] = 'skip';
    else if (a.suggestedCardId !== null && !taken.has(a.suggestedCardId) && cards.some((c) => c.id === a.suggestedCardId)) {
      taken.add(a.suggestedCardId);
      out[a.accountId] = `card:${a.suggestedCardId}`;
    } else out[a.accountId] = '';
  }
  return out;
}

/**
 * The pick as the server takes it, checked here first (the server checks again): every account
 * decided, and no card picked twice. A problem names the account, so its select gets the focus.
 */
export function pickChoices(
  accounts: readonly BankAccountView[],
  values: Readonly<Record<string, PickValue | undefined>>,
): { ok: true; choices: BankPickChoice[] } | { ok: false; accountId: string; message: string } {
  const choices: BankPickChoice[] = [];
  const cards = new Set<number>();
  for (const a of accounts) {
    const v = values[a.accountId] ?? '';
    if (v === '') return { ok: false, accountId: a.accountId, message: BANK_MESSAGES.decideEvery };
    if (v === 'create' || v === 'skip') {
      choices.push(v === 'create' ? { accountId: a.accountId, action: 'create' } : { accountId: a.accountId, action: 'skip' });
      continue;
    }
    const cardId = Number(v.slice('card:'.length));
    if (cards.has(cardId)) return { ok: false, accountId: a.accountId, message: BANK_MESSAGES.cardTwice };
    cards.add(cardId);
    choices.push({ accountId: a.accountId, action: 'attach', cardId });
  }
  return { ok: true, choices };
}

/** After a pick whose sync didn't finish (it failed; the bank row says why): the scheduled syncs try it again (review C-M8). */
export const SYNC_UNFINISHED_LINE = "The bank's sync didn't finish, so the dashboard will try it again.";

/**
 * Whether the pick's sync didn't finish: one ran (the first pick, or a card attached or made) and
 * the bank's last sync didn't move. `before` is the bank as shown when the pick was sent.
 */
export function pickSyncUnfinished(before: Pick<BankView, 'picked' | 'lastSyncAt'> | undefined, after: Pick<BankView, 'lastSyncAt'> | undefined, choices: readonly BankPickChoice[]): boolean {
  if (!after) return false;
  const synced = !before?.picked || choices.some((c) => c.action !== 'skip');
  return synced && after.lastSyncAt === (before?.lastSyncAt ?? null);
}

/** "Saved the cards for Plaid Bank: 1 attached, 1 new card, 1 skipped." */
export function pickSavedLine(name: string, choices: readonly BankPickChoice[], opts: { syncUnfinished?: boolean } = {}): string {
  const n = (action: BankPickChoice['action']) => choices.filter((c) => c.action === action).length;
  const parts = [
    n('attach') > 0 ? `${n('attach')} attached` : null,
    n('create') > 0 ? `${n('create')} ${n('create') === 1 ? 'new card' : 'new cards'}` : null,
    n('skip') > 0 ? `${n('skip')} skipped` : null,
  ].filter(Boolean);
  return `Saved the cards for ${name}${parts.length > 0 ? `: ${parts.join(', ')}` : ''}.${opts.syncUnfinished ? ` ${SYNC_UNFINISHED_LINE}` : ''}`;
}

/**
 * A card's freshness on the home card and the drill-down (the design's "Freshness"). A card with
 * no bank says when it was last imported, as before. A linked card says when its data last
 * changed, warns once that's more than 12 hours old (twice the 6-hour sync, spec §8), and says when
 * its bank needs reconnecting, which an admin fixes with Reconnect.
 */
export function cardFreshness(updatedAt: string | null, bank: BankFreshness | null, now: number): { updated: string; stale: string | null; reconnect: string | null } {
  if (!bank) return { updated: updatedLine(updatedAt, now), stale: null, reconnect: null };
  const name = bankName(bank);
  const reconnect = bank.status === 'needs_reconnect' ? `${name} needs to be reconnected, so this card isn't updating.` : null;
  // The server's flag is as of its answer; the clock here keeps ticking on a page left open.
  const old = bank.stale || isStale(updatedAt, now, BANK_STALE_AFTER_MS);
  const hours = Math.round(BANK_STALE_AFTER_MS / 3_600_000);
  return {
    updated: updatedAt ? `Updated ${formatAgo(updatedAt, now)}` : 'Not synced yet',
    stale: old && !reconnect ? `${name} hasn't synced in over ${hours} hours, so this may be out of date.` : null,
    reconnect,
  };
}

/** A Plaid category code as people read it (shared with the server, which names codes in its refusals). */
export { pfcLabel };

/** A category in the mapping's select: its name, and "(archived)" for one that's skipped until it's changed (spec §12.7). */
export function categoryOptionLabel(c: Pick<CategoryRef, 'name' | 'archived'>): string {
  return `${c.name}${c.archived ? ' (archived)' : ''}`;
}

/**
 * A mapping row's details (review G4-M8): the code as Plaid writes it, whether it's a main
 * (primary) or a detailed category, the taxonomy version when known, and how many transactions
 * carry it.
 */
export function codeDetails(r: { code: string; kind: 'primary' | 'detailed'; taxonomyVersion: string | null; transactionCount: number }): string {
  return [r.code, r.kind === 'primary' ? 'main category' : 'detailed category', r.taxonomyVersion ? `taxonomy ${r.taxonomyVersion}` : null, transactionCountLine(r.transactionCount)]
    .filter(Boolean)
    .join(' · ');
}

/** "12 transactions", "1 transaction", "No transactions yet". */
export function transactionCountLine(n: number): string {
  if (n === 0) return 'No transactions yet';
  return `${n} ${n === 1 ? 'transaction' : 'transactions'}`;
}

/**
 * Connect bank while a bank's account list never loaded (review C-S-M3): the duplicate check
 * compares the accounts Link returns with each bank's, so it can't see a second link of that
 * login, which would spend a Trial connection. Said once; pressing Connect bank again goes on.
 */
export function connectWarningLine(names: readonly string[]): string {
  const which = names.length <= 1 ? (names[0] ?? 'that bank') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `Load the accounts for ${which} first, so the dashboard can tell if you're linking the same login twice. To connect a bank anyway, press Connect bank again.`;
}

/**
 * A click that opens a link somewhere else (a new tab or window, or a download) rather than leaving
 * this page: Ctrl, Cmd, Shift or Alt held, or not the main button (review C-M4).
 */
export function opensElsewhere(e: { button: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }): boolean {
  return e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey;
}
