import * as React from 'react';
import { cn } from '@/lib/cn';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

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
}: DataTableProps<T>): React.JSX.Element {
  const colSpan = columns.length || 1;
  const showEmpty = !isLoading && !error && rows != null && rows.length === 0;

  return (
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
        <TableBody>
          {isLoading && (
            <TableRow>
              <TableCell colSpan={colSpan} className="py-8 text-center text-muted-foreground">
                Loading…
              </TableCell>
            </TableRow>
          )}
          {!isLoading && error != null && (
            <TableRow>
              <TableCell colSpan={colSpan} className="py-8 text-center text-destructive">
                {errorMessage(error)}
              </TableCell>
            </TableRow>
          )}
          {showEmpty && (
            <TableRow>
              <TableCell colSpan={colSpan} className="p-0">
                {empty ?? <div className="py-8 text-center text-muted-foreground">No results.</div>}
              </TableCell>
            </TableRow>
          )}
          {!isLoading &&
            error == null &&
            rows?.map((row) => (
              <TableRow
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
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
      </Table>
    </div>
  );
}
