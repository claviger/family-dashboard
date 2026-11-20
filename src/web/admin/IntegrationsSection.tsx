import { Link } from '@tanstack/react-router';
import { useEffect, useRef, useState, type FormEvent, type Ref } from 'react';
import { CALENDAR_LINK_ERRORS, type CalendarLinkInfo } from '../../shared/calendar.js';
import { connectedLine, disconnectCalendarConfirm, lastReachedLine, linkProblem, pickAccountLine, pickExpired, pickLabel, PICK_EXPIRED, reconnectNote, type CalendarLinkOutcome } from './calendarLink.js';
import { useCalendarLink, useCancelCalendarPick, useChangeCalendar, useChooseCalendar, useDisconnectCalendar, useStartCalendarLink } from './calendarQueries.js';
import { bankConnectionLabel, bankConnections, type ConnectionsState } from './labels.js';
import { useNow } from '../useNow.js';

/**
 * Connect or Reconnect Google Calendar: a POST (so the CSRF check covers it) that answers with
 * Google's consent page, which the browser visits; Google sends it back to /admin. It stays
 * disabled once the URL arrives, so a second press can't start a second link, until a page the
 * browser restores from its back-forward cache enables it again.
 */
function ConnectCalendarButton({ label, buttonRef }: { label: 'Connect Google Calendar' | 'Reconnect Google Calendar'; buttonRef?: Ref<HTMLButtonElement> }) {
  const [error, setError] = useState<string | null>(null);
  const start = useStartCalendarLink({ onError: (err) => setError(err.message) });
  const { reset } = start;
  useEffect(() => {
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) reset();
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, [reset]);
  return (
    <>
      <button ref={buttonRef} type="button" className="primary" disabled={start.isPending || start.isSuccess} onClick={() => { setError(null); start.mutate(); }}>
        {label}
      </button>
      {error && <p className="error" role="alert">{error}</p>}
    </>
  );
}

/**
 * The admin picks the family calendar from the ones their Google account can change (spec §9.1).
 * A failed pick or Cancel is reported through `onError`, to the section, since the refresh after
 * it can take the picker away with its own state (R4-I1).
 */
function CalendarPicker({ pending, connectedAccount, familyTimeZone, legendRef, onStart, onDone, onCancelled, onError }: {
  pending: NonNullable<CalendarLinkInfo['pending']>;
  /** The account of the connection this pick replaces, if there is one. */
  connectedAccount: string | null;
  familyTimeZone: string;
  legendRef: Ref<HTMLLegendElement>;
  /** A pick or Cancel was sent: the section clears its last message. */
  onStart: () => void;
  onDone: () => void;
  onCancelled: () => void;
  onError: (message: string) => void;
}) {
  const [picked, setPicked] = useState(pending.calendars.length === 1 ? pending.calendars[0]!.id : '');
  // Only "Pick a calendar.", which can't outlive the picker.
  const [error, setError] = useState<string | null>(null);
  const choose = useChooseCalendar({ onError: (err) => onError(err.message), onSuccess: onDone });
  const cancel = useCancelCalendarPick({ onError: (err) => onError(err.message), onSuccess: onCancelled });
  const account = pickAccountLine(pending.account, connectedAccount);
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!picked) {
      setError('Pick a calendar.');
      return;
    }
    setError(null);
    onStart();
    choose.mutate(picked);
  }
  return (
    <form className="calendar-picker" aria-label="Pick the family calendar" onSubmit={submit}>
      <p className="pick-account"><strong>{account.signedIn}</strong></p>
      {account.replaces && <p className="notice">{account.replaces}</p>}
      <fieldset className="calendar-picks">
        <legend ref={legendRef} tabIndex={-1}>
          Pick the family calendar. Everyone with the Calendar panel will see and change its events.
        </legend>
        {pending.calendars.map((c) => (
          <label key={c.id} className="inline-check">
            <input type="radio" name="calendar" value={c.id} checked={picked === c.id} onChange={() => setPicked(c.id)} />
            {pickLabel(c, familyTimeZone)}
          </label>
        ))}
      </fieldset>
      <p className="muted">Only calendars this account owns or can make changes to are listed.</p>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="form-row">
        <button type="submit" className="primary" disabled={choose.isPending}>Use this calendar</button>
        <button type="button" disabled={cancel.isPending || choose.isPending} onClick={() => { setError(null); onStart(); cancel.mutate(); }}>Cancel</button>
      </div>
    </form>
  );
}

/**
 * Banks through Plaid: each one's status, from the admin connections query. They're connected,
 * refreshed, and removed in Spend settings, so this only links there.
 */
