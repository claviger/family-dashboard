import { useIsMutating, useMutation, useMutationState, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { RowDraft } from './drafts.js';
import {
  SPEND_MESSAGES, type Card, type CardMapping, type CardStatements, type Category, type CsvImportRecord, type DuplicateRemoval, type DuplicateRestore, type ImportPreview, type ImportProfileResponse, type Rule,
  type SpendOverview, type SpendPerson, type SpendSummary, type SpendTransaction, type TransactionBatchChange, type TransactionPatch,
} from '../../../shared/spend.js';
import { api, apiUpload } from '../../api.js';
import { invalidateWhenIdle as refreshWhenIdle } from '../../invalidateWhenIdle.js';

const BASE = '/api/panels/spend';

export const spendKeys = {
  all: ['spend'] as const,
  summary: ['spend', 'summary'] as const,
  importProfile: (cardId: number) => ['spend', 'importProfile', cardId] as const,
  overview: (card: number | null, cycle: string | null) => ['spend', 'overview', card, cycle] as const,
  categories: ['spend', 'categories'] as const,
  people: ['spend', 'people'] as const,
  cards: ['spend', 'cards'] as const,
  statements: (cardId: number) => ['spend', 'statements', cardId] as const,
  imports: (cardId: number) => ['spend', 'imports', cardId] as const,
  rules: ['spend', 'rules'] as const,
  /** Admins with Plaid configured (plaidQueries.ts). */
  banks: ['spend', 'banks'] as const,
  /** Admins (plaidQueries.ts). */
  mappings: ['spend', 'mappings'] as const,
};

/**
 * Every Spend change's key starts with `spendKeys.all`, so `isMutating` sees them all. An upload
 * changes nothing until it's saved (a write), so its key is outside: a change settling while a
 * file uploads still refreshes.
 */
const writeKey = ['spend', 'write'] as const;
/** For Spend changes made by other modules' hooks (plaidQueries.ts), so they settle and refresh with the rest. */
export const spendWriteKey = writeKey;
const transactionKey = ['spend', 'transaction'] as const;
const saveKey = [...transactionKey, 'save'] as const;
const uploadKey = ['spend-upload'] as const;

/** Refreshes every Spend query once the last Spend change in flight settles (see `refreshWhenIdle`). */
export function invalidateWhenIdle(qc: QueryClient) {
  return refreshWhenIdle(qc, spendKeys.all, () => qc.invalidateQueries({ queryKey: spendKeys.all }));
}

/** The home card. Refetched every 60 seconds and on focus, like the other cards (spec §7). */
export function useSpendSummary() {
  return useQuery({ queryKey: spendKeys.summary, queryFn: () => api<SpendSummary>(`${BASE}/summary`), refetchInterval: 60_000 });
}

/** The drill-down for one card and cycle (null: the server's defaults). The last one stays on screen while the next loads. */
export function useSpendOverview(card: number | null, cycle: string | null) {
  const p = new URLSearchParams();
  if (card !== null) p.set('card', String(card));
  if (cycle !== null) p.set('cycle', cycle);
  const qs = p.toString();
  return useQuery({
    queryKey: spendKeys.overview(card, cycle),
    queryFn: () => api<SpendOverview>(`${BASE}/overview${qs ? `?${qs}` : ''}`),
    refetchInterval: 60_000,
    placeholderData: (previous) => previous,
  });
}

export function useSpendCategories() {
  return useQuery({ queryKey: spendKeys.categories, queryFn: () => api<Category[]>(`${BASE}/categories`) });
}

export function useSpendPeople() {
  return useQuery({ queryKey: spendKeys.people, queryFn: () => api<SpendPerson[]>(`${BASE}/people`) });
}

/** Admins only (Spend settings). */
export function useSpendCards(enabled = true) {
  return useQuery({ queryKey: spendKeys.cards, queryFn: () => api<Card[]>(`${BASE}/cards`), enabled });
}

export function useCardStatements(cardId: number | null) {
  return useQuery({ queryKey: spendKeys.statements(cardId ?? 0), queryFn: () => api<CardStatements>(`${BASE}/cards/${cardId}/statements`), enabled: cardId !== null });
}

/** A card's recent imports, for "Undo this import" (admins). */
export function useCardImports(cardId: number) {
  return useQuery({ queryKey: spendKeys.imports(cardId), queryFn: () => api<CsvImportRecord[]>(`${BASE}/cards/${cardId}/imports`) });
}

export function useSpendRules(enabled = true) {
  return useQuery({ queryKey: spendKeys.rules, queryFn: () => api<Rule[]>(`${BASE}/rules`), enabled });
}

/** One change to Spend settings, or a CSV commit: the method, the path under /api/panels/spend, and a label for messages. */
export interface SpendWrite {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  label: string;
  /** The status line once it's saved, when it's more than "Saved X." (decided when it's sent). */
  done?: string;
  /**
   * The element that had focus when it was sent. `useSpendWrite` fills it in, so focus moved once
   * it settles can give way to wherever the person has gone since (review C-M3).
   */
  from?: Element | null;
  /** Called when this call succeeds, whether or not it's the latest: e.g. to clear a field only once the server took it. */
  onDone?: () => void;
}

/**
 * Changes to Spend settings. Every call's failure goes to `onError`, and success to `onSuccess`
 * (callbacks passed to `mutate()` fire only for the latest call). Every Spend query refreshes once
 * the last change settles. `mutate` notes what had focus when it was called, as `from`.
 */
export function useSpendWrite<T = unknown>(handlers: { onError?: (v: SpendWrite, err: Error) => void; onSuccess?: (v: SpendWrite, data: T) => void } = {}) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationKey: writeKey,
    mutationFn: (v: SpendWrite) => api<T>(`${BASE}${v.path}`, { method: v.method, body: v.body }),
    onError: (err, v) => handlers.onError?.(v, err),
    onSuccess: (data, v) => {
      handlers.onSuccess?.(v, data);
      v.onDone?.();
    },
    onSettled: () => invalidateWhenIdle(qc),
  });
  return { ...mutation, mutate: (v: SpendWrite) => mutation.mutate({ ...v, from: v.from === undefined ? document.activeElement : v.from }) };
}

