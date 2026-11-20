import { useState } from 'react';
import type { BoardRow } from '../../../shared/chores.js';
import { afterComplete } from './focusTargets.js';
import { boardStateLabel } from './format.js';
import { useChoreAction, useChoreSummary, usePendingChores, type ChoreActionVariables } from './queries.js';
import { useFocusRegistry } from './useFocus.js';

const ERROR_PREFIX: Partial<Record<ChoreActionVariables['action'], string>> = {
  complete: "Couldn't mark that chore done.",
  claim: "Couldn't claim that chore.",
};

/**
 * Home card (chore board spec, "Home tile"): your due chores with checkboxes, overdue first (always
 * every one); then yours with nothing due yet, muted; then the top of Up for grabs with Claim. The
 * server keeps it to six rows.
 */
export function ChoresSummary() {
  const summary = useChoreSummary();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState('');
  const focus = useFocusRegistry();
  const pending = usePendingChores();
  const action = useChoreAction({
    onError: (v, err) => {
      focus.cancel();
      setError(`${ERROR_PREFIX[v.action] ?? ''} ${err.message}`.trim());
    },
    onSuccess: (v) => setStatus(v.action === 'claim' ? `Claimed: ${v.title}` : `Done: ${v.title}`),
  });

  function complete(r: BoardRow, after: number[]) {
    setError(null);
    setStatus('');
    // Once its checkbox is gone, focus the next of your due chores, else the Yours heading; if it
    // comes straight back for the chore's next occurrence (it was late), focus it there.
    focus.focusLater(() => afterComplete(focus.get, r.choreId, r.occurrenceId!, after, 'mine-heading'));
    action.mutate({ choreId: r.choreId, title: r.title, action: 'complete', occurrenceId: r.occurrenceId! });
  }

  function claim(r: BoardRow) {
    setError(null);
    setStatus('');
    // The claimed chore moves to Yours, with a checkbox; focus it there.
    focus.focusLater(() => focus.get(`check-${r.choreId}`));
    action.mutate({ choreId: r.choreId, title: r.title, action: 'claim' });
  }

  if (summary.isPending) return <p className="muted">Loading…</p>;
  if (summary.error) return <p className="error">{summary.error.message}</p>;
  const { today, due, waiting, upForGrabs } = summary.data;

  return (
    <div className="chores-summary">
      {error && <p className="error" role="alert">{error}</p>}
      <section aria-labelledby="chores-mine-heading">
        <h3 id="chores-mine-heading" ref={focus.reg('mine-heading')} tabIndex={-1} className="chores-subhead">Yours</h3>
        {due.length === 0 ? (
          <p className="muted">{waiting.length === 0 ? 'Nothing on your plate.' : 'Nothing due right now.'}</p>
        ) : (
          <ul className="todo-list">
            {due.map((r, i) => (
              <li key={r.choreId} className="todo-row">
                <input
                  ref={focus.reg(`check-${r.choreId}`)}
                  type="checkbox"
                  data-occurrence={r.occurrenceId ?? undefined}
                  aria-label={`Complete ${r.title}`}
                  checked={pending.get(r.choreId) === 'complete'}
                  disabled={pending.has(r.choreId)}
                  onChange={() => complete(r, due.slice(i + 1).map((n) => n.choreId))}
                />
                <span className="todo-main">
                  <span className="todo-title">{r.title}</span>
                  <span className={r.state === 'overdue' ? 'todo-due overdue' : 'todo-due'}>{boardStateLabel(r, today, true)}</span>
                  {r.todoSyncStatus === 'pending' && <span className="todo-due">Not on to-do list yet</span>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      {waiting.length > 0 && (
        <section aria-labelledby="chores-waiting-heading">
          <h3 id="chores-waiting-heading" className="chores-subhead">Coming up</h3>
          <ul className="todo-list">
            {waiting.map((r) => (
              <li key={r.choreId} className="todo-row chore-waiting">
                <span className="todo-main">
                  <span className="todo-title">{r.title}</span>
                  <span className="todo-due">{boardStateLabel(r, today, true)}</span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {upForGrabs.length > 0 && (
        <section aria-labelledby="chores-grabs-heading">
          <h3 id="chores-grabs-heading" className="chores-subhead">Up for grabs</h3>
          <ul className="todo-list">
            {upForGrabs.map((r) => (
              <li key={r.choreId} className="todo-row">
                <span className="todo-main">
                  <span className="todo-title">{r.title}</span>
                  <span className="todo-due">{r.frequency}</span>
                </span>
                <span className="todo-actions">
                  <button type="button" aria-label={`Claim ${r.title}`} disabled={pending.has(r.choreId)} onClick={() => claim(r)}>
                    Claim
                  </button>
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <p role="status" className="muted todo-status">{status}</p>
    </div>
  );
}
