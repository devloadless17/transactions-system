import { dehydrate, HydrationBoundary } from '@tanstack/react-query';
import type { OperationsResponse } from '@app/shared';
import { AdminOverview } from '@/features/admin/overview-view';
import { apiServer } from '@/lib/api.server';
import { makeServerQueryClient } from '@/lib/server-query-client';
import { requireRole } from '@/lib/session';
import { FULL_ADMIN_ROLES } from '@/features/admin/access';

export const dynamic = 'force-dynamic';

// Only the RANGE-INDEPENDENT query is prefetched here.
//
// The range-keyed ones (platform, flows) deliberately are NOT, for the same
// reason app/(company)/app/page.tsx documents: their window is a LOCAL day, and
// only the browser knows the viewer's timezone. Prefetching them resolved
// "today" against the container's UTC clock while sharing the client's
// timezone-independent cache key, so the tile rendered the server's day first
// and the browser's day a moment later — the same figure visibly changing on
// screen. A first-paint skeleton on two tiles is much cheaper than a revenue
// number nobody can trust.

export default async function Page() {
  // Overview is platform analytics — full admins only. Back office is redirected
  // to its landing page (it never sees this route in its nav).
  await requireRole(FULL_ADMIN_ROLES);
  const qc = makeServerQueryClient();

  await Promise.all([
    qc.prefetchQuery({
      queryKey: ['admin', 'analytics', 'operations'],
      queryFn: () => apiServer<OperationsResponse>('/admin/analytics/operations'),
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
