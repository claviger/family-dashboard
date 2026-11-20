import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BankPickChoice, BanksView, MappingBatchChange, MappingView } from '../../../shared/plaid.js';
import { api } from '../../api.js';
import { invalidateWhenIdle, spendKeys, spendWriteKey } from './queries.js';

/**
 * Spend settings' banks and the Plaid category mapping (spec §12.2, §12.7). Every bank route
 * answers the whole `BanksView`, and every mapping route the whole `MappingView`, so a change's
 * answer goes straight into the cache; then every Spend query refreshes once the last Spend change
 * settles (cards come and go with a pick, transactions with a sync). Failures go to the hook's
 * `onError`, since the control that sent a change can be gone by the time it fails.
 */

const BASE = '/api/panels/spend';

export const fetchBanks = () => api<BanksView>(`${BASE}/banks`);

/** Admins with Plaid configured (a 404 otherwise). `refetchInterval` polls while a sync runs out of sight (review G4-M5). */
export function useBanks(enabled = true, refetchInterval?: () => number | false) {
  return useQuery({ queryKey: spendKeys.banks, queryFn: fetchBanks, enabled, refetchInterval: refetchInterval ?? false });
}

/**
 * Dismisses a removal Plaid never confirmed (the admin route the System page uses too). The
 * notice is in both lists, so both refresh.
 */
export function useDismissRevocation(handlers: { onError?: (err: Error) => void; onSuccess?: () => void } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api<void>(`/api/admin/integrations/revocations/${id}/dismiss`, { method: 'POST' }),
    onError: (err) => handlers.onError?.(err),
    onSuccess: () => handlers.onSuccess?.(),
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: spendKeys.banks }), qc.invalidateQueries({ queryKey: ['admin', 'system'] })]),
  });
}

/** Admins. Works without Plaid: the codes are worth seeing either way. */
export function useMappings(enabled = true) {
  return useQuery({ queryKey: spendKeys.mappings, queryFn: () => fetchMappings(), enabled });
}

/**
 * One bank change: the pick, Refresh (sync now), Load accounts (fetch the bank's account list
 * again, when linking couldn't, or for accounts a sync saw), or Remove. `name` is the bank's, for
 * messages.
 */
export type BankAction =
  | { kind: 'pick'; bankId: number; name: string; choices: BankPickChoice[] }
  | { kind: 'load'; bankId: number; name: string }
  | { kind: 'refresh'; bankId: number; name: string }
  | { kind: 'remove'; bankId: number; name: string; deleteTransactions: boolean };

/** A bank change as sent, with the element that had focus then, so focus moved later can give way (review C-M3). */
export type SentBankAction = BankAction & { from: Element | null };

function bankRequest(v: BankAction): { path: string; body?: unknown } {
  switch (v.kind) {
    case 'pick':
      return { path: `/banks/${v.bankId}/accounts`, body: { accounts: v.choices } };
    case 'refresh':
      return { path: `/banks/${v.bankId}/refresh` };
    case 'load':
      return { path: `/banks/${v.bankId}/load-accounts` };
    case 'remove':
      return { path: `/banks/${v.bankId}/remove`, body: { deleteTransactions: v.deleteTransactions } };
  }
}

/**
 * `onError` may return a promise (checking what an unanswered change did): the change stays
 * pending until it settles, so its controls stay busy meanwhile.
 */
export function useBankAction(handlers: { onError?: (v: SentBankAction, err: Error) => void | Promise<void>; onSuccess?: (v: SentBankAction, view: BanksView) => void } = {}) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationKey: spendWriteKey,
    mutationFn: (v: SentBankAction) => {
      const { path, body } = bankRequest(v);
      return api<BanksView>(`${BASE}${path}`, { method: 'POST', body });
    },
    onError: (err, v) => handlers.onError?.(v, err),
    onSuccess: (view, v) => {
      qc.setQueryData(spendKeys.banks, view);
      handlers.onSuccess?.(v, view);
    },
    onSettled: () => invalidateWhenIdle(qc),
  });
  return { ...mutation, mutate: (v: BankAction) => mutation.mutate({ ...v, from: document.activeElement }) };
}

export const fetchMappings = () => api<MappingView>(`${BASE}/mappings`);

/** The mapping editor's one Save (review G4-I3): every draft in one PATCH, all or nothing. */
export interface MappingSave {
  changes: MappingBatchChange[];
  /** How many codes were edited. */
  count: number;
  /** The element that had focus when it was sent (review C-M3). */
  from: Element | null;
}

/**
 * The page's handler runs before the answer goes into the cache, so it settles its drafts against
 * its own Save's answer first, quietly. `onError` may return a promise (checking
 * what an unanswered Save did): the Save stays pending until it settles.
 */
export function useMappingSave(handlers: { onError?: (v: MappingSave, err: Error) => void | Promise<void>; onSuccess?: (v: MappingSave, view: MappingView) => void } = {}) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationKey: spendWriteKey,
    mutationFn: (v: MappingSave) => api<MappingView>(`${BASE}/mappings`, { method: 'PATCH', body: { changes: v.changes } }),
    onError: (err, v) => handlers.onError?.(v, err),
    onSuccess: (view, v) => {
      handlers.onSuccess?.(v, view);
      qc.setQueryData(spendKeys.mappings, view);
    },
    onSettled: () => invalidateWhenIdle(qc),
  });
  return { ...mutation, mutate: (v: Omit<MappingSave, 'from'>) => mutation.mutate({ ...v, from: document.activeElement }) };
}
