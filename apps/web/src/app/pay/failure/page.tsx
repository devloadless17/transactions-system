import { XCircle } from 'lucide-react';

export const dynamic = 'force-dynamic';

export default async function PayFailurePage({
  searchParams,
}: {
  searchParams: Promise<{ ref?: string }>;
}) {
  const { ref } = await searchParams;
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/20 p-6">
      <div className="w-full max-w-md rounded-xl border bg-background p-8 text-center shadow-sm">
        <XCircle className="mx-auto h-12 w-12 text-destructive" />
        <h1 className="mt-4 text-xl font-semibold">Payment not completed</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Your payment could not be completed. You can close this page and try again.
        </p>
        {ref && (
          <p className="mt-4 text-xs text-muted-foreground">
            Reference: <span className="font-mono">#{ref}</span>
          </p>
        )}
      </div>
    </main>
  );
}
