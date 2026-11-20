import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useRef, useState, type FormEvent, type MouseEvent as ReactMouseEvent, type Ref } from 'react';
import { PLAID_LINK_ERRORS, type BankPickChoice, type BankView, type BanksView } from '../../../shared/plaid.js';
import type { CardOption } from '../../../shared/spend.js';
import { isOutcomeUnknown } from '../../api.js';
import { serverNowEstimate } from '../../freshness.js';
import { confirmDiscardUnsaved } from '../../unsavedChanges.js';
import { useMe } from '../../shell/useMe.js';
import { useNow } from '../../useNow.js';
import { Modal } from '../calendar/Modal.js';
import { useFocusRegistry } from '../chores/useFocus.js';
import { cardName } from './format.js';
import { fetchBanks, useBankAction, useBanks, useDismissRevocation, type SentBankAction } from './plaidQueries.js';
import {
  accountLabel, addAccountsHref, bankName, bankPollInterval, bankStatusLine, CONNECT_BANK_PATH, connectWarningLine, deferredLine, initialPick, loadedLine,
  missingCardLine, newAccountsLine, notLoadedLine, opensElsewhere, pickableAccounts, pickChoices, pickSavedLine, pickSyncUnfinished, pickTargets, plaidDate, progressLine,
  RECHECK_AFTER_MS, reconnectHref, removedBankLines, removedLine, removedUnconfirmedLine, removeHint, removingLine, revocationWaitingLine, revokedLine,
  trialLines, unknownOutcome, wantsPoll, type PickValue,
} from './plaidText.js';
import { spendKeys } from './queries.js';
import { bankReturnFromSearch } from './spendSearch.js';

/** A failed bank change, shown with its bank: in the pick or the Remove dialog while they're open, else on the bank's row. */
interface BankError {
  bankId: number;
  kind: SentBankAction['kind'];
  message: string;
}

const ACCOUNT_STATE_LINES = { skipped: 'Skipped, not tracked', waiting: 'Waiting for a card' } as const;

/**
 * Connect bank, Reconnect and Add accounts are full page loads (the Link page has its own CSP), so
 * the router's blocker never sees them: unsaved work on the page (the mapping editor's drafts) is
 * asked about first, and dropped only if the person agrees (review G4-I3). A click that opens the
 * link in a new tab leaves this page and its drafts as they are, so nothing is asked (review C-M4).
 */
const leaveForLink = (e: ReactMouseEvent) => {
  if (opensElsewhere(e)) return;
  if (!confirmDiscardUnsaved()) e.preventDefault();
};

/**
 * The pick step (the design's departures 2 and 11): a card for each account that isn't on one yet.
 * An existing card (the one with the same last 4 is suggested), a new card, or Skip. The bank's own
 * missing cards come first: when the bank gave an account a new id, choosing its old card for the
 * new one keeps the card's history on one card. Every waiting
 * account must be decided before Save; a skipped one can be attached later, which resyncs the bank
 * from the start. A problem found here focuses its select; a refusal from the server is shown by
 * the section (it outlives this form) and passed back in as `error`.
 */
