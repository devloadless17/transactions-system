import 'server-only';
import { QueryClient } from '@tanstack/react-query';

/**
 * A fresh QueryClient for server-side prefetching in a Server Component.
 * Always create a NEW one per request (never share across requests) so one
 * user's prefetched data can't leak into another's. The default `staleTime`
 * mirrors the client (see query-client.tsx) so hydrated data isn't treated as
 * stale the instant it lands on the client — which would re-trigger a spinner.
 */
export function makeServerQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
      },
    },
  });
}