/** A note, or Remove rule (reset to automatic), on one transaction. Category and person picks go through `useTransactionSave`. */
export type TransactionChange =
  | { kind: 'patch'; id: number; patch: TransactionPatch; label: string }
  /** `sent`: the row's drafts when the reset was sent, so only those it still holds are cleared. */
  | { kind: 'reset'; id: number; fields: ('category' | 'person')[]; label: string; sent?: RowDraft };

/** The drill-down's one Save: every draft, and what the status line and focus need once it settles. */
export interface TransactionSave {
  changes: TransactionBatchChange[];
  /** How many fields were edited (not rows). */
  count: number;
  /** The saved rows that were shown when Save was pressed: those a filter now hides are counted. */
  shownIds: readonly number[];
  /** The element that had focus when it was sent (review C-M3). */
  from: Element | null;
}

/** Shows saved rows at once in every drill-down cache; the totals catch up when every query refreshes. */
function putTransactions(qc: QueryClient, saved: readonly SpendTransaction[]) {
  const byId = new Map(saved.map((t) => [t.id, t]));
  qc.setQueriesData<SpendOverview>({ queryKey: ['spend', 'overview'] }, (old) =>
    old ? { ...old, transactions: old.transactions.map((x) => byId.get(x.id) ?? x) } : old,
  );
}

/** Notes and Remove rule (reset to automatic) on a transaction (anyone with the panel). */
export function useTransactionChange(handlers: { onError?: (v: TransactionChange, err: Error) => void; onSuccess?: (v: TransactionChange, t: SpendTransaction) => void } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: transactionKey,
    mutationFn: (v: TransactionChange) =>
      v.kind === 'patch'
        ? api<SpendTransaction>(`${BASE}/transactions/${v.id}`, { method: 'PATCH', body: v.patch })
        : api<SpendTransaction>(`${BASE}/transactions/${v.id}/reset`, { method: 'POST', body: { fields: v.fields } }),
    onError: (err, v) => handlers.onError?.(v, err),
    onSuccess: (t, v) => {
      putTransactions(qc, [t]);
      handlers.onSuccess?.(v, t);
    },
    onSettled: () => invalidateWhenIdle(qc),
  });
}

/**
 * Saves every category and person draft in one request (PATCH /transactions): all of them, or
 * none. The saved rows go into every drill-down cache, and every Spend query refreshes once the
 * last change settles.
 */
export function useTransactionSave(handlers: { onError?: (v: TransactionSave, err: Error) => void; onSuccess?: (v: TransactionSave, saved: SpendTransaction[]) => void } = {}) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationKey: saveKey,
    mutationFn: (v: TransactionSave) => api<SpendTransaction[]>(`${BASE}/transactions`, { method: 'PATCH', body: { changes: v.changes } }),
    onError: (err, v) => handlers.onError?.(v, err),
    onSuccess: (saved, v) => {
      putTransactions(qc, saved);
      handlers.onSuccess?.(v, saved);
    },
    onSettled: () => invalidateWhenIdle(qc),
  });
  return { ...mutation, mutate: (v: Omit<TransactionSave, 'from'>) => mutation.mutate({ ...v, from: document.activeElement }) };
}

/** Remove duplicate, or its Undo (admins). `label` names the row for the status line. */
export type DuplicateChange = { kind: 'remove' | 'restore'; id: number; label: string };

/** Takes a removed row out of every drill-down cache, and out of its twins' lists, so its twin's button goes at once. */
function dropTransaction(qc: QueryClient, id: number) {
  qc.setQueriesData<SpendOverview>({ queryKey: ['spend', 'overview'] }, (old) =>
    old
      ? { ...old, transactions: old.transactions.filter((x) => x.id !== id).map((x) => (x.twinIds.includes(id) ? { ...x, twinIds: x.twinIds.filter((t) => t !== id) } : x)) }
      : old,
  );
}

