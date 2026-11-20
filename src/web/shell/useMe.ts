import { useQuery } from '@tanstack/react-query';
import type { MeResponse } from '../../shared/api.js';
import { api } from '../api.js';

export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: () => api<MeResponse>('/api/me'), refetchInterval: 60_000 });
}
