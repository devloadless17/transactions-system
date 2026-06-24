'use client';
import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from '@/lib/toast';
import { cn } from '@/lib/cn';

/**
 * Inline click-to-copy text. Copies `value` to the clipboard on click and shows
 * a brief confirmation. `stopPropagation` so it can live inside a clickable row
 * (e.g. the admin queue rows open a review dialog on click) without triggering
 * that row action. Displays `value` unless `display` is given; the full `value`
 * is always what gets copied (so a truncated wallet address still copies whole).
 */
export function CopyText({
  value,
  label,
  display,
  className,
  multiline = false,
}: {
  value: string | null | undefined;
  label?: string;
  display?: string;
  className?: string;
  // Multi-line content (e.g. a note): don't truncate; wrap and keep line breaks,
  // with the copy icon trailing the last line.
  multiline?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  if (!value) return <span className="text-muted-foreground">—</span>;
  return (
    <button
      type="button"
      title={`Copy${label ? ` ${label}` : ''}`}
      onClick={(e) => {
        e.stopPropagation();
        if (!navigator.clipboard) return;
        void navigator.clipboard.writeText(value);
        setCopied(true);
        toast.success(`${label ? `${label} ` : ''}copied`);
        window.setTimeout(() => setCopied(false), 1200);
      }}
      className={cn(
        'group inline-flex max-w-full gap-1 text-left align-middle hover:text-foreground',
        multiline ? 'items-start' : 'items-center',
        className,
      )}
    >
      <span className={multiline ? 'whitespace-pre-wrap break-words' : 'truncate'}>
        {display ?? value}
      </span>
      {copied ? (
        <Check className="mt-0.5 h-3 w-3 shrink-0 text-emerald-500" />
      ) : (
        <Copy className="mt-0.5 h-3 w-3 shrink-0 opacity-0 transition-opacity group-hover:opacity-60" />
      )}
    </button>
  );
}
