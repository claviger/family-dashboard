import { useEffect, useRef, useState } from 'react';
import type { CardOption, Category, RuleInput, RuleSaveResponse, SpendPerson, SpendTransaction } from '../../../shared/spend.js';
import { useMediaQuery } from '../../useMediaQuery.js';
import { useFocusRegistry } from '../chores/useFocus.js';
import { clearSent, conflictNote, draftValue, fieldDraft, setDraft, type DraftField, type Drafts } from './drafts.js';
import { money, personName, resettableFields, shortDate, sourceNote } from './format.js';
import { useDuplicateChange, usePendingTransactions, useSpendWrite, useTransactionChange, type DuplicateChange, type TransactionChange } from './queries.js';
import { pickerId } from './SaveBar.js';
import { nextSort, type SortColumn, type TransactionSort } from './spendSearch.js';
import { NoteDialog, RuleDialog } from './TransactionDialogs.js';

type Field = DraftField;
type Find = () => HTMLElement | null | undefined;

/** The status line's Undo, offered after Remove duplicate (OverviewTab shows it). */
export interface StatusUndo {
  /** The transaction it brings back: Undo waits (aria-disabled) while a change to it is out. */
  id: number;
  /** The accessible name: what Undo brings back. */
  label: string;
  run: () => void;
}

/** Shown (visibly and as the picker's description) on a field that's been changed but not saved. */
const EDITED_NOTE = 'Changed, not saved';

/** Why Remove duplicate waits on a row with unsaved picks (visibly, and as its accessible description). */
const DUPLICATE_DRAFTS_NOTE = 'Save or discard its changes to remove it.';

/**
 * The transaction table (spec §12.12): date, merchant, category and person (changed in place),
 * amount, a Pending label, and the note. Row actions: the note, "Add rule"
 * (admins), and "Remove rule" (it resets fields to automatic) when a field was set by hand, or keeps a value that can't be
 * assigned any more. On phones it's a list.
 *
 * - Picking a category or person only changes a draft for that row (kept by OverviewTab), so
 *   arrowing through a select's options never saves. An edited picker says "Changed, not saved";
 *   one someone else has changed since says so and to what; one whose pick has been archived or
 *   deactivated since says that. `SaveBar` saves every draft at once. The pickers stay usable
 *   while a save is out.
 * - Notes, "Add rule", and "Remove rule" act at once, as before. Reset
 *   also drops the drafts of the fields it reset, and the rule dialog starts from the row's drafts.
 * - Every control's name says which transaction it's for (merchant, date, amount, numbered when two
 *   rows would still share it).
 * - When a reset or a rule takes a row out of the filter, focus moves to the next row's category
 *   picker, or to the Transactions heading, and the status line says why the row went (review I5).
 * - Sorting (spec §12.12): each sortable header is a button (`aria-sort` on its th) that turns the
 *   column around, or picks it; `rows` come sorted (OverviewTab), so drafts and Save are untouched.
 *   Phones get a "Sort by" select instead, beside the filters.
 * - Remove duplicate (admins, on a row with a twin) acts at once: the row goes, focus moves on as
 *   for a row that leaves the filter, and the status line says so with an Undo, which brings it
 *   back and focuses its button.
 *   The rule dialog stays open (busy) until the refreshed transactions are in, so focus is chosen
 *   from them.
 */
