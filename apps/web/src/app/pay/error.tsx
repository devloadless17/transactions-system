'use client';

import { useEffect } from 'react';
import { AlertTriangle } from 'lucide-react';

// Error boundary for the /pay/* payer landings. The global app error.tsx points
// people "back to the dashboard" — wrong for an anonymous payer. This one is
// payment-context: reassure that the payment itself may have completed (these are
// post-payment display pages) and offer a retry, with no dashboard links.
export default function PayError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('Pay page error:', error);
  }, [error]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/20 p-6">
      <div className="w-full max-w-md rounded-xl border bg-background p-8 text-center shadow-sm">
        <AlertTriangle className="mx-auto h-12 w-12 text-amber-500" />
        <h1 className="mt-4 text-xl font-semibold">This page didn’t load</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Your payment may still have gone through — check your payment app or your records. You can
          try loading this page again.
        </p>
        <button
          onClick={reset}
          className="mt-5 inline-flex h-10 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          Try again
        </button>
      </div>
    </main>
  );
}
