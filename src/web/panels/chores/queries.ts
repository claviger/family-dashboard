import { useMutation, useMutationState, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  BoardResponse, BoardRowResponse, Chore, ChoreInput, ChoreListResponse, ChorePeopleEntry, ChoreResponse, ChoreSummaryResponse, HistoryResponse, OccurrenceResponse,
  NewChoreInput,
} from '../../../shared/chores.js';
import { api } from '../../api.js';
import { invalidateWhenIdle as refreshWhenIdle } from '../../invalidateWhenIdle.js';
import type { HistoryFilter } from './historySearch.js';

const BASE = '/api/panels/chores';

export const choreKeys = {
  all: ['chores'] as const,
  summary: ['chores', 'summary'] as const,
  board: ['chores', 'board'] as const,
  history: (filter: HistoryFilter) => ['chores', 'history', filter] as const,
  chores: ['chores', 'definitions'] as const,
  people: ['chores', 'people'] as const,
};

/** Every chore mutation key starts with `choreKeys.all`, so `isMutating` sees them all. */
export const choreMutationKeys = {
  occurrence: ['chores', 'occurrence'] as const,
  definition: ['chores', 'definition'] as const,
  chore: ['chores', 'chore'] as const,
};

/**
 * Refreshes chore and to-do queries once the last in-flight chore mutation settles. Chore changes
 * move to-dos (and to-do changes move chores), so both are refreshed. Called from `onSettled`,
 * where the settling mutation still counts as in flight.
 *
 * To-do queries are skipped while a to-do mutation is in flight: refetching them then would
 * overwrite its optimistic state (a ticked checkbox would flicker back). That mutation refreshes
 * them, and chore queries, when it settles.
 */
function invalidateWhenIdle(qc: QueryClient) {
  return refreshWhenIdle(qc, choreKeys.all, () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: choreKeys.all }),
      qc.isMutating({ mutationKey: ['todo'] }) === 0 ? qc.invalidateQueries({ queryKey: ['todo'] }) : undefined,
    ]),
  );
}

export function useChoreSummary() {
  return useQuery({ queryKey: choreKeys.summary, queryFn: () => api<ChoreSummaryResponse>(`${BASE}/summary`), refetchInterval: 60_000 });
}

export function useBoard() {
  return useQuery({ queryKey: choreKeys.board, queryFn: () => api<BoardResponse>(`${BASE}/board`), refetchInterval: 60_000 });
}

export type { HistoryFilter } from './historySearch.js';

export function historyQueryString(f: HistoryFilter): string {
  const p = new URLSearchParams({ person: String(f.person), range: f.range, skipped: String(f.skipped) });
  if (f.range === 'custom') {
    p.set('from', f.from);
    p.set('to', f.to);
  }
  if (f.choreId !== null) p.set('choreId', String(f.choreId));
  return p.toString();
}

/** A custom range waits until both dates are filled in. */
export function useHistory(filter: HistoryFilter) {
  return useQuery({
    queryKey: choreKeys.history(filter),
    queryFn: () => api<HistoryResponse>(`${BASE}/history?${historyQueryString(filter)}`),
    enabled: filter.range !== 'custom' || (filter.from !== '' && filter.to !== ''),
    refetchInterval: 60_000,
  });
}

export function useChores() {
  return useQuery({ queryKey: choreKeys.chores, queryFn: () => api<ChoreListResponse>(`${BASE}/chores`) });
}

export function useChorePeople() {
  return useQuery({ queryKey: choreKeys.people, queryFn: () => api<ChorePeopleEntry[]>(`${BASE}/people`) });
}

/** History's corrections (admins). Complete and skip go through `useChoreAction`. */
export type OccurrenceAction = { action: 'reopen' } | { action: 'credit'; userId: number };

export type OccurrenceVariables = OccurrenceAction & { id: number; title: string };

function bodyOf(v: OccurrenceAction): unknown {
  return v.action === 'credit' ? { userId: v.userId } : undefined;
}

export interface ChoreMutationHandlers {
  /** Called for every failed call (callbacks passed to `mutate()` fire only for the latest call). */
  onError?: (vars: OccurrenceVariables, err: Error) => void;
  /** `occ.warning` is set when an old to-do couldn't be removed yet; show it (spec §14). */
  onSuccess?: (vars: OccurrenceVariables, occ: OccurrenceResponse) => void;
}

