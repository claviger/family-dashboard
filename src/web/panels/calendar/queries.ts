import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CalendarEvent, CalendarEventDetail, CalendarWindow, CreateEventInput, EditScope, UpdateEventInput } from '../../../shared/calendar.js';
import { api } from '../../api.js';

const BASE = '/api/panels/calendar';

export const calendarKeys = {
  all: ['calendar'] as const,
  summary: ['calendar', 'summary'] as const,
  window: (start: string, end: string) => ['calendar', 'window', start, end] as const,
  event: (id: string) => ['calendar', 'event', id] as const,
};

/** The home card's window. Refetched every 60 seconds and on focus, like the other cards (spec §7). */
export function useCalendarSummary() {
  return useQuery({ queryKey: calendarKeys.summary, queryFn: () => api<CalendarWindow>(`${BASE}/summary`), refetchInterval: 60_000 });
}

/** One window of the drill-down. The previous window stays on screen while the next one loads. */
export function useCalendarWindow(start: string, end: string) {
  return useQuery({
    queryKey: calendarKeys.window(start, end),
    queryFn: () => api<CalendarWindow>(`${BASE}/events?start=${start}&end=${end}`),
    refetchInterval: 60_000,
    placeholderData: (previous) => previous,
  });
}

/** The refresh button (spec §9.2): fetches the window from Google, skipping the 5-minute cache. Errors go to `onError`. */
export function useRefreshCalendar(handlers: { onError?: (err: Error) => void } = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ['calendar', 'refresh'],
    mutationFn: ({ start, end }: { start: string; end: string }) => api<CalendarWindow>(`${BASE}/events?start=${start}&end=${end}&refresh=1`),
    onSuccess: (data, { start, end }) => qc.setQueryData(calendarKeys.window(start, end), data),
    onError: (err) => handlers.onError?.(err),
  });
}

/** One event, fresh from Google, for the detail and the edit form. Not retried: a 404 means it's gone. */
export function useCalendarEvent(id: string | null) {
  return useQuery({
    queryKey: calendarKeys.event(id ?? ''),
    queryFn: () => api<CalendarEventDetail>(`${BASE}/events/${encodeURIComponent(id!)}`),
    enabled: id !== null,
    staleTime: 0,
    retry: false,
  });
}

export type CalendarAction = 'create' | 'update' | 'delete';

/**
 * Creating, editing, and deleting events. Every call's failure is reported through `onError`
 * (callbacks passed to `mutate()` fire only for the latest call). When one settles, every calendar
 * query refreshes: the server has marked its cached windows stale.
 */
export function useCalendarMutations(handlers: { onError?: (action: CalendarAction, err: Error) => void } = {}) {
  const qc = useQueryClient();
  const onSettled = () => qc.invalidateQueries({ queryKey: calendarKeys.all });
  return {
    create: useMutation({
      mutationKey: ['calendar', 'create'],
      mutationFn: (input: CreateEventInput) => api<CalendarEvent>(`${BASE}/events`, { method: 'POST', body: input }),
      onError: (err) => handlers.onError?.('create', err),
      onSettled,
    }),
    update: useMutation({
      mutationKey: ['calendar', 'update'],
      mutationFn: ({ id, body }: { id: string; body: UpdateEventInput }) => api<void>(`${BASE}/events/${encodeURIComponent(id)}`, { method: 'PATCH', body }),
      onError: (err) => handlers.onError?.('update', err),
      onSettled,
    }),
    remove: useMutation({
      mutationKey: ['calendar', 'delete'],
      mutationFn: ({ id, scope, etag, seriesEtag }: { id: string; scope: EditScope; etag: string; seriesEtag?: string }) => {
        const q = new URLSearchParams({ scope, etag, ...(seriesEtag ? { seriesEtag } : {}) });
        return api<void>(`${BASE}/events/${encodeURIComponent(id)}?${q.toString()}`, { method: 'DELETE' });
      },
      onError: (err) => handlers.onError?.('delete', err),
      onSettled,
    }),
  };
}
