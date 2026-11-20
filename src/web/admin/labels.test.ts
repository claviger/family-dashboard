import { describe, expect, it } from 'vitest';
import type { StuckTodo } from '../../shared/chores.js';
import type { ConnectionSummary } from '../../shared/integrations.js';
import { bankConnectionLabel, bankConnections, dismissConfirm, resetLinksConfirm, todoistLabel } from './labels.js';

const NOW = Date.parse('2026-11-15T12:00:00Z');

describe('bank connections', () => {
  // A synthetic bank connection: the account is the bank's name.
  const bank: ConnectionSummary = {
    id: 5, kind: 'plaid', scope: 'family', ownerUserId: 1, ownerName: 'Admin', account: 'First Test Bank', status: 'ok',
    lastSuccessAt: '2026-11-15T10:00:00Z', lastError: null, lastErrorAt: null,
  };

  it("says how each bank is doing, by the bank's name", () => {
    expect(bankConnectionLabel(bank, NOW)).toBe('First Test Bank: working, last reached 2 hours ago');
    expect(bankConnectionLabel({ ...bank, lastSuccessAt: null }, NOW)).toBe('First Test Bank: connected, not synced yet');
    expect(bankConnectionLabel({ ...bank, status: 'needs_reconnect' }, NOW)).toBe('First Test Bank: needs reconnecting');
    expect(bankConnectionLabel({ ...bank, status: 'error', account: null }, NOW)).toBe('Bank: sync failing');
  });

  it('says a bank waiting for its pick is waiting for cards, not working (review C-M9)', () => {
    expect(bankConnectionLabel({ ...bank, waitingForCards: true }, NOW)).toBe('First Test Bank: waiting for cards');
    expect(bankConnectionLabel({ ...bank, lastSuccessAt: null, waitingForCards: true }, NOW)).toBe('First Test Bank: waiting for cards');
    expect(bankConnectionLabel({ ...bank, waitingForCards: false }, NOW)).toBe('First Test Bank: working, last reached 2 hours ago');
    // A login problem is the more pressing thing to say.
    expect(bankConnectionLabel({ ...bank, status: 'needs_reconnect', waitingForCards: true }, NOW)).toBe('First Test Bank: needs reconnecting');
  });

  it("names a Savings connection's wait as accounts, not cards", () => {
    expect(bankConnectionLabel({ ...bank, account: 'Example Brokerage', waitingForCards: true, plaidPurpose: 'savings' }, NOW)).toBe('Example Brokerage: waiting for accounts to be chosen');
    expect(bankConnectionLabel({ ...bank, waitingForCards: true, plaidPurpose: 'spend' }, NOW)).toBe('First Test Bank: waiting for cards');
    expect(bankConnectionLabel({ ...bank, account: null, status: 'error', plaidPurpose: 'savings' }, NOW)).toBe('Savings connection: sync failing');
  });

  it('lists only the Plaid connections, oldest first, once they have loaded', () => {
    const todoist: ConnectionSummary = { ...bank, id: 1, kind: 'todoist', scope: 'user' };
    expect(bankConnections({ state: 'ready', connections: [{ ...bank, id: 9 }, todoist, bank] }).map((c) => c.id)).toEqual([5, 9]);
    expect(bankConnections({ state: 'loading' })).toEqual([]);
  });
});

describe('todoistLabel', () => {
  const conn: ConnectionSummary = {
    id: 1, kind: 'todoist', scope: 'user', ownerUserId: 2, ownerName: 'Kid', account: 'kid@example.com', status: 'ok',
    lastSuccessAt: '2026-11-15T11:55:00Z', lastError: null, lastErrorAt: null,
  };

  it("says Loading or Couldn't load until the connections are in, never Not linked", () => {
    expect(todoistLabel({ state: 'loading' }, 2, NOW)).toBe('Loading…');
    expect(todoistLabel({ state: 'error' }, 2, NOW)).toBe("Couldn't load");
  });

  it("describes the person's link once they're in", () => {
    expect(todoistLabel({ state: 'ready', connections: [] }, 2, NOW)).toBe('Not linked');
    expect(todoistLabel({ state: 'ready', connections: [conn] }, 2, NOW)).toBe('Linked as kid@example.com, synced 5 minutes ago');
    expect(todoistLabel({ state: 'ready', connections: [{ ...conn, status: 'needs_reconnect' }] }, 2, NOW)).toBe('Linked as kid@example.com, needs reconnecting');
    expect(todoistLabel({ state: 'ready', connections: [{ ...conn, status: 'error', account: null }] }, 2, NOW)).toBe('Linked, sync failing');
  });
});

describe('dismissConfirm', () => {
  const stuck: StuckTodo = {
    kind: 'remove', id: 1, title: 'Feed the cat', dueDate: '2026-11-15', owner: { id: 2, displayName: 'Kid' }, attempts: 12, lastError: null,
    stuckSince: '2026-11-15T12:00:00Z',
  };

  it('says what dismissing leaves behind, by kind', () => {
    expect(dismissConfirm(stuck)).toBe("Dismiss removing the to-do for Feed the cat, due 2026-11-15? It won't be tried again. The chore to-do stays on their Todoist list.");
    expect(dismissConfirm({ ...stuck, kind: 'complete' })).toBe("Dismiss completing the to-do for Feed the cat, due 2026-11-15? It won't be tried again. The chore to-do stays open on their Todoist list.");
    expect(dismissConfirm({ ...stuck, kind: 'create', dueDate: null })).toBe("Dismiss adding a to-do for Feed the cat? It won't be tried again. This occurrence won't get a to-do.");
  });
});

describe('resetLinksConfirm', () => {
  it('names only the integrations that are set up', () => {
    const both = resetLinksConfirm({ todoist: true });
    expect(both).toContain('Everyone linked to Todoist goes back to a to-do list on the dashboard');
    expect(both).toContain('each Google or Todoist account can remove');
    const calendarOnly = resetLinksConfirm({ todoist: false });
    expect(calendarOnly).not.toMatch(/Todoist/);
    expect(calendarOnly).toBe(
      'Reset links for the new key? Google Calendar is disconnected, and an admin connects it again. ' +
        "Its saved sign-in can't be read with the new key, so it's deleted without being revoked: the Google account can remove the " +
        "dashboard's access in its own settings. Only do this if the original key is lost: putting it back brings the link back as it was.",
    );
    for (const text of [both, calendarOnly]) expect(text).not.toMatch(/—/);
    expect(resetLinksConfirm({ todoist: true, plaid: false })).toBe(both);
  });

  it('names the banks when Plaid is set up: linking again costs a Trial connection, and the old ones stay at Plaid', () => {
    const banks = resetLinksConfirm({ todoist: false, plaid: true });
    expect(banks).toBe(
      'Reset links for the new key? Google Calendar is disconnected, and an admin connects it again. ' +
        'Every bank is disconnected too, and its cards and transactions are kept: connect each bank again, and each new link uses another Plaid Trial connection. ' +
        "The saved sign-ins can't be read with the new key, so they're deleted without being revoked: the Google account can remove the dashboard's access in its own settings, " +
        'and the old bank connections stay active at Plaid until they expire. Only do this if the original key is lost: putting it back brings every link back as it was.',
    );
    const all = resetLinksConfirm({ todoist: true, plaid: true });
    expect(all).toContain('Everyone linked to Todoist goes back to a to-do list on the dashboard');
    expect(all).toContain('each Google or Todoist account can remove');
    expect(all).toContain('another Plaid Trial connection');
    for (const text of [banks, all]) expect(text).not.toMatch(/—/);
  });
});
