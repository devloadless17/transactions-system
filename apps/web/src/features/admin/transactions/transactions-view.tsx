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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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
import { TransactionDetailDrawer } from './transaction-detail-drawer';

interface Filters {
  status?: TransactionStatus | '';
  sourceId?: string;
  companyId?: string;
  search?: string;
}

const PAGE_SIZE = 20;

export function TransactionsView({ scope }: { scope: 'admin' | 'company' }) {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<Filters>({});
  const [reverseTarget, setReverseTarget] = useState<TransactionResponse | null>(null);
  const [detailTarget, setDetailTarget] = useState<TransactionResponse | null>(null);
  const params = new URLSearchParams();
  params.set('page', String(page));
  params.set('pageSize', String(PAGE_SIZE));
  if (filters.status) params.set('status', filters.status);
  if (filters.sourceId) params.set('sourceId', filters.sourceId);
  if (filters.companyId) params.set('companyId', filters.companyId);
  if (filters.search) params.set('search', filters.search);

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

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Transactions</h1>
          <p className="text-sm text-muted-foreground">
            {scope === 'admin'
              ? 'All transactions ingested across the platform.'
              : 'Transactions ingested via your API keys.'}
          </p>
        </div>
        <Button variant="outline" onClick={downloadCsv}>
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>External ID</TableHead>
                <TableHead>Source</TableHead>
                {scope === 'admin' && <TableHead>Company</TableHead>}
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-right">Fee</TableHead>
                <TableHead className="text-right">Net</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                {scope === 'admin' && <TableHead></TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell
                    colSpan={scope === 'admin' ? 9 : 7}
                    className="py-8 text-center text-muted-foreground"
                  >
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {error && (
                <TableRow>
                  <TableCell
                    colSpan={scope === 'admin' ? 9 : 7}
                    className="py-8 text-center text-destructive"
                  >
                    {error instanceof ApiClientError ? error.message : 'Failed to load'}
                  </TableCell>
                </TableRow>
              )}
              {data?.data.length === 0 && (
                <TableRow>
                  <TableCell colSpan={scope === 'admin' ? 9 : 7}>
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
                  </TableCell>
                </TableRow>
              )}
              {data?.data.map((t) => (
                <TableRow key={t.id} className="cursor-pointer" onClick={() => setDetailTarget(t)}>
                  <TableCell className="font-mono text-xs">{t.externalTransactionId}</TableCell>
                  <TableCell>{t.sourceCode}</TableCell>
                  {scope === 'admin' && (
                    <TableCell>
                      {companyById.get(t.companyId)?.name ?? t.companyId.slice(0, 8)}
                    </TableCell>
                  )}
                  <TableCell className="text-right font-mono text-xs">
                    {trimAmount(t.amount)} {t.currency}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {trimAmount(t.commissionAmount)}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {trimAmount(t.netAmount)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(t.status)}>{t.status}</Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-xs">
                    {new Date(t.createdAt).toLocaleString()}
                  </TableCell>
                  {scope === 'admin' && (
                    <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                      {t.status === 'COMPLETED' && (
                        <Button variant="ghost" size="sm" onClick={() => setReverseTarget(t)}>
                          Reverse
                        </Button>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
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

      {data && data.meta.totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            Page {data.meta.page} of {data.meta.totalPages} · {data.meta.total} total
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= data.meta.totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
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