function BankPick(props: {
  bank: BankView;
  attachable: readonly CardOption[];
  busy: boolean;
  error: string | null;
  legendRef: Ref<HTMLLegendElement>;
  onSave: (choices: BankPickChoice[]) => void;
  onCancel: () => void;
}) {
  const { bank } = props;
  const accounts = pickableAccounts(bank);
  const name = bankName(bank);
  const targets = pickTargets(bank, props.attachable);
  const [values, setValues] = useState(() => initialPick(accounts, [...targets.missing, ...targets.existing]));
  const [problem, setProblem] = useState<{ accountId: string; message: string } | null>(null);
  const selects = useRef(new Map<string, HTMLSelectElement>());
  const id = `spend-bank-${bank.id}-pick`;

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // aria-disabled, not disabled, while a change is out, so focus stays on Save if it fails.
    if (props.busy) return;
    const checked = pickChoices(accounts, values);
    if (!checked.ok) {
      setProblem({ accountId: checked.accountId, message: checked.message });
      selects.current.get(checked.accountId)?.focus();
      return;
    }
    setProblem(null);
    props.onSave(checked.choices);
  }

  return (
    <form className="spend-closings spend-bank-pick" aria-label={`Choose cards for ${name}`} onSubmit={submit} noValidate>
      <fieldset className="calendar-picks">
        <legend ref={props.legendRef} tabIndex={-1}>
          Choose a card for each account from {name}. {bank.needsPick ? "The bank isn't synced until you save." : ''}
        </legend>
        {accounts.map((a) => {
          const bad = problem?.accountId === a.accountId;
          return (
            <label key={a.accountId} className="spend-picker">
              Card for {accountLabel(a)}
              <select
                ref={(el) => {
                  if (el) selects.current.set(a.accountId, el);
                  else selects.current.delete(a.accountId);
                }}
                // Named here, not by the wrapping label, so the name doesn't take in the picked option's text.
                aria-label={`Card for ${accountLabel(a)}`}
                value={values[a.accountId] ?? ''}
                aria-invalid={bad || undefined}
                aria-describedby={bad ? `${id}-problem` : undefined}
                onChange={(e) => setValues({ ...values, [a.accountId]: e.target.value as PickValue })}
              >
                <option value="">Choose a card</option>
                {targets.missing.length > 0 && (
                  <optgroup label={`Cards ${name} stopped sharing`}>
                    {targets.missing.map((c) => (
                      <option key={c.id} value={`card:${c.id}`}>{cardName(c)}</option>
                    ))}
                  </optgroup>
                )}
                {targets.existing.length > 0 && (
                  <optgroup label="Existing cards">
                    {targets.existing.map((c) => (
                      <option key={c.id} value={`card:${c.id}`}>{cardName(c)}</option>
                    ))}
                  </optgroup>
                )}
                <option value="create">New card</option>
                <option value="skip">Skip this account</option>
              </select>
            </label>
          );
        })}
      </fieldset>
      <p className="muted spend-form-note">
        A new card starts hidden from Spend: show it from Cards below. A skipped account's transactions aren't saved. Attaching it later fetches
        the bank's history again.
      </p>
      {problem && <p id={`${id}-problem`} className="error spend-form-note" role="alert">{problem.message}</p>}
      {props.error && <p className="error spend-form-note" role="alert">{props.error}</p>}
      <span className="todo-actions spend-form-note">
        <button type="submit" className="primary" aria-disabled={props.busy}>Save cards</button>
        <button type="button" onClick={props.onCancel}>Cancel</button>
      </span>
    </form>
  );
}

/**
 * Remove a bank (decision 10, the design's departure 9, research §9): revoke at Plaid first, then
 * the bank and its cards are marked removed. The cards keep their history unless "Also delete its
 * transactions" is ticked, which deletes only the bank's own rows and brings back the rows they
 * had replaced (CSV rows, or an earlier connection's), with what was set by hand; CSV rows from an
 * import that was undone stay gone. A refusal shows here; focus stays on Remove bank.
 *
 * Once Remove is sent it can't be stopped (Plaid may already have ended the access), so while it's
 * out Cancel and Escape do nothing, and the dialog says so (review G4-C1).
 */
function RemoveBankDialog(props: {
  bank: BankView;
  busy: boolean;
  error: string | null;
  returnFocus: () => HTMLElement | null | undefined;
  onRemove: (deleteTransactions: boolean) => void;
  onClose: () => void;
}) {
  const { bank } = props;
  const name = bankName(bank);
  const [deleteTransactions, setDeleteTransactions] = useState(false);
  const cards = [...bank.accounts.flatMap((a) => (a.card ? [a.card] : [])), ...bank.missingCards].map(cardName);
  const which = cards.length === 0 ? 'this bank' : cards.length === 1 ? cards[0] : `${cards.slice(0, -1).join(', ')} and ${cards[cards.length - 1]}`;
  return (
    <Modal labelledBy="spend-remove-bank-title" onClose={props.onClose} returnFocus={props.returnFocus} locked={props.busy}>
      <h3 id="spend-remove-bank-title">Remove {name}?</h3>
      <p>
        The dashboard stops syncing {which} and removes its access at Plaid. The cards stay, marked "bank connection removed", and keep their
        transactions unless you tick the box. Its pending transactions are deleted either way, since the bank won't post them now. Removing a bank
        doesn't give back a Plaid Trial connection.
      </p>
      <form
        className="event-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (props.busy) return;
          props.onRemove(deleteTransactions);
        }}
      >
        <label className="inline-check">
          {/* Locked while Remove is out (review C-M3): what was sent is what happens. */}
          <input
            type="checkbox"
            checked={deleteTransactions}
            aria-describedby="spend-remove-bank-hint"
            aria-disabled={props.busy}
            onChange={(e) => {
              if (!props.busy) setDeleteTransactions(e.target.checked);
            }}
          />
          Also delete its transactions
        </label>
        <p id="spend-remove-bank-hint" className="muted">{removeHint(name)}</p>
        <p className="muted">
          Your bank may still list the dashboard as a connected app afterwards (Bank of America can). If it does, remove it there too.
        </p>
        {props.error && <p className="error" role="alert">{props.error}</p>}
        {/* Always in the dialog, so a screen reader hears it once Remove is sent. */}
        <p role="status" className="muted">{props.busy ? removingLine(name) : ''}</p>
        <span className="todo-actions">
          <button type="submit" className="primary" aria-disabled={props.busy}>Remove bank</button>
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

