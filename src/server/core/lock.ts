import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Runs async work one at a time per key, in the order it was requested. Phase 4 keys it by user
 * id, so every operation on one person's Todoist account (syncs, writes, token refreshes, link,
 * unlink) runs alone: two refreshes can't race and trip Todoist's refresh-token replay rule, and a
 * write can't interleave with a sync that is rewriting the same mirror rows.
 *
 * Not reentrant: calling `run` for a key from inside work already running for that key would wait
 * for itself forever, so it rejects at once instead (the keys held are tracked with
 * AsyncLocalStorage, which follows the work through its awaits). Code that holds the lock calls
 * the unlocked internals instead. Work for other keys can still be started from inside.
 *
 * In-process only, which is enough because one copy of the app runs per database (spec §3.2).
 */
/** `KeyedLock.run` waited past its `deadline` for the lock; the work never ran. */
export class LockWaitTimeout extends Error {
  constructor() {
    super('Gave up waiting for the lock.');
    this.name = 'LockWaitTimeout';
  }
}

export class KeyedLock<K = number> {
  private readonly tails = new Map<K, Promise<void>>();
  private readonly held = new AsyncLocalStorage<ReadonlySet<K>>();

  /**
   * `opts.deadline` (epoch ms, the real clock) bounds the wait for the lock, not the work: past it,
   * the call rejects with LockWaitTimeout and `fn` never runs. Work that has started is never
   * abandoned; it bounds itself.
   */
  run<T>(key: K, fn: () => Promise<T>, opts: { deadline?: number } = {}): Promise<T> {
    const outer = this.held.getStore();
    if (outer?.has(key)) return Promise.reject(new Error(`KeyedLock re-entered for key ${String(key)}; call the unlocked code instead.`));
    if (opts.deadline !== undefined && opts.deadline <= Date.now()) return Promise.reject(new LockWaitTimeout());
    const inside = new Set(outer ?? []).add(key);
    const prev = this.tails.get(key) ?? Promise.resolve();
    let started = false;
    let abandoned = false;
    const result = prev.then(() => {
      if (abandoned) throw new LockWaitTimeout();
      started = true;
      return this.held.run(inside, fn);
    });
    const tail = result.then(
      () => {},
      () => {},
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    if (opts.deadline === undefined) return result;
    const waitMs = opts.deadline - Date.now();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (started) return;
        abandoned = true;
        reject(new LockWaitTimeout());
      }, waitMs);
      timer.unref();
      result.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  /** True while work for `key` is running or waiting. */
  busy(key: K): boolean {
    return this.tails.has(key);
  }
}
