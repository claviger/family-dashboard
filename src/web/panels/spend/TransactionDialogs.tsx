import { useState } from 'react';
import { NOTE_MAX, type CardOption, type Category, type RuleInput, type SpendPerson, type SpendTransaction } from '../../../shared/spend.js';
import { Modal } from '../calendar/Modal.js';
import { longDate, money } from './format.js';
import { RuleForm } from './RuleForm.js';
import { ruleFormFromTransaction } from './ruleFormValues.js';

/** "Discard your changes?" before closing a dialog with unsaved changes (the Calendar form's convention). */
function closeUnlessKept(dirty: boolean, onClose: () => void) {
  if (!dirty || window.confirm('Discard your changes?')) onClose();
}

/** Adds, edits, or clears a transaction's note (spec §12.12). Anyone with the panel can. */
export function NoteDialog(props: {
  transaction: SpendTransaction;
  busy: boolean;
  error: string | null;
  returnFocus: () => HTMLElement | null | undefined;
  onSave: (note: string | null) => void;
  onClose: () => void;
}) {
  const t = props.transaction;
  const [text, setText] = useState(t.note ?? '');
  const dirty = text !== (t.note ?? '');
  const close = () => closeUnlessKept(dirty, props.onClose);
  return (
    <Modal labelledBy="spend-note-title" onClose={close} returnFocus={props.returnFocus}>
      <h3 id="spend-note-title">Note</h3>
      <p className="muted spend-dialog-merchant">
        {t.merchant}, {longDate(t.date)}, {money(t.amountCents, t.currency)}
      </p>
      <form
        className="event-form"
        onSubmit={(e) => {
          e.preventDefault();
          props.onSave(text.trim() === '' ? null : text);
        }}
      >
        <label className="spend-note-field">
          Note
          <textarea autoFocus rows={4} maxLength={NOTE_MAX} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        {props.error && <p className="error" role="alert">{props.error}</p>}
        <span className="todo-actions">
          <button type="submit" className="primary" disabled={props.busy}>Save note</button>
          {t.note && (
            <button type="button" disabled={props.busy} onClick={() => props.onSave(null)}>Remove note</button>
          )}
          <button type="button" onClick={close}>Cancel</button>
        </span>
      </form>
    </Modal>
  );
}

/**
 * "Add rule" (spec §12.8, admins): a new rule filled in from the transaction,
 * matching text that contains its merchant, with the category and person the row shows (including
 * ones picked but not saved yet). It goes first in the list, so it wins for this merchant, and it's
 * applied to past transactions unless unticked.
 */
export function RuleDialog(props: {
  transaction: SpendTransaction;
  /** The row's unsaved picks: the rule starts from them, over the saved values. */
  draft?: { category?: string; person?: string };
  categories: Category[];
  people: SpendPerson[];
  cards: CardOption[];
  busy: boolean;
  error: string | null;
  returnFocus: () => HTMLElement | null | undefined;
  onSave: (input: RuleInput) => void;
  onClose: () => void;
}) {
  const t = props.transaction;
  return (
    <Modal labelledBy="spend-rule-title" onClose={props.onClose} returnFocus={props.returnFocus} className="spend-rule-dialog">
      <h3 id="spend-rule-title">Add rule</h3>
      <p className="muted">
        A new rule from {t.merchant}, with the category and person it shows now, including changes you haven't saved. It goes to the top of the rules, so it wins over the others.
      </p>
      <RuleForm
        name="New rule from a transaction"
        initial={ruleFormFromTransaction(t, props.draft)}
        categories={props.categories}
        people={props.people}
        cards={props.cards}
        submitLabel="Save rule"
        busy={props.busy}
        error={props.error}
        placeFirst
        onSubmit={props.onSave}
        onCancel={props.onClose}
      />
    </Modal>
  );
}