/** "Couldn't save the cards for X." and so on, for a failed change. */
function failedLine(v: SentBankAction, err: Error): string {
  const what =
    v.kind === 'pick' ? `save the cards for ${v.name}` : v.kind === 'refresh' ? `refresh ${v.name}` : v.kind === 'load' ? `load the accounts from ${v.name}` : `remove ${v.name}`;
  return `Couldn't ${what}. ${err.message}`;
}

/**
 * Spend settings: banks (spec §12.2, admins, only with Plaid configured). Connect bank goes to the
 * Link page with a full page load (it has its own CSP), and every link step comes back here: with
 * `?bank=<id>`, which opens and focuses that bank's pick (or the bank, when nothing waits), or
 * with `?bank_error=<code>`, whose message is shown and focused. Both are read once and taken out
 * of the URL, so a reload doesn't show them again.
 *
 * Each change says what it's doing in the status line as it starts (review G4-I2). One whose
 * answer never comes (no connection, or a gateway's error page) may still have happened, so the
 * list is fetched again and the status line says what it shows (review G4-I1): a change it shows
 * made is treated as done; otherwise the message goes with the bank's controls, to try again.
 * While a picked bank hasn't synced yet, or a sync was left to the background, the list is fetched
 * every 5 seconds for 2 minutes (review G4-M5).
 */
