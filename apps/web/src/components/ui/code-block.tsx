'use client';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

/**
 * A read-only code/snippet box with a hover "Copy" button. Shared by every
 * documentation tab so code samples look and behave identically everywhere.
 */
export function CodeBlock({ code, className }: { code: string; className?: string }) {
  return (
    <div className={cn('group relative rounded-md border bg-muted/30', className)}>
      <pre className="overflow-x-auto p-3 font-mono text-xs leading-relaxed">{code}</pre>
      <Button
        variant="ghost"
        size="sm"
        className="absolute right-2 top-2 opacity-0 transition-opacity group-hover:opacity-100"
        onClick={() => {
          navigator.clipboard?.writeText(code);
          toast.success('Copied');
        }}
      >
        Copy
      </Button>
    </div>
  );
}
