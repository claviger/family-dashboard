import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ChoresProjectInput, TodoistLink } from '../../shared/integrations.js';
import { api } from '../api.js';

const BASE = '/api/todoist';

export const todoistKeys = {
  all: ['todoist'] as const,
  link: ['todoist', 'link'] as const,
};

/**
 * The signed-in person's Todoist link. While open to-dos are still moving into Todoist after a
 * link, it refetches every 5 seconds so the count goes down as they move.
 */
export function useTodoistLink(enabled: boolean) {
  return useQuery({
    queryKey: todoistKeys.link,
    queryFn: () => api<TodoistLink>(BASE),
    enabled,
    refetchInterval: (q) => (q.state.data?.linked && q.state.data.waitingToMove > 0 ? 5_000 : 60_000),
  });
}

/**
 * Starts a link: the server sets the flow cookie and answers with Todoist's consent page, which the
 * browser then visits. A POST, so the CSRF check applies.
 */
export function useStartTodoistLink(handlers: { onError?: (err: Error) => void } = {}) {
  return useMutation({
    mutationKey: ['todoist', 'start'],
    mutationFn: () => api<{ url: string }>('/connect/todoist/start', { method: 'POST' }),
    onSuccess: ({ url }) => window.location.assign(url),
    onError: (err) => handlers.onError?.(err),
  });
}

/** Errors are reported through `onError` for every call, like the to-do mutations. */
export function useSetChoresProject(handlers: { onError?: (err: Error) => void } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ['todoist', 'choresProject'],
    mutationFn: (input: ChoresProjectInput) => api<void>(`${BASE}/chores-project`, { method: 'PUT', body: input }),
    onError: (err) => handlers.onError?.(err),
    onSettled: () => qc.invalidateQueries({ queryKey: todoistKeys.all }),
  });
}

/** Unlinking changes the to-do list's backend and can change chore to-dos, so everything refreshes. */
export function useDisconnectTodoist(handlers: { onError?: (err: Error) => void; onSuccess?: () => void } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ['todoist', 'disconnect'],
    mutationFn: () => api<void>(`${BASE}/disconnect`, { method: 'POST' }),
    onError: (err) => handlers.onError?.(err),
    onSuccess: () => handlers.onSuccess?.(),
    onSettled: () =>
      Promise.all([
        qc.invalidateQueries({ queryKey: todoistKeys.all }),
        qc.invalidateQueries({ queryKey: ['todo'] }),
        qc.invalidateQueries({ queryKey: ['chores'] }),
      ]),
  });
}
