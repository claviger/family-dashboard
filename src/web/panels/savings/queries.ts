import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  SAVINGS_MESSAGES, type SavingsAccountPatch, type SavingsGroupChoices, type SavingsHandAccountInput, type SavingsImportDraft, type SavingsImportUpdate, type SavingsOverview,
  type SavingsPickChoice, type SavingsSetBalanceInput, type SavingsSettingsView, type SavingsSummary,
} from '../../../shared/savings.js';
import { api, apiUpload } from '../../api.js';
import { invalidateWhenIdle as refreshWhenIdle } from '../../invalidateWhenIdle.js';

const BASE = '/api/panels/savings';

export const savingsKeys = {
  all: ['savings'] as const,
  summary: ['savings', 'summary'] as const,
  overview: (month: string | null) => ['savings', 'overview', month] as const,
  /** Admins, with or without Plaid. */
  settings: ['savings', 'settings'] as const,
};
/** Every Savings change's key starts with `savingsKeys.all`, so `isMutating` sees them all. */
const writeKey = ['savings', 'write'] as const;

/** The home card. Every 60 seconds and on focus, like the other cards (main spec §7). */
export function useSavingsSummary() {
  return useQuery({ queryKey: savingsKeys.summary, queryFn: () => api<SavingsSummary>(`${BASE}/summary`), refetchInterval: 60_000 });
}

/** The drill-down for a month (null: the current one). The last one stays on screen while the next loads. */
export function useSavingsOverview(month: string | null) {
  return useQuery({
    queryKey: savingsKeys.overview(month),
    queryFn: () => api<SavingsOverview>(`${BASE}/overview${month ? `?month=${encodeURIComponent(month)}` : ''}`),
    refetchInterval: 60_000,
    placeholderData: (previous) => previous,
  });
}

export const fetchSavingsSettings = () => api<SavingsSettingsView>(`${BASE}/settings`);

/** Admins, with or without Plaid. `refetchInterval` polls while a sync runs out of sight, as Spend's banks do. */
export function useSavingsSettings(enabled = true, refetchInterval?: () => number | false) {
  return useQuery({ queryKey: savingsKeys.settings, queryFn: fetchSavingsSettings, enabled, refetchInterval: refetchInterval ?? false });
}

/** One settings change. `name` is the connection's or account's, for messages. */
export type SavingsAction =
  | { kind: 'pick'; id: number; name: string; choices: SavingsPickChoice[] }
  | { kind: 'refresh'; id: number; name: string }
  | { kind: 'load'; id: number; name: string }
  | { kind: 'remove'; id: number; name: string; deleteData: boolean }
  | { kind: 'update'; id: number; accountId: number; name: string; patch: SavingsAccountPatch };

/** A change as sent, with the element that had focus then, so focus moved later can give way (Spend's review C-M3). */
export type SentSavingsAction = SavingsAction & { from: Element | null };

function request(v: SavingsAction): { method: 'POST' | 'PATCH'; path: string; body?: unknown } {
  switch (v.kind) {
    case 'pick':
      return { method: 'POST', path: `/connections/${v.id}/accounts`, body: { accounts: v.choices } };
    case 'refresh':
      return { method: 'POST', path: `/connections/${v.id}/refresh` };
    case 'load':
      return { method: 'POST', path: `/connections/${v.id}/load-accounts` };
    case 'remove':
      return { method: 'POST', path: `/connections/${v.id}/remove`, body: { deleteData: v.deleteData } };
    case 'update':
      return { method: 'PATCH', path: `/accounts/${v.accountId}`, body: v.patch };
  }
}

/** Refreshes every Savings query once the last Savings change in flight settles. */
function invalidateWhenIdle(qc: ReturnType<typeof useQueryClient>) {
  return refreshWhenIdle(qc, savingsKeys.all, () => qc.invalidateQueries({ queryKey: savingsKeys.all }));
}

/**
 * Every settings route answers the whole view: it goes into the cache, then every Savings query
 * refreshes once the last change settles. `onError` may return a promise; the change stays
 * pending until it settles, so its controls stay busy meanwhile.
 */
export function useSavingsAction(handlers: { onError?: (v: SentSavingsAction, err: Error) => void | Promise<void>; onSuccess?: (v: SentSavingsAction, view: SavingsSettingsView) => void } = {}) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationKey: writeKey,
    mutationFn: (v: SentSavingsAction) => {
      const { method, path, body } = request(v);
      return api<SavingsSettingsView>(`${BASE}${path}`, { method, body });
    },
    onError: (err, v) => handlers.onError?.(v, err),
    onSuccess: (view, v) => {
      qc.setQueryData(savingsKeys.settings, view);
      handlers.onSuccess?.(v, view);
    },
    onSettled: () => invalidateWhenIdle(qc),
  });
  return { ...mutation, mutate: (v: SavingsAction) => mutation.mutate({ ...v, from: document.activeElement }) };
}

/**
 * Dismisses a removal Plaid never confirmed: the shared admin route the System page and Spend
 * settings use. The notice is in the Savings list and the System page's, so both refresh.
 */
