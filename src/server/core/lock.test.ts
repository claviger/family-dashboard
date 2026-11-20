import { describe, expect, it } from 'vitest';
import { KeyedLock, LockWaitTimeout } from './lock.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe('KeyedLock', () => {
  it('runs work for one key one at a time, in order, and other keys alongside', async () => {
    const lock = new KeyedLock<number>();
    const log: string[] = [];
    const gate = deferred();
    const a = lock.run(1, async () => { log.push('a start'); await gate.promise; log.push('a end'); });
    const b = lock.run(1, async () => { log.push('b'); });
    const c = lock.run(2, async () => { log.push('c'); });
    await c;
    expect(log).toEqual(['a start', 'c']);
    expect(lock.busy(1)).toBe(true);
    gate.resolve();
    await Promise.all([a, b]);
    expect(log).toEqual(['a start', 'c', 'a end', 'b']);
    await Promise.resolve();
    expect(lock.busy(1)).toBe(false);
  });

  it('gives up waiting at a deadline without ever running the work, but never abandons work that started (R2-M7)', async () => {
    const lock = new KeyedLock<number>();
    const gate = deferred();
    const log: string[] = [];
    const a = lock.run(1, async () => { log.push('a'); await gate.promise; });
    const late = lock.run(1, async () => { log.push('late'); }, { deadline: Date.now() + 20 });
    await expect(late).rejects.toBeInstanceOf(LockWaitTimeout);
    // Work that's already running isn't cut short by its deadline.
    gate.resolve();
    await a;
    const slow = lock.run(1, async () => { await new Promise((r) => setTimeout(r, 40)); return 'done'; }, { deadline: Date.now() + 10 });
    await expect(slow).resolves.toBe('done');
    expect(log).toEqual(['a']);
    // A deadline already passed doesn't run anything.
    await expect(lock.run(1, async () => { log.push('never'); }, { deadline: Date.now() - 1 })).rejects.toBeInstanceOf(LockWaitTimeout);
    await expect(lock.run(1, async () => 'next')).resolves.toBe('next');
    expect(log).toEqual(['a']);
  });

  it('refuses re-entry for the same key instead of waiting for itself forever, and allows other keys', async () => {
    const lock = new KeyedLock<number>();
    const inner = await lock.run(1, async () => {
      await expect(lock.run(1, async () => 'never')).rejects.toThrow(/re-entered/);
      return lock.run(2, async () => 'other key');
    });
    expect(inner).toBe('other key');
    // Work started after the lock was released runs normally.
    await expect(lock.run(1, async () => 'later')).resolves.toBe('later');
  });

  it('keeps going after a failure, and hands the failure to its own caller only', async () => {
    const lock = new KeyedLock<number>();
    const failed = lock.run(1, async () => { throw new Error('boom'); });
    const next = lock.run(1, async () => 'ok');
    await expect(failed).rejects.toThrow('boom');
    await expect(next).resolves.toBe('ok');
  });
});
