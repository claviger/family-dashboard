import { useMutation, useMutationState, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  CreateTodoInput, TodoItem, TodoListResponse, TodoPerson, TodoPrefs, TodoSummaryResponse, UpdateTodoInput,
} from '../../../shared/todo.js';
import { api } from '../../api.js';
import { invalidateWhenIdle as refreshWhenIdle } from '../../invalidateWhenIdle.js';

const BASE = '/api/panels/todo';

/** `userId` undefined means the signed-in user's own list. */
function withOwner(path: string, userId: number | undefined): string {
  return userId === undefined ? path : `${path}?userId=${userId}`;
}

export const todoKeys = {
  all: ['todo'] as const,
  summary: ['todo', 'summary'] as const,
  list: (userId: number | undefined) => ['todo', 'list', userId ?? 'me'] as const,
  people: ['todo', 'people'] as const,
  prefs: ['todo', 'prefs'] as const,
};

/**
 * Mutation keys. Every to-do mutation starts with `todoKeys.all`, so `isMutating` can tell
 * whether another one is still in flight. Completing and reopening share a key, so the home
 * card and the drill-down see each other's in-flight items.
 */
export const todoMutationKeys = {
  create: ['todo', 'create'] as const,
  update: ['todo', 'update'] as const,
  setDone: ['todo', 'setDone'] as const,
  remove: ['todo', 'remove'] as const,
  prefs: ['todo', 'prefs'] as const,
};

/**
 * Refreshes every to-do query once the last in-flight to-do mutation settles. Refetching while
 * another is still running would overwrite that one's optimistic state with stale data.
 * Called from `onSettled`, where the settling mutation still counts as in flight. Chore queries
 * are refreshed too, because completing or deleting a chore's to-do changes the chore, except
 * while a chore mutation is in flight: a refetch then would land in the middle of that change,
 * and the chore mutation refreshes both kinds when it settles.
 */
function invalidateWhenIdle(qc: QueryClient) {
  return refreshWhenIdle(qc, todoKeys.all, () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: todoKeys.all }),
      qc.isMutating({ mutationKey: ['chores'] }) === 0 ? qc.invalidateQueries({ queryKey: ['chores'] }) : undefined,
    ]),
  );
}

/** Ids of items with a pending mutation under `mutationKey`, from any component. */
export function usePendingTodoIds(mutationKey: readonly unknown[]): ReadonlySet<number> {
  const ids = useMutationState({
    filters: { mutationKey, status: 'pending' },
    select: (m) => (m.state.variables as { id: number } | undefined)?.id,
  });
  return new Set(ids.filter((id): id is number => id !== undefined));
}

export function useTodoSummary() {
  return useQuery({
    queryKey: todoKeys.summary,
    queryFn: () => api<TodoSummaryResponse>(`${BASE}/summary`),
    refetchInterval: 60_000,
  });
}

export function useTodoList(userId: number | undefined) {
  return useQuery({
    queryKey: todoKeys.list(userId),
    queryFn: () => api<TodoListResponse>(withOwner(`${BASE}/items`, userId)),
    refetchInterval: 60_000,
  });
}

export function useTodoPeople(enabled: boolean) {
  return useQuery({ queryKey: todoKeys.people, queryFn: () => api<TodoPerson[]>(`${BASE}/people`), enabled });
}

export function useTodoPrefs() {
  return useQuery({ queryKey: todoKeys.prefs, queryFn: () => api<TodoPrefs>(`${BASE}/prefs`) });
}

export function useSaveTodoPrefs() {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: todoMutationKeys.prefs,
    mutationFn: (prefs: TodoPrefs) => api<void>(`${BASE}/prefs`, { method: 'PUT', body: prefs }),
    onSettled: () => invalidateWhenIdle(qc),
  });
}

export type TodoMutationAction = 'create' | 'update' | 'complete' | 'uncomplete' | 'remove';

export interface TodoMutationHandlers {
  /**
   * Called for every failed call. Callbacks passed to `mutate()` fire only for the latest
   * call, so errors are reported here instead. `id` is the item's id, if it has one.
   */
  onError?: (action: TodoMutationAction, err: Error, id: number | undefined) => void;
}

/** Mutations on one person's list. They refresh all to-do queries when the last one settles. */
export function useTodoMutations(userId: number | undefined, handlers: TodoMutationHandlers = {}) {
  const qc = useQueryClient();
  const onSettled = () => invalidateWhenIdle(qc);
  const report = (action: TodoMutationAction, err: Error, id?: number) => handlers.onError?.(action, err, id);
  return {
    create: useMutation({
      mutationKey: todoMutationKeys.create,
      mutationFn: (input: CreateTodoInput) =>
        api<TodoItem>(withOwner(`${BASE}/items`, userId), { method: 'POST', body: input }),
      onError: (err) => report('create', err),
      onSettled,
    }),
    update: useMutation({
      mutationKey: todoMutationKeys.update,
      mutationFn: ({ id, patch }: { id: number; patch: UpdateTodoInput }) =>
        api<TodoItem>(withOwner(`${BASE}/items/${id}`, userId), { method: 'PATCH', body: patch }),
      onError: (err, { id }) => report('update', err, id),
      onSettled,
    }),
    setDone: useMutation({
      mutationKey: todoMutationKeys.setDone,
      mutationFn: ({ id, done }: { id: number; done: boolean }) =>
        api<TodoItem>(withOwner(`${BASE}/items/${id}/${done ? 'complete' : 'uncomplete'}`, userId), { method: 'POST' }),
      onError: (err, { id, done }) => report(done ? 'complete' : 'uncomplete', err, id),
      onSettled,
    }),
    remove: useMutation({
      mutationKey: todoMutationKeys.remove,
      mutationFn: ({ id }: { id: number }) => api<void>(withOwner(`${BASE}/items/${id}`, userId), { method: 'DELETE' }),
      onError: (err, { id }) => report('remove', err, id),
      onSettled,
    }),
  };
}

/**
 * Checkbox completion on the home card (spec §10.3): the item shows as done at once and
 * goes back to open if the server call fails. Only the failed item is rolled back, so other
 * checkboxes ticked in the meantime keep their state.
 */
export function useCompleteFromSummary(handlers: TodoMutationHandlers = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: todoMutationKeys.setDone,
    mutationFn: ({ id }: { id: number }) => api<TodoItem>(`${BASE}/items/${id}/complete`, { method: 'POST' }),
    onMutate: async ({ id }) => {
      await qc.cancelQueries({ queryKey: todoKeys.summary });
      const completedAt = new Date().toISOString();
      qc.setQueryData<TodoSummaryResponse>(todoKeys.summary, (s) =>
        s && { ...s, items: s.items.map((i) => (i.id === id ? { ...i, completedAt } : i)) },
      );
    },
    onError: (err, { id }) => {
      qc.setQueryData<TodoSummaryResponse>(todoKeys.summary, (s) =>
        s && { ...s, items: s.items.map((i) => (i.id === id ? { ...i, completedAt: null } : i)) },
      );
      handlers.onError?.('complete', err, id);
    },
    onSettled: () => invalidateWhenIdle(qc),
  });
}
