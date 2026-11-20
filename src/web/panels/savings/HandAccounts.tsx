import { useEffect, useRef, useState } from 'react';
import { SAVINGS_NICKNAME_MAX, type SavingsAccountKind, type SavingsHandAccount, type SavingsImportProfileView, type SavingsImportRecord } from '../../../shared/savings.js';
import { useMe } from '../../shell/useMe.js';
import { Modal } from '../calendar/Modal.js';
import { AccountTools, accountDoneLine, accountFailedLine } from './AccountTools.js';
import { handBalanceLine } from './format.js';
import { useSavingsAccountAction, useSavingsSettings, type SavingsAccountAction } from './queries.js';

/**
 * Accounts added by hand (the CSV import spec, "Accounts"; admins only, and the server checks): Add
 * an account by hand, then each one's balance line (where it came from: imported or set by hand),
 * rename, hide, Remove (keeping its history, or with "Also delete its data"), and its AccountTools.
 * A removed one is listed by name only: no Set balance or Import. Works with or without Plaid.
 */
export function HandAccounts() {
  const me = useMe().data!;
  const settings = useSavingsSettings();
  const heading = useRef<HTMLHeadingElement>(null);
  const [nickname, setNickname] = useState('');
  const [kind, setKind] = useState<SavingsAccountKind>('cash');
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [nicknameMissing, setNicknameMissing] = useState(false);
  const [removing, setRemoving] = useState<SavingsHandAccount | null>(null);
  const action = useSavingsAccountAction({
    onError: (v, err) => {
      setStatus('');
      setError(accountFailedLine(v, err));
    },
    onSuccess: (v, view) => {
      setError(null);
      setStatus(accountDoneLine(v, view));
      if (v.kind === 'add') setNickname('');
      if (v.kind === 'removeHand') setRemoving(null);
    },
  });
  const busy = action.isPending;
  const send = (v: SavingsAccountAction) => {
    if (busy) return;
    setError(null);
    setStatus('');
    action.mutate(v);
  };
  const data = settings.data;
  const live = data?.handAccounts.filter((a) => !a.removed) ?? [];
  const removed = data?.handAccounts.filter((a) => a.removed) ?? [];
  return (
    <section aria-labelledby="savings-hand-heading" className="admin-section spend-settings">
      <h3 id="savings-hand-heading" ref={heading} tabIndex={-1}>Accounts added by hand</h3>
      <p className="muted">For an account Plaid doesn't bring in. Import its bank's CSV for past balances and money in and out, or set its balance by hand.</p>
      <form
        className="form-row savings-hand-add"
        aria-label="Add an account by hand"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (busy) return;
          if (nickname.trim() === '') {
            setNicknameMissing(true);
            return setError('Give the account a nickname.');
          }
          setNicknameMissing(false);
          send({ kind: 'add', name: nickname.trim(), input: { nickname: nickname.trim(), kind } });
        }}
      >
        <label>
          Nickname
          <input type="text" maxLength={SAVINGS_NICKNAME_MAX} value={nickname} aria-invalid={nicknameMissing || undefined} onChange={(e) => setNickname(e.target.value)} />
        </label>
        <label>
          Kind
          <select value={kind} onChange={(e) => setKind(e.target.value as SavingsAccountKind)}>
            <option value="cash">Cash</option>
            <option value="investment">Investment</option>
          </select>
        </label>
        <button type="submit" className="primary" aria-disabled={busy}>Add account</button>
      </form>
      {settings.isPending ? <p className="muted">Loading…</p> : !data ? <p className="error">{settings.error?.message}</p> : live.length === 0 ? <p className="muted">No accounts added by hand.</p> : (
        <ul className="todo-list" aria-label="Accounts added by hand">
          {live.map((a) => (
            <HandRow
              key={a.id}
              a={a}
              imports={data.imports.filter((r) => r.accountId === a.id)}
              profile={data.profiles.find((p) => p.accountId === a.id) ?? null}
              timeZone={me.family.timeZone}
              busy={busy}
              send={send}
              onRemove={() => {
                setError(null);
                setRemoving(a);
              }}
            />
          ))}
        </ul>
      )}
      {removed.length > 0 && <p className="muted">Removed, with their history kept for past months: {removed.map((a) => a.nickname).join(', ')}.</p>}
      {/* While the Remove dialog is open, it shows the failure itself. */}
      {error && !removing && <p className="error" role="alert">{error}</p>}
      <p role="status" className="muted todo-status">{status}</p>
      {removing && (
        <RemoveHandDialog
          a={removing}
          busy={busy}
          error={error}
          returnFocus={() => heading.current}
          onRemove={(deleteData) => send({ kind: 'removeHand', accountId: removing.id, name: removing.nickname, deleteData })}
          onClose={() => setRemoving(null)}
        />
      )}
    </section>
  );
}

