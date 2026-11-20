import { TODOIST_STALE_AFTER_MS, type TodoistFreshness } from '../../../shared/integrations.js';
import { formatAgo, isStale, serverNowEstimate } from '../../freshness.js';
import { ConnectTodoistButton } from '../../settings/ConnectTodoistButton.js';
import { useNow } from '../../useNow.js';

/**
 * For a list that lives in Todoist (spec §7, §8, §14): "Updated X ago", a warning once that's
 * older than twice the 10-minute sync, and a Reconnect prompt when the link needs it. Only the
 * owner can reconnect, so someone else's list (an admin's view) says so instead of linking.
 *
 * The age goes by the server's clock (`serverNowEstimate`, from `receivedAt`, the query's
 * `dataUpdatedAt`), and ticks every 30 seconds while the page stays open.
 */
export function TodoistStatus({ todoist, receivedAt, ownerName }: { todoist: TodoistFreshness; receivedAt: number; ownerName?: string }) {
  const now = serverNowEstimate(todoist.serverNow, receivedAt, useNow(30_000));
  if (todoist.status === 'needs_reconnect') {
    return ownerName ? (
      <p className="notice" role="status">{ownerName}'s Todoist link needs reconnecting. Only they can reconnect it, in their Settings.</p>
    ) : (
      <div className="notice todoist-reconnect" role="alert">
        <span>Todoist needs to be reconnected. Until then this list shows what was last synced, and changes can't be saved.</span>
        <ConnectTodoistButton label="Reconnect Todoist" />
      </div>
    );
  }
  return (
    <p className="muted todoist-freshness">
      {todoist.lastSyncAt ? `Todoist · updated ${formatAgo(todoist.lastSyncAt, now)}` : 'Todoist · waiting for the first sync'}
      {isStale(todoist.lastSyncAt, now, TODOIST_STALE_AFTER_MS) && (
        <span className="error"> · Todoist hasn't synced for a while, so this may be out of date.</span>
      )}
    </p>
  );
}

/** A read-only project tag (spec §10.6: the project is shown, never edited here). */
export function ProjectTag({ projectId, todoist }: { projectId: string | null; todoist: TodoistFreshness }) {
  if (projectId === null) return <span className="project-tag">Not in Todoist yet</span>;
  const name = todoist.projects.find((p) => p.id === projectId)?.name;
  return name ? <span className="project-tag">{name}</span> : null;
}
