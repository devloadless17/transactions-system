'use client';
import type { ReactNode } from 'react';
import { AlertTriangle } from 'lucide-react';

/**
 * A red banner for money a person must deal with (a withdrawal stuck in
 * PROCESSING, a Whish payment that needs attention). Shown above the list it
 * concerns, with the one action that narrows the list to those rows.
 */
export function AttentionBanner({
  title,
  children,
  action,
}: {
  title: string;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-md border border-destructive/40 bg-destructive/10 p-4 text-sm sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex items-start gap-2">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        <div className="space-y-1">
          <p className="font-medium text-destructive">{title}</p>
          <div className="text-foreground/80">{children}</div>
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
