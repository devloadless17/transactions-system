'use client';
import { useEffect, useState } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@/lib/toast';
import {
  TransactionStatus,
  type PaginatedResponse,
  type SourceResponse,
  type TransactionResponse,
} from '@app/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { DataTable, type Column } from '@/components/ui/data-table';
import { Pagination } from '@/components/ui/pagination';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { apiFetch } from '@/lib/api.client';
import { ApiClientError, publicApiBase } from '@/lib/api';
import { trimAmount } from '@/lib/format';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { EmptyState } from '@/components/empty-state';
import { Inbox } from 'lucide-react';
import {
  DateRangePicker,
  type PickedRange,
  type RangePreset,
} from '@/components/ui/date-range-picker';
import { CompanyFilter, useCompanyNames } from '@/features/admin/company-filter';
import { TransactionDetailDrawer } from './transaction-detail-drawer';

interface Filters {
  status?: TransactionStatus | '';
  sourceId?: string;
  companyId?: string;
  search?: string;
  // Inclusive bounds: dates as YYYY-MM-DD, optional times as HH:mm. Expanded to
  // ISO instants below (full day when a time is omitted).
  from?: string;
  to?: string;
  fromTime?: string;
  toTime?: string;
}

const PAGE_SIZE = 20;

// Filter keys mirrored to the URL (page is handled separately).
const FILTER_KEYS = [
  'status',
  'sourceId',
  'companyId',
  'search',
  'from',
  'to',
  'fromTime',
  'toTime',
] as const;

// Local YYYY-MM-DD, n days before today (0 = today).
function dayKey(daysAgo = 0): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

function filtersFromParams(p: URLSearchParams): Filters {
  const f: Filters = {};
  for (const k of FILTER_KEYS) {
    const v = p.get(k);
    if (v) (f as Record<string, string>)[k] = v;
  }
  return f;
}

// URL query string mirroring page + filters. Page 1 and empty filters are
// omitted to keep the URL clean and the equality check stable.
function urlParamsFromState(page: number, filters: Filters): string {
  const p = new URLSearchParams();
  if (page > 1) p.set('page', String(page));
  for (const k of FILTER_KEYS) {
    const v = filters[k];
    if (v) p.set(k, v);
  }
  return p.toString();
}

