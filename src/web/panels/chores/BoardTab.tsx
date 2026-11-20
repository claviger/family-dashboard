import { useNavigate, useSearch } from '@tanstack/react-router';
import { useRef, useState, type KeyboardEvent } from 'react';
import type { BoardRow, BoardRowResponse, NewChoreInput } from '../../../shared/chores.js';
import { Avatar } from '../../shell/Avatar.js';
import { useMe } from '../../shell/useMe.js';
import { boardCountLabel, boardEmptyMessage, boardWhoFromSearch, boardWhoPeople, boardWhoSearch, filterBoardRows, type BoardWho } from './boardFilter.js';
import { ChoreForm } from './ChoreForm.js';
import { emptyChoreForm } from './choreFormValues.js';
import { onceSettled } from './focusTargets.js';
import { boardStateLabel, wontSeeChores, wontSeeWarning } from './format.js';
import { useBoard, useChoreAction, useChoreDefinition, useChorePeople, usePendingChores, type ChoreActionVariables } from './queries.js';
import { useFocusRegistry } from './useFocus.js';

const ERROR_PREFIX: Record<ChoreActionVariables['action'], string> = {
  claim: "Couldn't claim that chore.",
  release: "Couldn't release that chore.",
  assign: "Couldn't assign that chore.",
  complete: "Couldn't mark that chore done.",
  skip: "Couldn't skip that chore.",
};

function doneMessage(v: ChoreActionVariables, hadSomeone: boolean): string {
  switch (v.action) {
    case 'claim':
      return hadSomeone ? `Taken over: ${v.title}` : `Claimed: ${v.title}`;
    case 'release':
      return `Released: ${v.title}`;
    case 'assign':
      return v.userId === null ? `Unassigned: ${v.title}` : `Assigned: ${v.title}`;
    case 'complete':
      return `Done: ${v.title}`;
    case 'skip':
      return `Skipped: ${v.title}`;
  }
}

/**
 * The Board tab (chore board spec, "The board" and "Chores page"): every active chore, most often
 * first, with who has it and its state. Anyone claims an unassigned chore or takes one over, releases
 * their own, and checks off their own due ones; admins also skip and assign. Anyone can add a chore:
 * a member for themselves or nobody, an admin for anyone.
 *
 * Admins assign from an "Assign…" button that opens a picker under its row, one row at a time:
 * changing the picker only selects, so keyboarding through its options doesn't reassign at every
 * step, and Assign (or Unassign) applies it. Picking someone who would never see the chore shows the
 * warning at once, before Assign is pressed. Focus goes to the picker when it opens, and back to the
 * Assign… button when it closes (Assign, Cancel, or Escape).
 *
 * Who has each chore is its own column on wider screens (avatar and name, or Unassigned), and part
 * of the meta line under the title on phones (CSS picks one; the other is display: none). The
 * "Who has it" filter above the list (Everyone, Mine, Unassigned, or a person) is `?who=` in the
 * URL, next to the drill-down's `?tab=`. It only hides rows here, keeping the board's order. An
 * action that takes its row out of the filter says so, and focus goes to the Chores heading.
 */
