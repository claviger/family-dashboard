import { useState } from 'react';
import { describeSchedule, type Chore, type ChoreInput } from '../../../shared/chores.js';
import { dayAfterWord } from './format.js';
import { ChoreForm } from './ChoreForm.js';
import { toChoreFormValues } from './choreFormValues.js';
import { useChoreDefinition, useChorePeople, useChores, usePendingChoreIds, type DefinitionVariables } from './queries.js';
import { useFocusRegistry } from './useFocus.js';

const ERROR_PREFIX: Record<DefinitionVariables['action'], string> = {
  create: '',
  update: '',
  pause: "Couldn't pause that chore.",
  resume: "Couldn't resume that chore.",
  archive: "Couldn't archive that chore.",
};

/**
 * The Manage tab (chore board spec, "Chores page"), admins only: edit, pause, resume, and archive
 * chores, with the paused and archived ones listed on their own. Chores are added on the Board, and
 * who has one changes there too.
 */
export function ManageTab() {
  const list = useChores();
  const people = useChorePeople();
  const pending = usePendingChoreIds();
  const focus = useFocusRegistry();
  const [editingId, setEditingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  /** A pause or archive that went through with a to-do left to remove later (spec §14). */
  const [notice, setNotice] = useState<string | null>(null);
  const definition = useChoreDefinition({
    onError: (v, err) => {
      focus.cancel();
      if (v.action === 'create' || v.action === 'update') setFormError(err.message);
      else setError(`${ERROR_PREFIX[v.action]} ${err.message}`);
    },
  });

  /** `from` is what had focus when the save was sent: focus moved on meanwhile stays where it went. */
  function stopEditing(id: number, from?: Element | null) {
    setEditingId(null);
    setFormError(null);
    focus.focusLater(() => focus.get(`edit-${id}`), from);
  }

  function changeStatus(chore: Chore, action: 'pause' | 'resume' | 'archive') {
    if (action === 'archive' && !window.confirm(`Archive "${chore.title}"? It leaves the board, and it can't be changed after.`)) return;
    setError(null);
    setStatus('');
    setNotice(null);
    // Pausing and resuming move the chore between lists; archiving moves it to Archived. Focus the
    // button that does the opposite where it went, or the list heading.
    focus.focusLater(() =>
      action === 'archive' ? focus.get('chores-heading') : (focus.get(`${action === 'pause' ? 'resume' : 'pause'}-${chore.id}`) ?? null),
    );
    definition.mutate(
      { action, id: chore.id, title: chore.title },
      {
        onSuccess: (res) => {
          setStatus(`${action === 'pause' ? 'Paused' : action === 'resume' ? 'Resumed' : 'Archived'}: ${chore.title}`);
          setNotice(res.warning ?? null);
        },
      },
    );
  }

  if (list.isPending || people.isPending) return <p className="muted">Loading…</p>;
  if (list.error) return <p className="error">{list.error.message}</p>;
  if (people.error) return <p className="error">{people.error.message}</p>;
  const { today, chores } = list.data;
  const inactive = new Set(people.data.filter((p) => !p.active).map((p) => p.id));

  function item(c: Chore) {
    if (editingId === c.id) {
      return (
        <li key={c.id} className="todo-row editing">
          <ChoreForm
            name={`Edit ${c.title}`}
            initial={toChoreFormValues(c, today)}
            submitLabel="Save"
            busy={definition.isPending}
            error={formError}
            onCancel={() => stopEditing(c.id)}
            onSubmit={(input: ChoreInput) => {
              setFormError(null);
              setStatus('');
              const from = document.activeElement;
              definition.mutate({ action: 'update', id: c.id, input }, {
                onSuccess: (chore) => {
                  setStatus(`Saved: ${chore.title}`);
                  stopEditing(c.id, from);
                },
              });
            }}
          />
        </li>
      );
    }
    return (
      <li key={c.id} className="todo-row chore-row">
        <span className="todo-main">
          <span className="todo-title">{c.title}</span>
          <span className="todo-due">{describeSchedule(c.schedule)}{c.schedule.kind === 'weekly' && c.schedule.interval > 1 ? ` · from the week of ${dayAfterWord(c.startDate, today)}` : ''}</span>
          <span className="todo-due">Has it: {c.assignee?.displayName ?? 'Unassigned'}</span>
          {c.assignee && inactive.has(c.assignee.id) && (
            <span className="todo-due warning">{c.assignee.displayName} is deactivated. Give the chore to someone else on the Board.</span>
          )}
        </span>
        <span className="todo-actions chore-actions">
          <button
            ref={focus.reg(`edit-${c.id}`)}
            type="button"
            aria-label={`Edit ${c.title}`}
            disabled={pending.has(c.id)}
            onClick={() => {
              setError(null);
              setFormError(null);
              setEditingId(c.id);
            }}
          >
            Edit
          </button>
          {c.status === 'active' ? (
            <button ref={focus.reg(`pause-${c.id}`)} type="button" aria-label={`Pause ${c.title}`} disabled={pending.has(c.id)} onClick={() => changeStatus(c, 'pause')}>
              Pause
            </button>
          ) : (
            <button ref={focus.reg(`resume-${c.id}`)} type="button" aria-label={`Resume ${c.title}`} disabled={pending.has(c.id)} onClick={() => changeStatus(c, 'resume')}>
              Resume
            </button>
          )}
          <button type="button" aria-label={`Archive ${c.title}`} disabled={pending.has(c.id)} onClick={() => changeStatus(c, 'archive')}>
            Archive
          </button>
        </span>
      </li>
    );
  }

  const active = chores.filter((c) => c.status === 'active');
  const paused = chores.filter((c) => c.status === 'paused');
  const archived = chores.filter((c) => c.status === 'archived');

  return (
    <div className="chores-tab">
      {error && <p className="error" role="alert">{error}</p>}
      {notice && <p className="notice" role="alert">{notice}</p>}
      <p role="status" className="muted todo-status">{status}</p>

      <section className="todo-group" aria-labelledby="chores-list-heading">
        <h3 id="chores-list-heading" ref={focus.reg('chores-heading')} tabIndex={-1}>
          Chores <span className="muted">({active.length})</span>
        </h3>
        {active.length === 0 && <p className="muted">No chores on the board. Add one on the Board tab.</p>}
        <ul className="todo-list">{active.map(item)}</ul>
      </section>

      {paused.length > 0 && (
        <section className="todo-group" aria-labelledby="chores-paused-heading">
          <h3 id="chores-paused-heading">
            Paused <span className="muted">({paused.length})</span>
          </h3>
          <ul className="todo-list">{paused.map(item)}</ul>
        </section>
      )}

      {archived.length > 0 && (
        <details className="todo-completed">
          <summary>Archived ({archived.length})</summary>
          <ul className="todo-list">
            {archived.map((c) => (
              <li key={c.id} className="todo-row done">
                <span className="todo-main">
                  <span className="todo-title">{c.title}</span>
                  <span className="todo-due">{describeSchedule(c.schedule)}</span>
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
