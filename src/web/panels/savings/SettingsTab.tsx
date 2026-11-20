import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useRef, useState, type FormEvent, type Ref } from 'react';
import {
  SAVINGS_LINK_ERRORS, SAVINGS_NICKNAME_MAX, type SavingsConnectionView, type SavingsImportProfileView, type SavingsImportRecord, type SavingsPickChoice, type SavingsSettingsAccount,
  type SavingsSettingsView,
} from '../../../shared/savings.js';
import { isOutcomeUnknown } from '../../api.js';
import { formatAgo, serverNowEstimate } from '../../freshness.js';
import { useMe } from '../../shell/useMe.js';
import { useNow } from '../../useNow.js';
import { Modal } from '../calendar/Modal.js';
import { useFocusRegistry } from '../chores/useFocus.js';
import {
  addAccountsHref, bankPollInterval, CONNECT_BANK_PATH, NO_ANSWER, plaidDate, reconnectHref, removedBankLines, removingLine, revocationWaitingLine,
  revokedLine, trialLines,
} from '../spend/plaidText.js';
import { bankReturnFromSearch } from '../spend/spendSearch.js';
import { AccountTools } from './AccountTools.js';
import { accountLabel } from './format.js';
import { HandAccounts } from './HandAccounts.js';
import { fetchSavingsSettings, savingsKeys, useDismissSavingsNotice, useSavingsAction, useSavingsSettings, type SavingsAction, type SentSavingsAction } from './queries.js';

/** Link, for a new Savings connection: a full page load (it runs under its own CSP). */
const CONNECT_SAVINGS_HREF = `${CONNECT_BANK_PATH}?for=savings`;

const connectionName = (c: { institutionName: string | null }) => c.institutionName?.trim() || 'Savings connection';
const plaidAccountLabel = (a: Pick<SavingsSettingsAccount, 'name' | 'mask'>) => accountLabel({ nickname: a.name, mask: a.mask });

/** The accounts the pick shows: every one waiting, and a skipped one that can be shown later (a kind Savings can't show stays skipped). */
const pickableAccounts = (c: SavingsConnectionView) => c.accounts.filter((a) => a.state === 'waiting' || (a.state === 'skipped' && a.showable));

/** A failed change, shown with its connection: in the pick or the Remove dialog while they're open, else on the row. */
interface RowError {
  id: number;
  kind: SavingsAction['kind'];
  message: string;
}

function progressLine(v: SavingsAction): string {
  switch (v.kind) {
    case 'pick': return `Saving the accounts for ${v.name} and syncing…`;
    case 'refresh': return `Refreshing ${v.name}…`;
    case 'load': return `Loading the accounts for ${v.name}…`;
    case 'remove': return `Removing ${v.name}…`;
    case 'update': return `Saving ${v.name}…`;
  }
}

function doneLine(v: SavingsAction, view: SavingsSettingsView): string {
  const later = view.message ? ` ${view.message}` : '';
  switch (v.kind) {
    case 'pick': {
      const shown = v.choices.filter((c) => c.action === 'show').length;
      const skipped = v.choices.length - shown;
      const parts = [shown > 0 ? `${shown} shown` : null, skipped > 0 ? `${skipped} not shown` : null].filter(Boolean).join(', ');
      return `Saved the accounts for ${v.name}${parts ? `: ${parts}` : ''}.${later}`;
    }
    case 'refresh': return view.message ? `${v.name}: ${view.message}` : `Refreshed ${v.name}.`;
    case 'load': {
      const c = view.connections.find((x) => x.id === v.id);
      const waiting = c ? c.accounts.filter((a) => a.state === 'waiting').length : 0;
      return waiting === 0 ? `Loaded the accounts for ${v.name}. Nothing new to choose.` : `Loaded the accounts for ${v.name}. Choose whether to show ${waiting === 1 ? 'the new account' : `the ${waiting} new accounts`}.`;
    }
    case 'remove': return `Removed ${v.name}. ${v.deleteData ? 'Its balances, deposits and withdrawals were deleted.' : 'Its history is kept.'}${later}`;
    case 'update':
      return v.patch.hidden === true ? `Hid ${v.name}. It's still synced.` : v.patch.hidden === false ? `${v.name} is shown again.` : `Renamed ${v.name} to ${v.patch.nickname}.`;
  }
}

