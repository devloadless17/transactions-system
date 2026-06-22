import 'server-only';
import { dehydrate, HydrationBoundary } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { makeServerQueryClient } from './server-query-client';
import { apiServer } from './api.server';

export interface ListPrefetch {
  /**
   * MUST exactly match the key the client `useQuery` uses on first mount, or the
   * hydrated entry is ignored — benign (the client just refetches), but no win.
   */
  queryKey: readonly unknown[];
  /** API path (relative to /v1) to prefetch, e.g. `/company/withdrawals?...`. */
  path: string;
}

/**
 * Server-prefetch a page's primary above-the-fold query (or queries) and hydrate
 * them into the client cache, so the page renders populated on first paint —
 * no client-side loading flash. This is what makes the deposits/overview pages
 * feel instant; using it everywhere makes every list page feel the same.
 *
 * Auth/RLS: `apiServer` forwards the caller's cookies, so each prefetch is scoped
 * exactly like the equivalent client request. Prefetch failures are swallowed —
 * SSR must never crash; the client query refetches on a cache miss.
 *
 * Only use for queries whose default key is DETERMINISTIC server-side. Do NOT use
 * for date-range-defaulted feeds/dashboards: the server's "today" may differ from
 * the browser's, which would hydrate the wrong window.
 */
export async function withListPrefetch(
  prefetches: ListPrefetch[],
  children: ReactNode,
): Promise<ReactNode> {
  const qc = makeServerQueryClient();
  await Promise.all(
    prefetches.map((p) =>
      qc.prefetchQuery({ queryKey: p.queryKey, queryFn: () => apiServer(p.path) }),
    ),
  ).catch(() => {
    // SSR must never crash on a prefetch failure; client queries retry on miss.
  });
  return <HydrationBoundary state={dehydrate(qc)}>{children}</HydrationBoundary>;
}
