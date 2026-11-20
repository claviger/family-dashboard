import { CALENDAR_API_DISABLED_MESSAGE, CALENDAR_LINK_ERRORS, type CalendarLinkError, type CalendarLinkInfo } from '../../shared/calendar.js';

/**
 * Copy and small decisions for the Integrations section's Google Calendar block (spec §5, §9.1).
 * Pure, so it's unit-tested (calendarLink.test.ts) and type-checked with the server code.
 */

/** Where the consent page sent the admin back: `?calendar=choose`, or `?calendar_error=<code>`. */
export type CalendarLinkOutcome = { kind: 'choose' } | { kind: 'error'; code: CalendarLinkError } | null;

export function calendarLinkOutcome(searchStr: string): CalendarLinkOutcome {
  const params = new URLSearchParams(searchStr);
  if (params.get('calendar') === 'choose') return { kind: 'choose' };
  const code = params.get('calendar_error');
  return code && Object.hasOwn(CALENDAR_LINK_ERRORS, code) ? { kind: 'error', code: code as CalendarLinkError } : null;
}

/**
 * Asked before disconnecting (spec §9.1). Revoking ends every grant the Google account gave this
 * app, sign-in included (docs/research/google-calendar-v3.md §1), so the admin is told; the
 * dashboard's own sessions aren't affected.
 */
export function disconnectCalendarConfirm(connection: NonNullable<CalendarLinkInfo['connection']>): string {
  const account = connection.account ? ` (${connection.account})` : '';
  return (
    `Disconnect Google Calendar? The Calendar panel stops showing ${connection.calendarName}, and nothing is deleted from Google Calendar. ` +
    `This also removes the dashboard's access from the Google account it's connected with${account}, including the consent it gave for signing in here: ` +
    'if that account signs in to the dashboard, Google asks for consent again. Nobody is signed out of the dashboard.'
  );
}

/**
 * What's wrong with the link, for the Integrations section, or null. A reconnect comes first,
 * since nothing works until then; then the Calendar API being off for the Cloud project, which
 * waiting won't fix (C-M2); then Google not being reachable for a while. `alert` ones need an admin.
 */
export function linkProblem(connection: NonNullable<CalendarLinkInfo['connection']>): { alert: boolean; text: string } | null {
  if (connection.status === 'needs_reconnect') {
    return { alert: true, text: "Google Calendar needs to be reconnected. Until then the calendar shows what was last fetched, and changes can't be saved." };
  }
  if (connection.apiDisabled) return { alert: true, text: CALENDAR_API_DISABLED_MESSAGE };
  if (connection.status === 'error') {
    return { alert: false, text: `Google Calendar hasn't been reachable for a while${connection.lastError ? `: ${connection.lastError}` : '.'} It keeps trying.` };
  }
  return null;
}

/** One line about the connected calendar. */
export function connectedLine(connection: NonNullable<CalendarLinkInfo['connection']>): string {
  const as = connection.account ? ` as ${connection.account}` : '';
  const by = connection.linkedBy ? ` Connected by ${connection.linkedBy}.` : '';
  return `Showing ${connection.calendarName}, through Google${as}.${by}`;
}

/** A calendar in the picker: its name, and whether it's the account's main calendar or in another time zone. */
export function pickLabel(c: { name: string; primary: boolean; timeZone: string | null }, familyTimeZone: string): string {
  const notes = [c.primary ? 'main calendar' : null, c.timeZone && c.timeZone !== familyTimeZone ? `in ${c.timeZone}` : null].filter(Boolean);
  return notes.length > 0 ? `${c.name} (${notes.join(', ')})` : c.name;
}

/**
 * Shown over the picker, before anything is chosen (plan review): which Google account the admin
 * just signed in with, and, when it isn't the connected one, what choosing does to that one.
 */
export function pickAccountLine(pendingAccount: string | null, connectedAccount: string | null): { signedIn: string; replaces: string | null } {
  const signedIn = pendingAccount ? `Connected as ${pendingAccount}.` : "Connected to Google. Google didn't say which account.";
  // Only when both accounts are known (R4-M5): an unnamed one may well be the same account.
  const replaces = connectedAccount && pendingAccount && pendingAccount !== connectedAccount
    ? `Choosing a calendar here replaces the connection through ${connectedAccount}, and removes the dashboard's access from that account.`
    : null;
  return { signedIn, replaces };
}

/** When the calendar last reached Google, in the family's time zone (R4-M6), as the rest of the dashboard shows times. */
export function lastReachedLine(lastSuccessAt: string | null, familyTimeZone: string, locale?: string): string {
  if (!lastSuccessAt) return 'Not reached Google yet.';
  const when = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: familyTimeZone }).format(new Date(lastSuccessAt));
  return `Last reached Google ${when}.`;
}

/** Under Reconnect: what happens when a different Google account signs in. */
export function reconnectNote(connection: NonNullable<CalendarLinkInfo['connection']>): string {
  const account = connection.account ?? 'the connected account';
  return `If you sign in to Google with a different account, the dashboard's access is removed from ${account} once you pick a calendar.`;
}

/** Back with `?calendar=choose`, but there's no pick waiting (it expired, or another tab finished or cancelled it). */
export const PICK_EXPIRED = 'That calendar pick expired. Start again.';

export function pickExpired(outcome: CalendarLinkOutcome, info: Pick<CalendarLinkInfo, 'pending'> | undefined, pickerSeen: boolean): boolean {
  return outcome?.kind === 'choose' && info !== undefined && info.pending === null && !pickerSeen;
}
