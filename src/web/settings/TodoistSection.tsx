import { useEffect, useRef, useState } from 'react';
import { TODOIST_LINK_ERRORS, type TodoistLinkError } from '../../shared/integrations.js';
import { formatAgo, serverNowEstimate } from '../freshness.js';
import { useNow } from '../useNow.js';
import { ConnectTodoistButton } from './ConnectTodoistButton.js';
import { useDisconnectTodoist, useSetChoresProject, useTodoistLink } from './queries.js';

/** What unlinking does (spec §10.6, "On unlinking"), said before it happens. */
export const DISCONNECT_CONFIRM =
  'Disconnect Todoist? The open tasks in your Todoist Inbox and your chore to-dos become to-dos here, ' +
  'and new chore to-dos go on your dashboard list. They stop syncing with Todoist. ' +
  "Nothing is deleted from Todoist, and chore to-dos stay linked to their chores. You can connect again later.";

/** What syncs (the owner's change request of 2026-11-16): the Inbox, plus chore to-dos wherever they are. */
export const SYNC_SCOPE_NOTE =
  'Only your Todoist Inbox syncs with this list, plus your chore to-dos wherever they are in Todoist. Tasks in your other projects stay in Todoist.';

/** The result of a link attempt, from `?todoist=connected` or `?todoist_error=` (see the routes). */
export type LinkOutcome = { kind: 'connected' } | { kind: 'error'; code: TodoistLinkError } | null;

export function linkOutcomeFrom(searchStr: string): LinkOutcome {
  const params = new URLSearchParams(searchStr);
  if (params.get('todoist') === 'connected') return { kind: 'connected' };
  const code = params.get('todoist_error');
  return code && Object.hasOwn(TODOIST_LINK_ERRORS, code) ? { kind: 'error', code: code as TodoistLinkError } : null;
}

/**
 * Personal settings → Todoist (spec §7, §10.6): Connect, Reconnect, or Disconnect, and where chore
 * to-dos go. Connecting goes to Todoist's consent page and comes back here (`ConnectTodoistButton`).
 * Without the To-do panel (`hasPanel` false), a link that's still stored can only be disconnected.
 */
