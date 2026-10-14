'use client';
import { useQuery } from '@tanstack/react-query';
import type { AdminAttention } from '@app/shared';
import { apiFetch } from '@/lib/api.client';

/**
 * Money a person must look at now: withdrawals stuck in PROCESSING (a Whish
 * transfer whose outcome is unknown, or one that never finished) and Whish Pay
 * payments that need attention. Drives the red sidebar alert, the Withdrawals /
 * Whish Pay banners and the Overview's "Needs your attention" card.
 *
 * Keyed ['admin','operations','attention']: every withdrawal event refreshes it
 * live (realtime bridge). Whish events are far more frequent, so a Whish payment
 * flagged for attention shows within the 60s poll instead.
 */
export function useAdminAttention(): AdminAttention | undefined {
  const q = useQuery({
    queryKey: ['admin', 'operations', 'attention'],
    queryFn: () => apiFetch<AdminAttention>('/admin/operations/attention'),
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    // Ambient alert — must not drive the top progress bar (see TopProgressBar).
    meta: { background: true },
  });
  return q.data;
}