function failedLine(v: SavingsAction, err: Error): string {
  const what =
    v.kind === 'pick' ? `save the accounts for ${v.name}`
    : v.kind === 'refresh' ? `refresh ${v.name}`
    : v.kind === 'load' ? `load the accounts for ${v.name}`
    : v.kind === 'remove' ? `remove ${v.name}`
    : `save ${v.name}`;
  return `Couldn't ${what}. ${err.message}`;
}

/** One line about where a connection stands, by the server's clock. */
function statusLine(c: SavingsConnectionView, now: number): string {
  const synced = c.lastSyncAt ? `last synced ${formatAgo(c.lastSyncAt, now)}` : 'not synced yet';
  if (c.status === 'needs_reconnect') return `Needs reconnecting, ${synced}`;
  if (c.status === 'error') return `Sync failing, ${synced}`;
  if (c.needsPick && !c.picked) return 'Waiting for you to choose accounts';
  return c.lastSyncAt ? `Synced ${formatAgo(c.lastSyncAt, now)}` : 'Not synced yet';
}

/**
 * Savings settings (the Savings spec, "Linking"; plan decisions 9, 10, 14; admins only, and the
 * server checks every change): Connect an account through Plaid (`?for=savings`), the Trial count
 * (shared with Spend), lasting removal notices (dismissed through the admin route the System page
 * uses), and each connection: its status, Plaid's Investments message as the server words it, the
 * pick (Show with a nickname, or not), rename and hide, Refresh, Load accounts, Add accounts,
 * Reconnect, and Remove with "Also delete its data". Connect, Reconnect and Add accounts are full page
 * loads (the Link page has its own CSP); nothing here holds work a reload loses except an open pick
 * or rename, so nothing is asked first, unlike Spend's mapping drafts. The Link page comes back with `?bank=<id>`
 * (that connection's pick opens and takes focus) or `?bank_error=<code>` (its message is shown
 * and focused); both are read once and taken out of the URL. Spend settings' banks are the model.
 *
 * Below the connections, Accounts added by hand (HandAccounts), with or without Plaid. Every
 * linked account on the panel also has AccountTools: Set balance, Import a CSV, its imports with
 * Undo, and its saved import settings.
 */
export function SettingsTab({ plaidConfigured }: { plaidConfigured: boolean }) {
  return (
    <>
      {plaidConfigured ? <Connections /> : (
        <section className="admin-section" aria-labelledby="savings-connections-heading">
          <h3 id="savings-connections-heading">Connections</h3>
          <p className="muted">Connecting accounts needs Plaid. Set PLAID_CLIENT_ID and PLAID_SECRET on the server. Accounts added by hand work without it.</p>
        </section>
      )}
      <HandAccounts />
    </>
  );
}

