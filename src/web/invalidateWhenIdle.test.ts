import { MutationObserver, QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { invalidateWhenIdle } from './invalidateWhenIdle.js';

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * A panel with one query, which reads the server's value when its fetch starts and answers when the
 * test says, and mutations that each set the server's value.
 */
function setup() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const server = { value: 0 };
  const fetches: { resolve: () => void }[] = [];
  const observer = new QueryObserver(qc, {
    queryKey: ['panel', 'data'],
    queryFn: () => {
      const seen = server.value;
      const d = deferred();
      fetches.push({ resolve: d.resolve });
      return d.promise.then(() => seen);
    },
  });
  const unsubscribe = observer.subscribe(() => {});
  const refresh = () => qc.invalidateQueries({ queryKey: ['panel'] });
  function mutation(value: number) {
    const write = deferred();
    const m = new MutationObserver(qc, {
      mutationKey: ['panel', 'write'],
      mutationFn: async () => {
        await write.promise;
        server.value = value;
      },
      onSettled: () => invalidateWhenIdle(qc, ['panel'], refresh),
    });
    const done = m.mutate().catch(() => {});
    return { land: () => write.resolve(), done, observer: m };
  }
  return { qc, server, fetches, mutation, unsubscribe, data: () => qc.getQueryData<number>(['panel', 'data']) };
}

describe('invalidateWhenIdle', () => {
  it('refreshes once when the last change settles', async () => {
    const s = setup();
    s.fetches[0]!.resolve();
    await tick();
    const a = s.mutation(1);
    const b = s.mutation(2);
    a.land();
    await tick();
    // B is still out, so A leaves the refresh to it.
    expect(s.fetches).toHaveLength(1);
    b.land();
    await tick();
    expect(s.fetches).toHaveLength(2);
    s.fetches[1]!.resolve();
    await Promise.all([a.done, b.done]);
    expect(s.data()).toBe(2);
    s.unsubscribe();
  });

  it("refreshes again when a change settles during another's refresh", async () => {
    const s = setup();
    s.fetches[0]!.resolve();
    await tick();
    const a = s.mutation(1);
    a.land();
    await tick();
    // A's refresh is out (it read 1), and A counts as in flight until it lands.
    expect(s.fetches).toHaveLength(2);
    const b = s.mutation(2);
    b.land();
    await tick();
    s.fetches[1]!.resolve();
    await tick();
    // B's change came after that read, so another refresh follows.
    expect(s.fetches).toHaveLength(3);
    s.fetches[2]!.resolve();
    await Promise.all([a.done, b.done]);
    expect(s.data()).toBe(2);
    s.unsubscribe();
  });

  it("doesn't refetch again while another change is still out, and that one refreshes when it settles", async () => {
    const s = setup();
    s.fetches[0]!.resolve();
    await tick();
    const a = s.mutation(1);
    a.land();
    await tick();
    expect(s.fetches).toHaveLength(2);
    const b = s.mutation(2);
    const c = s.mutation(3);
    c.land();
    await tick();
    s.fetches[1]!.resolve();
    await Promise.all([a.done, c.done]);
    // B is still out: a refetch now could overwrite what it shows while it saves.
    expect(s.fetches).toHaveLength(2);
    b.land();
    await tick();
    expect(s.fetches).toHaveLength(3);
    s.fetches[2]!.resolve();
    await b.done;
    expect(s.data()).toBe(2);
    s.unsubscribe();
  });

  it('keeps a change in flight until the refresh that covers it lands', async () => {
    const s = setup();
    s.fetches[0]!.resolve();
    await tick();
    const a = s.mutation(1);
    a.land();
    await tick();
    const b = s.mutation(2);
    b.land();
    await tick();
    expect(b.observer.getCurrentResult().isPending).toBe(true);
    s.fetches[1]!.resolve();
    await tick();
    expect(b.observer.getCurrentResult().isPending).toBe(true);
    s.fetches[2]!.resolve();
    await Promise.all([a.done, b.done]);
    expect(b.observer.getCurrentResult().isPending).toBe(false);
    expect(s.qc.isMutating()).toBe(0);
    s.unsubscribe();
  });
});
