'use client';
import { QueryClient, QueryClientProvider, keepPreviousData } from '@tanstack/react-query';
import { useState } from 'react';

/**
 * The app's one QueryClient. It is created in the ROOT layout, so it lives as
 * long as the tab does — across sign-out and sign-in, which are soft
 * navigations — and its query keys carry no user or role. Whatever changes who
 * is signed in must therefore `clear()` it, or the next user on the tab is
 * rendered the previous one's cached data (a full admin's unredacted rows for
 * back office, one company's data for another's):
 *   - the sign-out buttons and the change-password form, on the way out;
 *   - a successful sign-in, on the way in — the catch-all, since a session can
 *     also end with no client code running (a server redirect to /login).
 * An expired session caught by the client leaves by a full page load instead
 * (notifySessionExpired in api.client.ts), which discards this client.
 */
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
            // Keep a view's data cached for 30 min after navigating away, so
            // bouncing between pages in a work session re-renders INSTANTLY from
            // cache (then silently revalidates if older than staleTime) rather than
            // re-showing a skeleton + refetch. Default is 5 min, which evicts mid-session.
            gcTime: 30 * 60_000,
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