function Connections() {
  const me = useMe().data!;
  const timeZone = me.family.timeZone;
  const qc = useQueryClient();
  const [pollSince, setPollSince] = useState<number | null>(null);
  const pollRef = useRef(pollSince);
  pollRef.current = pollSince;
  const settings = useSavingsSettings(true, () => bankPollInterval(pollRef.current, Date.now()));
  const clientNow = useNow(30_000);
  const focus = useFocusRegistry();
  const navigate = useNavigate({ from: '/$panelId' });
  const search = useSearch({ from: '/$panelId' });
  const [returned] = useState(() => bankReturnFromSearch(search));
  const [picking, setPicking] = useState<number | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);
  const [error, setError] = useState<RowError | null>(null);
  const [status, setStatus] = useState('');
  const [noticeError, setNoticeError] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const linkErrorRef = useRef<HTMLParagraphElement>(null);
  const handledReturn = useRef(false);

  /** After a load: the pick opens when an account waits, else focus goes to the connection. */
  function afterLoad(v: SentSavingsAction, view: SavingsSettingsView) {
    const c = view.connections.find((x) => x.id === v.id);
    if (c && c.accounts.some((a) => a.state === 'waiting')) {
      setPicking(c.id);
      focus.focusLater(() => focus.get(`pick-${c.id}`), v.from);
    } else {
      focus.focusLater(() => focus.get(`conn-${v.id}`) ?? heading.current, v.from);
    }
  }

  /** An answer that never came: the change may or may not have happened, so the list is fetched again and the line says to check it. */
  async function settleUnknown(v: SentSavingsAction) {
    let after: SavingsSettingsView | null = null;
    try {
      after = await qc.fetchQuery({ queryKey: savingsKeys.settings, queryFn: fetchSavingsSettings, staleTime: 0 });
    } catch {
      after = null;
    }
    setStatus('');
    setError({
      id: v.id,
      kind: v.kind,
      message: after
        ? `${NO_ANSWER} The list below is up to date: check whether ${v.name} changed before trying again.`
        : `${NO_ANSWER} The list couldn't be loaded to check what changed. Reload the page.`,
    });
  }

  const action = useSavingsAction({
    onError: (v, err) => {
      focus.cancel();
      if (isOutcomeUnknown(err)) return settleUnknown(v);
      setStatus('');
      setError({ id: v.id, kind: v.kind, message: failedLine(v, err) });
    },
    onSuccess: (v, view) => {
      if ((v.kind === 'pick' || v.kind === 'refresh') && view.message) setPollSince(Date.now());
      setStatus(doneLine(v, view));
      if (v.kind === 'pick') {
        setPicking((now) => (now === v.id ? null : now));
        // The pick goes away; focus goes to its connection, unless the admin has moved on since Save.
        focus.focusLater(() => focus.get(`conn-${v.id}`), v.from);
      } else if (v.kind === 'load') {
        afterLoad(v, view);
      } else if (v.kind === 'remove') {
        setRemoving((now) => (now === v.id ? null : now));
        focus.focusLater(() => heading.current, v.from);
      }
    },
  });
  const busy = action.isPending;
  const run = (v: SavingsAction) => {
    if (busy) return;
    setError(null);
    setStatus(progressLine(v));
    action.mutate(v);
  };

  const dismiss = useDismissSavingsNotice({
    onError: (err) => setNoticeError(`Couldn't dismiss the notice. ${err.message}`),
    onSuccess: () => {
      setStatus('Notice dismissed.');
      focus.focusLater(() => heading.current);
    },
  });

  // Back from the Link page: take `bank` and `bank_error` out of the URL, keeping what was read.
  useEffect(() => {
    if (search.bank === undefined && search.bank_error === undefined) return;
    void navigate({
      search: (prev: Record<string, unknown>) => {
        const { bank: _bank, bank_error: _error, ...rest } = prev;
        return rest;
      },
      replace: true,
      resetScroll: false,
    });
  }, [search.bank, search.bank_error, navigate]);

  useEffect(() => {
    if (returned.bankError) linkErrorRef.current?.focus();
  }, [returned.bankError]);

  const data = settings.data;
  // A picked connection that hasn't synced yet: poll (once, for 2 minutes) until it shows its first sync.
  useEffect(() => {
    if (pollSince === null && data?.connections.some((c) => c.picked && c.lastSyncAt === null)) setPollSince(Date.now());
  }, [data, pollSince]);
  // `?bank=`: once the list is in, open that connection's pick if anything waits, and focus it; else focus the connection.
  useEffect(() => {
    if (handledReturn.current || returned.bank === null || !data) return;
    handledReturn.current = true;
    const c = data.connections.find((x) => x.id === returned.bank);
    if (!c) return;
    if (c.needsPick && pickableAccounts(c).length > 0) {
      setPicking(c.id);
      focus.focusLater(() => focus.get(`pick-${c.id}`));
    } else {
      (focus.get(c.accountsLoaded ? `conn-${c.id}` : `load-${c.id}`) ?? focus.get(`conn-${c.id}`))?.focus();
    }
  }, [data, returned.bank, focus]);

  const linkError = returned.bankError;
  const orphanError = error !== null && data !== undefined && !data.connections.some((c) => c.id === error.id) ? error.message : null;
  const now = data ? serverNowEstimate(data.serverNow, settings.dataUpdatedAt, clientNow) : clientNow;
  const removingConn = data && removing !== null ? data.connections.find((c) => c.id === removing) : undefined;

  return (
    <section aria-labelledby="savings-connections-heading" className="admin-section spend-settings">
      <h3 id="savings-connections-heading" ref={heading} tabIndex={-1}>Connections</h3>
      {linkError && (
        <p ref={linkErrorRef} tabIndex={-1} className={linkError === 'exited' ? 'notice' : 'error'} role={linkError === 'exited' ? 'status' : 'alert'}>
          {SAVINGS_LINK_ERRORS[linkError]}
        </p>
      )}
      <p className="muted">
        Connect Fidelity through Plaid to bring in your checking and brokerage balances, and the money put in and taken out. Only those numbers are
        kept, never the transactions. They're checked every morning, and Refresh checks now.
      </p>
      {settings.isPending ? (
        <p className="muted">Loading…</p>
      ) : !data ? (
        <p className="error">{settings.error?.message}</p>
      ) : (
        <Body
          data={data}
          now={now}
          timeZone={timeZone}
          busy={busy}
          error={error}
          picking={picking}
          removing={removing}
          focus={focus}
          dismissing={dismiss.isPending}
          noticeError={noticeError}
          onDismiss={(id) => {
            if (dismiss.isPending) return;
            setNoticeError(null);
            setStatus('');
            dismiss.mutate(id);
          }}
          onPick={(c) => {
            setError(null);
            setPicking(c.id);
            focus.focusLater(() => focus.get(`pick-${c.id}`));
          }}
          onCancelPick={(c) => {
            setPicking(null);
            setError(null);
            focus.focusLater(() => focus.get(`choose-${c.id}`) ?? focus.get(`conn-${c.id}`));
          }}
          send={run}
          onRemove={(c) => {
            setError(null);
            setRemoving(c.id);
          }}
        />
      )}
      {removingConn && (
        <RemoveDialog
          c={removingConn}
          busy={busy}
          error={error?.id === removingConn.id && error.kind === 'remove' ? error.message : null}
          returnFocus={() => {
            const button = focus.get(`remove-${removingConn.id}`);
            return button?.isConnected ? button : heading.current;
          }}
          onRemove={(deleteData) => run({ kind: 'remove', id: removingConn.id, name: connectionName(removingConn), deleteData })}
          onClose={() => setRemoving(null)}
        />
      )}
      <p role="status" className="muted todo-status">{orphanError ?? status}</p>
    </section>
  );
}

