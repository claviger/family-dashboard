import { useRef, useState, type FormEvent } from 'react';
import { CARD_NICKNAME_MAX, type Card, type CardInput, type CardStatements, type Closing, type CsvImportRecord, type ImportUndoResult } from '../../../shared/spend.js';
import { useMe } from '../../shell/useMe.js';
import { useFocusRegistry } from '../chores/useFocus.js';
import { cardName, instantDate, longDate, mappingLines } from './format.js';
import { useCardImportProfile, useCardImports, useCardStatements, useSpendCards, useSpendWrite, type SpendWrite } from './queries.js';

const SOURCE_LABELS: Record<Closing['source'], string> = { manual: 'Set by hand', plaid: 'From the bank', inferred: 'From the usual closing day' };

/** An undo of a CSV import: DELETE /cards/:id/imports/:importId. */
const UNDO_PATH = /^\/cards\/(\d+)\/imports\/\d+$/;

/** "add", "delete", "undo", or "save", for "Couldn't … X". */
function failedVerb(v: SpendWrite): string {
  if (/\/import-profile$/.test(v.path)) return 'clear';
  if (UNDO_PATH.test(v.path)) return 'undo';
  if (v.method === 'DELETE') return 'delete';
  if (v.method === 'POST' && !/\/(archive|unarchive|move|apply)$/.test(v.path)) return 'add';
  return 'save';
}

/**
 * The card form: a nickname, an optional last 4, included or not, and the usual closing day (spec
 * §12.4). Checked here before sending (the server checks again), like the other forms: a problem
 * focuses its field, marks it `aria-invalid`, and points it at the message.
 */
function CardForm(props: { name: string; initial: CardInput; submitLabel: string; busy: boolean; onSubmit: (input: CardInput) => void; onCancel: () => void }) {
  const [v, setV] = useState(props.initial);
  const [problem, setProblem] = useState<{ field: 'nickname' | 'mask'; error: string } | null>(null);
  const nickname = useRef<HTMLInputElement>(null);
  const mask = useRef<HTMLInputElement>(null);
  const id = props.name.replace(/\W+/g, '-').toLowerCase();
  const invalid = (field: 'nickname' | 'mask', hint?: string) =>
    problem?.field === field ? { 'aria-invalid': true as const, 'aria-describedby': `${id}-problem` } : hint ? { 'aria-describedby': hint } : {};
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // While a save is out the button is aria-disabled, not disabled, so focus stays on it if the save fails.
    if (props.busy) return;
    const m = (v.mask ?? '').trim();
    const found =
      v.nickname.trim() === ''
        ? { field: 'nickname' as const, error: 'Enter a nickname.' }
        : m !== '' && !/^[0-9A-Za-z]{2,4}$/.test(m)
          ? { field: 'mask' as const, error: 'Enter the last 2 to 4 characters of the card number, or leave it empty.' }
          : null;
    setProblem(found);
    if (found) {
      (found.field === 'nickname' ? nickname : mask).current?.focus();
      return;
    }
    props.onSubmit({ ...v, nickname: v.nickname.trim(), mask: m });
  }
  return (
    <form className="todo-form form-row" aria-label={props.name} onSubmit={submit} noValidate>
      <label>
        Nickname
        <input ref={nickname} autoFocus maxLength={CARD_NICKNAME_MAX} value={v.nickname} onChange={(e) => setV({ ...v, nickname: e.target.value })} {...invalid('nickname')} />
      </label>
      <label>
        Last 4 (optional)
        <input
          ref={mask}
          inputMode="numeric"
          maxLength={4}
          value={v.mask ?? ''}
          onChange={(e) => setV({ ...v, mask: e.target.value })}
          {...invalid('mask', `${id}-mask-hint`)}
        />
      </label>
      <label>
        Usual closing day
        <select
          value={v.usualClosingDay ?? ''}
          aria-describedby={`${id}-day-hint`}
          onChange={(e) => setV({ ...v, usualClosingDay: e.target.value === '' ? null : Number(e.target.value) })}
        >
          <option value="">Not set</option>
          {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
      </label>
      <label className="inline-check">
        <input type="checkbox" checked={v.included} onChange={(e) => setV({ ...v, included: e.target.checked })} />
        Show it in Spend
      </label>
      <p id={`${id}-mask-hint`} className="muted spend-form-note">Only the last 2 to 4 characters, never the whole card number.</p>
      <p id={`${id}-day-hint`} className="muted spend-form-note">
        The day each statement closes. Days after the 28th move to the month's last day in shorter months. Without it, spending is grouped by calendar month.
      </p>
      {problem && <p id={`${id}-problem`} className="error spend-form-note" role="alert">{problem.error}</p>}
      <span className="todo-actions spend-form-note">
        <button type="submit" className="primary" aria-disabled={props.busy}>{props.submitLabel}</button>
        <button type="button" onClick={props.onCancel}>Cancel</button>
      </span>
    </form>
  );
}

