import { describe, expect, it } from 'vitest';
import { BANK_MESSAGES, type BankAccountView, type BankView } from '../../../shared/plaid.js';
import type { BankFreshness, CardOption } from '../../../shared/spend.js';
import {
  accountLabel, addAccountsHref, bankName, bankStatusLine, cardFreshness, categoryOptionLabel, CONNECT_BANK_PATH, deferredLine, initialPick, loadedLine,
  missingCardLine, newAccountsLine, notLoadedLine, pfcLabel, pickableAccounts, pickChoices, pickSavedLine, pickSyncUnfinished, pickTargets, plaidDate, reconnectHref,
  removedBankLines, removedLine, removeHint, revokedLine, transactionCountLine, trialLines, progressLine, removingLine, removedUnconfirmedLine, unknownOutcome,
  NO_ANSWER, wantsPoll, bankPollInterval, BANK_POLL_MS, BANK_POLL_FOR_MS, codeDetails, revocationWaitingLine, connectWarningLine, opensElsewhere,
} from './plaidText.js';
import type { BanksView, RemovedBankView } from '../../../shared/plaid.js';

// Synthetic banks, accounts and cards, made up for these tests.
const NOW = Date.parse('2026-11-16T12:00:00Z');

const account = (accountId: string, patch: Partial<BankAccountView> = {}): BankAccountView => ({
  accountId, name: 'Test Rewards Card', officialName: null, mask: '1111', subtype: 'credit card', state: 'waiting', card: null, suggestedCardId: null, ...patch,
});
const card = (id: number, mask: string | null = null): CardOption => ({ id, nickname: `Card ${id}`, mask, archived: false });

describe('links to the Link page', () => {
  it('are plain paths: connect, reconnect in update mode, and add accounts', () => {
    expect(CONNECT_BANK_PATH).toBe('/connect/plaid/link');
    expect(reconnectHref(7)).toBe('/connect/plaid/link?item=7');
    expect(addAccountsHref(7)).toBe('/connect/plaid/link?item=7&accounts=1');
  });
});

describe('names', () => {
  it('names a bank, or says Bank when Plaid gave no name', () => {
    expect(bankName({ institutionName: 'First Test Bank' })).toBe('First Test Bank');
    expect(bankName({ institutionName: null })).toBe('Bank');
    expect(bankName({ institutionName: '  ' })).toBe('Bank');
  });

  it('labels an account with its last 4 when it has one', () => {
    expect(accountLabel({ name: 'Test Rewards Card', mask: '1111' })).toBe('Test Rewards Card ·1111');
    expect(accountLabel({ name: 'Test Rewards Card', mask: null })).toBe('Test Rewards Card');
  });
});

describe('trialLines', () => {
  it('shows the count, removed banks included, and warns only at the limit, never refusing', () => {
    expect(trialLines({ used: 3, limit: 10 })).toEqual({ used: '3 of 10 Plaid Trial connections used. Removed banks still count.', warning: null });
    expect(trialLines({ used: 10, limit: 10 }).warning).toBe("Plaid's Trial allows 10. If you're still on the Trial, linking another will fail.");
    expect(trialLines({ used: 12, limit: 10 }).warning).not.toBeNull();
  });

  it('says "connections" rather than "banks" for Savings', () => {
    expect(trialLines({ used: 3, limit: 10 }, 'connections').used).toBe('3 of 10 Plaid Trial connections used. Removed connections still count.');
  });
});

describe('bankStatusLine', () => {
  const ok = { status: 'ok' as const, needsPick: false, lastSyncAt: '2026-11-16T11:55:00Z' };

  it('says when it last synced, by the clock given', () => {
    expect(bankStatusLine(ok, NOW)).toBe('Synced 5 minutes ago');
    expect(bankStatusLine({ ...ok, lastSyncAt: null }, NOW)).toBe('Not synced yet');
  });

  it('says a new bank waits for the pick', () => {
    expect(bankStatusLine({ ...ok, needsPick: true, lastSyncAt: null }, NOW)).toBe('Waiting for you to choose cards');
  });

  it('puts a reconnect or a failing sync first', () => {
    expect(bankStatusLine({ ...ok, status: 'needs_reconnect' }, NOW)).toBe('Needs reconnecting, last synced 5 minutes ago');
    expect(bankStatusLine({ ...ok, status: 'error', lastSyncAt: null }, NOW)).toBe('Sync failing, not synced yet');
  });
});