function Body(props: {
  data: SavingsSettingsView;
  now: number;
  timeZone: string;
  busy: boolean;
  error: RowError | null;
  picking: number | null;
  removing: number | null;
  focus: ReturnType<typeof useFocusRegistry>;
  dismissing: boolean;
  noticeError: string | null;
  onDismiss: (id: number) => void;
  onPick: (c: SavingsConnectionView) => void;
  onCancelPick: (c: SavingsConnectionView) => void;
  send: (v: SavingsAction) => void;
  onRemove: (c: SavingsConnectionView) => void;
}) {
  const { data, busy, focus, error, send } = props;
  const trial = data.trial ? trialLines(data.trial, 'connections') : null;
  const locked = data.keyMismatch;
  return (
    <>
      {locked && (
        <p className="notice" role="status">
          Accounts can't be connected, refreshed, or removed until the server's encryption key is fixed. The System section of the Admin page says how.
        </p>
      )}
      {data.notices.map((n) => (
        // A removal Plaid never confirmed: lasting until dismissed, here or on the System page.
        <div key={n.id} className="notice spend-bank-notice">
          <p id={`savings-notice-${n.id}`}>{n.message}</p>
          <button type="button" aria-describedby={`savings-notice-${n.id}`} aria-disabled={props.dismissing} onClick={() => props.onDismiss(n.id)}>
            Dismiss
          </button>
        </div>
      ))}
      {props.noticeError && <p className="error" role="alert">{props.noticeError}</p>}
      {trial && <p className="muted">{trial.used}</p>}
      {trial?.warning && <p className="notice">{trial.warning}</p>}
      {!locked && (
        <p>
          {/* A full page load: the Link page runs under its own CSP, outside the app. */}
          <a className="button primary" href={CONNECT_SAVINGS_HREF}>Connect an account</a>
        </p>
      )}
      {data.connections.length === 0 ? (
        <p className="muted">No accounts connected.</p>
      ) : (
        <ul className="todo-list" aria-label="Savings connections">
          {data.connections.map((c) => {
            const name = connectionName(c);
            const shown = error?.id === c.id ? error : null;
            // The pick and the dialog show their own failures while they're open.
            const rowError = shown && !(shown.kind === 'pick' && props.picking === c.id) && !(shown.kind === 'remove' && props.removing === c.id) ? shown.message : null;
            const disconnect = plaidDate(c.disconnectAt, props.timeZone);
            const consent = plaidDate(c.consentExpiresAt, props.timeZone);
            const pickable = c.accountsLoaded && pickableAccounts(c).length > 0;
            const onPanel = c.accounts.filter((a) => a.savingsAccountId !== null);
            const loadButton = (
              <button ref={focus.reg(`load-${c.id}`)} type="button" aria-label={`Load accounts from ${name}`} aria-disabled={busy} onClick={() => !busy && send({ kind: 'load', id: c.id, name })}>
                Load accounts
              </button>
            );
            return (
              <li key={c.id} className="todo-row chore-row spend-settings-row">
                <div className="todo-main">
                  <h4 ref={focus.reg(`conn-${c.id}`)} tabIndex={-1} className="todo-title spend-bank-name">{name}</h4>
                  <span className={c.status === 'ok' ? 'todo-due' : 'todo-due warning'}>{statusLine(c, props.now)}</span>
                  {c.lastError && <span className="todo-due warning">{c.lastError}</span>}
                </div>
                <span className="todo-actions chore-actions">
                  {!c.accountsLoaded && !locked && loadButton}
                  {pickable && !locked && (
                    <button
                      ref={focus.reg(`choose-${c.id}`)}
                      type="button"
                      aria-expanded={props.picking === c.id}
                      aria-label={`Choose accounts for ${name}`}
                      onClick={() => (props.picking === c.id ? props.onCancelPick(c) : props.onPick(c))}
                    >
                      Choose accounts
                    </button>
                  )}
                  {c.picked && !locked && (
                    <button type="button" aria-label={`Refresh ${name}`} aria-disabled={busy} onClick={() => !busy && send({ kind: 'refresh', id: c.id, name })}>
                      Refresh
                    </button>
                  )}
                  {c.fix !== null && c.fix !== 'remove' && !locked && (
                    <a className={c.status === 'needs_reconnect' ? 'button primary' : 'button'} href={reconnectHref(c.id)} aria-label={`Reconnect ${name}`}>
                      Reconnect
                    </a>
                  )}
                  {!locked && (
                    <button ref={focus.reg(`remove-${c.id}`)} type="button" aria-label={`Remove ${name}`} aria-disabled={busy} onClick={() => !busy && props.onRemove(c)}>
                      Remove
                    </button>
                  )}
                </span>
                {!c.accountsLoaded ? (
                  <p className="notice spend-form-note">The dashboard couldn't get the list of accounts from {name} yet. Load them, then choose which to show.</p>
                ) : (
                  c.needsPick && props.picking !== c.id && pickable && (
                    <p className="notice spend-form-note">
                      {c.picked ? `${name} has an account waiting for you to choose whether to show it.` : `Choose which of ${name}'s accounts to show. Nothing is synced until you do.`}
                    </p>
                  )
                )}
                {/* Plaid's Investments for the brokerage, in the server's words with its fix. */}
                {c.investments.message && <p className={c.investments.status === 'unavailable' ? 'notice spend-form-note' : 'muted spend-form-note'}>{c.investments.message}</p>}
                {c.fix === 'reconnect_or_remove' && <p className="notice spend-form-note">{revokedLine(name)}</p>}
                {c.newAccountsAt && c.accountsLoaded && !locked && (
                  <div className="notice spend-form-note spend-bank-new">
                    <p>{name} has accounts the dashboard doesn't have yet. Load accounts picks up the ones it already shares, and Add accounts opens Plaid to share more.</p>
                    <span className="todo-actions">
                      {loadButton}
                      <a className="button" href={addAccountsHref(c.id)} aria-label={`Add accounts from ${name}`}>Add accounts</a>
                    </span>
                  </div>
                )}
                {disconnect ? (
                  <p className="notice spend-form-note">Reconnect {name} before {disconnect}, or it stops syncing.</p>
                ) : (
                  consent && <p className="muted spend-form-note">{name} has agreed to share data until {consent}. Reconnect before then to keep it syncing.</p>
                )}
                {rowError && <p className="error spend-form-note" role="alert">{rowError}</p>}
                {props.picking === c.id && pickable && (
                  <Pick
                    c={c}
                    name={name}
                    busy={busy}
                    error={shown?.kind === 'pick' ? shown.message : null}
                    legendRef={focus.reg(`pick-${c.id}`)}
                    onSave={(choices) => send({ kind: 'pick', id: c.id, name, choices })}
                    onCancel={() => props.onCancelPick(c)}
                  />
                )}
                {c.accountsLoaded && (onPanel.length > 0 || c.accounts.some((a) => a.state === 'skipped')) && (
                  <ul className="savings-account-list" aria-label={`Accounts at ${name}`}>
                    {onPanel.map((a) => (
                      <AccountRow
                        key={a.accountId}
                        c={c}
                        a={a}
                        busy={busy || locked}
                        send={send}
                        imports={data.imports.filter((r) => r.accountId === a.savingsAccountId)}
                        profile={data.profiles.find((p) => p.accountId === a.savingsAccountId) ?? null}
                        timeZone={props.timeZone}
                      />
                    ))}
                    {c.accounts.filter((a) => a.state === 'skipped').map((a) => (
                      <li key={a.accountId} className="todo-due">{plaidAccountLabel(a)}: not shown{a.showable ? '. Choose accounts to show it.' : ''}</li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {data.removed.length > 0 && (
        <>
          <h4 className="spend-bank-subhead">Removed connections</h4>
          <ul className="todo-list" aria-label="Removed savings connections">
            {data.removed.map((r) => {
              const lines = removedBankLines({ reason: r.reason, removedAt: r.removedAt, cards: [] }, props.timeZone);
              const when = r.reason === 'removed_with_transactions' ? lines.when.replace('with its transactions', 'with its data') : lines.when;
              return (
                <li key={r.id} className="todo-row">
                  <span className="todo-main">
                    <span className="todo-title">{connectionName(r)}</span>
                    <span className="todo-due">{when}</span>
                    {r.accounts.length > 0 && (
                      <span className="todo-due">Its accounts keep their history in past months: {r.accounts.map((a) => a.nickname).join(', ')}.</span>
                    )}
                    {r.revocation === 'waiting' && <span className="todo-due warning">{revocationWaitingLine}</span>}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </>
  );
}

/**
 * The pick (plan decision 9): every account not on the panel, Show (with a nickname, 1 to 40
 * characters, starting from Plaid's name) or not. Every waiting account is sent, shown or skipped;
 * a skipped one is sent only when it's now shown. An account that isn't cash or investment can't
 * be shown, and says so. A missing nickname focuses its field; a refusal from the server comes
 * back in as `error`.
 */
function Pick(props: {
  c: SavingsConnectionView;
  name: string;
  busy: boolean;
  error: string | null;
  legendRef: Ref<HTMLLegendElement>;
  onSave: (choices: SavingsPickChoice[]) => void;
  onCancel: () => void;
}) {
  const accounts = pickableAccounts(props.c);
  const [choices, setChoices] = useState<Record<string, { show: boolean; nickname: string }>>(() =>
    Object.fromEntries(accounts.map((a) => [a.accountId, { show: a.state === 'waiting' && a.showable, nickname: a.name.trim().slice(0, SAVINGS_NICKNAME_MAX) }])),
  );
  const [problem, setProblem] = useState<string | null>(null);
  const fields = useRef(new Map<string, HTMLInputElement>());
  const id = `savings-pick-${props.c.id}`;
  const set = (accountId: string, patch: Partial<{ show: boolean; nickname: string }>) => setChoices((c) => ({ ...c, [accountId]: { ...c[accountId]!, ...patch } }));

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // aria-disabled, not disabled, while a change is out, so focus stays on Save if it fails.
    if (props.busy) return;
    const list: SavingsPickChoice[] = [];
    for (const a of accounts) {
      const v = choices[a.accountId]!;
      if (v.show && a.showable) {
        if (v.nickname.trim() === '') {
          setProblem(a.accountId);
          fields.current.get(a.accountId)?.focus();
          return;
        }
        list.push({ accountId: a.accountId, action: 'show', nickname: v.nickname.trim() });
      } else if (a.state === 'waiting') {
        list.push({ accountId: a.accountId, action: 'skip' });
      }
    }
    setProblem(null);
    props.onSave(list);
  }

  return (
    <form className="spend-closings spend-bank-pick" aria-label={`Choose accounts for ${props.name}`} onSubmit={submit} noValidate>
      <fieldset className="calendar-picks">
        <legend ref={props.legendRef} tabIndex={-1}>
          Choose which accounts from {props.name} to show, and a nickname for each. {props.c.picked ? '' : "Nothing is synced until you save."}
        </legend>
        {accounts.map((a) => {
          const v = choices[a.accountId]!;
          const label = plaidAccountLabel(a);
          const bad = problem === a.accountId;
          return (
            <div key={a.accountId} className="savings-pick-row">
              <label className="inline-check">
                <input type="checkbox" checked={v.show && a.showable} disabled={!a.showable} onChange={(e) => set(a.accountId, { show: e.target.checked })} />
                <span>
                  Show {label} <span className="muted">({a.subtype ?? a.type})</span>
                </span>
              </label>
              {v.show && a.showable && (
                <label>
                  Nickname for {label}
                  <input
                    ref={(el) => {
                      if (el) fields.current.set(a.accountId, el);
                      else fields.current.delete(a.accountId);
                    }}
                    type="text"
                    maxLength={SAVINGS_NICKNAME_MAX}
                    value={v.nickname}
                    aria-invalid={bad || undefined}
                    aria-describedby={bad ? `${id}-problem` : undefined}
                    onChange={(e) => set(a.accountId, { nickname: e.target.value })}
                  />
                </label>
              )}
              {!a.showable && <span className="todo-due">Savings shows cash and investment accounts only.</span>}
            </div>
          );
        })}
      </fieldset>
      <p className="muted spend-form-note">An account you don't show isn't stored or fetched. You can show it later from Choose accounts.</p>
      {problem && <p id={`${id}-problem`} className="error spend-form-note" role="alert">Give each account you show a nickname.</p>}
      {props.error && <p className="error spend-form-note" role="alert">{props.error}</p>}
      <span className="todo-actions spend-form-note">
        <button type="submit" className="primary" aria-disabled={props.busy}>Save accounts</button>
        <button type="button" onClick={props.onCancel}>Cancel</button>
      </span>
    </form>
  );
}

/**
 * A shown or hidden account: rename it, or hide it (display only: still synced, decision 10) or
 * show it again; and its AccountTools. It's cash or investment by its Plaid `type`, as the pick decided.
 */
function AccountRow(props: {
  c: SavingsConnectionView;
  a: SavingsSettingsAccount;
  busy: boolean;
  send: (v: SavingsAction) => void;
  imports: readonly SavingsImportRecord[];
  profile: SavingsImportProfileView | null;
  timeZone: string;
}) {
  const { a } = props;
  const current = a.nickname ?? a.name;
  const [nickname, setNickname] = useState(current);
  // A rename saved elsewhere (or the server's trim) is the new starting point.
  useEffect(() => setNickname(current), [current]);
  const accountId = a.savingsAccountId!;
  const label = accountLabel({ nickname: current, mask: a.mask });
  const hidden = a.state === 'hidden';
  const changed = nickname.trim() !== '' && nickname.trim() !== current;
  return (
    <li>
      <form
        className="form-row savings-account-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (props.busy || !changed) return;
          props.send({ kind: 'update', id: props.c.id, accountId, name: label, patch: { nickname: nickname.trim() } });
        }}
      >
        <span className="todo-due">
          {plaidAccountLabel(a)} ({a.subtype ?? a.type}): {hidden ? 'hidden from Savings, still synced' : 'shown'}
        </span>
        <label>
          Nickname
          <input type="text" maxLength={SAVINGS_NICKNAME_MAX} value={nickname} aria-label={`Nickname for ${plaidAccountLabel(a)}`} onChange={(e) => setNickname(e.target.value)} />
        </label>
        <button type="submit" aria-label={`Rename ${plaidAccountLabel(a)}`} aria-disabled={props.busy || !changed}>Rename</button>
        <button
          type="button"
          aria-label={hidden ? `Show ${label} again` : `Hide ${label}`}
          aria-disabled={props.busy}
          onClick={() => !props.busy && props.send({ kind: 'update', id: props.c.id, accountId, name: label, patch: { hidden: !hidden } })}
        >
          {hidden ? 'Show again' : 'Hide'}
        </button>
      </form>
      <AccountTools accountId={accountId} label={label} kind={a.type === 'investment' ? 'investment' : 'cash'} imports={props.imports} profile={props.profile} timeZone={props.timeZone} />
    </li>
  );
}

/**
 * Remove (decision 14): revoke at Plaid first, then the connection's accounts are marked removed.
 * They keep their history (past months still show them, marked "connection removed") unless
 * "Also delete its data" is ticked. Once sent it can't be stopped, so Cancel and Escape wait.
 */
function RemoveDialog(props: {
  c: SavingsConnectionView;
  busy: boolean;
  error: string | null;
  returnFocus: () => HTMLElement | null | undefined;
  onRemove: (deleteData: boolean) => void;
  onClose: () => void;
}) {
  const name = connectionName(props.c);
  const [deleteData, setDeleteData] = useState(false);
  return (
    <Modal labelledBy="savings-remove-title" onClose={props.onClose} returnFocus={props.returnFocus} locked={props.busy}>
      <h3 id="savings-remove-title">Remove {name}?</h3>
      <p>
        The dashboard stops syncing {name} and removes its access at Plaid. Its accounts leave the home card and the graph, and keep their balances,
        deposits and withdrawals for past months unless you tick the box. Removing doesn't give back a Plaid Trial connection.
      </p>
      <form
        className="event-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (props.busy) return;
          props.onRemove(deleteData);
        }}
      >
        <label className="inline-check">
          <input
            type="checkbox"
            checked={deleteData}
            aria-describedby="savings-remove-hint"
            aria-disabled={props.busy}
            onChange={(e) => {
              if (!props.busy) setDeleteData(e.target.checked);
            }}
          />
          Also delete its data
        </label>
        <p id="savings-remove-hint" className="muted">Deletes every balance, deposit and withdrawal the dashboard kept for {name}'s accounts. This can't be undone.</p>
        <p className="muted">{name} may still list the dashboard as a connected app afterwards. If it does, remove it there too.</p>
        {props.error && <p className="error" role="alert">{props.error}</p>}
        <p role="status" className="muted">{props.busy ? removingLine(name) : ''}</p>
        <span className="todo-actions">
          <button type="submit" className="primary" aria-disabled={props.busy}>Remove</button>
          <button
            type="button"
            aria-disabled={props.busy}
            onClick={() => {
              if (!props.busy) props.onClose();
            }}
          >
            Cancel
          </button>
        </span>
      </form>
    </Modal>
  );
}
