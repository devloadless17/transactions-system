import { dehydrate, HydrationBoundary } from '@tanstack/react-query';
import type {
  FlowsResponse,
  OperationsResponse,
  OverviewResponse,
  PlatformAnalyticsResponse,
} from '@app/shared';
import { AdminOverview } from '@/features/admin/overview-view';
import { apiServer } from '@/lib/api.server';
import { makeServerQueryClient } from '@/lib/server-query-client';

export const dynamic = 'force-dynamic';

// First paint always uses the default 30-day preset + USD (see AdminOverview's
// initial state and analytics/date-range.tsx). Replicated here so the SSR query
// KEYS match the client's exactly — only then does hydration take. The preset
// key is the stable token 'p30' (no timestamp), so server/client keys agree
// even though each resolves the absolute window at its own request time.
const RANGE_KEY = 'p30';
const CURRENCY = 'USD';

function defaultRangeParams(): URLSearchParams {
  // Mirrors resolveRange({ mode: 'preset', days: 30 }) in date-range.tsx.
  const anchor = Math.ceil(Date.now() / 60_000) * 60_000;
  return new URLSearchParams({
    from: new Date(anchor - 30 * 24 * 3600 * 1000).toISOString(),
    to: new Date(anchor).toISOString(),
  });
}

export default async function Page() {
  const qc = makeServerQueryClient();
  const rp = defaultRangeParams();
  const flowsParams = new URLSearchParams(rp);
  flowsParams.set('currency', CURRENCY);
  const overviewParams = new URLSearchParams(rp);
  overviewParams.set('currency', CURRENCY);

  // Prefetch the above-the-fold queries. Each key mirrors the client useQuery.
  await Promise.all([
    qc.prefetchQuery({
      queryKey: ['admin', 'analytics', 'platform', RANGE_KEY],
      queryFn: () =>
        apiServer<PlatformAnalyticsResponse>(`/admin/analytics/platform?${rp.toString()}`),
    }),
    qc.prefetchQuery({
      queryKey: ['admin', 'analytics', 'operations'],
      queryFn: () => apiServer<OperationsResponse>('/admin/analytics/operations'),
    }),
    qc.prefetchQuery({
      queryKey: ['admin', 'analytics', 'overview', CURRENCY, RANGE_KEY],
      queryFn: () =>
        apiServer<OverviewResponse>(`/admin/analytics/overview?${overviewParams.toString()}`),
    }),
    qc.prefetchQuery({
      queryKey: ['admin', 'analytics', 'flows', RANGE_KEY, CURRENCY],
      queryFn: () => apiServer<FlowsResponse>(`/admin/analytics/flows?${flowsParams.toString()}`),
    }),
  ]).catch(() => {
    // Swallow prefetch errors — client queries will surface/retry. SSR must not
    // crash the page or break the auth-in-layout flow.
  });

  return (
    <HydrationBoundary state={dehydrate(qc)}>
      <AdminOverview />
    </HydrationBoundary>
  );
}
