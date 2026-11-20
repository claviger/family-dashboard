import { useState, type FormEvent } from 'react';
import { isAmountInput, parseCentsInputUpTo } from '../../../shared/money.js';
import {
  SAVINGS_GROUP_CHOICES, SAVINGS_MAX_BALANCE_CENTS, SAVINGS_MESSAGES, type SavingsAccountKind, type SavingsGroupChoice, type SavingsImportProfileView, type SavingsImportRecord,
  type SavingsSetBalanceInput, type SavingsSettingsView,
} from '../../../shared/savings.js';
import { ApiError, isOutcomeUnknown } from '../../api.js';
import { todayIn } from '../calendar/calendarView.js';
import { useFocusRegistry } from '../chores/useFocus.js';
import { NO_ANSWER } from '../spend/plaidText.js';
import { SavingsCsvImport } from './CsvImport.js';
import { CHOICE_LABELS, groupName, importNames, importRecordLine, profileLine, undoWarning } from './format.js';
import { useSavingsAccountAction, type SavingsAccountAction } from './queries.js';

const fileOf = (name: string | null) => name ?? 'the file';

export function accountDoneLine(v: SavingsAccountAction, view: SavingsSettingsView): string {
  switch (v.kind) {
    case 'add': return `Added ${v.name}.`;
    case 'patch': return v.patch.hidden === true ? `Hid ${v.name}.` : v.patch.hidden === false ? `${v.name} is shown again.` : `Renamed ${v.name} to ${v.patch.nickname}.`;
    case 'balance': return `Saved the balance for ${v.name}.`;
    case 'removeHand': return `Removed ${v.name}. ${v.deleteData ? 'Its balances, deposits and withdrawals were deleted.' : 'Its history is kept for past months.'}`;
    case 'commit': return view.message ?? `Imported into ${v.name}.`;
    case 'undo': return view.message ?? `Undid the import of ${fileOf(v.fileName)}.`;
    case 'editProfile': return `Saved the import settings for ${v.name}. They apply from the next import.`;
    case 'clearProfile': return `Cleared the import settings for ${v.name}. The next import starts fresh.`;
  }
}

export function accountFailedLine(v: SavingsAccountAction, err: Error): string {
  if (isOutcomeUnknown(err)) return `${NO_ANSWER} Reload the page to check whether ${v.name} changed before trying again.`;
  const what = {
    add: `add ${v.name}`, patch: `save ${v.name}`, balance: `save the balance for ${v.name}`, removeHand: `remove ${v.name}`, commit: `import into ${v.name}`,
    undo: `undo the import of ${fileOf(v.kind === 'undo' ? v.fileName : null)}`, editProfile: `save the import settings for ${v.name}`, clearProfile: `clear the import settings for ${v.name}`,
  }[v.kind];
  return `Couldn't ${what}. ${err.message}`;
}

type Open = 'balance' | 'import' | 'profile' | null;

/**
 * An account's Set balance, Import a CSV, recent imports with Undo, and saved import settings with
 * Edit and Clear (the CSV import spec, "Accounts", "Importing", "Saved per account"). Every account
 * in Savings settings that isn't removed has them, linked or added by hand. Undo asks first when a
 * later import skipped rows as already here (the record's `overlaps`). Its own status line says
 * what happened; the server's refusals (a day Plaid has, say) show as they're worded.
 */
