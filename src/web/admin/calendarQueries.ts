import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { CalendarLinkInfo } from '../../shared/calendar.js';
import { api } from '../api.js';

const BASE = '/api/admin/panels/calendar';

export const calendarLinkKey = ['admin', 'calendar', 'link'] as const;

type Handlers<T = void> = { onError?: (err: Error) => void; onSuccess?: (data: T) => void };

/** The Integrations section's view of the family calendar. */
export function useCalendarLink() {
  return useQuery({ queryKey: calendarLinkKey, queryFn: () => api<CalendarLinkInfo>(`${BASE}/link`) });
}

/** Linking changes what the Calendar panel shows, so its queries refresh too. */
function useLinkMutation<T>(key: string, fn: () => Promise<T>, handlers: Handlers<T>) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ['admin', 'calendar', key],
    mutationFn: fn,
    onError: (err) => handlers.onError?.(err),
    onSuccess: (data) => handlers.onSuccess?.(data),
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: ['admin'] }), qc.invalidateQueries({ queryKey: ['calendar'] })]),
  });
}

/**
 * Starts a link: the server sets the flow cookie and answers with Google's consent page, which the
 * browser then visits. A POST, so the CSRF check applies.
 */
export function useStartCalendarLink(handlers: { onError?: (err: Error) => void } = {}) {
  return useMutation({
    mutationKey: ['admin', 'calendar', 'start'],
    mutationFn: () => api<{ url: string }>('/connect/google-calendar/start', { method: 'POST' }),
    onSuccess: ({ url }) => window.location.assign(url),
    onError: (err) => handlers.onError?.(err),
  });
}

export function useChooseCalendar(handlers: Handlers = {}) {
  const qc = useQueryClient();
  return useMutation({
    mutationKey: ['admin', 'calendar', 'choose'],
    mutationFn: (calendarId: string) => api<void>(`${BASE}/link/choose`, { method: 'POST', body: { calendarId } }),
    onError: (err) => handlers.onError?.(err),
    onSuccess: () => handlers.onSuccess?.(),
    onSettled: () => Promise.all([qc.invalidateQueries({ queryKey: ['admin'] }), qc.invalidateQueries({ queryKey: ['calendar'] })]),
  });
}

export function useChangeCalendar(handlers: Handlers = {}) {
  return useLinkMutation('change', () => api<void>(`${BASE}/link/change`, { method: 'POST' }), handlers);
}

export function useCancelCalendarPick(handlers: Handlers = {}) {
  return useLinkMutation('cancel', () => api<void>(`${BASE}/link/cancel`, { method: 'POST' }), handlers);
}

export function useDisconnectCalendar(handlers: Handlers<{ revoked: boolean }> = {}) {
  return useLinkMutation('disconnect', () => api<{ revoked: boolean }>(`${BASE}/disconnect`, { method: 'POST' }), handlers);
}
