'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import Link from 'next/link';
import {
  SUPPORTED_CURRENCIES,
  type AuditLogResponse,
  type CompanyResponse,
  type OverviewResponse,
  type PaginatedResponse,
  type TransactionResponse,
  type WalletResponse,
} from '@app/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { DataTable, type Column } from '@/components/ui/data-table';
import { apiFetch } from '@/lib/api.client';
import { ApiClientError } from '@/lib/api';
import { KpiCard } from '@/features/analytics/kpi-card';
import { VolumeChart } from '@/features/analytics/volume-chart';
import { CompanyUsersCard } from './company-users-card';

export function CompanyDetailView({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const [chartCurrency, setChartCurrency] = useState<string>('USD');
  const [chartDays, setChartDays] = useState<number>(30);

  const companyQ = useQuery({
    queryKey: ['admin', 'company', companyId],
    queryFn: () => apiFetch<CompanyResponse>(`/admin/companies/${companyId}`),
  });

  const overviewQ = useQuery({
    queryKey: ['admin', 'company', companyId, 'overview', chartCurrency, chartDays],
    queryFn: () => {
      const to = new Date();
      const from = new Date(to.getTime() - chartDays * 24 * 3600 * 1000);
      const params = new URLSearchParams({
        from: from.toISOString(),
        to: to.toISOString(),
        currency: chartCurrency,
      });
      return apiFetch<OverviewResponse>(
        `/admin/analytics/companies/${companyId}/overview?${params.toString()}`,
      );
    },
  });
  const walletsQ = useQuery({
    queryKey: ['admin', 'company', companyId, 'wallets'],
    queryFn: () => apiFetch<{ data: WalletResponse[] }>(`/admin/companies/${companyId}/wallets`),
  });
  const txQ = useQuery({
    queryKey: ['admin', 'company', companyId, 'transactions'],
    queryFn: () =>
      apiFetch<PaginatedResponse<TransactionResponse>>(
        `/admin/transactions?companyId=${companyId}&pageSize=10`,
      ),
  });
  const auditQ = useQuery({
    queryKey: ['admin', 'company', companyId, 'audit'],
    queryFn: () =>
      apiFetch<PaginatedResponse<AuditLogResponse>>(
        `/admin/audit-logs?companyId=${companyId}&pageSize=20`,
      ),
  });

  const disableMu = useMutation({
    mutationFn: () =>
      apiFetch<CompanyResponse>(`/admin/companies/${companyId}/disable`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Company disabled');
      qc.invalidateQueries({ queryKey: ['admin', 'company', companyId] });
      qc.invalidateQueries({ queryKey: ['admin', 'companies'] });
    },
    onError: (err) => toast.error(err instanceof ApiClientError ? err.message : 'Failed'),
  });

  const walletColumns: Column<WalletResponse>[] = [
    { key: 'currency', header: 'Currency', className: 'font-medium', cell: (w) => w.currency },
    {
      key: 'available',
      header: 'Available',
      align: 'right',
      className: 'font-mono',
      cell: (w) => trimAmount(w.availableBalance),
    },
    {
      key: 'pending',
      header: 'Pending',
      align: 'right',
      className: 'font-mono',
      cell: (w) => trimAmount(w.pendingBalance),
    },
    {
      key: 'reserved',
      header: 'Reserved',
      align: 'right',
      className: 'font-mono',
      cell: (w) => trimAmount(w.reservedBalance),
    },
    {
      key: 'updated',
      header: 'Updated',
      className: 'text-xs text-muted-foreground',
      cell: (w) => new Date(w.updatedAt).toLocaleString(),
    },
  ];

  const txColumns: Column<TransactionResponse>[] = [
    {
      key: 'external',
      header: 'External',
      className: 'font-mono text-xs',
      cell: (t) => t.externalTransactionId,
    },
    { key: 'source', header: 'Source', cell: (t) => t.sourceCode },
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
      key: 'status',
      header: 'Status',
      cell: (t) => (
        <Badge variant={t.status === 'COMPLETED' ? 'success' : 'secondary'}>{t.status}</Badge>
      ),
    },
    {
      key: 'created',
      header: 'Created',
      className: 'text-xs text-muted-foreground',
      cell: (t) => new Date(t.createdAt).toLocaleString(),
    },
  ];

  const auditColumns: Column<AuditLogResponse>[] = [
    {
      key: 'when',
      header: 'When',
      className: 'text-xs text-muted-foreground',
      cell: (a) => new Date(a.createdAt).toLocaleString(),
    },
    { key: 'actor', header: 'Actor', className: 'text-xs', cell: (a) => a.actorEmail ?? '—' },
    { key: 'action', header: 'Action', className: 'font-mono text-xs', cell: (a) => a.action },
    {
      key: 'entity',
      header: 'Entity',
      className: 'font-mono text-xs',
      cell: (a) => (
        <>
          {a.entityType}
          {a.entityId ? `:${a.entityId.slice(0, 8)}` : ''}
        </>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <Link href="/admin/companies" className="text-xs text-muted-foreground hover:underline">
            ← All companies
          </Link>
          <h1 className="mt-1 text-2xl font-semibold">
            {companyQ.data?.name ?? 'Loading…'}
            {companyQ.data && (
              <Badge
                className="ml-3 align-middle"
                variant={companyQ.data.status === 'ACTIVE' ? 'success' : 'destructive'}
              >
                {companyQ.data.status}
              </Badge>
            )}
          </h1>
          {companyQ.data && (
            <p className="text-sm text-muted-foreground">
              slug: <span className="font-mono break-all">{companyQ.data.slug}</span> · default
              currency: {companyQ.data.defaultCurrency} · created{' '}
              {new Date(companyQ.data.createdAt).toLocaleDateString()}
            </p>
          )}
        </div>
        {companyQ.data?.status === 'ACTIVE' && (
          <Button
            className="w-full sm:w-auto"
            variant="destructive"
            onClick={() => {
              if (
                confirm(
                  `Disable ${companyQ.data?.name}? Their API keys will keep working until revoked.`,
                )
              ) {
                disableMu.mutate();
              }
            }}
            disabled={disableMu.isPending}
          >
            {disableMu.isPending ? 'Disabling…' : 'Disable company'}
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Volume"
          value={
            overviewQ.data
              ? `${fmt(overviewQ.data.kpi.totalVolume)} ${overviewQ.data.kpi.currency}`
              : '—'
          }
          hint={`Last ${chartDays}d`}
        />
        <KpiCard
          label="Fees paid"
          value={
            overviewQ.data
              ? `${fmt(overviewQ.data.kpi.totalFees)} ${overviewQ.data.kpi.currency}`
              : '—'
          }
        />
        <KpiCard
          label="Transactions"
          value={overviewQ.data ? overviewQ.data.kpi.transactionCount.toLocaleString() : '—'}
        />
        <KpiCard
          label="Average tx"
          value={
            overviewQ.data
              ? `${fmt(overviewQ.data.kpi.averageAmount)} ${overviewQ.data.kpi.currency}`
              : '—'
          }
        />
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <CardTitle>Activity</CardTitle>
              <CardDescription>Daily completed transaction volume.</CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <div className="flex items-center gap-1 rounded-md border bg-background p-1">
                {[7, 30, 90].map((d) => (
                  <Button
                    key={d}
                    variant={chartDays === d ? 'default' : 'ghost'}
                    size="sm"
                    onClick={() => setChartDays(d)}
                  >
                    {d}d
                  </Button>
                ))}
              </div>
              <select
                value={chartCurrency}
                onChange={(e) => setChartCurrency(e.target.value)}
                className="h-9 rounded-md border border-input bg-background px-3 text-sm"
              >
                {SUPPORTED_CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {overviewQ.data ? (
            <VolumeChart buckets={overviewQ.data.daily.buckets} currency={chartCurrency} />
          ) : (
            <div className="h-72 w-full animate-pulse rounded bg-muted" />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Wallets</CardTitle>
          <CardDescription>
            One row per currency. Auto-created on first transaction.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <DataTable<WalletResponse>
            columns={walletColumns}
            rows={walletsQ.data?.data}
            rowKey={(w) => w.id}
            empty={<div className="py-6 text-center text-muted-foreground">No wallets yet.</div>}
          />
        </CardContent>
      </Card>

      <CompanyUsersCard companyId={companyId} />

      <Card>
        <CardHeader>
          <CardTitle>Recent transactions</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <DataTable<TransactionResponse>
            columns={txColumns}
            rows={txQ.data?.data}
            rowKey={(t) => t.id}
            empty={<div className="py-6 text-center text-muted-foreground">No transactions.</div>}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Audit log</CardTitle>
          <CardDescription>Mutating actions tied to this company.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <DataTable<AuditLogResponse>
            columns={auditColumns}
            rows={auditQ.data?.data}
            rowKey={(a) => a.id}
            empty={<div className="py-6 text-center text-muted-foreground">No audit entries.</div>}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function fmt(s: string): string {
  const n = Number(s);
  if (Number.isNaN(n)) return s;
  if (n === 0) return '0';
  if (Math.abs(n) >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return n.toString();
}

function trimAmount(s: string): string {
  if (!s.includes('.')) return s;
  return s.replace(/\.?0+$/, '');
}