export function TransactionList(props: {
  rows: SpendTransaction[];
  categories: Category[];
  people: SpendPerson[];
  cards: CardOption[];
  isAdmin: boolean;
  /** Unsaved picks, by transaction id, for every row of the card (shown or not). */
  drafts: Drafts;
  /** The cycle shown (its start), noted with each pick. */
  cycle: string | null;
  /** How each shown row is named (merchant, date, amount), from `rowLabels`. */
  labels: ReadonlyMap<number, string>;
  setDrafts: (update: (d: Drafts) => Drafts) => void;
  /** Whether a transaction still matches the table's filters. */
  matches: (t: SpendTransaction) => boolean;
  /** The Transactions heading, where focus goes when no row is left to take it. */
  heading: () => HTMLElement | null | undefined;
  /** How `rows` are sorted, and a pick of another order (the header buttons). */
  sort: TransactionSort;
  onSort: (sort: TransactionSort) => void;
  onStatus: (message: string, undo?: StatusUndo) => void;
  onError: (message: string | null) => void;
}) {
  const wide = useMediaQuery('(min-width: 768px)');
  const focus = useFocusRegistry();
  const pending = usePendingTransactions();
  const pendingNow = useRef(pending);
  pendingNow.current = pending;
  const { drafts, setDrafts } = props;
  const [noteFor, setNoteFor] = useState<SpendTransaction | null>(null);
  /** The rule dialog's transaction, and where focus goes when it closes (decided when it opened). */
  const [ruleFor, setRuleFor] = useState<{ t: SpendTransaction; returnFocus: Find } | null>(null);
  /** A saved rule's answer, held until the refreshed transactions are in. */
  const [ruleSaved, setRuleSaved] = useState<RuleSaveResponse | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  /** Where focus goes when each row's change settles, and the control it was sent from, decided when it was sent. */
  const focusTargets = useRef(new Map<number, { find: Find; from: Element | null }>());
  /** The transaction whose note dialog is open, for a save that settles after it closed. */
  const noteOpen = useRef<number | null>(null);
  noteOpen.current = noteFor?.id ?? null;
  const label = (t: SpendTransaction) => props.labels.get(t.id) ?? t.merchant;
  const hasDrafts = (t: SpendTransaction) => fieldDraft(drafts, t.id, 'category') !== undefined || fieldDraft(drafts, t.id, 'person') !== undefined;

  /** The control to focus after a change to `t`: its own (`key`), else the next row's category picker, else the heading. */
  function focusAfter(t: SpendTransaction, key: string) {
    const after = props.rows.slice(props.rows.findIndex((r) => r.id === t.id) + 1).map((r) => r.id);
    return () => focus.get(`${key}-${t.id}`) ?? after.map((id) => focus.get(`category-${id}`)).find((el) => el) ?? props.heading();
  }

  /** Focus the control the change was sent from, or the next one if its row is gone. */
  function settleFocus(id: number) {
    const target = focusTargets.current.get(id);
    focusTargets.current.delete(id);
    if (target) focus.focusLater(target.find, target.from);
  }

  const change = useTransactionChange({
    onError: (v, err) => {
      const message = `Couldn't save the change to ${v.label}. ${err.message}`;
      // A note's failure shows in its dialog while it's open; anything else above the table, with focus back on the control.
      if (v.kind === 'patch' && noteOpen.current === v.id) setDialogError(message);
      else props.onError(message);
      if (v.kind === 'reset') settleFocus(v.id);
    },
    onSuccess: (v, t) => {
      const gone = !props.matches(t) ? ' It no longer matches the filter, so it is hidden.' : '';
      if (v.kind === 'patch') {
        setNoteFor((open) => (open?.id === v.id ? null : open));
        props.onStatus(`Note saved: ${v.label}.${gone}`);
        return;
      }
      // Reset decides the fields it named again, so their unsaved picks go too: only those the
      // row still held when it was sent, since a pick made meanwhile is newer.
      setDrafts((d) => clearSent(d, v.id, v.fields, v.sent));
      props.onStatus(`Rule removed: ${v.label}.${gone}`);
      settleFocus(v.id);
    },
  });

  const duplicate = useDuplicateChange({
    onError: (v, err) => {
      props.onError(v.kind === 'remove' ? `Couldn't remove ${v.label} as a duplicate. ${err.message}` : `Couldn't bring back ${v.label}. ${err.message}`);
      // A failed Undo stays offered, with focus on it, so it can be tried again.
      if (v.kind === 'restore') focusTargets.current.delete(v.id);
      else settleFocus(v.id);
    },
    onSuccess: (v) => {
      if (v.kind === 'remove') props.onStatus(`Removed duplicate: ${v.label}.`, { id: v.id, label: v.label, run: () => restore(v) });
      else props.onStatus(`Brought back: ${v.label}.`);
      settleFocus(v.id);
    },
  });

  /**
   * Sends Remove duplicate or its Undo; focus goes to `find` once it settles. Undo runs from a later
   * render, so it reads what's pending now, and leaves the status line (and its focused Undo button,
   * aria-disabled meanwhile) in place until the answer comes.
   */
  function sendDuplicate(v: DuplicateChange, find: Find) {
    if (pendingNow.current.has(v.id)) return;
    props.onError(null);
    if (v.kind === 'remove') props.onStatus('');
    focus.cancel();
    focusTargets.current.clear();
    focusTargets.current.set(v.id, { find, from: document.activeElement });
    duplicate.mutate(v);
  }

  /** Undo: the row comes back, and focus goes to its Remove duplicate button (or its picker, or the heading). */
  function restore(v: DuplicateChange) {
    sendDuplicate({ ...v, kind: 'restore' }, () => focus.get(`dup-${v.id}`) ?? focus.get(`category-${v.id}`) ?? props.heading());
  }

  const rule = useSpendWrite<RuleSaveResponse>({
    onError: (_v, err) => setDialogError(`Couldn't add the rule. ${err.message}`),
    // The write stays pending until every Spend query has refreshed; the dialog closes then (below).
    onSuccess: (_v, res) => setRuleSaved(res),
  });

  // A saved rule may move its row (and others) out of the filter. Once the refreshed transactions
  // are in, the dialog closes: focus goes back to the row's button, or on from it if the row went
  // (review S3-I1), and the status line says so.
  useEffect(() => {
    if (!ruleSaved || rule.isPending || !ruleFor) return;
    const gone = props.rows.some((r) => r.id === ruleFor.t.id) ? '' : ' It no longer matches the filter, so it is hidden.';
    const changed = ruleSaved.applied === null ? '' : ` ${ruleSaved.applied} ${ruleSaved.applied === 1 ? 'transaction' : 'transactions'} changed.`;
    props.onStatus(`Rule added.${changed}${gone}`);
    setRuleSaved(null);
    setRuleFor(null);
  });

  /**
   * Sends a reset. Focus still waiting from an earlier change is dropped (the person has moved on);
   * this one's goes to `key` on the row, or on from it, once the change settles.
   */
  function send(v: TransactionChange, t: SpendTransaction, key: string) {
    if (pending.has(t.id)) return;
    props.onError(null);
    props.onStatus('');
    focus.cancel();
    focusTargets.current.clear();
    focusTargets.current.set(t.id, { find: focusAfter(t, key), from: document.activeElement });
    change.mutate(v);
  }

  /** The name of a picker value, for "Someone else changed this to …". */
  function nameOf(t: SpendTransaction, field: Field, value: string): string {
    if (field === 'category') {
      return props.categories.find((c) => String(c.id) === value)?.name ?? (String(t.category.id) === value ? t.category.name : 'another category');
    }
    if (value === '') return 'Household';
    const p = props.people.find((x) => String(x.id) === value) ?? (t.person && String(t.person.id) === value ? t.person : undefined);
    return p ? personName(p) : 'someone else';
  }

  /** What a picker says under it, most pressing first: its pick can't be saved, someone else changed it, it's changed, or where its value came from. */
  function pickerNote(t: SpendTransaction, field: Field): { text: string; flagged: boolean; edited: boolean } {
    const d = fieldDraft(drafts, t.id, field);
    if (!d) return { text: sourceNote(field === 'category' ? t.categorySource : t.personSource), flagged: false, edited: false };
    if (field === 'category') {
      const c = props.categories.find((x) => String(x.id) === d.value);
      if (c?.archived) return { text: `${c.name} is archived now. Pick another category.`, flagged: true, edited: true };
    } else {
      const p = props.people.find((x) => String(x.id) === d.value);
      if (p && !p.active) return { text: `${p.displayName} is deactivated now. Pick someone else.`, flagged: true, edited: true };
    }
    if (d.changedTo !== undefined) return { text: conflictNote(nameOf(t, field, d.changedTo)), flagged: true, edited: true };
    return { text: EDITED_NOTE, flagged: false, edited: true };
  }

  function picker(t: SpendTransaction, field: Field) {
    const key = `${field}-${t.id}`;
    const note = pickerNote(t, field);
    const name = field === 'category' ? 'Category' : 'Person';
    const value = draftValue(drafts, t, field);
    const className = ['spend-picker', note.edited && 'spend-edited', note.flagged && 'spend-flagged'].filter(Boolean).join(' ');
    return (
      <span className={className}>
        <select
          ref={focus.reg(key)}
          id={pickerId(field, t.id)}
          aria-label={`${name} for ${label(t)}`}
          aria-describedby={note.text ? `${key}-note` : undefined}
          value={value}
          onChange={(e) => {
            const picked = e.target.value;
            setDrafts((d) => setDraft(d, t, field, picked, { cycle: props.cycle, label: label(t) }));
          }}
        >
          {field === 'category' ? categoryOptions(t, value) : personOptions(t, value)}
        </select>
        {note.text && <span id={`${key}-note`} className={note.edited ? 'spend-edited-note' : 'todo-due'}>{note.text}</span>}
      </span>
    );
  }

  /** Active categories, plus the row's own and its pick even if archived since (shown so, and flagged). */
  function categoryOptions(t: SpendTransaction, value: string) {
    const options = props.categories.filter((c) => !c.archived || c.id === t.category.id || String(c.id) === value);
    if (!options.some((c) => c.id === t.category.id)) options.push({ ...t.category, inUse: true });
    return options.map((c) => (
      <option key={c.id} value={c.id}>{c.name}{c.archived ? ' (archived)' : ''}</option>
    ));
  }

  /** Active people, plus the row's own and its pick even if deactivated since (named so, and flagged). */
  function personOptions(t: SpendTransaction, value: string) {
    const options = props.people.filter((p) => p.active || p.id === t.person?.id || String(p.id) === value);
    // Before the people list loads, the row's own person is still offered, so the picker shows them.
    if (t.person && !options.some((p) => p.id === t.person!.id)) options.push(t.person);
    return [
      <option key="household" value="">Household</option>,
      ...options.map((p) => <option key={p.id} value={p.id}>{personName(p)}</option>),
    ];
  }

  function actions(t: SpendTransaction) {
    // Set by hand, or kept because it can't be assigned any more (review C-M8).
    const resettable = resettableFields(t);
    return (
      <span className="todo-actions spend-actions">
        <button
          ref={focus.reg(`note-${t.id}`)}
          type="button"
          aria-label={`${t.note ? 'Edit the note on' : 'Add a note to'} ${label(t)}`}
          onClick={() => {
            setDialogError(null);
            setNoteFor(t);
          }}
        >
          {t.note ? 'Edit note' : 'Note'}
        </button>
        {props.isAdmin && (
          <button
            ref={focus.reg(`rule-${t.id}`)}
            type="button"
            aria-label={`Add rule for ${label(t)}`}
            onClick={() => {
              setDialogError(null);
              setRuleSaved(null);
              setRuleFor({ t, returnFocus: focusAfter(t, 'rule') });
            }}
          >
            Add rule
          </button>
        )}
        {props.isAdmin && t.twinIds.length > 0 && (
          <>
            <button
              ref={focus.reg(`dup-${t.id}`)}
              type="button"
              aria-label={`Remove duplicate ${label(t)}`}
              // Unsaved picks on the row would go with it: they're saved or discarded first.
              aria-disabled={pending.has(t.id) || hasDrafts(t)}
              aria-describedby={hasDrafts(t) ? `dup-note-${t.id}` : undefined}
              // The row goes: focus moves to the next row's category picker, or the heading.
              onClick={() => {
                if (hasDrafts(t)) return;
                sendDuplicate({ kind: 'remove', id: t.id, label: label(t) }, focusAfter(t, 'dup'));
              }}
            >
              Remove duplicate
            </button>
            {hasDrafts(t) && <span id={`dup-note-${t.id}`} className="todo-due spend-dup-note">{DUPLICATE_DRAFTS_NOTE}</span>}
          </>
        )}
        {resettable.length > 0 && (
          <button
            type="button"
            aria-label={`Remove rule from ${label(t)}`}
            aria-disabled={pending.has(t.id)}
            // The button goes away once nothing is left to reset; focus goes to the category picker.
            onClick={() => send({ kind: 'reset', id: t.id, fields: [...resettable], label: t.merchant, sent: drafts.get(t.id) }, t, 'category')}
          >
            Remove rule
          </button>
        )}
      </span>
    );
  }

  function merchantCell(t: SpendTransaction) {
    return (
      <span className="todo-main">
        <span className="todo-title">
          {t.merchant}
          {t.pending && <>{' '}<span className="chore-badge">Pending</span></>}
        </span>
        {t.note && <span className="todo-notes muted spend-note"><span className="visually-hidden">Note: </span>{t.note}</span>}
      </span>
    );
  }

  /** A sortable column's header: a button that sorts by it, with `aria-sort` on the th while it does. */
  function sortHeader(by: SortColumn, name: string, className?: string) {
    const sorted = props.sort.by === by;
    return (
      <th scope="col" className={className} aria-sort={sorted ? (props.sort.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
        <button type="button" className="spend-sort" onClick={() => props.onSort(nextSort(props.sort, by))}>
          {name}
          {sorted && (
            <svg className="icon spend-sort-icon" viewBox="0 0 24 24" aria-hidden="true">
              <path d={props.sort.dir === 'asc' ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'} />
            </svg>
          )}
        </button>
      </th>
    );
  }

  return (
    <>
      {props.rows.length === 0 ? (
        <p className="muted">No transactions to show.</p>
      ) : wide ? (
        <div className="table-wrap">
          <table className="spend-table">
            <caption className="visually-hidden">Transactions</caption>
            <thead>
              <tr>
                {sortHeader('date', 'Date')}
                {sortHeader('name', 'Merchant')}
                <th scope="col">Category</th>
                <th scope="col">Person</th>
                {sortHeader('amount', 'Amount', 'spend-number')}
                <th scope="col"><span className="visually-hidden">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              {props.rows.map((t) => (
                <tr key={t.id}>
                  <td className="spend-date">{shortDate(t.date)}</td>
                  <td>{merchantCell(t)}</td>
                  <td>{picker(t, 'category')}</td>
                  <td>{picker(t, 'person')}</td>
                  <td className="spend-number">{money(t.amountCents, t.currency)}</td>
                  <td>{actions(t)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ul className="todo-list spend-list" aria-label="Transactions">
          {props.rows.map((t) => (
            <li key={t.id} className="spend-list-item">
              <span className="spend-list-top">
                {merchantCell(t)}
                <span className="spend-amount">
                  {money(t.amountCents, t.currency)}
                  <span className="todo-due">{shortDate(t.date)}</span>
                </span>
              </span>
              <span className="spend-list-pickers">
                {picker(t, 'category')}
                {picker(t, 'person')}
              </span>
              {actions(t)}
            </li>
          ))}
        </ul>
      )}
      {noteFor && (
        <NoteDialog
          transaction={noteFor}
          busy={change.isPending}
          error={dialogError}
          returnFocus={focusAfter(noteFor, 'note')}
          onSave={(note) => {
            if (pending.has(noteFor.id)) return;
            setDialogError(null);
            props.onStatus('');
            change.mutate({ kind: 'patch', id: noteFor.id, patch: { note }, label: noteFor.merchant });
          }}
          onClose={() => setNoteFor(null)}
        />
      )}
      {ruleFor && (
        <RuleDialog
          transaction={ruleFor.t}
          draft={{ category: drafts.get(ruleFor.t.id)?.category?.value, person: drafts.get(ruleFor.t.id)?.person?.value }}
          categories={props.categories}
          people={props.people}
          cards={props.cards}
          busy={rule.isPending || ruleSaved !== null}
          error={dialogError}
          // Applying the rule may move the row out of the filter: then focus goes on from it.
          returnFocus={ruleFor.returnFocus}
          onSave={(input: RuleInput) => {
            if (rule.isPending || ruleSaved) return;
            setDialogError(null);
            props.onStatus('');
            rule.mutate({ method: 'POST', path: '/rules', body: input, label: input.matchText });
          }}
          onClose={() => setRuleFor(null)}
        />
      )}
    </>
  );
}