function HandRow(props: {
  a: SavingsHandAccount; imports: readonly SavingsImportRecord[]; profile: SavingsImportProfileView | null; timeZone: string; busy: boolean; send: (v: SavingsAccountAction) => void; onRemove: () => void;
}) {
  const { a } = props;
  const [nickname, setNickname] = useState(a.nickname);
  // A rename saved elsewhere (or the server's trim) is the new starting point.
  useEffect(() => setNickname(a.nickname), [a.nickname]);
  const changed = nickname.trim() !== '' && nickname.trim() !== a.nickname;
  return (
    <li className="todo-row chore-row spend-settings-row">
      <div className="todo-main">
        <h4 className="todo-title spend-bank-name">{a.nickname}</h4>
        <span className="todo-due">{a.kind === 'investment' ? 'Investment' : 'Cash'}, {a.hidden ? 'hidden from Savings' : 'shown'}. {handBalanceLine(a.latest)}</span>
      </div>
      <span className="todo-actions chore-actions">
        <button
          type="button"
          aria-label={a.hidden ? `Show ${a.nickname} again` : `Hide ${a.nickname}`}
          aria-disabled={props.busy}
          onClick={() => !props.busy && props.send({ kind: 'patch', accountId: a.id, name: a.nickname, patch: { hidden: !a.hidden } })}
        >
          {a.hidden ? 'Show again' : 'Hide'}
        </button>
        <button type="button" aria-label={`Remove ${a.nickname}`} aria-disabled={props.busy} onClick={() => !props.busy && props.onRemove()}>Remove</button>
      </span>
      <form
        className="form-row savings-account-form savings-hand-rename"
        onSubmit={(e) => {
          e.preventDefault();
          if (!props.busy && changed) props.send({ kind: 'patch', accountId: a.id, name: a.nickname, patch: { nickname: nickname.trim() } });
        }}
      >
        <label>
          Nickname
          <input type="text" maxLength={SAVINGS_NICKNAME_MAX} value={nickname} aria-label={`Nickname for ${a.nickname}`} onChange={(e) => setNickname(e.target.value)} />
        </label>
        <button type="submit" aria-label={`Rename ${a.nickname}`} aria-disabled={props.busy || !changed}>Rename</button>
      </form>
      <AccountTools accountId={a.id} label={a.nickname} kind={a.kind} imports={props.imports} profile={props.profile} timeZone={props.timeZone} />
    </li>
  );
}

/** Remove a hand-added account: kept for past months, or with "Also delete its data". Once sent it can't be stopped, so Cancel waits. */
function RemoveHandDialog(props: {
  a: SavingsHandAccount;
  busy: boolean;
  error: string | null;
  returnFocus: () => HTMLElement | null | undefined;
  onRemove: (deleteData: boolean) => void;
  onClose: () => void;
}) {
  const [deleteData, setDeleteData] = useState(false);
  const name = props.a.nickname;
  return (
    <Modal labelledBy="savings-hand-remove-title" onClose={props.onClose} returnFocus={props.returnFocus} locked={props.busy}>
      <h3 id="savings-hand-remove-title">Remove {name}?</h3>
      <p>{name} leaves the home card and the graph, and keeps its balances, deposits and withdrawals for past months unless you tick the box.</p>
      <form
        className="event-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!props.busy) props.onRemove(deleteData);
        }}
      >
        <label className="inline-check">
          <input type="checkbox" checked={deleteData} aria-describedby="savings-hand-remove-hint" aria-disabled={props.busy} onChange={(e) => !props.busy && setDeleteData(e.target.checked)} />
          Also delete its data
        </label>
        <p id="savings-hand-remove-hint" className="muted">Deletes every balance, deposit, withdrawal, import, and saved import setting the dashboard kept for {name}. This can't be undone.</p>
        {props.error && <p className="error" role="alert">{props.error}</p>}
        <span className="todo-actions">
          <button type="submit" className="primary" aria-disabled={props.busy}>{props.busy ? 'Removing…' : 'Remove'}</button>
          <button type="button" aria-disabled={props.busy} onClick={() => !props.busy && props.onClose()}>Cancel</button>
        </span>
      </form>
    </Modal>
  );
}
