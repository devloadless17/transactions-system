import { dehydrate, HydrationBoundary } from '@tanstack/react-query';
import type { FlowsResponse, OperationsResponse, PlatformAnalyticsResponse } from '@app/shared';
import { AdminOverview } from '@/features/admin/overview-view';
import { apiServer } from '@/lib/api.server';
import { makeServerQueryClient } from '@/lib/server-query-client';
import { requireRole } from '@/lib/session';
import { analyticsRangeParams, DEFAULT_RANGE, rangeKey } from '@/features/analytics/range';
import { FULL_ADMIN_ROLES } from '@/features/admin/access';

export const dynamic = 'force-dynamic';

// First paint uses AdminOverview's initial range + USD, and the SSR query KEYS
// must match the client's exactly — only then does hydration take.
//
// Both are now DERIVED from DEFAULT_RANGE rather than hand-copied. They used to
// be a literal 'p30' while the client had already moved to `{ mode: 'today' }`,
// so the keys never matched: every admin dashboard load paid for two server
// round-trips whose results were dehydrated into the HTML and then ignored,
// plus the skeleton flash this prefetch exists to avoid.
const RANGE_KEY = rangeKey(DEFAULT_RANGE);
const CURRENCY = 'USD';

export default async function Page() {
  // Overview is platform analytics — full admins only. Back office is redirected
  // to its landing page (it never sees this route in its nav).
  await requireRole(FULL_ADMIN_ROLES);
  const qc = makeServerQueryClient();
  const rp = analyticsRangeParams(DEFAULT_RANGE);
  const flowsParams = new URLSearchParams(rp);
  flowsParams.set('currency', CURRENCY);

  // Prefetch the above-the-fold queries. Each key mirrors the client useQuery.
  // The admin "By source" tile now reads topSources from the per-currency flows
  // response, so the heavy full overview() compute is no longer fetched here.
  await Promise.all([
    qc.prefetchQuery({
      queryKey: ['admin', 'analytics', 'platform', RANGE_KEY],
      queryFn: () =>
        apiServer<PlatformAnalyticsResponse>(`/admin/analytics/platform?${rp.toString()}`),
      // The key is timezone-independent but the BOUNDS are resolved with the
      // server's clock, so a host in another timezone could hydrate a
      // neighbouring day's window (the reason app/(company)/app/page.tsx skips
      // range-keyed prefetching entirely). staleTime 0 keeps the SSR payload as
      // a first-paint placeholder that the client refetches on mount.
      staleTime: 0,
    }),
    qc.prefetchQuery({
      queryKey: ['admin', 'analytics', 'operations'],
      queryFn: () => apiServer<OperationsResponse>('/admin/analytics/operations'),
    }),
    qc.prefetchQuery({
      queryKey: ['admin', 'analytics', 'flows', RANGE_KEY, CURRENCY],
      queryFn: () => apiServer<FlowsResponse>(`/admin/analytics/flows?${flowsParams.toString()}`),
      staleTime: 0, // same reasoning as the platform prefetch above
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