export function BoardTab() {
  const me = useMe().data!;
  const isAdmin = me.user.role === 'admin';
  const board = useBoard();
  const people = useChorePeople();
  const search = useSearch({ from: '/$panelId' });
  const navigate = useNavigate({ from: '/$panelId' });
  const whoInUrl = boardWhoFromSearch(search.who);
  const whoPeople = boardWhoPeople(board.data?.rows ?? [], people.data ?? [], me.user.id, whoInUrl);
  // A person id nobody has (or before the people load) is Everyone, in the picker and the list alike.
  const who: BoardWho = typeof whoInUrl === 'number' && !whoPeople.some((p) => p.id === whoInUrl) ? 'all' : whoInUrl;
  const pending = usePendingChores();
  const focus = useFocusRegistry();
  const [adding, setAdding] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  /** A change that went through with a to-do left to remove later (spec §14). */
  const [notice, setNotice] = useState<string | null>(null);
  /** The chore whose assign picker is open; one at a time. */
  const [assigning, setAssigning] = useState<number | null>(null);
  /** The assign picker's selection per chore, while it differs from who has it: '' is Unassigned. */
  const [assignTo, setAssignTo] = useState<ReadonlyMap<number, string>>(new Map());
  const setAssignFor = (choreId: number, value: string | null) =>
    setAssignTo((m) => {
      const next = new Map(m);
      if (value === null) next.delete(choreId);
      else next.set(choreId, value);
      return next;
    });
  /** Whether each in-flight claim was a take-over, for its status message. */
  const tookOver = useRef(new Map<number, boolean>());
  /** The control each in-flight action was made from, to give focus back to it if the action fails. */
  const madeFrom = useRef(new Map<number, Element | null>());
  /** This render's in-flight chores, for focus requests that wait for an action to settle. */
  const pendingNow = useRef<ReadonlyMap<number, string>>(new Map());
  /** Chores whose action just took their row out of the Who has it filter, so focus goes on to the heading. */
  const hiddenAfter = useRef(new Set<number>());
  const action = useChoreAction({
    onError: (v, err) => {
      tookOver.current.delete(v.choreId);
      const from = madeFrom.current.get(v.choreId);
      madeFrom.current.delete(v.choreId);
      focus.cancel();
      // The control was disabled while the request was out, which dropped its focus: give it back.
      if (from instanceof HTMLElement) {
        focus.focusLater(onceSettled(() => pendingNow.current.has(v.choreId), () => (from.isConnected ? from : null)), from);
      }
      setError(`${ERROR_PREFIX[v.action]} ${err.message}`);
    },
    onSuccess: (v, res) => {
      // Claim, release, and assign answer with the chore's new row: say so if the filter now hides it.
      const newRow = v.action === 'claim' || v.action === 'release' || v.action === 'assign' ? (res as BoardRowResponse) : null;
      const gone = newRow !== null && filterBoardRows([newRow], who, me.user.id).length === 0;
      if (gone) hiddenAfter.current.add(v.choreId);
      const hidden = gone ? '. It no longer matches the filter, so it is hidden.' : '';
      setStatus(`${doneMessage(v, tookOver.current.get(v.choreId) ?? false)}${hidden}`);
      tookOver.current.delete(v.choreId);
      madeFrom.current.delete(v.choreId);
      setNotice(res.warning ?? null);
      if (v.action === 'assign') {
        setAssignFor(v.choreId, null);
        setAssigning((cur) => (cur === v.choreId ? null : cur));
      }
    },
  });
  const definition = useChoreDefinition({
    onError: (_v, err) => {
      focus.cancel();
      setFormError(err.message);
    },
  });

  pendingNow.current = pending;
  const activePeople = (people.data ?? []).filter((p) => p.active);
  const peopleById = new Map((people.data ?? []).map((p) => [p.id, p]));

  function run(r: BoardRow, v: ChoreActionVariables) {
    setError(null);
    setStatus('');
    setNotice(null);
    if (v.action === 'claim') tookOver.current.set(r.choreId, r.assignee !== null);
    madeFrom.current.set(r.choreId, document.activeElement);
    // Once it's done: the row stays where it is, and the button pressed may go away (Claim becomes
    // Release), so focus the row; after an assign, the Assign… button the picker closes back to.
    // If the filter hides the row now (it's still shown until the board refreshes), the Chores heading.
    const target = v.action === 'assign' ? `assign-${r.choreId}` : `row-${r.choreId}`;
    hiddenAfter.current.delete(r.choreId);
    focus.focusLater(
      onceSettled(
        () => pendingNow.current.has(r.choreId),
        () => (hiddenAfter.current.has(r.choreId) ? undefined : focus.get(target)) ?? focus.get('board-heading'),
      ),
    );
    action.mutate(v);
  }

  function openAssign(choreId: number) {
    if (assigning !== null) setAssignFor(assigning, null);
    setError(null);
    setAssigning(choreId);
  }

  /** Closes the picker without assigning, and puts focus back on its Assign… button. */
  function closeAssign(choreId: number) {
    setAssignFor(choreId, null);
    setAssigning(null);
    focus.focusLater(() => focus.get(`assign-${choreId}`));
  }

  function startAdding() {
    setError(null);
    setFormError(null);
    setAdding(true);
  }

  /** `from` is what had focus when the save was sent: focus moved on meanwhile stays where it went. */
  function stopAdding(from?: Element | null) {
    setAdding(false);
    setFormError(null);
    focus.focusLater(() => focus.get('add-chore'), from);
  }

  function row(r: BoardRow, today: string) {
    const busy = pending.has(r.choreId);
    const mine = r.assignee?.id === me.user.id;
    const base = { choreId: r.choreId, title: r.title };
    const assignee = r.assignee ? peopleById.get(r.assignee.id) : undefined;
    const currentPick = r.assignee ? String(r.assignee.id) : '';
    const pick = assignTo.get(r.choreId) ?? currentPick;
    const picked = pick === '' ? undefined : peopleById.get(Number(pick));
    const open = isAdmin && assigning === r.choreId;
    const pickWarning = open && pick !== currentPick && wontSeeChores(picked) ? wontSeeWarning(picked!.displayName) : null;
    const assignVerb = pick === '' && currentPick !== '' ? 'Unassign' : 'Assign';
    const label = boardStateLabel(r, today, mine);
    const whoName = r.assignee ? (mine ? 'You' : r.assignee.displayName) : 'Unassigned';
    return (
      <li key={r.choreId} ref={focus.reg(`row-${r.choreId}`)} tabIndex={-1} className="todo-row chore-row">
        {mine && r.occurrenceId !== null ? (
          <input
            type="checkbox"
            aria-label={`Complete ${r.title}`}
            checked={pending.get(r.choreId) === 'complete'}
            disabled={busy}
            onChange={() => run(r, { ...base, action: 'complete', occurrenceId: r.occurrenceId! })}
          />
        ) : r.assignee ? (
          <Avatar person={r.assignee} className="chore-lead" />
        ) : (
          <span className="avatar avatar-open chore-lead" aria-hidden="true" />
        )}
        <span className="todo-main">
          <span className="todo-title">{r.title}</span>
          <span className="chore-meta">
            <span className="todo-due">{r.frequency}</span>
            {/* On phones who has it is here; on wider screens it's the column after the title. */}
            <span className="todo-due chore-who-meta">{whoName}</span>
            {label && <span className={r.state === 'overdue' ? 'todo-due overdue' : 'todo-due'}>{label}</span>}
          </span>
          {r.todoSyncStatus === 'pending' && <span className="todo-due">Not on to-do list yet</span>}
          {isAdmin && assignee && wontSeeChores(assignee) && <span className="todo-due warning">{wontSeeWarning(assignee.displayName)}</span>}
        </span>
        <span className="chore-who">
          {r.assignee ? <Avatar person={r.assignee} /> : <span className="avatar avatar-open" aria-hidden="true" />}
          <span className="chore-who-name">
            <span className="visually-hidden">Who has it: </span>
            {whoName}
          </span>
        </span>
        <span className="todo-actions chore-actions">
          {mine ? (
            <button type="button" aria-label={`Release ${r.title}`} disabled={busy} onClick={() => run(r, { ...base, action: 'release' })}>
              Release
            </button>
          ) : (
            <button
              type="button"
              aria-label={`${r.assignee ? 'Take over' : 'Claim'} ${r.title}`}
              disabled={busy}
              onClick={() => run(r, { ...base, action: 'claim' })}
            >
              {r.assignee ? 'Take over' : 'Claim'}
            </button>
          )}
          {isAdmin && r.occurrenceId !== null && (
            <button type="button" aria-label={`Skip ${r.title}`} disabled={busy} onClick={() => run(r, { ...base, action: 'skip', occurrenceId: r.occurrenceId! })}>
              Skip
            </button>
          )}
          {isAdmin && people.data && (
            <button
              ref={focus.reg(`assign-${r.choreId}`)}
              type="button"
              aria-label={`Assign ${r.title}…`}
              aria-expanded={open}
              aria-controls={open ? `assign-panel-${r.choreId}` : undefined}
              disabled={busy}
              onClick={() => (open ? closeAssign(r.choreId) : openAssign(r.choreId))}
            >
              Assign…
            </button>
          )}
        </span>
        {open && (
          <div
            id={`assign-panel-${r.choreId}`}
            className="chore-assign"
            onKeyDown={(e: KeyboardEvent) => {
              if (e.key === 'Escape') {
                e.preventDefault();
                closeAssign(r.choreId);
              }
            }}
          >
            <label>
              Who has it
              <select
                autoFocus
                aria-label={`Who has ${r.title}`}
                aria-describedby={pickWarning ? `assign-warning-${r.choreId}` : undefined}
                value={pick}
                disabled={busy}
                onChange={(e) => setAssignFor(r.choreId, e.target.value === currentPick ? null : e.target.value)}
              >
                <option value="">Unassigned</option>
                {r.assignee && !activePeople.some((p) => p.id === r.assignee!.id) && (
                  <option value={r.assignee.id} disabled>{r.assignee.displayName}</option>
                )}
                {activePeople.map((p) => <option key={p.id} value={p.id}>{p.displayName}</option>)}
              </select>
            </label>
            <button
              type="button"
              className="primary"
              aria-label={`${assignVerb} ${r.title}`}
              disabled={busy || pick === currentPick}
              onClick={() => run(r, { ...base, action: 'assign', userId: pick === '' ? null : Number(pick) })}
            >
              {assignVerb}
            </button>
            <button type="button" aria-label={`Cancel assigning ${r.title}`} onClick={() => closeAssign(r.choreId)}>
              Cancel
            </button>
            {pickWarning && <p id={`assign-warning-${r.choreId}`} className="todo-due warning" aria-live="polite">{pickWarning}</p>}
          </div>
        )}
      </li>
    );
  }

  if (board.isPending || people.isPending) return <p className="muted">Loading…</p>;
  if (board.error) return <p className="error">{board.error.message}</p>;
  if (people.error) return <p className="error">{people.error.message}</p>;
  const { today, rows } = board.data;
  const shown = filterBoardRows(rows, who, me.user.id);
  const whoPicked = typeof who === 'number' ? whoPeople.find((p) => p.id === who) : undefined;
  const setWho = (next: BoardWho) => void navigate({ search: { ...search, who: boardWhoSearch(next) }, resetScroll: false });

  return (
    <div className="chores-tab">
      <div className="form-row">
        <button ref={focus.reg('add-chore')} type="button" className="primary" onClick={startAdding} disabled={adding}>
          Add chore
        </button>
      </div>
      {adding && (
        <ChoreForm
          name="New chore"
          initial={emptyChoreForm(today)}
          assignTo={isAdmin ? activePeople : activePeople.filter((p) => p.id === me.user.id)}
          submitLabel="Add"
          busy={definition.isPending}
          error={formError}
          onCancel={() => stopAdding()}
          onSubmit={(input: NewChoreInput) => {
            setFormError(null);
            setStatus('');
            const from = document.activeElement;
            // Add is disabled while a save is in flight, so this is always the latest call.
            definition.mutate({ action: 'create', input }, {
              onSuccess: (chore) => {
                setStatus(`Added: ${chore.title}`);
                stopAdding(from);
              },
            });
          }}
        />
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="notice" role="alert">{notice}</p>}
      <p role="status" className="muted todo-status">{status}</p>
      {rows.length > 0 && (
        <form className="form-row chores-filters" aria-label="Board filters" onSubmit={(e) => e.preventDefault()}>
          <label>
            Who has it
            <select
              value={String(who)}
              onChange={(e) => {
                const v = e.target.value;
                setWho(v === 'all' || v === 'mine' || v === 'unassigned' ? v : Number(v));
              }}
            >
              <option value="all">Everyone</option>
              <option value="mine">Mine</option>
              <option value="unassigned">Unassigned</option>
              {whoPeople.map((p) => (
                <option key={p.id} value={p.id}>{p.active ? p.displayName : `${p.displayName} (deactivated)`}</option>
              ))}
            </select>
          </label>
        </form>
      )}
      <section className="todo-group" aria-labelledby="board-heading">
        <h3 id="board-heading" ref={focus.reg('board-heading')} tabIndex={-1}>
          Chores <span className="muted">{boardCountLabel(shown.length, rows.length, who)}</span>
        </h3>
        {rows.length === 0 && <p className="muted">No chores yet. Add the first one.</p>}
        {rows.length > 0 && shown.length === 0 && <p className="muted">{boardEmptyMessage(who, whoPicked?.displayName)}</p>}
        {shown.length > 0 && (
          <div className="chore-board">
            {/* The column headings, on wider screens only. Each row names who has it itself, so they're hidden from screen readers. */}
            <div className="chore-board-head" aria-hidden="true">
              <span />
              <span>Chore</span>
              <span>Who has it</span>
            </div>
            <ul className="todo-list">{shown.map((r) => row(r, today))}</ul>
          </div>
        )}
      </section>
    </div>
  );
}