describe('plaidDate', () => {
  it("dates Plaid's date-times on the family's calendar, and drops what doesn't read as one", () => {
    expect(plaidDate('2027-10-01T03:00:00Z', 'America/Los_Angeles')).toBe('Sep 30, 2027');
    expect(plaidDate(null, 'UTC')).toBeNull();
    expect(plaidDate('soon', 'UTC')).toBeNull();
  });
});

describe('the pick', () => {
  const bank: Pick<BankView, 'accounts'> = {
    accounts: [
      account('a1', { state: 'attached', card: card(1, '1111') }),
      account('a2', { mask: '2222', suggestedCardId: 2 }),
      account('a3', { mask: '3333', state: 'skipped' }),
      account('a4', { mask: '4444' }),
    ],
  };

  it('offers every account not on a card, skipped ones included', () => {
    expect(pickableAccounts(bank).map((a) => a.accountId)).toEqual(['a2', 'a3', 'a4']);
  });

  it('starts from the suggested card, keeps skipped ones skipped, and leaves the rest undecided', () => {
    expect(initialPick(pickableAccounts(bank), [card(2, '2222'), card(3)])).toEqual({ a2: 'card:2', a3: 'skip', a4: '' });
  });

  it("doesn't suggest a card that isn't attachable, or one an earlier account already took", () => {
    expect(initialPick([account('a2', { suggestedCardId: 2 })], [card(3)])).toEqual({ a2: '' });
    expect(initialPick([account('x', { suggestedCardId: 2 }), account('y', { suggestedCardId: 2 })], [card(2)])).toEqual({ x: 'card:2', y: '' });
  });

  it('turns the selects into the request: attach, create, or skip', () => {
    const accounts = pickableAccounts(bank);
    expect(pickChoices(accounts, { a2: 'card:2', a3: 'skip', a4: 'create' })).toEqual({
      ok: true,
      choices: [
        { accountId: 'a2', action: 'attach', cardId: 2 },
        { accountId: 'a3', action: 'skip' },
        { accountId: 'a4', action: 'create' },
      ],
    });
  });

  it('refuses an undecided account, or a card picked twice, naming the account to focus', () => {
    const accounts = pickableAccounts(bank);
    expect(pickChoices(accounts, { a2: 'card:2', a3: 'skip' })).toEqual({ ok: false, accountId: 'a4', message: BANK_MESSAGES.decideEvery });
    expect(pickChoices(accounts, { a2: 'card:2', a3: 'skip', a4: '' })).toMatchObject({ ok: false, accountId: 'a4' });
    expect(pickChoices(accounts, { a2: 'card:2', a3: 'skip', a4: 'card:2' })).toEqual({ ok: false, accountId: 'a4', message: BANK_MESSAGES.cardTwice });
  });

  it('says what was saved', () => {
    expect(pickSavedLine('First Test Bank', [
      { accountId: 'a', action: 'attach', cardId: 1 },
      { accountId: 'b', action: 'create' },
      { accountId: 'c', action: 'create' },
      { accountId: 'd', action: 'skip' },
    ])).toBe('Saved the cards for First Test Bank: 1 attached, 2 new cards, 1 skipped.');
    expect(pickSavedLine('First Test Bank', [{ accountId: 'b', action: 'create' }])).toBe('Saved the cards for First Test Bank: 1 new card.');
  });

  it("says when the pick's sync didn't finish, so it'll be tried again (review C-M8)", () => {
    expect(pickSavedLine('First Test Bank', [{ accountId: 'b', action: 'create' }], { syncUnfinished: true })).toBe(
      "Saved the cards for First Test Bank: 1 new card. The bank's sync didn't finish, so the dashboard will try it again.",
    );
    const create = [{ accountId: 'b', action: 'create' as const }];
    const skip = [{ accountId: 'b', action: 'skip' as const }];
    // The first pick: no sync yet, before or after.
    expect(pickSyncUnfinished({ picked: false, lastSyncAt: null }, { lastSyncAt: null }, skip)).toBe(true);
    expect(pickSyncUnfinished({ picked: false, lastSyncAt: null }, { lastSyncAt: '2026-11-16T12:00:00Z' }, skip)).toBe(false);
    // A later pick that attaches syncs; one that only skips doesn't.
    expect(pickSyncUnfinished({ picked: true, lastSyncAt: '2026-11-16T10:00:00Z' }, { lastSyncAt: '2026-11-16T10:00:00Z' }, create)).toBe(true);
    expect(pickSyncUnfinished({ picked: true, lastSyncAt: '2026-11-16T10:00:00Z' }, { lastSyncAt: '2026-11-16T10:00:00Z' }, skip)).toBe(false);
    expect(pickSyncUnfinished({ picked: true, lastSyncAt: '2026-11-16T10:00:00Z' }, undefined, create)).toBe(false);
  });
});

