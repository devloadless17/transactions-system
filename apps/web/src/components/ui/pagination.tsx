import * as React from 'react';
import { Button } from '@/components/ui/button';

export type PaginationProps = {
  page: number;
  totalPages: number;
  total: number;
  /** Optional page size, only used to enrich the summary if provided. */
  pageSize?: number;
  onPageChange: (page: number) => void;
};

/**
 * "Page X of Y · N total" summary with Prev/Next controls.
 *
 * Sticks to the bottom of the scroll viewport so the controls stay reachable
 * without scrolling past a full page of rows; it settles into place at the end
 * of the content. Stacks vertically on mobile and renders inline from `sm` up.
 * Returns `null` (renders nothing) when `totalPages <= 1`.
 */
export function Pagination({
  page,
  totalPages,
  total,
  onPageChange,
}: PaginationProps): React.JSX.Element | null {
  if (totalPages <= 1) return null;

  return (
    <div className="sticky bottom-0 z-10 flex flex-col gap-2 rounded-md border bg-background/95 px-4 py-3 text-sm shadow-sm backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:flex-row sm:items-center sm:justify-between">
      <span className="text-muted-foreground">
        Page {page} of {totalPages} · {total} total
      </span>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 1}
          onClick={() => onPageChange(Math.max(1, page - 1))}
        >
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= totalPages}
          onClick={() => onPageChange(page + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
