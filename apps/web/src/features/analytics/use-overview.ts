'use client';
import { useQuery } from '@tanstack/react-query';
import type { OverviewResponse } from '@app/shared';
import { apiFetch } from '@/lib/api.client';

export function useOverview(args: {
  scope: 'admin' | 'company';
  currency?: string;
  days?: number;
}) {
  const days = args.days ?? 30;
  const path = args.scope === 'admin' ? '/admin/analytics/overview' : '/company/analytics/overview';

  return useQuery({
    queryKey: [args.scope, 'analytics', 'overview', args.currency ?? null, days],
    queryFn: () => {
      // Compute the window at fetch time and round the upper bound UP to the
      // next minute, so a transaction created in the current (partial) minute
      // is inside [from, to] immediately instead of being excluded until the
      // clock ticks over. Bucketing to the minute keeps the backend's
      // per-window cache key stable for ~60s; the queryKey is days-based, so
      // recomputing here never churns the query.
      const anchor = Math.ceil(Date.now() / 60_000) * 60_000;
      const params = new URLSearchParams({
        from: new Date(anchor - days * 24 * 3600 * 1000).toISOString(),
        to: new Date(anchor).toISOString(),
      });
      if (args.currency) params.set('currency', args.currency);
      return apiFetch<OverviewResponse>(`${path}?${params.toString()}`);
    },
    // Periodic refresh keeps the dashboard live without the user touching it.
    refetchInterval: 30_000,
    // Always treat data as stale so navigating back to the dashboard after
    // mutating something (ingesting a tx, requesting a withdrawal) refetches
    // immediately on remount instead of showing the prior snapshot.
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    retry: 1,
  });
}
