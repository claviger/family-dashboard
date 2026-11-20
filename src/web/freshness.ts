/**
 * "Updated X ago" and the stale warning (spec §7, §8). Pure, so it's unit-tested
 * (src/web/freshness.test.ts) and type-checked with the server code.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function plural(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? '' : 's'} ago`;
}

/** "just now", "5 minutes ago", "2 hours ago", "3 days ago". A time in the future counts as now. */
export function formatAgo(iso: string, now: number): string {
  const ms = Math.max(0, now - new Date(iso).getTime());
  if (ms < MINUTE) return 'just now';
  if (ms < HOUR) return plural(Math.floor(ms / MINUTE), 'minute');
  if (ms < DAY) return plural(Math.floor(ms / HOUR), 'hour');
  return plural(Math.floor(ms / DAY), 'day');
}

/**
 * "Now" by the server's clock: the server's time when it answered (`serverNow`), plus how long
 * ago, by this device's clock, the answer arrived (`receivedAt`, e.g. TanStack Query's
 * `dataUpdatedAt`). Ages computed from it don't depend on the device's clock being right, only on
 * it running at the right speed.
 */
export function serverNowEstimate(serverNow: string, receivedAt: number, clientNow: number): number {
  return Date.parse(serverNow) + Math.max(0, clientNow - receivedAt);
}

/** Spec §8: stale once older than twice the source's normal refresh interval. Never synced isn't "stale"; it's shown on its own. */
export function isStale(iso: string | null, now: number, staleAfterMs: number): boolean {
  return iso !== null && now - new Date(iso).getTime() > staleAfterMs;
}