// Build an inclusive ISO bound from a date (YYYY-MM-DD) + optional time (HH:mm).
// Returns undefined for a malformed value (e.g. a tampered/stale URL like ?from=x)
// so `.toISOString()` can't throw RangeError during render and crash the page into
// an inescapable error boundary.
function isoBound(date: string, time: string | undefined, endOfDay: boolean): string | undefined {
  const t = time || (endOfDay ? '23:59' : '00:00');
  const d = new Date(`${date}T${t}:${endOfDay ? '59.999' : '00'}`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

// `canReverse` gates the admin-only Reverse action. Back office can view
// transactions (and the detail drawer / CSV) but not reverse them; defaults to
// false so the destructive action is opt-in.
export function TransactionsView({
  scope,
  canReverse = false,
}: {
  scope: 'admin' | 'company';
  canReverse?: boolean;
}) {
  const qc = useQueryClient();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const urlString = searchParams.toString();

  // State is initialised from the URL on mount so a shared/bookmarked link (or
  // the Back button) restores the exact filtered view.
  const [page, setPage] = useState(() => Number(searchParams.get('page')) || 1);
  const [filters, setFilters] = useState<Filters>(() => filtersFromParams(searchParams));

  // Single writer: update page/filters AND push them to the URL together.
  // We use the native `history.replaceState` (which Next integrates with
  // useSearchParams) rather than `router.replace`: a stream of search keystrokes
  // would otherwise fire one RSC roundtrip each. replaceState updates the URL
  // bar + Back/Forward without re-running server components. Because state and
  // URL end up in sync, the read-back effect below stays a no-op — no loop.
  function applyState(nextPage: number, nextFilters: Filters) {
    setPage(nextPage);
    setFilters(nextFilters);
    const qs = urlParamsFromState(nextPage, nextFilters);
    window.history.replaceState(null, '', pathname + (qs ? `?${qs}` : ''));
  }
  // Changing any filter resets back to page 1.
  function setFilter(patch: Partial<Filters>) {
    applyState(1, { ...filters, ...patch });
  }

  // Read-back: adopt external URL changes (Back/Forward) into state. Guarded by
  // equality so our own writes don't trigger a redundant re-sync.
  useEffect(() => {
    if (urlString !== urlParamsFromState(page, filters)) {
      const p = new URLSearchParams(urlString);
      setPage(Number(p.get('page')) || 1);
      setFilters(filtersFromParams(p));
    }
    // Depend only on the URL string; current state is read fresh above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlString]);

  const dateValue: PickedRange = {
    from: filters.from,
    to: filters.to,
    fromTime: filters.fromTime,
    toTime: filters.toTime,
  };
  const datePresets: RangePreset[] = [
    { label: 'Today', from: dayKey(0), to: dayKey(0) },
    { label: 'Last 7 days', from: dayKey(6), to: dayKey(0) },
    { label: 'Last 30 days', from: dayKey(29), to: dayKey(0) },
  ].map((p) => ({
    label: p.label,
    active: filters.from === p.from && filters.to === p.to && !filters.fromTime && !filters.toTime,
    onSelect: () => setFilter({ from: p.from, to: p.to, fromTime: undefined, toTime: undefined }),
  }));
  const [reverseTarget, setReverseTarget] = useState<TransactionResponse | null>(null);
  const [detailTarget, setDetailTarget] = useState<TransactionResponse | null>(null);

  // Debounce the free-text search into the query key only; the input stays live.
  const debouncedSearch = useDebouncedValue(filters.search ?? '', 300);

  const params = new URLSearchParams();
  params.set('page', String(page));
  params.set('pageSize', String(PAGE_SIZE));
  if (filters.status) params.set('status', filters.status);
  if (filters.sourceId) params.set('sourceId', filters.sourceId);
  if (filters.companyId) params.set('companyId', filters.companyId);
  if (debouncedSearch) params.set('search', debouncedSearch);
  // Expand the picked dates/times to inclusive ISO bounds the API expects:
  // start of the "from" instant (default 00:00) through the end of the "to"
  // minute (default 23:59, i.e. end of day).
  if (filters.from) {
    const fromIso = isoBound(filters.from, filters.fromTime, false);
    if (fromIso) params.set('from', fromIso);
  }
  if (filters.to) {
    const toIso = isoBound(filters.to, filters.toTime, true);
    if (toIso) params.set('to', toIso);
  }

  const basePath = scope === 'admin' ? '/admin/transactions' : '/company/transactions';
  const { data, isLoading, error } = useQuery({
    queryKey: [scope, 'transactions', params.toString()],
    queryFn: () =>
      apiFetch<PaginatedResponse<TransactionResponse>>(`${basePath}?${params.toString()}`),
  });

  const sourcesQ = useQuery({
    queryKey: ['sources', 'all'],
    queryFn: () => apiFetch<{ data: SourceResponse[] }>('/admin/sources/all'),
  });

  // Resolve names only for the companies shown on THIS page (no bulk fetch).
  const companyNames = useCompanyNames(
    scope === 'admin' ? (data?.data.map((t) => t.companyId) ?? []) : [],
  );

  const [exporting, setExporting] = useState(false);
  async function downloadCsv() {
    const exportParams = new URLSearchParams(params);
    exportParams.delete('page');
    exportParams.delete('pageSize');
    const path =
      scope === 'admin' ? '/admin/transactions/export.csv' : '/company/transactions/export.csv';
    const base = publicApiBase();
    setExporting(true);
    try {
      // Fetch with credentials, then download the blob. A failed request returns
      // an error body, not a CSV, so check `ok` before saving — otherwise the
      // user silently downloads a file full of error JSON.
      const r = await fetch(`${base}${path}?${exportParams.toString()}`, {
        credentials: 'include',
      });
      if (!r.ok) throw new Error(`Export failed (${r.status})`);
      const blob = await r.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `transactions-${Date.now()}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Export failed. Please try again.');
    } finally {
      setExporting(false);
    }
  }

  const columns: Column<TransactionResponse>[] = [
    {
      key: 'external',
      header: 'External ID',
      className: 'font-mono text-xs',
      cell: (t) => t.externalTransactionId,
    },
    { key: 'source', header: 'Source', cell: (t) => t.sourceCode },
    ...(scope === 'admin'
      ? [
          {
            key: 'company',
            header: 'Company',
            cell: (t: TransactionResponse) =>
              companyNames.get(t.companyId) ?? t.companyId.slice(0, 8),
          } as Column<TransactionResponse>,
        ]
      : []),
    {
      key: 'customer',
      header: 'Customer',
      cell: (t) =>
        t.customer || t.phone ? (
          <div>
            <div>{t.customer ?? '—'}</div>
            {t.phone && <div className="text-xs text-muted-foreground">{t.phone}</div>}
          </div>
        ) : (
          '—'
        ),
    },
    { key: 'target', header: 'Target', cell: (t) => t.target ?? '—' },
    {
      key: 'note',
      header: 'Note',
      cell: (t) =>
        t.note ? (
          <span
            className="block max-w-[14rem] truncate text-xs text-muted-foreground"
            title={t.note}
          >
            {t.note}
          </span>
        ) : (
          '—'
        ),
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      className: 'font-mono text-xs',
      cell: (t) => `${trimAmount(t.amount)} ${t.currency}`,
    },
    {
      key: 'fee',
      header: 'Fee',
      align: 'right',
      className: 'font-mono text-xs',
      cell: (t) => trimAmount(t.commissionAmount),
    },
    {
      key: 'net',
      header: 'Net',
      align: 'right',
      className: 'font-mono text-xs',
      cell: (t) => trimAmount(t.netAmount),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (t) => <Badge variant={statusVariant(t.status)}>{t.status}</Badge>,
    },
    {
      key: 'created',
      header: 'Created',
      className: 'text-muted-foreground text-xs',
      cell: (t) => new Date(t.createdAt).toLocaleString(),
    },
    ...(scope === 'admin' && canReverse
      ? [
          {
            key: 'actions',
            header: '',
            align: 'right',
            cell: (t: TransactionResponse) => (
              <span onClick={(e) => e.stopPropagation()}>
                {t.status === 'COMPLETED' && (
                  <Button variant="ghost" size="sm" onClick={() => setReverseTarget(t)}>
                    Reverse
                  </Button>
                )}
              </span>
            ),
          } as Column<TransactionResponse>,
        ]
      : []),
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Transactions</h1>
          <p className="text-sm text-muted-foreground">
            {scope === 'admin'
              ? 'All transactions ingested across the platform.'
              : 'Transactions ingested via your API keys.'}
          </p>
        </div>
        <Button
          className="w-full sm:w-auto"
          variant="outline"
          onClick={downloadCsv}
          disabled={exporting}
        >
          {exporting ? 'Exporting…' : 'Export CSV'}
        </Button>
      </div>

      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Search ext id</label>
              <Input
                placeholder="ext-001"
                value={filters.search ?? ''}
                onChange={(e) => setFilter({ search: e.target.value })}
                className="w-40"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Date range</label>
              <DateRangePicker
                value={dateValue}
                presets={datePresets}
                placeholder="All dates"
                className="w-64"
                onChange={(v) =>
                  setFilter({
                    from: v.from,
                    to: v.to,
                    fromTime: v.fromTime,
                    toTime: v.toTime,
                  })
                }
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Status</label>
              <select
                value={filters.status ?? ''}
                onChange={(e) => setFilter({ status: (e.target.value as TransactionStatus) || '' })}
                className="h-10 rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">All</option>
                {Object.values(TransactionStatus).map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Source</label>
              <select
                value={filters.sourceId ?? ''}
                onChange={(e) => setFilter({ sourceId: e.target.value || undefined })}
                className="h-10 rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">All</option>
                {sourcesQ.data?.data.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.code}
                  </option>
                ))}
              </select>
            </div>
            {scope === 'admin' && (
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Company</label>
                <CompanyFilter
                  value={filters.companyId ?? ''}
                  onChange={(id) => setFilter({ companyId: id || undefined })}
                />
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <DataTable<TransactionResponse>
            columns={columns}
            rows={data?.data}
            isLoading={isLoading}
            error={error}
            rowKey={(t) => t.id}
            onRowClick={(t) => setDetailTarget(t)}
            empty={
              <EmptyState
                icon={Inbox}
                title="No transactions"
                description={
                  Object.values(filters).some(Boolean)
                    ? 'Try clearing or widening the filters above.'
                    : scope === 'company'
                      ? 'Use one of your API keys to send a transaction via /v1/ingest/transactions.'
                      : 'Once companies start ingesting, transactions will appear here.'
                }
              />
            }
          />
        </CardContent>
      </Card>

      <ReverseTransactionDialog
        target={reverseTarget}
        onClose={() => setReverseTarget(null)}
        onDone={() => {
          setReverseTarget(null);
          qc.invalidateQueries({ queryKey: ['admin', 'transactions'] });
        }}
      />

      <TransactionDetailDrawer
        scope={scope}
        transaction={detailTarget}
        onClose={() => setDetailTarget(null)}
      />

      {data && (
        <Pagination
          page={data.meta.page}
          total={data.meta.total}
          totalPages={data.meta.totalPages}
          onPageChange={(p) => applyState(p, filters)}
        />
      )}
    </div>
  );
}

function ReverseTransactionDialog({
  target,
  onClose,
  onDone,
}: {
  target: TransactionResponse | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState('');
  const mu = useMutation({
    mutationFn: () => {
      if (!target) throw new Error('no target');
      return apiFetch<TransactionResponse>(`/admin/transactions/${target.id}/reverse`, {
        method: 'POST',
        body: { reason },
      });
    },
    onSuccess: () => {
      toast.success('Transaction reversed');
      setReason('');
      onDone();
    },
    onError: (err) => toast.error(err instanceof ApiClientError ? err.message : 'Failed'),
  });

  return (
    <Dialog open={!!target} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reverse transaction</DialogTitle>
          <DialogDescription>
            {target &&
              `Compensating ledger entries will be written for ${trimAmount(target.netAmount)} ${target.currency}. The wallet's available balance must remain non-negative.`}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="reason">Reason (required, ≥3 chars)</Label>
          <Input
            id="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="duplicate ingest / chargeback / …"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={mu.isPending || reason.trim().length < 3}
            onClick={() => mu.mutate()}
          >
            {mu.isPending ? 'Reversing…' : 'Confirm reversal'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function statusVariant(s: TransactionStatus): 'success' | 'warning' | 'destructive' | 'secondary' {
  switch (s) {
    case 'COMPLETED':
      return 'success';
    case 'PENDING':
    case 'PROCESSING':
      return 'warning';
    case 'FAILED':
    case 'REVERSED':
      return 'destructive';
    default:
      return 'secondary';
  }
}