export function BanksSettings() {
  const me = useMe().data!;
  const timeZone = me.family.timeZone;
  const qc = useQueryClient();
  // When polling started; the interval reads it through a ref, so a new start takes effect at once.
  const [pollSince, setPollSince] = useState<number | null>(null);
  const pollRef = useRef(pollSince);
  pollRef.current = pollSince;
  const banks = useBanks(true, () => bankPollInterval(pollRef.current, Date.now()));
  const clientNow = useNow(30_000);
  const focus = useFocusRegistry();
  const navigate = useNavigate({ from: '/$panelId' });
  const search = useSearch({ from: '/$panelId' });
  const [returned] = useState(() => bankReturnFromSearch(search));
  const [picking, setPicking] = useState<number | null>(null);
  const [removing, setRemoving] = useState<number | null>(null);
  const [error, setError] = useState<BankError | null>(null);
  const [status, setStatus] = useState('');
  const heading = useRef<HTMLHeadingElement>(null);
  const linkErrorRef = useRef<HTMLParagraphElement>(null);
  const handledReturn = useRef(false);
  /** The bank as shown when the change out now was sent, to tell what an unanswered one did. */
  const sentFrom = useRef<BankView | undefined>(undefined);
  const [noticeError, setNoticeError] = useState<string | null>(null);
  /** The error shown now, for the second look at an unanswered change (review C-M1), and its timer. */
  const errorRef = useRef(error);
  errorRef.current = error;
  const recheck = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(recheck.current), []);
  /** Connect bank's warning about banks whose accounts never loaded, once shown (review C-S-M3). */
  const [connectWarned, setConnectWarned] = useState(false);

  /** After a load: the pick opens when an account waits for a card, else focus goes to the bank. */
  function afterLoad(v: SentBankAction, view: BanksView) {
    const bank = view.banks.find((b) => b.id === v.bankId);
    const waiting = bank ? bank.accounts.filter((a) => a.state === 'waiting').length : 0;
    if (bank && waiting > 0) {
      setPicking(bank.id);
      focus.focusLater(() => focus.get(`pick-${bank.id}`), v.from);
    } else {
      focus.focusLater(() => focus.get(`bank-${v.bankId}`) ?? heading.current, v.from);
    }
    return waiting;
  }

  async function freshBanks(): Promise<BanksView | null> {
    try {
      return await qc.fetchQuery({ queryKey: spendKeys.banks, queryFn: fetchBanks, staleTime: 0 });
    } catch {
      return null;
    }
  }

  /**
   * An answer that never came: fetch the list again and say what it shows (review G4-I1). When it
   * doesn't show the change yet, the change may still be finishing at the server: the message says
   * to check again in a minute before trying again, and the page looks once more by itself after
   * RECHECK_AFTER_MS, unless the admin has tried again or moved on meanwhile (review C-M1).
   */
  async function settleUnknown(v: SentBankAction) {
    const before = sentFrom.current;
    const after = await freshBanks();
    const outcome = unknownOutcome(v, before, after);
    if (!outcome.done) {
      setStatus('');
      const shown: BankError = { bankId: v.bankId, kind: v.kind, message: outcome.message };
      setError(shown);
      window.clearTimeout(recheck.current);
      recheck.current = window.setTimeout(() => void lookAgain(v, before, shown), RECHECK_AFTER_MS);
      return;
    }
    settled(v, outcome.message, after);
  }

  /** The second look at an unanswered change, if its message is still the one shown. */
  async function lookAgain(v: SentBankAction, before: BankView | undefined, shown: BankError) {
    if (errorRef.current !== shown) return;
    const after = await freshBanks();
    if (errorRef.current !== shown) return;
    const outcome = unknownOutcome(v, before, after, { final: true });
    if (!outcome.done) {
      setError({ ...shown, message: outcome.message });
      return;
    }
    setError(null);
    settled(v, outcome.message, after);
  }

  /** An unanswered change the list now shows made: treated as a success. */
  function settled(v: SentBankAction, message: string, after: BanksView | null) {
    setStatus(message);
    if (v.kind === 'remove') {
      setRemoving((now) => (now === v.bankId ? null : now));
      focus.focusLater(() => heading.current, v.from);
    } else if (v.kind === 'pick') {
      setPicking((now) => (now === v.bankId ? null : now));
      focus.focusLater(() => focus.get(`bank-${v.bankId}`) ?? heading.current, v.from);
    } else if (v.kind === 'load' && after) {
      afterLoad(v, after);
    }
  }

  const action = useBankAction({
    onError: (v, err) => {
      focus.cancel();
      if (isOutcomeUnknown(err)) return settleUnknown(v);
      setStatus('');
      setError({ bankId: v.bankId, kind: v.kind, message: failedLine(v, err) });
    },
    onSuccess: (v, view) => {
      // A pick's or Refresh's sync that ran past the request's deadline goes on in the background, and the server says so.
      if ((v.kind === 'pick' || v.kind === 'refresh') && view.message) setPollSince(Date.now());
      if (v.kind === 'pick') {
        setPicking((now) => (now === v.bankId ? null : now));
        // A sync that failed is tried again by the scheduled syncs, and the line says so (review C-M8).
        const syncUnfinished = pickSyncUnfinished(sentFrom.current, view.banks.find((b) => b.id === v.bankId), v.choices);
        setStatus(view.message ? deferredLine(v.name, view.message) : pickSavedLine(v.name, v.choices, { syncUnfinished }));
        // The pick goes away; focus goes to its bank, unless the admin has moved on since Save.
        focus.focusLater(() => focus.get(`bank-${v.bankId}`), v.from);
      } else if (v.kind === 'refresh') {
        setStatus(view.message ? deferredLine(v.name, view.message) : `Refreshed ${v.name}.`);
      } else if (v.kind === 'load') {
        setStatus(loadedLine(v.name, afterLoad(v, view)));
      } else {
        // The bank's row is gone: focus goes to the section's heading (the dialog's return focus finds it too).
        setRemoving((now) => (now === v.bankId ? null : now));
        setStatus(view.message ? removedUnconfirmedLine(v.name, v.deleteTransactions, view.message) : removedLine(v.name, v.deleteTransactions));
        focus.focusLater(() => heading.current, v.from);
      }
    },
  });
  const busy = action.isPending;
  const run = (v: Parameters<typeof action.mutate>[0]) => {
    if (busy) return;
    setError(null);
    setStatus(progressLine(v));
    sentFrom.current = banks.data?.banks.find((b) => b.id === v.bankId);
    action.mutate(v);
  };

  const dismiss = useDismissRevocation({
    onError: (err) => setNoticeError(`Couldn't dismiss the notice. ${err.message}`),
    onSuccess: () => {
      setStatus('Notice dismissed.');
      // The notice and its button are gone.
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

  // `?bank=`: once the list is in, open that bank's pick if anything waits, and focus it; else focus the bank.
  const data = banks.data;

  // A picked bank that hasn't synced yet: poll (once, for 2 minutes) until it shows its first sync.
  useEffect(() => {
    if (pollSince === null && wantsPoll(data)) setPollSince(Date.now());
  }, [data, pollSince]);
  useEffect(() => {
    if (handledReturn.current || returned.bank === null || !data) return;
    handledReturn.current = true;
    const bank = data.banks.find((b) => b.id === returned.bank);
    if (!bank) return;
    if (bank.needsPick && pickableAccounts(bank).length > 0) {
      setPicking(bank.id);
      focus.focusLater(() => focus.get(`pick-${bank.id}`));
    } else {
      // The bank is already on the page (this runs after the render that showed the list), and
      // nothing renders again to run a `focusLater`, so focus it now. Found by e2e/plaid.spec.ts.
      // When linking couldn't fetch its accounts, Load accounts is the way on, so it gets the focus.
      (focus.get(bank.accountsLoaded ? `bank-${bank.id}` : `load-${bank.id}`) ?? focus.get(`bank-${bank.id}`))?.focus();
    }
  }, [data, returned.bank, focus]);

  const linkError = returned.bankError;
  // A failure for a bank no longer listed has no row to show it: the status line says it (review C-M1).
  const orphanError = error !== null && data !== undefined && !data.banks.some((b) => b.id === error.bankId) ? error.message : null;
  const unloaded = (data?.banks ?? []).filter((b) => !b.accountsLoaded).map(bankName);
  // Linking again while a bank's accounts never loaded could be the same login twice, which the
  // duplicate check can't see: said first, then the next press goes on (review C-S-M3).
  const onConnect = (e: ReactMouseEvent) => {
    if (unloaded.length > 0 && !connectWarned) {
      e.preventDefault();
      setConnectWarned(true);
      return;
    }
    leaveForLink(e);
  };
  return (
    <section aria-labelledby="spend-banks-heading" className="admin-section">
      <h3 id="spend-banks-heading" ref={heading} tabIndex={-1}>Banks</h3>
      {linkError && (
        <p ref={linkErrorRef} tabIndex={-1} className={linkError === 'exited' ? 'notice' : 'error'} role={linkError === 'exited' ? 'status' : 'alert'}>
          {PLAID_LINK_ERRORS[linkError]}
        </p>
      )}
      <p className="muted">
        Connect a bank through Plaid to bring in its cards' transactions and statement dates automatically. They're checked every 6 hours, and
        Refresh checks now.
      </p>
      {banks.isPending ? (
        <p className="muted">Loading…</p>
      ) : !data ? (
        <p className="error">{banks.error?.message}</p>
      ) : (
        <BanksBody
          data={data}
          now={serverNowEstimate(data.serverNow, banks.dataUpdatedAt, clientNow)}
          timeZone={timeZone}
          busy={busy}
          error={error}
          picking={picking}
          removing={removing}
          focus={focus}
          dismissing={dismiss.isPending}
          noticeError={noticeError}
          connectWarning={connectWarned && unloaded.length > 0 ? connectWarningLine(unloaded) : null}
          onConnect={onConnect}
          onDismiss={(id) => {
            if (dismiss.isPending) return;
            setNoticeError(null);
            setStatus('');
            dismiss.mutate(id);
          }}
          onPick={(bank) => {
            setError(null);
            setPicking(bank.id);
            focus.focusLater(() => focus.get(`pick-${bank.id}`));
          }}
          onCancelPick={(bank) => {
            setPicking(null);
            setError(null);
            focus.focusLater(() => focus.get(`choose-${bank.id}`) ?? focus.get(`bank-${bank.id}`));
          }}
          onSavePick={(bank, choices) => run({ kind: 'pick', bankId: bank.id, name: bankName(bank), choices })}
          onRefresh={(bank) => run({ kind: 'refresh', bankId: bank.id, name: bankName(bank) })}
          onLoad={(bank) => run({ kind: 'load', bankId: bank.id, name: bankName(bank) })}
          onRemove={(bank) => {
            setError(null);
            setRemoving(bank.id);
          }}
        />
      )}
      {data && removing !== null && data.banks.some((b) => b.id === removing) && (
        <RemoveBankDialog
          bank={data.banks.find((b) => b.id === removing)!}
          busy={busy}
          error={error?.bankId === removing && error.kind === 'remove' ? error.message : null}
          returnFocus={() => {
            const button = focus.get(`remove-${removing}`);
            return button?.isConnected ? button : heading.current;
          }}
          onRemove={(deleteTransactions) => {
            const bank = data.banks.find((b) => b.id === removing)!;
            run({ kind: 'remove', bankId: bank.id, name: bankName(bank), deleteTransactions });
          }}
          onClose={() => setRemoving(null)}
        />
      )}
      <p role="status" className="muted todo-status">{orphanError ?? status}</p>
    </section>
  );
}

/** The Trial count, Connect bank, the banks with their actions, and removed banks. */
function BanksBody(props: {
  data: BanksView;
  now: number;
  timeZone: string;
  busy: boolean;
  error: BankError | null;
  picking: number | null;
  removing: number | null;
  focus: ReturnType<typeof useFocusRegistry>;
  dismissing: boolean;
  noticeError: string | null;
  connectWarning: string | null;
  onConnect: (e: ReactMouseEvent) => void;
  onDismiss: (id: number) => void;
  onPick: (bank: BankView) => void;
  onCancelPick: (bank: BankView) => void;
  onSavePick: (bank: BankView, choices: BankPickChoice[]) => void;
  onRefresh: (bank: BankView) => void;
  onLoad: (bank: BankView) => void;
  onRemove: (bank: BankView) => void;
}) {
  const { data, now, timeZone, busy, error, focus } = props;
  const trial = trialLines(data.trial);
  return (
    <>
      {data.keyMismatch && (
        <p className="notice" role="status">
          Banks can't be connected, refreshed, or removed until the server's encryption key is fixed. The System section of the Admin page says how.
        </p>
      )}
      {data.notices.map((n) => (
        // A removal Plaid never confirmed: lasting until dismissed, here or on the System page (review G4-M9).
        <div key={n.id} className="notice spend-bank-notice">
          <p id={`spend-bank-notice-${n.id}`}>{n.message}</p>
          <button type="button" aria-describedby={`spend-bank-notice-${n.id}`} aria-disabled={props.dismissing} onClick={() => props.onDismiss(n.id)}>
            Dismiss
          </button>
        </div>
      ))}
      {props.noticeError && <p className="error" role="alert">{props.noticeError}</p>}
      <p className="muted">{trial.used}</p>
      {trial.warning && <p className="notice">{trial.warning}</p>}
      {!data.keyMismatch && (
        <p>
          {/* A full page load: the Link page runs under its own CSP, outside the app. */}
          <a className="button primary" href={CONNECT_BANK_PATH} onClick={props.onConnect}>Connect bank</a>
        </p>
      )}
      {props.connectWarning && !data.keyMismatch && <p className="notice" role="alert">{props.connectWarning}</p>}
      {data.banks.length === 0 ? (
        <p className="muted">No banks connected.</p>
      ) : (
        <ul className="todo-list" aria-label="Connected banks">
          {data.banks.map((b) => {
            const name = bankName(b);
            const shown = error?.bankId === b.id ? error : null;
            // The pick and the dialog show their own failures while they're open.
            const rowError = shown && !(shown.kind === 'pick' && props.picking === b.id) && shown.kind !== 'remove' ? shown.message : null;
            const removeError = shown?.kind === 'remove' && props.removing !== b.id ? shown.message : null;
            const disconnect = plaidDate(b.disconnectAt, timeZone);
            const consent = plaidDate(b.consentExpiresAt, timeZone);
            const pickable = pickableAccounts(b).length > 0;
            const loadButton = (
              <button ref={focus.reg(`load-${b.id}`)} type="button" aria-label={`Load accounts from ${name}`} aria-disabled={busy} onClick={() => props.onLoad(b)}>
                Load accounts
              </button>
            );
            return (
              <li key={b.id} className="todo-row chore-row spend-settings-row">
                <div className="todo-main">
                  <h4 ref={focus.reg(`bank-${b.id}`)} tabIndex={-1} className="todo-title spend-bank-name">{name}</h4>
                  <span className={b.status === 'ok' ? 'todo-due' : 'todo-due warning'}>{bankStatusLine(b, now)}</span>
                  {b.lastError && <span className="todo-due warning">{b.lastError}</span>}
                  <ul className="spend-bank-accounts" aria-label={`Accounts at ${name}`}>
                    {b.accounts.map((a) => (
                      <li key={a.accountId} className="todo-due">
                        {accountLabel(a)}: {a.card ? `on ${cardName(a.card)}` : ACCOUNT_STATE_LINES[a.state as 'skipped' | 'waiting']}
                      </li>
                    ))}
                  </ul>
                </div>
                <span className="todo-actions chore-actions">
                  {!b.accountsLoaded && !data.keyMismatch && loadButton}
                  {pickable && !data.keyMismatch && (
                    <button
                      ref={focus.reg(`choose-${b.id}`)}
                      type="button"
                      aria-expanded={props.picking === b.id}
                      aria-label={`Choose cards for ${name}`}
                      onClick={() => (props.picking === b.id ? props.onCancelPick(b) : props.onPick(b))}
                    >
                      Choose cards
                    </button>
                  )}
                  {/* Hidden only before the first pick: a bank with a new account waiting still syncs (review G4-M4). */}
                  {b.picked && !data.keyMismatch && (
                    <button type="button" aria-label={`Refresh ${name}`} aria-disabled={busy} onClick={() => props.onRefresh(b)}>
                      Refresh
                    </button>
                  )}
                  {b.fix !== 'remove' && !data.keyMismatch && (
                    <a className={b.status === 'needs_reconnect' ? 'button primary' : 'button'} href={reconnectHref(b.id)} aria-label={`Reconnect ${name}`} onClick={leaveForLink}>
                      Reconnect
                    </a>
                  )}
                  {!data.keyMismatch && (
                    <button ref={focus.reg(`remove-${b.id}`)} type="button" aria-label={`Remove ${name}`} aria-disabled={busy} onClick={() => !busy && props.onRemove(b)}>
                      Remove
                    </button>
                  )}
                </span>
                {!b.accountsLoaded ? (
                  <p className="notice spend-form-note">{notLoadedLine(name)}</p>
                ) : (
                  b.needsPick && props.picking !== b.id && (
                    <p className="notice spend-form-note">Choose cards for this bank's accounts. It isn't synced until you do.</p>
                  )
                )}
                {b.fix === 'reconnect_or_remove' && <p className="notice spend-form-note">{revokedLine(name)}</p>}
                {b.newAccountsAt && b.accountsLoaded && !data.keyMismatch && (
                  <div className="notice spend-form-note spend-bank-new">
                    <p>{newAccountsLine(name)}</p>
                    <span className="todo-actions">
                      {loadButton}
                      <a className="button" href={addAccountsHref(b.id)} aria-label={`Add accounts from ${name}`} onClick={leaveForLink}>Add accounts</a>
                    </span>
                  </div>
                )}
                {disconnect ? (
                  <p className="notice spend-form-note">Reconnect {name} before {disconnect}, or it stops syncing.</p>
                ) : (
                  consent && <p className="muted spend-form-note">{name} has agreed to share data until {consent}. Reconnect before then to keep it syncing.</p>
                )}
                {b.missingCards.map((c) => (
                  <p key={c.id} className="notice spend-form-note">{missingCardLine(name, c, pickable)}</p>
                ))}
                {rowError && <p className="error spend-form-note" role="alert">{rowError}</p>}
                {removeError && <p className="error spend-form-note" role="alert">{removeError}</p>}
                {props.picking === b.id && pickable && (
                  <BankPick
                    bank={b}
                    attachable={data.attachableCards}
                    busy={busy}
                    error={shown?.kind === 'pick' ? shown.message : null}
                    legendRef={focus.reg(`pick-${b.id}`)}
                    onSave={(choices) => props.onSavePick(b, choices)}
                    onCancel={() => props.onCancelPick(b)}
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
      {data.removed.length > 0 && (
        <>
          <h4 className="spend-bank-subhead">Removed banks</h4>
          <ul className="todo-list" aria-label="Removed banks">
            {data.removed.map((r) => {
              // The copy follows how it was removed: its transactions kept or deleted, or a key reset.
              const lines = removedBankLines(r, timeZone);
              return (
                <li key={r.id} className="todo-row">
                  <span className="todo-main">
                    <span className="todo-title">{bankName(r)}</span>
                    <span className="todo-due">{lines.when}</span>
                    {lines.cards && <span className="todo-due">{lines.cards}</span>}
                    {/* A removal Plaid hasn't confirmed stays visible until it does (review C-W-I2). */}
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