/**
 * A card's closing dates (spec §12.4): add and edit manual ones; an inferred one is changed by adding
 * a manual date. A date being added stays in its field until the server takes it. After a date is
 * added or deleted, focus goes to the add field, which is always
 * there. After a change is saved, it goes to that date's Change button in its new place (the
 * buttons are disabled while a write is out, so it waits for the refreshed list), and Cancel goes
 * back to the Change button.
 */
function ClosingDates({ card, write, busy }: { card: Card; write: (v: SpendWrite) => void; busy: boolean }) {
  const statements = useCardStatements(card.id);
  const focus = useFocusRegistry();
  const [adding, setAdding] = useState('');
  const [editing, setEditing] = useState<{ id: number; date: string } | null>(null);
  const addField = useRef<HTMLInputElement>(null);
  if (statements.isPending) return <p className="muted">Loading…</p>;
  if (!statements.data) return <p className="error">{statements.error?.message}</p>;
  const data: CardStatements = statements.data;
  return (
    <section aria-label={`Closing dates for ${card.nickname}`} className="spend-closings">
      {data.mode === 'calendar_month' && <p className="notice">No closing day or date is set, so this card is grouped by calendar month.</p>}
      <ul className="todo-list">
        {data.closings.map((c) => (
          <li key={c.id ?? c.date} className="todo-row chore-row">
            {editing && editing.id === c.id ? (
              <form
                className="form-row"
                aria-label={`Change the closing date ${longDate(c.date)}`}
                onSubmit={(e) => {
                  e.preventDefault();
                  const id = editing.id;
                  write({ method: 'PUT', path: `/statements/${id}`, body: { closingDate: editing.date }, label: `the closing date ${longDate(c.date)}` });
                  setEditing(null);
                  focus.focusLater(() => focus.get(`change-${id}`) ?? addField.current);
                }}
              >
                <label>
                  Closing date
                  <input type="date" required autoFocus value={editing.date} onChange={(e) => setEditing({ ...editing, date: e.target.value })} />
                </label>
                <button type="submit" className="primary">Save</button>
                <button
                  type="button"
                  onClick={() => {
                    const id = editing.id;
                    setEditing(null);
                    focus.focusLater(() => focus.get(`change-${id}`));
                  }}
                >
                  Cancel
                </button>
              </form>
            ) : (
              <>
                <span className="todo-main">
                  <span className="todo-title">{longDate(c.date)}</span>
                  <span className="todo-due">{SOURCE_LABELS[c.source]}</span>
                </span>
                {c.id !== null && (
                  <span className="todo-actions chore-actions">
                    <button
                      ref={focus.reg(`change-${c.id}`)}
                      type="button"
                      aria-label={`Change the closing date ${longDate(c.date)}`}
                      disabled={busy}
                      onClick={() => setEditing({ id: c.id!, date: c.date })}
                    >
                      Change
                    </button>
                    {c.source === 'manual' && (
                      <button
                        type="button"
                        aria-label={`Delete the closing date ${longDate(c.date)}`}
                        onClick={() => {
                          write({ method: 'DELETE', path: `/statements/${c.id}`, label: `the closing date ${longDate(c.date)}` });
                          addField.current?.focus();
                        }}
                      >
                        Delete
                      </button>
                    )}
                  </span>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
      <form
        className="form-row"
        aria-label={`Add a closing date for ${card.nickname}`}
        onSubmit={(e) => {
          e.preventDefault();
          if (adding === '') return;
          const sent = adding;
          // The field keeps the date until the server takes it, so a refused one can be fixed (review C-M7).
          write({
            method: 'POST',
            path: `/cards/${card.id}/statements`,
            body: { closingDate: sent },
            label: `the closing date ${longDate(sent)}`,
            onDone: () => setAdding((now) => (now === sent ? '' : now)),
          });
          addField.current?.focus();
        }}
      >
        <label>
          Add a closing date
          <input ref={addField} type="date" value={adding} onChange={(e) => setAdding(e.target.value)} />
        </label>
        <button type="submit" disabled={adding === ''}>Add</button>
      </form>
      <p className="muted spend-form-note">A date you add replaces the one worked out from the usual closing day for that statement.</p>
    </section>
  );
}

const importName = (i: CsvImportRecord) => i.fileName ?? 'a file with no name';

/**
 * A card's recent CSV imports, each with "Undo this import" (review C-I1). Undo asks first, then
 * deletes the import's transactions, so the right file can be imported again. The server refuses
 * it when any of them was changed by hand, and says how many. After an undo, focus goes back to
 * the card's Imports button.
 */
function ImportHistory({ card, write, busy, timeZone }: { card: Card; write: (v: SpendWrite) => void; busy: boolean; timeZone: string }) {
  const imports = useCardImports(card.id);
  if (imports.isPending) return <p className="muted">Loading…</p>;
  if (!imports.data) return <p className="error">{imports.error?.message}</p>;
  return (
    <section aria-label={`Imports for ${card.nickname}`} className="spend-closings">
      {imports.data.length === 0 ? (
        <p className="muted">No imports yet.</p>
      ) : (
        <ul className="todo-list">
          {imports.data.map((i) => {
            const name = importName(i);
            const when = instantDate(i.uploadedAt, timeZone);
            const count = `${i.transactionCount} ${i.transactionCount === 1 ? 'transaction' : 'transactions'}`;
            return (
              <li key={i.id} className="todo-row chore-row">
                <span className="todo-main">
                  <span className="todo-title spend-file-name">{name}</span>
                  <span className="todo-due">
                    Imported {when}
                    {i.uploadedBy && ` by ${i.uploadedBy}`} · {count}
                    {i.format === 'custom' && ' · custom columns'}
                  </span>
                </span>
                <span className="todo-actions chore-actions">
                  <button
                    type="button"
                    aria-label={`Undo the import of ${name} from ${when}`}
                    // aria-disabled while a write is out, so focus stays on it if the undo fails.
                    aria-disabled={busy}
                    onClick={() => {
                      if (busy) return;
                      const what = i.transactionCount === 1 ? 'Its 1 transaction is' : `Its ${i.transactionCount} transactions are`;
                      if (!window.confirm(`Undo the import of ${name}? ${what} deleted, and the file can be imported again.`)) return;
                      write({ method: 'DELETE', path: `/cards/${card.id}/imports/${i.id}`, label: `the import of ${name}` });
                    }}
                  >
                    Undo this import
                  </button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <SavedColumns card={card} write={write} busy={busy} />
      <p className="muted spend-form-note">
        Undo deletes an import's transactions, so the file can be imported again. It isn't possible once any of them has a category, person, or note set by hand.
      </p>
    </section>
  );
}

/**
 * A card's saved columns (the generic import design, "Saved per card"), in words, with Clear. The
 * next file whose column names match these exactly is read with them; Clear goes back to a built-in
 * format or a guess.
 */
function SavedColumns({ card, write, busy }: { card: Card; write: (v: SpendWrite) => void; busy: boolean }) {
  const saved = useCardImportProfile(card.id);
  if (saved.isPending) return null;
  if (!saved.data) return <p className="error">{saved.error?.message}</p>;
  const p = saved.data.profile;
  if (!p) return <p className="muted">No saved columns. They're saved when a file is imported.</p>;
  return (
    <section aria-label={`Saved columns for ${card.nickname}`} className="spend-saved-columns">
      <h5>Saved columns</h5>
      <ul>{mappingLines(p.header, p.mapping).map((line) => <li key={line}>{line}</li>)}</ul>
      <p className="muted">Used for the next file whose columns are exactly: {p.header.join(', ')}.</p>
      <button
        type="button"
        aria-disabled={busy}
        onClick={() => {
          if (busy) return;
          write({ method: 'DELETE', path: `/cards/${card.id}/import-profile`, label: `the saved columns for ${card.nickname}`, done: `Cleared the saved columns for ${card.nickname}.` });
        }}
      >
        Clear saved columns
      </button>
    </section>
  );
}

/** "Its 6 transactions were deleted." */
function removedLine(removed: number): string {
  return removed === 1 ? 'Its 1 transaction was deleted.' : `Its ${removed} transactions were deleted.`;
}

/**
 * Spend settings: cards (spec §12.12). A card with transactions can be archived, not deleted; one
 * that rules name shows Delete as unavailable, with why. Each card's recent imports can be undone.
 */
export function CardsSettings() {
  const cards = useSpendCards();
  const timeZone = useMe().data!.family.timeZone;
  const focus = useFocusRegistry();
  const [mode, setMode] = useState<'new' | number | null>(null);
  const [datesFor, setDatesFor] = useState<number | null>(null);
  const [importsFor, setImportsFor] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const write = useSpendWrite<unknown>({
    onError: (v, err) => {
      // An archive's button was disabled while it ran: focus still goes back to it.
      if (!/\/(archive|unarchive)$/.test(v.path)) focus.cancel();
      setError(`Couldn't ${failedVerb(v)} ${v.label}. ${err.message}`);
    },
    onSuccess: (v, data) => {
      const undone = UNDO_PATH.exec(v.path);
      if (undone) {
        setStatus(`Undid ${v.label}. ${removedLine((data as ImportUndoResult).removed)}`);
        // The import's row goes; focus goes to the card's Imports button, unless it has moved on since the undo was sent.
        focus.focusLater(() => focus.get(`imports-${undone[1]}`), v.from);
        return;
      }
      setStatus(v.done ?? `${v.method === 'DELETE' ? 'Deleted' : 'Saved'} ${v.label}.`);
      // Clear saved columns: focus goes back to the card's Imports button, as an undo's does.
      const cleared = /^\/cards\/(\d+)\/import-profile$/.exec(v.path);
      if (cleared) focus.focusLater(() => focus.get(`imports-${cleared[1]}`), v.from);
      const cardEdit = v.method === 'PUT' && /^\/cards\/\d+$/.test(v.path);
      if (v.path === '/cards' || cardEdit) setMode(null);
      // A saved edit goes back to the card's Edit button, in its new place once the list has refreshed
      // (Edit buttons are disabled until then: a new nickname can move the card). Only from the
      // control that sent it: if focus moved on during a slow save, it stays there (review C-M3).
      if (cardEdit) focus.focusLater(() => focus.get(`edit-${v.path.split('/')[2]}`), v.from);
    },
  });
  const run = (v: SpendWrite) => {
    setError(null);
    setStatus('');
    write.mutate(v);
  };

  return (
    <section aria-labelledby="spend-cards-heading" className="admin-section">
      <h3 id="spend-cards-heading" ref={focus.reg('heading')} tabIndex={-1}>Cards</h3>
      {error && <p className="error" role="alert">{error}</p>}
      {cards.isPending ? (
        <p className="muted">Loading…</p>
      ) : !cards.data ? (
        <p className="error">{cards.error?.message}</p>
      ) : (
        <ul className="todo-list">
          {cards.data.map((c) =>
            mode === c.id ? (
              <li key={c.id} className="todo-row editing">
                <CardForm
                  name={`Edit ${c.nickname}`}
                  initial={{ nickname: c.nickname, mask: c.mask ?? '', included: c.included, usualClosingDay: c.usualClosingDay }}
                  submitLabel="Save card"
                  busy={write.isPending}
                  onSubmit={(input) => run({ method: 'PUT', path: `/cards/${c.id}`, body: input, label: input.nickname })}
                  onCancel={() => {
                    setMode(null);
                    focus.focusLater(() => focus.get(`edit-${c.id}`));
                  }}
                />
              </li>
            ) : (
              <li key={c.id} className="todo-row chore-row spend-settings-row">
                <span className="todo-main">
                  <span className="todo-title">
                    {cardName(c)}
                    {c.archived && <>{' '}<span className="chore-badge">Archived</span></>}
                    {!c.included && <>{' '}<span className="chore-badge">Not shown</span></>}
                  </span>
                  <span className="todo-due">
                    {c.usualClosingDay ? `Closes on day ${c.usualClosingDay}` : 'No closing day'} · {c.transactionCount} {c.transactionCount === 1 ? 'transaction' : 'transactions'}
                    {c.lastImportAt && ` · last imported ${instantDate(c.lastImportAt, timeZone)}`}
                    {c.plaidLinked && ' · connected to a bank'}
                  </span>
                  {c.bankRemovedAt && (
                    <span className="todo-due">Bank connection removed {instantDate(c.bankRemovedAt, timeZone)}. The card keeps its history.</span>
                  )}
                </span>
                <span className="todo-actions chore-actions">
                  <button ref={focus.reg(`edit-${c.id}`)} type="button" aria-label={`Edit ${c.nickname}`} disabled={write.isPending} onClick={() => setMode(c.id)}>
                    Edit
                  </button>
                  <button
                    type="button"
                    aria-expanded={datesFor === c.id}
                    aria-label={`Closing dates for ${c.nickname}`}
                    onClick={() => setDatesFor(datesFor === c.id ? null : c.id)}
                  >
                    Closing dates
                  </button>
                  <button
                    ref={focus.reg(`imports-${c.id}`)}
                    type="button"
                    aria-expanded={importsFor === c.id}
                    aria-label={`Imports for ${c.nickname}`}
                    onClick={() => setImportsFor(importsFor === c.id ? null : c.id)}
                  >
                    Imports
                  </button>
                  <button
                    ref={focus.reg(`archive-${c.id}`)}
                    type="button"
                    aria-label={`${c.archived ? 'Unarchive' : 'Archive'} ${c.nickname}`}
                    // Disabled while a write is out (like Move up and down), so focus waits for the refreshed list.
                    disabled={write.isPending}
                    onClick={() => {
                      // Archived cards sort last: focus follows the button to the card's new place.
                      focus.focusLater(() => focus.get(`archive-${c.id}`));
                      run({
                        method: 'POST',
                        path: `/cards/${c.id}/${c.archived ? 'unarchive' : 'archive'}`,
                        label: c.nickname,
                        done: `${c.archived ? 'Unarchived' : 'Archived'} ${c.nickname}.`,
                      });
                    }}
                  >
                    {c.archived ? 'Unarchive' : 'Archive'}
                  </button>
                  {/* A card with transactions is archived instead; one that rules name says so (review C-M2). */}
                  {c.deleteBlocker !== 'transactions' && (
                    <button
                      type="button"
                      aria-label={`Delete ${c.nickname}`}
                      aria-disabled={c.deleteBlocker === 'rules' || undefined}
                      aria-describedby={c.deleteBlocker === 'rules' ? `spend-card-${c.id}-delete-why` : undefined}
                      onClick={() => {
                        if (c.deleteBlocker) return;
                        if (!window.confirm(`Delete ${c.nickname}? Its closing dates go too.`)) return;
                        focus.focusLater(() => focus.get('heading'));
                        run({ method: 'DELETE', path: `/cards/${c.id}`, label: c.nickname });
                      }}
                    >
                      Delete
                    </button>
                  )}
                  {c.deleteBlocker === 'rules' && (
                    <span id={`spend-card-${c.id}-delete-why`} className="todo-due">Rules use this card</span>
                  )}
                </span>
                {datesFor === c.id && <ClosingDates card={c} write={run} busy={write.isPending} />}
                {importsFor === c.id && <ImportHistory card={c} write={run} busy={write.isPending} timeZone={timeZone} />}
              </li>
            ),
          )}
        </ul>
      )}
      {mode === 'new' ? (
        <CardForm
          name="New card"
          initial={{ nickname: '', mask: '', included: true, usualClosingDay: null }}
          submitLabel="Add card"
          busy={write.isPending}
          onSubmit={(input) => {
            focus.focusLater(() => focus.get('new'));
            run({ method: 'POST', path: '/cards', body: input, label: input.nickname });
          }}
          onCancel={() => {
            setMode(null);
            focus.focusLater(() => focus.get('new'));
          }}
        />
      ) : (
        <button ref={focus.reg('new')} type="button" onClick={() => setMode('new')}>New card</button>
      )}
      <p role="status" className="muted todo-status">{status}</p>
    </section>
  );
}
