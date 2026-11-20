import { useNavigate, useSearch } from '@tanstack/react-router';
import { useState } from 'react';
import {
  ASSIGNMENT_SOURCE_LABELS, HISTORY_RANGE_LABELS, HISTORY_RANGES, type HistoryEntry, type HistoryRange,
} from '../../../shared/chores.js';
import { Avatar } from '../../shell/Avatar.js';
import { useMe } from '../../shell/useMe.js';
import { creditPicker, formatDay, whoLine } from './format.js';
import { historyFilterFromSearch, historySearchFor } from './historySearch.js';
import {
  useChorePeople, useChores, useHistory, useOccurrenceAction, usePendingOccurrences, type HistoryFilter,
  type OccurrenceVariables,
} from './queries.js';
import { useFocusRegistry } from './useFocus.js';

/**
 * The History tab (spec §11.7): every completion and skip, filtered by person (you by default, or
 * Everyone), date range, and chore, with skips shown or hidden. Admins can change who gets
 * credit and reopen a chore's most recent occurrence.
 *
 * The filters live in the query string next to `?tab=history` (spec §7), so they survive reloads
 * and back/forward; `historyFilterFromSearch` checks them.
 */
export function HistoryTab() {
  const me = useMe().data!;
  const isAdmin = me.user.role === 'admin';
  const search = useSearch({ from: '/$panelId' });
  const navigate = useNavigate({ from: '/$panelId' });
  const filter = historyFilterFromSearch(search, me.user.id);
  const history = useHistory(filter);
  const people = useChorePeople();
  const chores = useChores();
  const pending = usePendingOccurrences();
  const focus = useFocusRegistry();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const [creditFor, setCreditFor] = useState<number | null>(null);
  const [creditTo, setCreditTo] = useState(0);
  const action = useOccurrenceAction({
    onError: (v, err) => {
      focus.cancel();
      setError(`${v.action === 'reopen' ? "Couldn't reopen that chore." : "Couldn't change the credit."} ${err.message}`);
    },
    onSuccess: (v) => {
      setStatus(v.action === 'reopen' ? `Reopened: ${v.title}` : `Credit changed: ${v.title}`);
      if (v.action === 'credit') setCreditFor(null);
    },
  });

  function run(v: OccurrenceVariables) {
    setError(null);
    setStatus('');
    action.mutate(v);
  }

  function entry(e: HistoryEntry, today: string) {
    const busy = pending.has(e.id);
    const picker = creditPicker(e.credited, people.data ?? [], me.user.id);
    return (
      <li key={e.id} className="todo-row chore-row">
        {e.state === 'done' && e.credited ? <Avatar person={e.credited} /> : <span className="avatar avatar-open" aria-hidden="true" />}
        <span className="todo-main">
          <span className="todo-title">
            {e.title}
            {e.state === 'skipped' && <span className="chore-badge">Skipped</span>}
            {e.late && <span className="chore-badge late">Late</span>}
          </span>
          <span className="todo-due">
            {e.dueDate === null ? 'As needed' : `Due ${formatDay(e.dueDate, today)}`} · {e.state === 'done' ? 'Done' : 'Skipped'} {formatDay(e.closedDate, today)}
          </span>
          <span className="todo-due">{whoLine(e)}</span>
          <span className="todo-due">Assigned: {ASSIGNMENT_SOURCE_LABELS[e.assignmentSource]}</span>
        </span>
        {isAdmin && (
          <span className="todo-actions chore-actions">
            {creditFor === e.id ? (
              <span className="form-row">
                <label>
                  Credit to
                  <select autoFocus value={creditTo} onChange={(ev) => setCreditTo(Number(ev.target.value))}>
                    {picker.options.map((p) => <option key={p.id} value={p.id} disabled={p.disabled}>{p.label}</option>)}
                  </select>
                </label>
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() => {
                    focus.focusLater(() => focus.get(`credit-${e.id}`));
                    run({ id: e.id, title: e.title, action: 'credit', userId: creditTo });
                  }}
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setCreditFor(null);
                    focus.focusLater(() => focus.get(`credit-${e.id}`));
                  }}
                >
                  Cancel
                </button>
              </span>
            ) : (
              <>
                {e.state === 'done' && (
                  <button
                    ref={focus.reg(`credit-${e.id}`)}
                    type="button"
                    aria-label={`Change credit for ${e.title}`}
                    disabled={busy}
                    onClick={() => {
                      setError(null);
                      setCreditTo(picker.initial);
                      setCreditFor(e.id);
                    }}
                  >
                    Change credit
                  </button>
                )}
                {e.canReopen && (
                  <button
                    type="button"
                    aria-label={`Reopen ${e.title}`}
                    disabled={busy}
                    onClick={() => {
                      // The entry leaves history; focus the filters' heading.
                      focus.focusLater(() => focus.get('history-heading'));
                      run({ id: e.id, title: e.title, action: 'reopen' });
                    }}
                  >
                    Reopen
                  </button>
                )}
              </>
            )}
          </span>
        )}
      </li>
    );
  }

  // Other keys (`tab`, and any the History tab doesn't own) pass through untouched.
  const set = (patch: Partial<HistoryFilter>) =>
    void navigate({
      search: { ...search, ...historySearchFor({ ...filter, ...patch }, me.user.id) },
      resetScroll: false,
    });

  return (
    <div className="chores-tab">
      <h3 ref={focus.reg('history-heading')} tabIndex={-1} className="visually-hidden">History</h3>
      <form className="form-row chores-filters" aria-label="History filters" onSubmit={(e) => e.preventDefault()}>
        <label>
          Person
          <select
            value={String(filter.person)}
            onChange={(e) => set({ person: e.target.value === 'all' ? 'all' : Number(e.target.value) })}
          >
            <option value="all">Everyone</option>
            {(people.data ?? [{ id: me.user.id, displayName: me.user.displayName, active: true }]).map((p) => (
              <option key={p.id} value={p.id}>{p.displayName}{p.active ? '' : ' (deactivated)'}</option>
            ))}
          </select>
        </label>
        <label>
          Date range
          <select value={filter.range} onChange={(e) => set({ range: e.target.value as HistoryRange })}>
            {HISTORY_RANGES.map((r) => <option key={r} value={r}>{HISTORY_RANGE_LABELS[r]}</option>)}
          </select>
        </label>
        {filter.range === 'custom' && (
          <>
            <label>
              From
              <input type="date" value={filter.from} max={filter.to || undefined} onChange={(e) => set({ from: e.target.value })} />
            </label>
            <label>
              To
              <input type="date" value={filter.to} min={filter.from || undefined} onChange={(e) => set({ to: e.target.value })} />
            </label>
          </>
        )}
        <label>
          Chore
          <select
            value={filter.choreId === null ? '' : String(filter.choreId)}
            onChange={(e) => set({ choreId: e.target.value === '' ? null : Number(e.target.value) })}
          >
            <option value="">All chores</option>
            {chores.data?.chores.map((c) => (
              <option key={c.id} value={c.id}>{c.title}{c.status === 'archived' ? ' (archived)' : ''}</option>
            ))}
          </select>
        </label>
        <label className="inline-check">
          <input type="checkbox" checked={filter.skipped} onChange={(e) => set({ skipped: e.target.checked })} />
          Show skipped
        </label>
      </form>

      {error && <p className="error" role="alert">{error}</p>}
      <p role="status" className="muted todo-status">{status}</p>
      {filter.range === 'custom' && (filter.from === '' || filter.to === '') && <p className="muted">Pick both dates.</p>}
      {history.isFetching && !history.data && <p className="muted">Loading…</p>}
      {history.error && <p className="error">{history.error.message}</p>}
      {history.data && (
        <>
          <p className="chores-totals" aria-live="polite">
            {history.data.totals.completed} completed · {history.data.totals.late} late · {history.data.totals.skipped} skipped
          </p>
          {history.data.entries.length === 0 ? (
            <p className="muted">Nothing in this range.</p>
          ) : (
            <section className="todo-group" aria-label="Completed and skipped">
              <ul className="todo-list">{history.data.entries.map((e) => entry(e, history.data.today))}</ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