/** One mutation for every occurrence action, so any component can see which ids are in flight. */
export function useOccurrenceAction(handlers: ChoreMutationHandlers = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: choreMutationKeys.occurrence,
    mutationFn: (v: OccurrenceVariables) =>
      api<OccurrenceResponse>(`${BASE}/occurrences/${v.id}/${v.action}`, { method: 'POST', body: bodyOf(v) }),
    onError: (err, v) => handlers.onError?.(v, err),
    onSuccess: (occ, v) => handlers.onSuccess?.(v, occ),
    onSettled: () => invalidateWhenIdle(qc),
  });
}

/** Occurrences with an action in flight, from any component: id → action. */
export function usePendingOccurrences(): ReadonlyMap<number, OccurrenceVariables['action']> {
  const pending = useMutationState({
    filters: { mutationKey: choreMutationKeys.occurrence, status: 'pending' },
    select: (m) => m.state.variables as OccurrenceVariables | undefined,
  });
  return new Map(pending.filter((v) => v !== undefined).map((v) => [v.id, v.action]));
}

/** What people do to a chore on the tile and the Board. Complete and skip go to its open occurrence. */
export type ChoreAction =
  | { action: 'claim' | 'release' }
  | { action: 'assign'; userId: number | null }
  | { action: 'complete' | 'skip'; occurrenceId: number };

export type ChoreActionVariables = ChoreAction & { choreId: number; title: string };

function choreActionRequest(v: ChoreActionVariables): Promise<{ warning?: string }> {
  switch (v.action) {
    case 'complete':
    case 'skip':
      return api<OccurrenceResponse>(`${BASE}/occurrences/${v.occurrenceId}/${v.action}`, { method: 'POST' });
    case 'assign':
      return api<BoardRowResponse>(`${BASE}/chores/${v.choreId}/assign`, { method: 'POST', body: { userId: v.userId } });
    default:
      return api<BoardRowResponse>(`${BASE}/chores/${v.choreId}/${v.action}`, { method: 'POST' });
  }
}

/** One mutation for every chore action, so the tile and the Board see which chores are in flight. */
export function useChoreAction(
  handlers: { onError?: (v: ChoreActionVariables, err: Error) => void; onSuccess?: (v: ChoreActionVariables, res: { warning?: string }) => void } = {},
) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: choreMutationKeys.chore,
    mutationFn: choreActionRequest,
    onError: (err, v) => handlers.onError?.(v, err),
    onSuccess: (res, v) => handlers.onSuccess?.(v, res),
    onSettled: () => invalidateWhenIdle(qc),
  });
}

/** Chores with an action in flight, from any component: chore id → action. */
export function usePendingChores(): ReadonlyMap<number, ChoreAction['action']> {
  const pending = useMutationState({
    filters: { mutationKey: choreMutationKeys.chore, status: 'pending' },
    select: (m) => m.state.variables as ChoreActionVariables | undefined,
  });
  return new Map(pending.filter((v) => v !== undefined).map((v) => [v.choreId, v.action]));
}

export type DefinitionVariables =
  | { action: 'create'; input: NewChoreInput }
  | { action: 'update'; id: number; input: ChoreInput }
  | { action: 'pause' | 'resume' | 'archive'; id: number; title: string };

/** Admin changes to chore definitions. Errors go to `onError`, since forms show them in place. */
export function useChoreDefinition(handlers: { onError?: (v: DefinitionVariables, err: Error) => void } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: choreMutationKeys.definition,
    // Create and update return a Chore, which is a ChoreResponse without a warning.
    mutationFn: (v: DefinitionVariables): Promise<ChoreResponse> => {
      if (v.action === 'create') return api<Chore>(`${BASE}/chores`, { method: 'POST', body: v.input });
      if (v.action === 'update') return api<Chore>(`${BASE}/chores/${v.id}`, { method: 'PUT', body: v.input });
      return api<ChoreResponse>(`${BASE}/chores/${v.id}/${v.action}`, { method: 'POST' });
    },
    onError: (err, v) => handlers.onError?.(v, err),
    onSettled: () => invalidateWhenIdle(qc),
  });
}

/** Ids of chores with a pause, resume, or archive in flight. */
export function usePendingChoreIds(): ReadonlySet<number> {
  const ids = useMutationState({
    filters: { mutationKey: choreMutationKeys.definition, status: 'pending' },
    select: (m) => {
      const v = m.state.variables as DefinitionVariables | undefined;
      return v && v.action !== 'create' ? v.id : undefined;
    },
  });
  return new Set(ids.filter((id): id is number => id !== undefined));
}