function BanksStatus({ banks }: { banks: ConnectionsState }) {
  const now = useNow(30_000);
  const list = bankConnections(banks);
  return (
    <>
      <h3>Banks (Plaid)</h3>
      {banks.state === 'loading' && <p className="muted">Loading…</p>}
      {banks.state === 'error' && <p className="error">Couldn't load the bank connections.</p>}
      {banks.state === 'ready' &&
        (list.length === 0 ? (
          <p className="muted">No banks connected.</p>
        ) : (
          <ul className="todo-list" aria-label="Bank connections">
            {list.map((c) => (
              <li key={c.id} className="todo-row">
                <span className={c.status === 'ok' ? 'todo-main' : 'todo-main warning'}>{bankConnectionLabel(c, now)}</span>
              </li>
            ))}
          </ul>
        ))}
      <p>
        <Link to="/$panelId" params={{ panelId: 'spend' }} search={{ tab: 'settings' }}>Manage banks in Spend settings</Link>
      </p>
      {/* Savings connections are Plaid connections too, managed from Savings settings (an admin needs the Savings grant to open it, main spec §6). */}
      {list.some((c) => c.plaidPurpose === 'savings') && (
        <p>
          <Link to="/$panelId" params={{ panelId: 'savings' }} search={{ tab: 'settings' }}>Manage savings accounts in Savings settings</Link>
        </p>
      )}
    </>
  );
}

/**
 * Admin → Integrations (spec §5): the family's Google Calendar, which any admin can connect,
 * reconnect, point at another calendar, or disconnect (spec §8, §9.1), and, with Plaid configured,
 * each bank's status with a link to Spend settings, where banks are managed. Each person's Todoist
 * link is on the Users table, since only they can link it.
 */
export function IntegrationsSection({ familyTimeZone, outcome, banks = null }: { familyTimeZone: string; outcome: CalendarLinkOutcome; banks?: ConnectionsState | null }) {
  const link = useCalendarLink();
  const [message, setMessage] = useState<{ error: boolean; text: string } | null>(null);
  const messageRef = useRef<HTMLParagraphElement>(null);
  const legendRef = useRef<HTMLLegendElement>(null);
  const outcomeRef = useRef<HTMLParagraphElement>(null);
  const focusedOutcome = useRef(false);
  // Focus follows what the admin did: the picker after Change calendar, a message after Cancel.
  const focusPicker = useRef(false);
  const pickerSeen = useRef(false);
  const change = useChangeCalendar({
    onError: (err) => setMessage({ error: true, text: err.message }),
    onSuccess: () => {
      focusPicker.current = true;
    },
  });
  const disconnect = useDisconnectCalendar({
    onError: (err) => setMessage({ error: true, text: err.message }),
    onSuccess: ({ revoked }) =>
      setMessage({
        error: false,
        text: revoked
          ? 'Google Calendar is disconnected.'
          : "Google Calendar is disconnected. Google didn't confirm removing the dashboard's access yet; it's tried again every hour.",
      }),
  });
  const info = link.data;

  // Back from Google's consent page, worked or not, focus moves to what comes next: the picker or the error.
  const pickerShown = info?.pending != null;
  if (pickerShown) pickerSeen.current = true;
  const expired = pickExpired(outcome, info, pickerSeen.current);
  useEffect(() => {
    if (pickerShown && focusPicker.current) {
      focusPicker.current = false;
      legendRef.current?.focus();
    }
  }, [pickerShown]);
  useEffect(() => {
    if (focusedOutcome.current) return;
    if (outcome?.kind === 'error' || expired) {
      focusedOutcome.current = true;
      outcomeRef.current?.focus();
    } else if (outcome?.kind === 'choose' && pickerShown) {
      focusedOutcome.current = true;
      legendRef.current?.focus();
    }
  }, [outcome?.kind, pickerShown, expired]);
  useEffect(() => {
    if (message) messageRef.current?.focus();
  }, [message]);

  const connection = info?.connection ?? null;
  const problem = connection ? linkProblem(connection) : null;
  return (
    <section className="admin-section" id="integrations" aria-labelledby="integrations-heading">
      <h2 id="integrations-heading">Integrations</h2>
      <h3>Google Calendar</h3>
      {outcome?.kind === 'error' && <p ref={outcomeRef} tabIndex={-1} className="error" role="alert">{CALENDAR_LINK_ERRORS[outcome.code]}</p>}
      {expired && <p ref={outcomeRef} tabIndex={-1} className="error" role="alert">{PICK_EXPIRED}</p>}
      {message && <p ref={messageRef} tabIndex={-1} className={message.error ? 'error' : 'muted'} role={message.error ? 'alert' : 'status'}>{message.text}</p>}
      {link.isPending && <p className="muted">Loading…</p>}
      {link.error && <p className="error">{link.error.message}</p>}
      {info?.keyMismatch && (
        <p className="notice" role="status">Google Calendar can't be connected or changed until the server's encryption key is fixed. The System section says how.</p>
      )}
      {info?.pending && (
        <CalendarPicker
          pending={info.pending}
          connectedAccount={connection?.account ?? null}
          familyTimeZone={familyTimeZone}
          legendRef={legendRef}
          onStart={() => setMessage(null)}
          onDone={() => setMessage({ error: false, text: 'Google Calendar is connected.' })}
          onCancelled={() => setMessage({ error: false, text: connection ? 'Nothing changed. The calendar stays as it was.' : 'Google Calendar is not connected.' })}
          onError={(text) => setMessage({ error: true, text })}
        />
      )}
      {info && !info.pending && !connection && (
        <>
          <p>
            Connect the family's Google Calendar so everyone with the Calendar panel can see and change its events. After signing in
            to Google, you pick which calendar.
          </p>
          {!info.keyMismatch && <ConnectCalendarButton label="Connect Google Calendar" />}
        </>
      )}
      {info && !info.pending && connection && (
        <>
          <p>{connectedLine(connection)}</p>
          <p className="muted">{lastReachedLine(connection.lastSuccessAt, familyTimeZone)}</p>
          {problem && (problem.alert ? <p className="notice" role="alert">{problem.text}</p> : <p className="error">{problem.text}</p>)}
          {!info.keyMismatch && (
            <div className="form-row">
              <ConnectCalendarButton label="Reconnect Google Calendar" />
              <button type="button" disabled={change.isPending} onClick={() => { setMessage(null); change.mutate(); }}>Change calendar</button>
              <button
                type="button"
                disabled={disconnect.isPending}
                onClick={() => {
                  if (!window.confirm(disconnectCalendarConfirm(connection))) return;
                  setMessage(null);
                  disconnect.mutate();
                }}
              >
                Disconnect
              </button>
            </div>
          )}
          {!info.keyMismatch && <p className="muted">{reconnectNote(connection)}</p>}
        </>
      )}
      {banks && <BanksStatus banks={banks} />}
    </section>
  );
}
