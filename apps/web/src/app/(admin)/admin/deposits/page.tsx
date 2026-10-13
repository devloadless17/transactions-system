import { dehydrate, HydrationBoundary } from '@tanstack/react-query';
import { UserRole, type PaginatedResponse, type TransactionResponse } from '@app/shared';
import { TransactionsView } from '@/features/admin/transactions/transactions-view';
import { apiServer } from '@/lib/api.server';
import { makeServerQueryClient } from '@/lib/server-query-client';
import { getSession } from '@/lib/session';
import { FULL_ADMIN_ROLES } from '@/features/admin/access';

export const dynamic = 'force-dynamic';

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  // Back office views deposits but can't reverse them; only a super admin can
  // record a deposit by hand (it puts money into a company's wallet).
  const session = await getSession();
  const canReverse = !!session && FULL_ADMIN_ROLES.includes(session.role);
  const canCreateDeposit = session?.role === UserRole.SUPER_ADMIN;
  // Refund sends real money back through Whish — super admins only, like the API.
  const canRefund = session?.role === UserRole.SUPER_ADMIN;
  const backoffice = session?.role === UserRole.BACKOFFICE;
  const qc = makeServerQueryClient();

  // Only prefetch the hot first-paint case: a bare load with no filters/page.
  // When the URL carries filters the client builds a different (and possibly
  // timezone-dependent) query key, so we let it fetch and skip SSR matching.
  if (Object.keys(sp).length === 0) {
    // Must match the client's key + fetch in transactions-view.tsx exactly:
    // queryKey [scope, 'transactions', params.toString()] with page 1.
    const key = 'page=1&pageSize=20';
    await qc
      .prefetchQuery({
        queryKey: ['admin', 'transactions', key],
        queryFn: () =>
          apiServer<PaginatedResponse<TransactionResponse>>(`/admin/transactions?${key}`),
      })
      .catch(() => {
        // Swallow prefetch errors (e.g. transient API hiccup) — the client
        // query will surface/retry. SSR must not crash the page.
      });
  }

  return (
    <HydrationBoundary state={dehydrate(qc)}>
      <TransactionsView
        scope="admin"
        canReverse={canReverse}
        canRefund={canRefund}
        canCreateDeposit={canCreateDeposit}
        backoffice={backoffice}
      />
    </HydrationBoundary>
  );
}
