import type { StuckTodo } from '../../shared/chores.js';
import type { ConnectionSummary } from '../../shared/integrations.js';
import { formatAgo } from '../freshness.js';

/** The admin connections query, as the Users table sees it. */
export type ConnectionsState = { state: 'loading' } | { state: 'error' } | { state: 'ready'; connections: ConnectionSummary[] };

/**
 * A person's Todoist link, for the Users table (spec §5). Until the connections have loaded it
 * says so, rather than "Not linked", which would be wrong for someone who is.
 */
export function todoistLabel(c: ConnectionsState, userId: number, now: number): string {
  if (c.state === 'loading') return 'Loading…';
  if (c.state === 'error') return "Couldn't load";
  const conn = c.connections.find((x) => x.kind === 'todoist' && x.ownerUserId === userId);
  if (!conn) return 'Not linked';
  const as = conn.account ? ` as ${conn.account}` : '';
  if (conn.status === 'needs_reconnect') return `Linked${as}, needs reconnecting`;
  if (conn.status === 'error') return `Linked${as}, sync failing`;
  return conn.lastSuccessAt ? `Linked${as}, synced ${formatAgo(conn.lastSuccessAt, now)}` : `Linked${as}`;
}

/**
 * A bank's Plaid connection, for Admin Integrations' list (the owner's answer: banks are managed in
 * Spend settings, and Integrations only says how each one is doing). The connection's account is
 * the bank's name.
 */
export function bankConnectionLabel(conn: Pick<ConnectionSummary, 'account' | 'status' | 'lastSuccessAt' | 'waitingForCards' | 'plaidPurpose'>, now: number): string {
  const savings = conn.plaidPurpose === 'savings';
  const name = conn.account?.trim() || (savings ? 'Savings connection' : 'Bank');
  if (conn.status === 'needs_reconnect') return `${name}: needs reconnecting`;
  if (conn.status === 'error') return `${name}: sync failing`;
  // Reached at the exchange, but nothing syncs until its cards (or, for Savings, its accounts) are chosen (review C-M9).
  if (conn.waitingForCards) return savings ? `${name}: waiting for accounts to be chosen` : `${name}: waiting for cards`;
  return conn.lastSuccessAt ? `${name}: working, last reached ${formatAgo(conn.lastSuccessAt, now)}` : `${name}: connected, not synced yet`;
}

/** The Plaid connections in the admin connections query, oldest first, for Integrations. */
export function bankConnections(c: ConnectionsState): ConnectionSummary[] {
  return c.state === 'ready' ? c.connections.filter((x) => x.kind === 'plaid').sort((a, b) => a.id - b.id) : [];
}

const DISMISS_WHAT: Record<StuckTodo['kind'], string> = {
  create: 'adding a to-do for',
  remove: 'removing the to-do for',
  complete: 'completing the to-do for',
};

const DISMISS_LEAVES: Record<StuckTodo['kind'], string> = {
  create: "This occurrence won't get a to-do.",
  remove: 'The chore to-do stays on their Todoist list.',
  complete: 'The chore to-do stays open on their Todoist list.',
};

/** Asked before an admin dismisses a stuck chore to-do: what's given up, and what it leaves behind. */
export function dismissConfirm(s: StuckTodo): string {
  const due = s.dueDate ? `, due ${s.dueDate}` : '';
  return `Dismiss ${DISMISS_WHAT[s.kind]} ${s.title}${due}? It won't be tried again. ${DISMISS_LEAVES[s.kind]}`;
}

/**
 * Said before an admin resets the links for a new key (spec §14). Names only the integrations set
 * up on this server: Google Calendar always, Todoist and Plaid's banks when they're configured.
 * For banks it says what the reset costs and leaves (the design's departure 10): each one is linked
 * again, using another Plaid Trial connection, and the old ones stay active at Plaid until they expire.
 */
export function resetLinksConfirm(configured: { todoist: boolean; plaid?: boolean }): string {
  const ending = "Only do this if the original key is lost: putting it back brings ";
  if (configured.plaid) {
    const todoist = configured.todoist
      ? 'Everyone linked to Todoist goes back to a to-do list on the dashboard, and keeps their open to-dos; then each person connects Todoist again. '
      : '';
    const accounts = configured.todoist ? 'each Google or Todoist account can remove' : 'the Google account can remove';
    return 'Reset links for the new key? Google Calendar is disconnected, and an admin connects it again. ' + todoist +
      'Every bank is disconnected too, and its cards and transactions are kept: connect each bank again, and each new link uses another Plaid Trial connection. ' +
      `The saved sign-ins can't be read with the new key, so they're deleted without being revoked: ${accounts} the dashboard's access in its own settings, ` +
      `and the old bank connections stay active at Plaid until they expire. ${ending}every link back as it was.`;
  }
  if (!configured.todoist) {
    return 'Reset links for the new key? Google Calendar is disconnected, and an admin connects it again. ' +
      "Its saved sign-in can't be read with the new key, so it's deleted without being revoked: the Google account can remove the " +
      `dashboard's access in its own settings. ${ending}the link back as it was.`;
  }
  return 'Reset links for the new key? Google Calendar is disconnected, and an admin connects it again. ' +
    'Everyone linked to Todoist goes back to a to-do list on the dashboard, and keeps their open to-dos; then each person connects Todoist again. ' +
    "The saved sign-ins can't be read with the new key, so they're deleted without being revoked: each Google or Todoist account can remove the " +
    `dashboard's access in its own settings. ${ending}every link back as it was.`;
}
