'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
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
          },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
