'use client';
import { useState } from 'react';
import { Download } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { toast } from '@/lib/toast';
import { publicApiBase } from '@/lib/api';
import { cn } from '@/lib/cn';

/**
 * Shared "Export CSV" button for every transaction-like list (deposits,
 * activity, withdrawals, payouts, loads, ledger). Sends the list's ACTIVE
 * filters to the matching `…/export.csv` endpoint (the server streams every
 * matching row, ignoring pagination), then downloads the returned blob.
 *
 * The `page` / `pageSize` params are stripped so the export always covers the
 * full filtered set, not just the page on screen. A failed request returns an
 * error body rather than a CSV, so we check `ok` before saving — otherwise the
 * user silently downloads a file full of error JSON.
 */
export function ExportCsvButton({
  path,
  params,
  filename,
  disabled,
  className,
}: {
  /** Endpoint path under the API base, e.g. `/admin/withdrawals/export.csv`. */
  path: string;
  /** The list's current query params (filters). `page`/`pageSize` are dropped. */
  params: URLSearchParams;
  /** Download filename prefix, e.g. `withdrawals` → `withdrawals-<ts>.csv`. */
  filename: string;
  disabled?: boolean;
  className?: string;
}) {
  const [exporting, setExporting] = useState(false);

  async function download() {
    const exportParams = new URLSearchParams(params);
    exportParams.delete('page');
    exportParams.delete('pageSize');
    setExporting(true);
    try {
      const qs = exportParams.toString();
      const r = await fetch(`${publicApiBase()}${path}${qs ? `?${qs}` : ''}`, {
        credentials: 'include',
      });
      if (!r.ok) throw new Error(`Export failed (${r.status})`);
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${filename}-${Date.now()}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Export failed. Please try again.');
    } finally {
      setExporting(false);
    }
  }

  return (
    <Button
      variant="outline"
      className={cn('w-full sm:w-auto', className)}
      onClick={download}
      disabled={disabled || exporting}
    >
      <Download className="mr-2 h-4 w-4" />
      {exporting ? 'Exporting…' : 'Export CSV'}
    </Button>
  );
}
