'use client';
import { useQuery } from '@tanstack/react-query';
import type { OverviewResponse } from '@app/shared';
import { apiFetch } from '@/lib/api.client';
import {
  analyticsRangeParams,
  DEFAULT_RANGE,
  isRangeReady,
  rangeKey,
  type DateRange,
} from './date-range';

export function useOverview(args: {
  scope: 'admin' | 'company';
  currency?: string;
  range?: DateRange;
}) {
  const range = args.range ?? DEFAULT_RANGE;
  const path = args.scope === 'admin' ? '/admin/analytics/overview' : '/company/analytics/overview';

  return useQuery({
    // rangeKey makes preset/custom windows distinct cache entries; resolveRange
    // (called in queryFn) anchors preset upper bounds to the minute so the
    // backend's per-window cache stays stable across the 30s auto-refresh.
    queryKey: [args.scope, 'analytics', 'overview', args.currency ?? null, rangeKey(range)],
    queryFn: () => {
      const params = analyticsRangeParams(range);
      if (args.currency) params.set('currency', args.currency);
      return apiFetch<OverviewResponse>(`${path}?${params.toString()}`);
    },
    // A half-finished custom range (one date picked) shouldn't fire a query.
    enabled: isRangeReady(range),
    // No timer polling: the Socket.IO bridge invalidates ['<scope>','analytics']
    // the moment underlying data changes and refetches everything on reconnect,
    // so the dashboard stays live without hammering the API every 30s.
    // (staleTime / focus behaviour come from the global QueryClient defaults.)
  });
}