/** Puts a restored row back in the drill-down showing its card and cycle (the list sorts itself), and back in its twins' lists. */
function putBack(qc: QueryClient, t: SpendTransaction) {
  qc.setQueriesData<SpendOverview>({ queryKey: ['spend', 'overview'] }, (old) => {
    if (!old || old.card?.id !== t.cardId || !old.cycle || t.date < old.cycle.start || t.date > old.cycle.end || old.transactions.some((x) => x.id === t.id)) return old;
    const twins = new Set(t.twinIds);
    return { ...old, transactions: [t, ...old.transactions.map((x) => (twins.has(x.id) && !x.twinIds.includes(t.id) ? { ...x, twinIds: [...x.twinIds, t.id] } : x))] };
  });
}

/**
 * Remove duplicate and its Undo (spec §12.12). The row leaves (or comes back to) the list at once;
 * the totals catch up when every Spend query refreshes, which the change waits for. Counted with
 * the transaction's other changes, so its buttons wait while one is out.
 */
export function useDuplicateChange(handlers: { onError?: (v: DuplicateChange, err: Error) => void; onSuccess?: (v: DuplicateChange, res: DuplicateRemoval | DuplicateRestore) => void } = {}) {
  const qc = useQueryClient();
  const mutation = useMutation({
    mutationKey: [...transactionKey, 'duplicate'],
    mutationFn: (v: DuplicateChange) =>
      api<DuplicateRemoval | DuplicateRestore>(`${BASE}/transactions/${v.id}/${v.kind === 'remove' ? 'remove-duplicate' : 'restore-duplicate'}`, { method: 'POST' }),
    onError: (err, v) => handlers.onError?.(v, err),
    onSuccess: (res, v) => {
      if ('transaction' in res) putBack(qc, res.transaction);
      else dropTransaction(qc, v.id);
      handlers.onSuccess?.(v, res);
    },
    onSettled: () => invalidateWhenIdle(qc),
  });
  return mutation;
}

/** Whether the drill-down's one Save is out. */
export function useIsSavingTransactions(): boolean {
  return useIsMutating({ mutationKey: saveKey }) > 0;
}

/** Transactions with a change in flight, from any component: a note, a reset, or a Save that includes them. */
export function usePendingTransactions(): ReadonlySet<number> {
  const pending = useMutationState({
    filters: { mutationKey: transactionKey, status: 'pending' },
    select: (m) => m.state.variables as TransactionChange | TransactionSave | undefined,
  });
  return new Set(pending.flatMap((v) => (v === undefined ? [] : 'changes' in v ? v.changes.map((c) => c.id) : [v.id])));
}

/**
 * Uploads a CSV for a card and returns its preview (spec §12.13). Errors go to `onError`. Both
 * handlers get the element that had focus when the upload was sent (review C-M3).
 */
export function useCsvUpload(handlers: { onError?: (err: Error, from: Element | null) => void; onSuccess?: (preview: ImportPreview, from: Element | null) => void } = {}) {
  const mutation = useMutation({
    mutationKey: uploadKey,
    mutationFn: ({ cardId, file }: { cardId: number; file: File; from: Element | null }) => {
      const form = new FormData();
      form.set('cardId', String(cardId));
      form.set('file', file);
      return apiUpload<ImportPreview>(`${BASE}/imports`, form, SPEND_MESSAGES.importTooBig);
    },
    onError: (err, v) => handlers.onError?.(err, v.from),
    onSuccess: (preview, v) => handlers.onSuccess?.(preview, v.from),
  });
  return { ...mutation, mutate: (v: { cardId: number; file: File }) => mutation.mutate({ ...v, from: document.activeElement }) };
}

/** A card's saved columns, for its Imports area (admins). */
export function useCardImportProfile(cardId: number) {
  return useQuery({ queryKey: spendKeys.importProfile(cardId), queryFn: () => api<ImportProfileResponse>(`${BASE}/cards/${cardId}/import-profile`) });
}

/**
 * The columns step's Preview: PUT /imports/:id with the mapping (the generic import design). Like
 * the upload it saves nothing, so it's outside the write key. Both handlers get the element that had
 * focus when it was sent.
 */
export function useUpdateCsvImport(handlers: { onError?: (err: Error, from: Element | null) => void; onSuccess?: (preview: ImportPreview, from: Element | null) => void } = {}) {
  const mutation = useMutation({
    mutationKey: uploadKey,
    mutationFn: ({ id, mapping }: { id: string; mapping: CardMapping; from: Element | null }) =>
      api<ImportPreview>(`${BASE}/imports/${encodeURIComponent(id)}`, { method: 'PUT', body: { mapping } }),
    onError: (err, v) => handlers.onError?.(err, v.from),
    onSuccess: (preview, v) => handlers.onSuccess?.(preview, v.from),
  });
  return { ...mutation, mutate: (v: { id: string; mapping: CardMapping }) => mutation.mutate({ ...v, from: document.activeElement }) };
}
