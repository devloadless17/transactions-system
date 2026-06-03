import { dehydrate, HydrationBoundary } from '@tanstack/react-query';
import type { PaginatedResponse, TransactionResponse } from '@app/shared';
import { TransactionsView } from '@/features/admin/transactions/transactions-view';
import { apiServer } from '@/lib/api.server';
import { makeServerQueryClient } from '@/lib/server-query-client';

export const dynamic = 'force-dynamic';

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
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
      <TransactionsView scope="admin" />
    </HydrationBoundary>
  );
}
