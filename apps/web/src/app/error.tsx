'use client';
import { useEffect } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { errorReference } from '@/lib/error-recovery';
import { useErrorRecovery } from '@/lib/use-error-recovery';

/**
 * Global error boundary. Next.js renders this whenever any route segment
 * throws. We surface a friendly UI plus a Reset button instead of the
 * default stack-trace dump.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Logging hook — wire to your error reporter (Sentry, Datadog) here.
    console.error('App error:', error);
  }, [error]);
  const { retry, retrying } = useErrorRecovery(error, reset);
  const ref = errorReference(error);

  return (
    <div className="flex min-h-screen items-center justify-center bg-muted/30 px-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Something went wrong</CardTitle>
          <CardDescription>
            We hit an unexpected error. The issue has been logged. You can try again or head back to
            the dashboard.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="break-words text-xs text-muted-foreground">
            {ref.label}: <span className="font-mono">{ref.value}</span>
          </p>
          <div className="flex gap-2">
            <Button onClick={retry} disabled={retrying}>
              {retrying ? 'Retrying…' : 'Try again'}
            </Button>
            <Button variant="outline" onClick={() => (window.location.href = '/')}>
              Home
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
