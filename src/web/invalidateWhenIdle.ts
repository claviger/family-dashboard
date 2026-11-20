import { hashKey, type QueryClient, type QueryKey } from '@tanstack/react-query';

interface Refreshing {
  /** A change settled since the current refresh started, so another one is needed. */
  dirty: boolean;
  /** The refresh loop in progress, if any. */
  run: Promise<void> | null;
  /** How many settled changes are waiting for `run`. */
  waiters: number;
}

const state = new WeakMap<QueryClient, Map<string, Refreshing>>();

function refreshingFor(qc: QueryClient, mutationKey: QueryKey): Refreshing {
  let byKey = state.get(qc);
  if (!byKey) state.set(qc, (byKey = new Map()));
  const hash = hashKey(mutationKey);
  let s = byKey.get(hash);
  if (!s) byKey.set(hash, (s = { dirty: false, run: null, waiters: 0 }));
  return s;
}

/**
 * Call from a mutation's `onSettled` (where it still counts as in flight), and return what it
 * returns. Refreshes once the last change under `mutationKey` settles, by calling `refresh`, so a
 * refetch never lands in the middle of another change.
 *
 * A change that settles while another's refresh is out marks the data dirty and waits for that
 * refresh, which then runs again: its first refetch may have read the server before this change
 * landed. So a change stays in flight until a refresh that started after it landed has finished
 * (or leaves the refresh to a change still saving), and the last change to settle is never left
 * out (review S3-M3).
 *
 * It never refetches while a change is still saving (one not waiting for the refresh): that could
 * overwrite what the change shows meanwhile. That change refreshes when it settles instead.
 *
 * `refresh` is called again for each round, so it can re-check anything it depends on.
 */
export function invalidateWhenIdle(qc: QueryClient, mutationKey: QueryKey, refresh: () => Promise<unknown>): Promise<void> | undefined {
  const s = refreshingFor(qc, mutationKey);
  s.dirty = true;
  if (s.run) {
    s.waiters += 1;
    return s.run;
  }
  // Another change is still out: it refreshes when it settles.
  if (qc.isMutating({ mutationKey }) > 1) return;
  s.waiters = 1;
  const run = (async () => {
    try {
      do {
        s.dirty = false;
        await refresh();
      } while (s.dirty && qc.isMutating({ mutationKey }) <= s.waiters);
    } finally {
      s.run = null;
    }
  })();
  s.run = run;
  return run;
}
