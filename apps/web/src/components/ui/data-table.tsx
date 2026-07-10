import * as React from 'react';
import { cn } from '@/lib/cn';
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Pagination } from '@/components/ui/pagination';

/**
 * Column definition for {@link DataTable}.
 * - `key` must be unique within the columns array (used as React key).
 * - `header` is the heading cell content.
 * - `cell` renders the body cell for a given row.
 * - `align` controls text alignment of both header and cell ('left' default).
 * - `className` / `headClassName` add classes to body / header cells.
 */
export type Column<T> = {
  key: string;
  header: React.ReactNode;
  cell: (row: T) => React.ReactNode;
  align?: 'left' | 'right';
  className?: string;
  headClassName?: string;
};

export type DataTableProps<T> = {
  columns: Column<T>[];
  rows: T[] | undefined;
  isLoading?: boolean;
  /** Render an error message if present (accepts a string or `{ message }`). */
  error?: unknown;
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  /** Empty-state node rendered (in a full-width cell) when rows.length === 0. */
  empty?: React.ReactNode;
  /** Keep the header visible while the body scrolls vertically. */
  stickyHeader?: boolean;
  className?: string;
  /**
   * Opt-in CLIENT-side pagination for already-fetched, naturally-bounded lists
   * (team members, API keys, the source catalog, …). When set and the row count
   * exceeds it, the table shows only one page at a time with Prev/Next controls.
   * Server-paginated lists (transactions, withdrawals, …) leave this unset and
   * render their own <Pagination/> against the API's meta instead.
   */
  pageSize?: number;
  /**
   * Optional totals row, rendered in a `<tfoot>` beneath the body. Supply the
   * `<TableRow>`/`<TableCell>`s yourself so the cells can span/align to match
   * your columns. Only shown once real rows are on screen — never over the
   * loading skeleton, the error row, or the empty state, where a "total" would
   * be meaningless or misleading.
   */
  footer?: React.ReactNode;
};

function errorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error && typeof error === 'object' && 'message' in error) {
    const m = (error as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return 'Failed to load';
}

/**
 * Generic, responsive table built on the shared `Table` primitives.
 *
 * Handles loading / error / empty states internally (a single centered,
 * full-width row), scrolls horizontally on small screens, and applies a
 * clickable hover style when `onRowClick` is provided. Presentational only —
 * it does no data fetching.
 */
export function DataTable<T>({
  columns,
  rows,
  isLoading,
  error,
  rowKey,
  onRowClick,
  empty,
  stickyHeader,
  className,
  pageSize,
  footer,
}: DataTableProps<T>): React.JSX.Element {
  const colSpan = columns.length || 1;
  const showEmpty = !isLoading && !error && rows != null && rows.length === 0;
  // A totals row only makes sense once real data is on screen.
  const showFooter = footer != null && !isLoading && rows != null && rows.length > 0;

  // Client-side paging (opt-in via `pageSize`): slice the already-loaded rows and
  // expose Prev/Next. Pure view state — never touches the network.
  const [page, setPage] = React.useState(1);
  const total = rows?.length ?? 0;
  const totalPages = pageSize ? Math.max(1, Math.ceil(total / pageSize)) : 1;
  // Clamp back when the list shrinks (a row revoked/removed) so we never strand
  // the viewer on an empty page past the end.
  React.useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);
  const visibleRows = pageSize && rows ? rows.slice((page - 1) * pageSize, page * pageSize) : rows;

  return (
    <div className="w-full">
      <div className="w-full overflow-x-auto">
        <Table className={className}>
          <TableHeader className={cn(stickyHeader && 'sticky top-0 z-10 bg-background')}>
            <TableRow>
              {columns.map((col) => (
                <TableHead
                  key={col.key}
                  className={cn(col.align === 'right' && 'text-right', col.headClassName)}
                >
                  {col.header}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody aria-busy={isLoading}>
            {/* Content-shaped skeleton rows: one cell per column with the same
              alignment/width classes as real rows, so column widths are identical
              and the swap to loaded data causes zero layout shift. */}
            {isLoading &&
              Array.from({ length: 8 }).map((_, i) => (
                <TableRow key={`dt-skeleton-${i}`} aria-hidden>
                  {columns.map((col) => (
                    <TableCell
                      key={col.key}
                      className={cn(col.align === 'right' && 'text-right', col.className)}
                    >
                      <div
                        className={cn(
                          'h-4 w-24 max-w-full animate-pulse rounded bg-muted',
                          col.align === 'right' && 'ml-auto',
                        )}
                      />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            {!isLoading && error != null && (rows == null || rows.length === 0) && (
              <TableRow>
                <TableCell colSpan={colSpan} className="py-8 text-center text-destructive">
                  {errorMessage(error)}
                </TableCell>
              </TableRow>
            )}
            {showEmpty && (
              <TableRow>
                <TableCell colSpan={colSpan} className="p-0">
                  {empty ?? (
                    <div className="py-8 text-center text-muted-foreground">No results.</div>
                  )}
                </TableCell>
              </TableRow>
            )}
            {/* Rows stay visible even if a background refetch errors (keepPreviousData),
              so the table never blanks on a transient failure; the error row above
              only shows on a genuine first-load failure (no rows to keep). */}
            {!isLoading &&
              visibleRows?.map((row) => (
                <TableRow
                  key={rowKey(row)}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  onKeyDown={
                    onRowClick
                      ? (e) => {
                          // Only activate when the ROW ITSELF is focused — let Enter/
                          // Space reach in-row action buttons (Reject/Cancel/Reverse)
                          // instead of hijacking them into a row click.
                          if (e.target !== e.currentTarget) return;
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            onRowClick(row);
                          }
                        }
                      : undefined
                  }
                  tabIndex={onRowClick ? 0 : undefined}
                  className={cn(onRowClick && 'cursor-pointer')}
                >
                  {columns.map((col) => (
                    <TableCell
                      key={col.key}
                      className={cn(col.align === 'right' && 'text-right', col.className)}
                    >
                      {col.cell(row)}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
          </TableBody>
          {showFooter && <TableFooter>{footer}</TableFooter>}
        </Table>
      </div>
      {pageSize != null && (
        <div className="px-4 pb-3">
          <Pagination page={page} total={total} totalPages={totalPages} onPageChange={setPage} />
        </div>
      )}
    </div>
  );
}
