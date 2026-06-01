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
 * Stacks vertically on mobile and renders inline from `sm` up. Returns
 * `null` (renders nothing) when `totalPages <= 1`.
 */
export function Pagination({
  page,
  totalPages,
  total,
  onPageChange,
}: PaginationProps): React.JSX.Element | null {
  if (totalPages <= 1) return null;

  return (
    <div className="flex flex-col gap-2 text-sm sm:flex-row sm:items-center sm:justify-between">
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
