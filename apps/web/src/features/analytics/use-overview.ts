'use client';
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { OverviewResponse } from '@app/shared';
import { apiFetch } from '@/lib/api.client';

export function useOverview(args: {
  scope: 'admin' | 'company';
  currency?: string;
  days?: number;
}) {
  const days = args.days ?? 30;
  // Bucket "now" to whole minutes so the queryKey doesn't churn on every
  // render — otherwise react-query treats each render as a brand-new query
  // and refetches in a loop.
  const { from, to } = useMemo(() => {
    const now = Math.floor(Date.now() / 60_000) * 60_000;
    return {
      to: new Date(now).toISOString(),
      from: new Date(now - days * 24 * 3600 * 1000).toISOString(),
    };
  }, [days]);

  const params = new URLSearchParams({ from, to });
  if (args.currency) params.set('currency', args.currency);
  const path = args.scope === 'admin' ? '/admin/analytics/overview' : '/company/analytics/overview';

  return useQuery({
    queryKey: [args.scope, 'analytics', 'overview', args.currency ?? null, days],
    queryFn: () => apiFetch<OverviewResponse>(`${path}?${params.toString()}`),
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
