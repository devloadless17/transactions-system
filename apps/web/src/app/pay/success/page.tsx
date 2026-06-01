import { CheckCircle2 } from 'lucide-react';

export const dynamic = 'force-dynamic';

export default async function PaySuccessPage({
  searchParams,
}: {
  searchParams: Promise<{ ref?: string }>;
}) {
  const { ref } = await searchParams;
  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/20 p-6">
      <div className="w-full max-w-md rounded-xl border bg-background p-8 text-center shadow-sm">
        <CheckCircle2 className="mx-auto h-12 w-12 text-green-600" />
        <h1 className="mt-4 text-xl font-semibold">Payment successful</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Thank you — your payment has been received and is being confirmed.
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
