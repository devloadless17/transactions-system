'use client';
import { QueryClient, QueryClientProvider, keepPreviousData } from '@tanstack/react-query';
import { useState } from 'react';

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Realtime invalidation (Socket.IO) already refetches affected
            // queries the moment data changes, so we don't need aggressive
            // re-fetching defaults. A short staleTime avoids redundant
            // network round-trips when navigating between views; focus
            // refetching is off since the socket keeps things fresh.
            staleTime: 30_000,
            refetchOnWindowFocus: false,
            retry: 1,
            // Keep the previous page's data on screen while the next page /
            // filter loads, so paginated tables and dashboards never blank out
            // or jump — the new data swaps in when it arrives. `isLoading` stays
            // false during these transitions (status is already "success" with
            // the prior data), so spinners only show on the genuine first load.
            placeholderData: keepPreviousData,
          },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