export function useDismissSavingsNotice(handlers: { onError?: (err: Error) => void; onSuccess?: () => void } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api<void>(`/api/admin/integrations/revocations/${id}/dismiss`, { method: 'POST' }),
    onError: (err) => handlers.onError?.(err),
    onSuccess: () => handlers.onSuccess?.(),
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: savingsKeys.settings }), qc.invalidateQueries({ queryKey: ['admin', 'system'] })]),
  });
}

/** A change to one account in Savings settings, linked or added by hand. `name` is its label, for messages. */
export type SavingsAccountAction =
  | { kind: 'add'; name: string; input: SavingsHandAccountInput }
  | { kind: 'patch'; accountId: number; name: string; patch: SavingsAccountPatch }
  | { kind: 'balance'; accountId: number; name: string; input: SavingsSetBalanceInput }
  | { kind: 'removeHand'; accountId: number; name: string; deleteData: boolean }
  | { kind: 'commit'; accountId: number; name: string; draftId: string }
  | { kind: 'undo'; accountId: number; name: string; importId: number; fileName: string | null }
  | { kind: 'editProfile'; accountId: number; name: string; choices: SavingsGroupChoices }
  | { kind: 'clearProfile'; accountId: number; name: string };

export type SentSavingsAccountAction = SavingsAccountAction & { from: Element | null };

function accountRequest(v: SavingsAccountAction): { method: 'POST' | 'PATCH' | 'DELETE'; path: string; body?: unknown } {
  switch (v.kind) {
    case 'add': return { method: 'POST', path: '/accounts', body: v.input };
    case 'patch': return { method: 'PATCH', path: `/accounts/${v.accountId}`, body: v.patch };
    case 'balance': return { method: 'POST', path: `/accounts/${v.accountId}/balance`, body: v.input };
    case 'removeHand': return { method: 'POST', path: `/accounts/${v.accountId}/remove`, body: { deleteData: v.deleteData } };
    case 'commit': return { method: 'POST', path: `/imports/${encodeURIComponent(v.draftId)}/commit`, body: {} };
    case 'undo': return { method: 'DELETE', path: `/accounts/${v.accountId}/imports/${v.importId}` };
    case 'editProfile': return { method: 'PATCH', path: `/accounts/${v.accountId}/import-profile`, body: { choices: v.choices } };
    case 'clearProfile': return { method: 'DELETE', path: `/accounts/${v.accountId}/import-profile` };
  }
}

/** One account change; like useSavingsAction, its answer is the whole settings view, and every Savings query refreshes after. */
export function useSavingsAccountAction(handlers: { onError?: (v: SentSavingsAccountAction, err: Error) => void; onSuccess?: (v: SentSavingsAccountAction, view: SavingsSettingsView) => void } = {}) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationKey: writeKey,
    mutationFn: (v: SentSavingsAccountAction) => {
      const { method, path, body } = accountRequest(v);
      return api<SavingsSettingsView>(`${BASE}${path}`, { method, body });
    },
    onError: (err, v) => handlers.onError?.(v, err),
    onSuccess: (view, v) => {
      qc.setQueryData(savingsKeys.settings, view);
      handlers.onSuccess?.(v, view);
    },
    onSettled: () => invalidateWhenIdle(qc),
  });
  return { ...mutation, mutate: (v: SavingsAccountAction) => mutation.mutate({ ...v, from: document.activeElement }) };
}

/** The import steps' key: outside `savingsKeys.all`, since nothing is saved until Import. */
const draftKey = ['savings-draft'] as const;

/** Uploads a CSV for an account: the draft. Nothing is saved yet, so nothing is refreshed. */
export function useSavingsCsvUpload(handlers: { onError?: (err: Error) => void; onSuccess?: (draft: SavingsImportDraft) => void } = {}) {
  return useMutation({
    mutationKey: draftKey,
    mutationFn: ({ accountId, file }: { accountId: number; file: File }) => {
      const form = new FormData();
      form.set('file', file);
      return apiUpload<SavingsImportDraft>(`${BASE}/accounts/${accountId}/imports`, form, SAVINGS_MESSAGES.importTooBig);
    },
    onError: (err) => handlers.onError?.(err),
    onSuccess: (draft) => handlers.onSuccess?.(draft),
  });
}

/** The columns step (a mapping) or the groups step (with every choice). */
export function useUpdateSavingsImport(handlers: { onError?: (err: Error) => void; onSuccess?: (draft: SavingsImportDraft, sent: SavingsImportUpdate) => void } = {}) {
  return useMutation({
    mutationKey: draftKey,
    mutationFn: ({ draftId, body }: { draftId: string; body: SavingsImportUpdate }) => api<SavingsImportDraft>(`${BASE}/imports/${encodeURIComponent(draftId)}`, { method: 'PUT', body }),
    onError: (err) => handlers.onError?.(err),
    onSuccess: (draft, v) => handlers.onSuccess?.(draft, v.body),
  });
}

/**
 * Cancel: the server forgets the draft and the rows it parsed. A plain call, not a mutation, so it
 * still goes out when the import steps close or the page moves on (an unmount). Best effort: a
 * draft it misses is pruned within the hour anyway.
 */
export function cancelSavingsDraft(draftId: string): void {
  void api<void>(`${BASE}/imports/${encodeURIComponent(draftId)}`, { method: 'DELETE' }).catch(() => undefined);
}
