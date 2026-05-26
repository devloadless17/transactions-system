'use client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Treat data as stale immediately so navigating back to a page after
            // mutating something always shows the latest. The backend has its
            // own short Redis cache to keep the actual DB hit cheap.
            staleTime: 0,
            // Refresh on focus + on remount so dashboards stay accurate without
            // the user needing to hard-reload.
            refetchOnWindowFocus: true,
            refetchOnMount: 'always',
            retry: 1,
          },
        },
      }),
  );
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