describe("a bank's cards that it stopped sharing", () => {
  it('are offered first in the pick, then the attachable cards, each once', () => {
    const missing = card(5, '5555');
    expect(pickTargets({ missingCards: [missing] }, [card(2), missing, card(3)])).toEqual({ missing: [missing], existing: [card(2), card(3)] });
    expect(pickTargets({ missingCards: [] }, [card(2)])).toEqual({ missing: [], existing: [card(2)] });
  });

  it("start the pick on the bank's own card when the server suggests it (an account whose id changed)", () => {
    const moved = account('new-id', { mask: '5555', suggestedCardId: 5 });
    const { missing, existing } = pickTargets({ missingCards: [card(5, '5555')] }, [card(2)]);
    expect(initialPick([moved], [...missing, ...existing])).toEqual({ 'new-id': 'card:5' });
    expect(pickChoices([moved], { 'new-id': 'card:5' })).toEqual({ ok: true, choices: [{ accountId: 'new-id', action: 'attach', cardId: 5 }] });
  });

  it('say so, and say how to repair one when an account waits for a card', () => {
    expect(missingCardLine('First Test Bank', card(5, '5555'), false)).toBe("First Test Bank didn't share Card 5 ·5555 when it was last reconnected. The card keeps its history.");
    expect(missingCardLine('First Test Bank', card(5, '5555'), true)).toBe(
      "First Test Bank didn't share Card 5 ·5555 when it was last reconnected. The card keeps its history. If the bank gave its account a new number, choose this card for it in Choose cards.",
    );
  });
});

describe('notices and status lines', () => {
  it('asks for Load accounts when the accounts never came, and offers both fixes for new accounts', () => {
    expect(notLoadedLine('First Test Bank')).toBe("The dashboard couldn't get the list of accounts from First Test Bank yet. Load them, then choose cards.");
    expect(newAccountsLine('First Test Bank')).toBe(
      "First Test Bank has accounts the dashboard doesn't have yet. Load accounts picks up the ones it already shares, and Add accounts opens Plaid to share more.",
    );
  });

  it('says what Load accounts found', () => {
    expect(loadedLine('First Test Bank', 0)).toBe('Loaded the accounts from First Test Bank. Nothing new needs a card.');
    expect(loadedLine('First Test Bank', 1)).toBe('Loaded the accounts from First Test Bank. Choose a card for the new account.');
    expect(loadedLine('First Test Bank', 3)).toBe('Loaded the accounts from First Test Bank. Choose a card for the 3 new accounts.');
  });

  it("offers both fixes when access was turned off at the bank, and shows the server's line for a sync left to the background", () => {
    expect(revokedLine('First Test Bank')).toBe('Access to First Test Bank was turned off at the bank. Reconnect to turn it back on, or remove the bank and connect it again.');
    expect(deferredLine('First Test Bank', BANK_MESSAGES.pickDeferred)).toBe('First Test Bank: Saved. Syncing in the background.');
    expect(deferredLine('First Test Bank', BANK_MESSAGES.refreshDeferred)).toBe('First Test Bank: Syncing in the background.');
  });
});

describe('a bank change while it runs (review G4-I2, G4-C1)', () => {
  it('says what is happening as each request starts', () => {
    expect(progressLine({ kind: 'pick', name: 'First Test Bank' })).toBe('Saving the cards for First Test Bank and syncing…');
    expect(progressLine({ kind: 'refresh', name: 'First Test Bank' })).toBe('Refreshing First Test Bank…');
    expect(progressLine({ kind: 'remove', name: 'First Test Bank' })).toBe('Removing First Test Bank…');
    expect(progressLine({ kind: 'load', name: 'First Test Bank' })).toBe('Loading the accounts for First Test Bank…');
    expect(removingLine('First Test Bank')).toBe('Removing First Test Bank. This can take up to a minute while Plaid confirms.');
  });
});

