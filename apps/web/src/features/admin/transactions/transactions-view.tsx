'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  TransactionStatus,
  type CompanyResponse,
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
import { ApiClientError } from '@/lib/api';
import { EmptyState } from '@/components/empty-state';
import { Inbox } from 'lucide-react';
import {
  DateRangePicker,
  type PickedRange,
  type RangePreset,
} from '@/components/ui/date-range-picker';
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

// Local YYYY-MM-DD, n days before today (0 = today).
function dayKey(daysAgo = 0): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

export function TransactionsView({ scope }: { scope: 'admin' | 'company' }) {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<Filters>({});

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
    onSelect: () => {
      setPage(1);
      setFilters((f) => ({ ...f, from: p.from, to: p.to, fromTime: undefined, toTime: undefined }));
    },
  }));
  const [reverseTarget, setReverseTarget] = useState<TransactionResponse | null>(null);
  const [detailTarget, setDetailTarget] = useState<TransactionResponse | null>(null);
  const params = new URLSearchParams();
  params.set('page', String(page));
  params.set('pageSize', String(PAGE_SIZE));
  if (filters.status) params.set('status', filters.status);
  if (filters.sourceId) params.set('sourceId', filters.sourceId);
  if (filters.companyId) params.set('companyId', filters.companyId);
  if (filters.search) params.set('search', filters.search);
  // Expand the picked dates/times to inclusive ISO bounds the API expects:
  // start of the "from" instant (default 00:00) through the end of the "to"
  // minute (default 23:59, i.e. end of day).
  if (filters.from)
    params.set('from', new Date(`${filters.from}T${filters.fromTime || '00:00'}:00`).toISOString());
  if (filters.to)
    params.set('to', new Date(`${filters.to}T${filters.toTime || '23:59'}:59.999`).toISOString());

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

  const companiesQ = useQuery({
    enabled: scope === 'admin',
    queryKey: ['admin', 'companies', 'all'],
    queryFn: () => apiFetch<PaginatedResponse<CompanyResponse>>('/admin/companies?pageSize=100'),
  });

  const companyById = new Map(companiesQ.data?.data.map((c) => [c.id, c]) ?? []);

  function downloadCsv() {
    const exportParams = new URLSearchParams(params);
    exportParams.delete('page');
    exportParams.delete('pageSize');
    const path =
      scope === 'admin' ? '/admin/transactions/export.csv' : '/company/transactions/export.csv';
    const base = process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001/v1';
    // Use a hidden iframe-style download — fetch with credentials, then blob.
    fetch(`${base}${path}?${exportParams.toString()}`, { credentials: 'include' })
      .then((r) => r.blob())
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `transactions-${Date.now()}.csv`;
        a.click();
        URL.revokeObjectURL(url);
      });
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
              companyById.get(t.companyId)?.name ?? t.companyId.slice(0, 8),
          } as Column<TransactionResponse>,
        ]
      : []),
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
    ...(scope === 'admin'
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
        <Button className="w-full sm:w-auto" variant="outline" onClick={downloadCsv}>
          Export CSV
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
                onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
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
                onChange={(v) => {
                  setPage(1);
                  setFilters((f) => ({
                    ...f,
                    from: v.from,
                    to: v.to,
                    fromTime: v.fromTime,
                    toTime: v.toTime,
                  }));
                }}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Status</label>
              <select
                value={filters.status ?? ''}
                onChange={(e) =>
                  setFilters((f) => ({ ...f, status: (e.target.value as TransactionStatus) || '' }))
                }
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
                onChange={(e) =>
                  setFilters((f) => ({ ...f, sourceId: e.target.value || undefined }))
                }
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
                <select
                  value={filters.companyId ?? ''}
                  onChange={(e) =>
                    setFilters((f) => ({ ...f, companyId: e.target.value || undefined }))
                  }
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm"
                >
                  <option value="">All</option>
                  {companiesQ.data?.data.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
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
          onPageChange={setPage}
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

function trimAmount(s: string): string {
  if (!s.includes('.')) return s;
  return s.replace(/\.?0+$/, '');
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
