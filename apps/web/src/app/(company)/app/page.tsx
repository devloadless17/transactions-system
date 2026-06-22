import { dehydrate, HydrationBoundary } from '@tanstack/react-query';
import type { PaginatedResponse, TransactionResponse, WalletResponse } from '@app/shared';
import { OverviewView } from '@/features/company/overview-view';
import { apiServer } from '@/lib/api.server';
import { makeServerQueryClient } from '@/lib/server-query-client';

export const dynamic = 'force-dynamic';

export default async function CompanyOverview() {
  // The (company) layout already calls requireRole for the three company roles,
  // so we deliberately don't re-auth here (avoids a duplicate /auth/me round-trip).
  // apiServer forwards the user's cookies, so RLS / role isolation is enforced
  // server-side exactly as for the client.
  const qc = makeServerQueryClient();
  await Promise.all([
    // Only the STATIC-keyed queries are prefetched — their keys match the client
    // exactly, so the hydrated data is used immediately instead of flashing a
    // skeleton. This kills the "balance loading" flash (the most trust-sensitive
    // number on the page) and the blank recent-transactions list. The analytics
    // queries are intentionally left to fetch client-side: their key includes a
    // local-day range that depends on the browser timezone, so prefetching with
    // the server's clock could hydrate the wrong day's window.
    qc.prefetchQuery({
      queryKey: ['company', 'wallets'],
      queryFn: () => apiServer<{ data: WalletResponse[] }>('/company/wallets'),
    }),
    qc.prefetchQuery({
      queryKey: ['company', 'transactions', 'recent'],
      queryFn: () =>
        apiServer<PaginatedResponse<TransactionResponse>>('/company/transactions?pageSize=5'),
    }),
  ]).catch(() => {
    // SSR must never crash on a prefetch failure; the client queries fetch/retry
    // on a cache miss or error.
  });

  return (
    <HydrationBoundary state={dehydrate(qc)}>
      <OverviewView />
    </HydrationBoundary>
  );
}
