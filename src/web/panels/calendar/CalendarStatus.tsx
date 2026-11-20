import { Link } from '@tanstack/react-router';
import type { CalendarFreshness } from '../../../shared/calendar.js';
import { serverNowEstimate } from '../../freshness.js';
import { useNow } from '../../useNow.js';
import { freshnessLine, readOnlyNote } from './format.js';

/**
 * Where the calendar's events came from (spec §7, §8, §9.2): "Updated X ago" by the server's clock,
 * ticking every 30 seconds, a warning once it's older than 10 minutes, and a note when the events
 * are read-only. Admins also get a way to the Integrations section when the link needs them.
 */
export function CalendarStatus({ freshness, receivedAt, isAdmin }: { freshness: CalendarFreshness; receivedAt: number; isAdmin: boolean }) {
  const now = serverNowEstimate(freshness.serverNow, receivedAt, useNow(30_000));
  const line = freshnessLine(freshness, now);
  const note = readOnlyNote(freshness, isAdmin);
  const adminCanFix = isAdmin && (freshness.readOnly === 'needs_reconnect' || freshness.readOnly === 'key_mismatch');
  return (
    <>
      {note && (
        <p className="notice calendar-note" role="status">
          {note}
          {adminCanFix && <> <Link to="/admin" hash="integrations">Go to Integrations</Link></>}
        </p>
      )}
      {line && (
        <p className="muted todoist-freshness">
          {line.text}
          {line.stale && <span className="error"> · This hasn't updated for a while, so it may be out of date.</span>}
        </p>
      )}
    </>
  );
}
