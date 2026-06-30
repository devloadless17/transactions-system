import { Loader2 } from 'lucide-react';

// Suspense fallback for the /pay/* payer landings. If the page is ever slow to
// render (e.g. the very first request after a container start), the payer sees
// this branded card instead of a blank screen or the generic app error boundary.
export default function PayLoading() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/20 p-6">
      <div className="w-full max-w-md rounded-xl border bg-background p-8 text-center shadow-sm">
        <Loader2 className="mx-auto h-12 w-12 animate-spin text-muted-foreground" />
        <h1 className="mt-4 text-xl font-semibold">Loading…</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          One moment while we load your payment confirmation.
        </p>
      </div>
    </main>
  );
}