describe('an answer that never came back (review G4-I1)', () => {
  const bank = (patch: Partial<BankView> = {}): BankView => ({
    id: 4, institutionName: 'First Test Bank', status: 'ok', lastError: null, fix: null, lastSuccessAt: null, lastSyncAt: '2026-11-16T10:00:00Z',
    needsPick: false, picked: true, accountsLoaded: true, accounts: [account('a', { state: 'attached', card: card(1) })], missingCards: [],
    consentExpiresAt: null, disconnectAt: null, newAccountsAt: null, ...patch,
  });
  const view = (...banks: BankView[]): BanksView => ({
    configured: true, keyMismatch: false, serverNow: '2026-11-16T12:00:00Z', trial: { used: 1, limit: 10 }, banks, removed: [], attachableCards: [], notices: [], message: null,
  });
  const name = 'First Test Bank';

  const removedBank = (revocation: RemovedBankView['revocation']): RemovedBankView => ({
    id: 4, institutionName: 'First Test Bank', removedAt: '2026-11-16T11:59:00Z', reason: 'removed', revocation, cards: [],
  });

  it('says what the list shows now after a Remove: removed, or not yet, checking again before trying again (review C-M1)', () => {
    expect(NO_ANSWER).toBe("The server didn't answer in time.");
    expect(unknownOutcome({ kind: 'remove', bankId: 4, name }, bank(), view())).toEqual({ done: true, message: "The server didn't answer in time. First Test Bank now shows as removed." });
    expect(unknownOutcome({ kind: 'remove', bankId: 4, name }, bank(), view(bank()))).toEqual({
      done: false, message: "The server didn't answer in time. First Test Bank doesn't show as removed yet. Check again in a minute before trying again.",
    });
    // The page's own second look, about 45 seconds on.
    expect(unknownOutcome({ kind: 'remove', bankId: 4, name }, bank(), view(bank()), { final: true })).toEqual({
      done: false, message: "The server didn't answer in time. First Test Bank still shows as connected. Try again.",
    });
  });

  it("adds that Plaid hasn't confirmed ending access when the removed bank says it's waiting (review C-W-I2)", () => {
    expect(revocationWaitingLine).toBe("Plaid hasn't confirmed it ended access yet. The dashboard retries every hour.");
    const after = { ...view(), removed: [removedBank('waiting')] };
    expect(unknownOutcome({ kind: 'remove', bankId: 4, name }, bank(), after)).toEqual({
      done: true, message: "The server didn't answer in time. First Test Bank now shows as removed. Plaid hasn't confirmed it ended access yet. The dashboard retries every hour.",
    });
    for (const revocation of ['confirmed', 'not_asked'] as const) {
      expect(unknownOutcome({ kind: 'remove', bankId: 4, name }, bank(), { ...view(), removed: [removedBank(revocation)] }).message).toBe(
        "The server didn't answer in time. First Test Bank now shows as removed.",
      );
    }
  });

  it('after the pick: judged by what was sent, each choice against the bank now (review C-W-I1)', () => {
    const waiting = bank({ needsPick: true, picked: false, lastSyncAt: null, accounts: [account('a')] });
    const created = [{ accountId: 'a', action: 'create' as const }];
    expect(unknownOutcome({ kind: 'pick', bankId: 4, name, choices: created }, waiting, view(bank()))).toEqual({
      done: true, message: "The server didn't answer in time. The cards for First Test Bank now show as saved.",
    });
    expect(unknownOutcome({ kind: 'pick', bankId: 4, name, choices: created }, waiting, view(waiting))).toEqual({
      done: false, message: "The server didn't answer in time. The cards for First Test Bank don't show as saved yet. Check again in a minute before trying again.",
    });
    expect(unknownOutcome({ kind: 'pick', bankId: 4, name, choices: created }, waiting, view(waiting), { final: true }).message).toBe(
      "The server didn't answer in time. First Test Bank still needs its cards chosen. Try again.",
    );
  });

  it('after attaching a skipped account: not saved while it still shows as skipped, though nothing waits (review C-W-I1)', () => {
    const skipped = bank({ accounts: [account('a', { state: 'attached', card: card(1) }), account('b', { state: 'skipped' })] });
    const attach = [{ accountId: 'b', action: 'attach' as const, cardId: 7 }];
    expect(unknownOutcome({ kind: 'pick', bankId: 4, name, choices: attach }, skipped, view(skipped)).done).toBe(false);
    // On another card than the one sent: not this pick.
    const elsewhere = bank({ accounts: [account('a', { state: 'attached', card: card(1) }), account('b', { state: 'attached', card: card(8) })] });
    expect(unknownOutcome({ kind: 'pick', bankId: 4, name, choices: attach }, skipped, view(elsewhere)).done).toBe(false);
    const attached = bank({ accounts: [account('a', { state: 'attached', card: card(1) }), account('b', { state: 'attached', card: card(7) })] });
    expect(unknownOutcome({ kind: 'pick', bankId: 4, name, choices: attach }, skipped, view(attached)).done).toBe(true);
    // A skip is saved once the account shows as skipped; a new card once it's attached.
    const both = [{ accountId: 'b', action: 'skip' as const }, { accountId: 'c', action: 'create' as const }];
    const before = bank({ accounts: [account('b'), account('c')] });
    const savedBoth = bank({ accounts: [account('b', { state: 'skipped' }), account('c', { state: 'attached', card: card(9) })] });
    expect(unknownOutcome({ kind: 'pick', bankId: 4, name, choices: both }, before, view(savedBoth)).done).toBe(true);
    expect(unknownOutcome({ kind: 'pick', bankId: 4, name, choices: both }, before, view(bank({ accounts: [account('b', { state: 'skipped' }), account('c')] }))).done).toBe(false);
  });

  it('after Refresh: a newer sync, or none yet', () => {
    expect(unknownOutcome({ kind: 'refresh', bankId: 4, name }, bank(), view(bank({ lastSyncAt: '2026-11-16T11:59:00Z' })))).toEqual({
      done: true, message: "The server didn't answer in time. First Test Bank has synced since you pressed Refresh.",
    });
    expect(unknownOutcome({ kind: 'refresh', bankId: 4, name }, bank(), view(bank()))).toEqual({
      done: false, message: "The server didn't answer in time. First Test Bank doesn't show a newer sync yet. Check again in a minute before trying again.",
    });
  });

  it('after Load accounts: loaded, or not yet', () => {
    const notLoaded = bank({ accountsLoaded: false, accounts: [], needsPick: true, picked: false, lastSyncAt: null });
    expect(unknownOutcome({ kind: 'load', bankId: 4, name }, notLoaded, view(bank({ needsPick: true, picked: false, accounts: [account('a')] })))).toEqual({
      done: true, message: "The server didn't answer in time. The accounts from First Test Bank now show as loaded.",
    });
    expect(unknownOutcome({ kind: 'load', bankId: 4, name }, notLoaded, view(notLoaded)).done).toBe(false);
    // A load for new accounts: done once the notice goes or an account is added.
    const noticed = bank({ newAccountsAt: '2026-11-16T09:00:00Z' });
    expect(unknownOutcome({ kind: 'load', bankId: 4, name }, noticed, view(bank())).done).toBe(true);
    expect(unknownOutcome({ kind: 'load', bankId: 4, name }, noticed, view(noticed))).toEqual({
      done: false, message: "The server didn't answer in time. The accounts from First Test Bank don't show as loaded yet. Check again in a minute before trying again.",
    });
  });

  it("says a bank that went meanwhile is gone, and when the list itself can't be had, says to reload", () => {
    expect(unknownOutcome({ kind: 'refresh', bankId: 4, name }, bank(), view())).toEqual({ done: true, message: "The server didn't answer in time. First Test Bank isn't connected anymore." });
    expect(unknownOutcome({ kind: 'remove', bankId: 4, name }, bank(), null)).toEqual({
      done: false, message: "The server didn't answer in time, and the bank list couldn't be loaded to check what changed. Reload the page.",
    });
  });
});

