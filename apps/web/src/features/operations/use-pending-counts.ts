'use client';
import { useQuery } from '@tanstack/react-query';
import type { PendingCounts } from '@app/shared';
import { apiFetch } from '@/lib/api.client';

/**
 * Live count of PENDING (needs-action) requests per money flow, for the sidebar
 * badges. Keyed `[scope, 'operations', 'counts']` so the realtime bridge
 * (withdrawals/payouts/loads topics) invalidates and refreshes it instantly.
 */
export function usePendingCounts(scope: 'admin' | 'company'): Record<string, number> {
  const q = useQuery({
    queryKey: [scope, 'operations', 'counts'],
    queryFn: () => apiFetch<PendingCounts>(`/${scope}/operations/counts`),
    staleTime: 30_000,
    // Ambient sidebar badge — must not drive the top progress bar (see TopProgressBar).
    meta: { background: true },
  });
  return {
    withdrawals: q.data?.withdrawals ?? 0,
    payouts: q.data?.payouts ?? 0,
    loads: q.data?.loads ?? 0,
  };
}