export function AccountTools(props: { accountId: number; label: string; kind: SavingsAccountKind; imports: readonly SavingsImportRecord[]; profile: SavingsImportProfileView | null; timeZone: string }) {
  const { accountId, label } = props;
  const focus = useFocusRegistry();
  const [open, setOpen] = useState<Open>(null);
  const [confirmUndo, setConfirmUndo] = useState<number | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const action = useSavingsAccountAction({
    onError: (v, err) => {
      setStatus('');
      setError(accountFailedLine(v, err));
      // An expired draft can't be imported: back to the buttons, where Import a CSV starts again.
      if (v.kind === 'commit' && err instanceof ApiError && err.status === 404) {
        setOpen(null);
        focus.focusLater(() => focus.get('import'), v.from);
      }
    },
    onSuccess: (v, view) => {
      setError(null);
      setStatus(accountDoneLine(v, view));
      setConfirmUndo(null);
      // The form goes away: focus goes back to the button that opened it, unless the admin moved on.
      if (v.kind === 'balance') {
        setOpen(null);
        focus.focusLater(() => focus.get('balance'), v.from);
      } else if (v.kind === 'commit' || v.kind === 'undo') {
        setOpen(null);
        focus.focusLater(() => focus.get('import'), v.from);
      } else if (v.kind === 'editProfile' || v.kind === 'clearProfile') {
        setOpen(null);
        focus.focusLater(() => (v.kind === 'editProfile' ? focus.get('profile') : null) ?? focus.get('import'), v.from);
      }
    },
  });
  const busy = action.isPending;
  const send = (v: SavingsAccountAction) => {
    if (busy) return;
    setError(null);
    setStatus('');
    action.mutate(v);
  };
  // Opening another form, or toggling this one shut, unmounts an open import, which cancels its draft.
  const toggle = (which: Exclude<Open, null>) => {
    setError(null);
    setOpen(open === which ? null : which);
  };
  /** Cancel or Close: the form goes, and focus goes back to the button that opened it. */
  const closeTo = (button: 'balance' | 'import' | 'profile') => () => {
    setOpen(null);
    focus.focusLater(() => focus.get(button));
  };
  const names = importNames(props.imports, props.timeZone);
  const undo = (r: SavingsImportRecord) => send({ kind: 'undo', accountId, name: label, importId: r.id, fileName: r.fileName });
  return (
    <div className="savings-tools">
      <span className="todo-actions">
        <button ref={focus.reg('balance')} type="button" aria-expanded={open === 'balance'} aria-label={`Set balance for ${label}`} onClick={() => toggle('balance')}>Set balance</button>
        <button ref={focus.reg('import')} type="button" aria-expanded={open === 'import'} aria-label={`Import a CSV into ${label}`} onClick={() => toggle('import')}>Import a CSV</button>
      </span>
      {open === 'balance' && <SetBalanceForm label={label} timeZone={props.timeZone} busy={busy} onSave={(input) => send({ kind: 'balance', accountId, name: label, input })} onCancel={closeTo('balance')} />}
      {open === 'import' && (
        <SavingsCsvImport accountId={accountId} label={label} busy={busy} onImport={(draftId) => send({ kind: 'commit', accountId, name: label, draftId })} onClose={closeTo('import')} />
      )}
      {props.profile && (
        <p className="todo-due savings-tool-line">
          <span>{profileLine(props.profile)}</span>
          <span className="todo-actions">
            <button ref={focus.reg('profile')} type="button" aria-expanded={open === 'profile'} aria-label={`Edit the import settings for ${label}`} onClick={() => toggle('profile')}>Edit</button>
            <button type="button" aria-label={`Clear the import settings for ${label}`} aria-disabled={busy} onClick={() => send({ kind: 'clearProfile', accountId, name: label })}>Clear</button>
          </span>
        </p>
      )}
      {open === 'profile' && props.profile && (
        <ProfileEditor profile={props.profile} label={label} busy={busy} onSave={(choices) => send({ kind: 'editProfile', accountId, name: label, choices })} onCancel={closeTo('profile')} />
      )}
      {props.imports.length > 0 && (
        <ul className="savings-imports" aria-label={`Imports into ${label}`}>
          {props.imports.map((r) => {
            const warning = undoWarning(r);
            // The upload day (and time, when needed) keeps two imports of the same file apart.
            const name = `${names.get(r.id)!}, into ${label}`;
            return (
              <li key={r.id} className="todo-due savings-tool-line">
                <span>{importRecordLine(r, props.timeZone)}</span>
                {confirmUndo === r.id ? (
                  <span className="notice savings-undo-confirm" role="group" aria-label={`Undo the import of ${name}?`}>
                    <span>{warning}</span>
                    <span className="todo-actions">
                      <button type="button" className="primary" aria-label={`Undo the import of ${name} anyway`} aria-disabled={busy} onClick={() => undo(r)}>Undo anyway</button>
                      <button type="button" aria-label={`Keep the import of ${name}`} onClick={() => setConfirmUndo(null)}>Keep it</button>
                    </span>
                  </span>
                ) : (
                  <button
                    type="button"
                    aria-label={`Undo the import of ${name}`}
                    aria-disabled={busy}
                    onClick={() => {
                      if (busy) return;
                      if (warning) setConfirmUndo(r.id);
                      else undo(r);
                    }}
                  >
                    Undo
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {error && <p className="error spend-form-note" role="alert">{error}</p>}
      <p role="status" className="muted todo-status">{status}</p>
    </div>
  );
}

/** Set balance: an amount as typed, for today or an earlier day. The server refuses a day Plaid has, and the message says so. */
function SetBalanceForm(props: { label: string; timeZone: string; busy: boolean; onSave: (input: SavingsSetBalanceInput) => void; onCancel: () => void }) {
  const today = todayIn(props.timeZone);
  const [amount, setAmount] = useState('');
  const [date, setDate] = useState(today);
  const [problem, setProblem] = useState<string | null>(null);
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (props.busy) return;
    if (!isAmountInput(amount)) return setProblem(SAVINGS_MESSAGES.balanceAmount);
    // Negative is fine (overdrawn); the limit is Set balance's own.
    if (parseCentsInputUpTo(amount, SAVINGS_MAX_BALANCE_CENTS) === null) return setProblem(SAVINGS_MESSAGES.balanceTooBig);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return setProblem('Pick the day the balance is for.');
    if (date > today) return setProblem(SAVINGS_MESSAGES.balanceFuture);
    setProblem(null);
    props.onSave({ amount: amount.trim(), date });
  }
  return (
    <form className="form-row savings-balance-form" aria-label={`Set the balance of ${props.label}`} onSubmit={submit} noValidate>
      <label>Balance<input type="text" inputMode="decimal" autoComplete="off" value={amount} aria-invalid={problem ? true : undefined} onChange={(e) => setAmount(e.target.value)} /></label>
      <label>For the day<input type="date" value={date} min="2000-01-01" max={today} onChange={(e) => setDate(e.target.value)} /></label>
      <button type="submit" className="primary" aria-disabled={props.busy}>Save balance</button>
      <button type="button" onClick={props.onCancel}>Cancel</button>
      <p className="muted spend-form-note">A balance from Plaid for the same day replaces it.</p>
      {problem && <p className="error spend-form-note" role="alert">{problem}</p>}
    </form>
  );
}

/** Edit: each saved group's choice (plan decision 16). The columns change on the next import; past imports keep what they stored. */
function ProfileEditor(props: { profile: SavingsImportProfileView; label: string; busy: boolean; onSave: (choices: Record<string, SavingsGroupChoice>) => void; onCancel: () => void }) {
  const [choices, setChoices] = useState<Record<string, SavingsGroupChoice>>(() => Object.fromEntries(props.profile.groups.map((g) => [g.label, g.choice])));
  return (
    <form className="event-form" aria-label={`Import settings for ${props.label}`} onSubmit={(e) => { e.preventDefault(); if (!props.busy) props.onSave(choices); }}>
      <p className="muted">What each saved group counts as on the next import. Past imports keep what they added; Undo and import again to change them.</p>
      {props.profile.groups.length === 0 ? <p className="muted">No groups saved.</p> : (
        <ul className="todo-list savings-groups" aria-label={`Saved groups for ${props.label}`}>
          {props.profile.groups.map((g) => (
            <li key={g.label} className="todo-row">
              <label className="savings-group">
                <span className="savings-group-name">{groupName(g.label)}</span>
                <select aria-label={`What ${groupName(g.label)} rows count as`} value={choices[g.label]} onChange={(e) => setChoices((c) => ({ ...c, [g.label]: e.target.value as SavingsGroupChoice }))}>
                  {SAVINGS_GROUP_CHOICES.map((c) => <option key={c} value={c}>{CHOICE_LABELS[c]}</option>)}
                </select>
              </label>
            </li>
          ))}
        </ul>
      )}
      <span className="todo-actions">
        <button type="submit" className="primary" aria-disabled={props.busy}>Save settings</button>
        <button type="button" onClick={props.onCancel}>Cancel</button>
      </span>
    </form>
  );
}