describe('polling the bank list (review G4-M5)', () => {
  const v = (banks: Partial<BankView>[]) => ({ banks }) as unknown as BanksView;
  it('is wanted while a picked bank has never synced', () => {
    expect(wantsPoll(undefined)).toBe(false);
    expect(wantsPoll(v([{ picked: true, lastSyncAt: null }]))).toBe(true);
    expect(wantsPoll(v([{ picked: false, lastSyncAt: null }]))).toBe(false);
    expect(wantsPoll(v([{ picked: true, lastSyncAt: '2026-11-16T10:00:00Z' }]))).toBe(false);
  });
  it('polls every 5 seconds for 2 minutes from when it started, then stops', () => {
    expect(BANK_POLL_MS).toBe(5_000);
    expect(BANK_POLL_FOR_MS).toBe(120_000);
    expect(bankPollInterval(null, NOW)).toBe(false);
    expect(bankPollInterval(NOW - 119_000, NOW)).toBe(5_000);
    expect(bankPollInterval(NOW - 120_000, NOW)).toBe(false);
  });
});

describe('removing a bank', () => {
  it("says when Plaid didn't confirm ending its access", () => {
    expect(removedUnconfirmedLine('First Test Bank', false, BANK_MESSAGES.removeUnconfirmed)).toBe(
      "Removed First Test Bank here. Its cards keep their transactions. Plaid didn't confirm it removed its access yet. The dashboard will keep trying every hour.",
    );
    expect(removedUnconfirmedLine('First Test Bank', true, BANK_MESSAGES.removeUnconfirmed)).toBe(
      "Removed First Test Bank here. Its transactions from the bank were deleted, and any rows they had replaced are back. Plaid didn't confirm it removed its access yet. The dashboard will keep trying every hour.",
    );
  });

  it('says that deleting its transactions brings back what they had replaced, except an undone import', () => {
    const hint = removeHint('First Test Bank');
    expect(hint).toContain('Only the transactions that came from First Test Bank are deleted.');
    expect(hint).toContain('Rows they had replaced, from CSV files or an earlier connection to the bank, come back, with any category, person or note set by hand.');
    expect(hint).toContain("Rows from a CSV import that was undone don't come back.");
    expect(removedLine('First Test Bank', true)).toBe('Removed First Test Bank. Its transactions from the bank were deleted, and any rows they had replaced are back.');
    expect(removedLine('First Test Bank', false)).toBe('Removed First Test Bank. Its cards keep their transactions.');
  });

  it("lists a removed bank by how it went, never saying its cards keep the history it deleted", () => {
    const r = { removedAt: '2026-11-16T20:00:00Z', cards: [card(1, '1111'), card(2)] };
    expect(removedBankLines({ ...r, reason: 'removed' }, 'UTC')).toEqual({ when: 'Removed Nov 16, 2026', cards: 'Its cards keep their history: Card 1 ·1111, Card 2.' });
    const deleted = removedBankLines({ ...r, reason: 'removed_with_transactions' }, 'UTC');
    expect(deleted).toEqual({ when: 'Removed Nov 16, 2026, with its transactions', cards: "Its cards stay, without the bank's transactions: Card 1 ·1111, Card 2." });
    expect(deleted.cards).not.toMatch(/history/);
    expect(removedBankLines({ ...r, reason: 'key_reset' }, 'UTC').when).toBe('Disconnected by the key reset Nov 16, 2026');
    expect(removedBankLines({ ...r, cards: [], reason: 'removed_with_transactions' }, 'UTC').cards).toBeNull();
  });
});