export function TodoistSection({ outcome, hasPanel }: { outcome: LinkOutcome; hasPanel: boolean }) {
  const link = useTodoistLink(true);
  const [error, setError] = useState<string | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  const connectRef = useRef<HTMLButtonElement>(null);
  const disconnectedRef = useRef<HTMLParagraphElement>(null);
  const outcomeRef = useRef<HTMLParagraphElement>(null);
  const outcomeFocused = useRef(false);
  const setProject = useSetChoresProject({ onError: (err) => setError(err.message) });
  const disconnect = useDisconnectTodoist({ onError: (err) => setError(err.message), onSuccess: () => setDisconnected(true) });

  // After disconnecting, focus moves to the Connect button that replaces the Disconnect one (or,
  // without the To-do panel, to the message saying it's done).
  useEffect(() => {
    if (disconnected && link.data?.linked === false) (hasPanel ? connectRef : disconnectedRef).current?.focus();
  }, [disconnected, link.data, hasPanel]);

  const linked = link.data?.linked ? link.data : null;

  // Back from Todoist's consent page, worked or not: focus moves to the message saying how it went.
  const outcomeShown = outcome?.kind === 'error' || (outcome?.kind === 'connected' && linked !== null);
  useEffect(() => {
    if (!outcomeShown || outcomeFocused.current) return;
    outcomeFocused.current = true;
    outcomeRef.current?.focus();
  }, [outcomeShown]);
  // "Updated X ago" goes by the server's clock and keeps ticking (see TodoistStatus).
  const clientNow = useNow(30_000);
  const now = linked ? serverNowEstimate(linked.serverNow, link.dataUpdatedAt, clientNow) : clientNow;

  function onDisconnect() {
    if (!window.confirm(DISCONNECT_CONFIRM)) return;
    setError(null);
    disconnect.mutate();
  }

  return (
    <section className="admin-section" aria-labelledby="todoist-heading">
      <h2 id="todoist-heading">Todoist</h2>
      {outcome?.kind === 'error' && <p ref={outcomeRef} tabIndex={-1} className="error" role="alert">{TODOIST_LINK_ERRORS[outcome.code]}</p>}
      {outcome?.kind === 'connected' && linked && <p ref={outcomeRef} tabIndex={-1} role="status">Todoist is connected.</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {link.isPending && <p className="muted">Loading…</p>}
      {link.error && <p className="error">{link.error.message}</p>}
      {link.data?.linked === false && !hasPanel && disconnected && <p role="status" ref={disconnectedRef} tabIndex={-1}>Todoist is disconnected.</p>}
      {link.data?.linked === false && hasPanel && (
        <>
          <p>
            Connect Todoist to use your Todoist Inbox as your to-do list. {SYNC_SCOPE_NOTE} Your open to-dos move into your
            Inbox. Admins can see and edit the tasks in your Inbox and your chore to-dos.
          </p>
          <ConnectTodoistButton label="Connect Todoist" buttonRef={connectRef} />
        </>
      )}
      {linked && !hasPanel && (
        <>
          <p>
            {linked.account ? `Your dashboard is still linked to Todoist as ${linked.account}.` : 'Your dashboard is still linked to Todoist.'}{' '}
            Your To-do panel is turned off, so it isn't syncing. You can disconnect it.
          </p>
          <div>
            <button type="button" onClick={onDisconnect} disabled={disconnect.isPending}>Disconnect Todoist</button>
          </div>
        </>
      )}
      {linked && hasPanel && (
        <>
          {linked.status === 'needs_reconnect' ? (
            <div className="notice" role="alert">
              <p>Todoist needs to be reconnected. Your list shows what was last synced, and changes can't be saved until you reconnect.</p>
              <ConnectTodoistButton label="Reconnect Todoist" />
            </div>
          ) : (
            <p>
              {linked.account ? `Connected as ${linked.account}.` : 'Connected.'}{' '}
              {linked.lastSyncAt ? `Updated ${formatAgo(linked.lastSyncAt, now)}.` : 'Waiting for the first sync.'}
            </p>
          )}
          <p className="muted">{SYNC_SCOPE_NOTE} Admins can see and edit the tasks in your Inbox and your chore to-dos.</p>
          {linked.status === 'error' && (
            <p className="error">Todoist hasn't synced for a while{linked.lastError ? `: ${linked.lastError}` : '.'} It keeps trying.</p>
          )}
          {linked.waitingToMove > 0 && (
            <p className="muted" role="status">Moving {linked.waitingToMove} to-do{linked.waitingToMove === 1 ? '' : 's'} into Todoist…</p>
          )}
          {linked.choresProjectLost && (
            <div className="notice" role="status">
              <p>
                Your chores project, {linked.choresProjectLost}, was deleted or archived in Todoist, so new chore to-dos go to your
                Inbox. Pick another project below, or keep Inbox.
              </p>
              <button
                type="button"
                disabled={setProject.isPending}
                onClick={() => {
                  setError(null);
                  setProject.mutate({ projectId: null });
                }}
              >
                Keep Inbox
              </button>
            </div>
          )}
          <label>
            Chore to-dos go to
            <select
              value={(setProject.isPending ? setProject.variables.projectId : linked.choresProjectId) ?? linked.inboxProjectId ?? ''}
              disabled={setProject.isPending || linked.projects.length === 0}
              onChange={(e) => {
                setError(null);
                const id = e.target.value;
                setProject.mutate({ projectId: id === linked.inboxProjectId ? null : id });
              }}
            >
              {linked.projects.map((p) => (
                <option key={p.id} value={p.id}>{p.id === linked.inboxProjectId ? `${p.name} (default)` : p.name}</option>
              ))}
            </select>
          </label>
          <div>
            <button type="button" onClick={onDisconnect} disabled={disconnect.isPending}>Disconnect Todoist</button>
          </div>
        </>
      )}
    </section>
  );
}