describe('cardFreshness', () => {
  const bank: BankFreshness = { itemId: 4, institutionName: 'First Test Bank', status: 'ok', lastSyncAt: '2026-11-16T11:00:00Z', stale: false };

  it('keeps the CSV wording for a card with no bank', () => {
    expect(cardFreshness('2026-11-13T12:00:00Z', null, NOW)).toEqual({ updated: 'Updated 3 days ago', stale: null, reconnect: null });
    expect(cardFreshness(null, null, NOW).updated).toBe('Nothing imported yet');
  });

  it('says when a linked card was updated, or that it has not synced yet', () => {
    expect(cardFreshness('2026-11-16T11:00:00Z', bank, NOW)).toEqual({ updated: 'Updated 1 hour ago', stale: null, reconnect: null });
    expect(cardFreshness(null, bank, NOW).updated).toBe('Not synced yet');
  });

  it("warns once it's more than 12 hours old, by the server's flag or the clock ticking on", () => {
    const warning = "First Test Bank hasn't synced in over 12 hours, so this may be out of date.";
    expect(cardFreshness('2026-11-16T11:00:00Z', { ...bank, stale: true }, NOW).stale).toBe(warning);
    expect(cardFreshness('2026-11-15T23:59:00Z', bank, NOW).stale).toBe(warning);
    expect(cardFreshness('2026-11-16T00:01:00Z', bank, NOW).stale).toBeNull();
  });

  it('says the bank needs reconnecting instead of the stale warning', () => {
    const f = cardFreshness('2026-11-14T12:00:00Z', { ...bank, status: 'needs_reconnect', stale: true }, NOW);
    expect(f.reconnect).toBe("First Test Bank needs to be reconnected, so this card isn't updating.");
    expect(f.stale).toBeNull();
  });
});

describe('the mapping', () => {
  it('reads codes as words, a detailed one under its primary', () => {
    expect(pfcLabel('FOOD_AND_DRINK', null)).toBe('Food and drink');
    expect(pfcLabel('FOOD_AND_DRINK_COFFEE', 'FOOD_AND_DRINK')).toBe('Food and drink: coffee');
    expect(pfcLabel('ODD_CODE', 'OTHER')).toBe('Odd code');
  });

  it('says whether a code is a main or a detailed one, its code, its taxonomy version, and its transactions (G4-M8)', () => {
    expect(codeDetails({ code: 'FOOD_AND_DRINK', kind: 'primary', taxonomyVersion: 'v2', transactionCount: 3 })).toBe('FOOD_AND_DRINK · main category · taxonomy v2 · 3 transactions');
    expect(codeDetails({ code: 'FOOD_AND_DRINK_COFFEE', kind: 'detailed', taxonomyVersion: 'v1', transactionCount: 0 })).toBe('FOOD_AND_DRINK_COFFEE · detailed category · taxonomy v1 · No transactions yet');
    expect(codeDetails({ code: 'ODD_CODE', kind: 'detailed', taxonomyVersion: null, transactionCount: 1 })).toBe('ODD_CODE · detailed category · 1 transaction');
  });

  it('flags an archived category, and counts transactions', () => {
    expect(categoryOptionLabel({ name: 'Dining', archived: false })).toBe('Dining');
    expect(categoryOptionLabel({ name: 'Dining', archived: true })).toBe('Dining (archived)');
    expect(transactionCountLine(0)).toBe('No transactions yet');
    expect(transactionCountLine(1)).toBe('1 transaction');
    expect(transactionCountLine(12)).toBe('12 transactions');
  });
});

describe('copy', () => {
  it('has no em dashes', () => {
    const texts = [
      trialLines({ used: 10, limit: 10 }).used, trialLines({ used: 10, limit: 10 }).warning!,
      cardFreshness(null, { itemId: 1, institutionName: null, status: 'needs_reconnect', lastSyncAt: null, stale: true }, NOW).reconnect!,
      removeHint('Bank'), removedLine('Bank', true), revokedLine('Bank'), newAccountsLine('Bank'), notLoadedLine('Bank'), loadedLine('Bank', 2),
      missingCardLine('Bank', card(1), true), removedBankLines({ removedAt: '2026-11-16T20:00:00Z', cards: [card(1)], reason: 'removed_with_transactions' }, 'UTC').cards!,
      progressLine({ kind: 'pick', name: 'Bank' }), removingLine('Bank'), removedUnconfirmedLine('Bank', true, BANK_MESSAGES.removeUnconfirmed), BANK_MESSAGES.removeNotAsked,
      unknownOutcome({ kind: 'remove', bankId: 1, name: 'Bank' }, undefined, null).message,
    ];
    for (const t of texts) expect(t).not.toMatch(/—/);
  });
});

describe('Connect bank while a bank has no account list (review C-S-M3)', () => {
  it("asks to load that bank's accounts first, and says how to go on anyway", () => {
    expect(connectWarningLine(['First Test Bank'])).toBe(
      "Load the accounts for First Test Bank first, so the dashboard can tell if you're linking the same login twice. To connect a bank anyway, press Connect bank again.",
    );
    expect(connectWarningLine(['First Test Bank', 'Second Test Bank'])).toBe(
      "Load the accounts for First Test Bank and Second Test Bank first, so the dashboard can tell if you're linking the same login twice. To connect a bank anyway, press Connect bank again.",
    );
  });
});

describe('a click on a Link page link (review C-M4)', () => {
  const click = { button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false };
  it('leaves the page only for a plain main-button click', () => {
    expect(opensElsewhere(click)).toBe(false);
    for (const mod of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey'] as const) expect(opensElsewhere({ ...click, [mod]: true }), mod).toBe(true);
    expect(opensElsewhere({ ...click, button: 1 })).toBe(true);
  });
});
