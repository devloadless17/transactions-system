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
  type VolumeMetric,
  type WalletResponse,
} from '@app/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { DataTable, type Column } from '@/components/ui/data-table';
import { apiFetch } from '@/lib/api.client';
import { ApiClientError } from '@/lib/api';
import { formatNumber as fmt, trimAmount } from '@/lib/format';
import { KpiCard } from '@/features/analytics/kpi-card';
import { VolumeChart } from '@/features/analytics/volume-chart.lazy';
import {
  DateRangeControls,
  DEFAULT_RANGE,
  isRangeReady,
  rangeKey,
  rangeLabel,
  resolveRange,
  type DateRange,
} from '@/features/analytics/date-range';
import { CompanyUsersCard } from './company-users-card';

export function CompanyDetailView({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const [chartCurrency, setChartCurrency] = useState<string>('USD');
  const [range, setRange] = useState<DateRange>(DEFAULT_RANGE);

  const companyQ = useQuery({
    queryKey: ['admin', 'company', companyId],
    queryFn: () => apiFetch<CompanyResponse>(`/admin/companies/${companyId}`),
  });

  const overviewQ = useQuery({
    queryKey: ['admin', 'company', companyId, 'overview', chartCurrency, rangeKey(range)],
    queryFn: () => {
      const { from, to } = resolveRange(range);
      const params = new URLSearchParams({ from, to, currency: chartCurrency });
      return apiFetch<OverviewResponse>(
        `/admin/analytics/companies/${companyId}/overview?${params.toString()}`,
      );
    },
    enabled: isRangeReady(range),
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
      toast.success('Company deactivated');
      qc.invalidateQueries({ queryKey: ['admin', 'company', companyId] });
      qc.invalidateQueries({ queryKey: ['admin', 'companies'] });
    },
    onError: (err) => toast.error(err instanceof ApiClientError ? err.message : 'Failed'),
  });

  const activateMu = useMutation({
    mutationFn: () =>
      apiFetch<CompanyResponse>(`/admin/companies/${companyId}/activate`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Company activated');
      qc.invalidateQueries({ queryKey: ['admin', 'company', companyId] });
      qc.invalidateQueries({ queryKey: ['admin', 'companies'] });
    },
    onError: (err) => toast.error(err instanceof ApiClientError ? err.message : 'Failed'),
  });

  const visibilityMu = useMutation({
    mutationFn: (visible: boolean) =>
      apiFetch<CompanyResponse>(`/admin/companies/${companyId}`, {
        method: 'PATCH',
        body: { visible },
      }),
    onSuccess: (c) => {
      toast.success(c.visible ? 'Company is now visible' : 'Company is now hidden');
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

  type SourceRow = NonNullable<typeof overviewQ.data>['topSources'][number];
  const sourceColumns: Column<SourceRow>[] = [
    {
      key: 'source',
      header: 'Source',
      className: 'font-mono text-xs',
      cell: (s) => (
        <Link href={`/admin/sources/${s.sourceId}`} className="hover:underline">
          {s.sourceCode}
        </Link>
      ),
    },
    {
      key: 'count',
      header: 'Count',
      align: 'right',
      className: 'font-mono',
      cell: (s) => s.count.toLocaleString(),
    },
    {
      key: 'volume',
      header: 'Volume',
      align: 'right',
      className: 'font-mono',
      cell: (s) => fmt(s.volume),
    },
    {
      key: 'fees',
      header: 'Fees',
      align: 'right',
      className: 'font-mono text-muted-foreground',
      cell: (s) => fmt(s.fees),
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
        {companyQ.data &&
          (companyQ.data.status === 'ACTIVE' ? (
            <Button
              className="w-full sm:w-auto"
              variant="destructive"
              onClick={() => {
                if (
                  confirm(
                    `Deactivate ${companyQ.data?.name}? It will immediately lose all access — ` +
                      `users can't log in, API keys stop working, and it can't send or receive ` +
                      `anything. All of its data is kept and access is fully restored if you ` +
                      `reactivate it.`,
                  )
                ) {
                  disableMu.mutate();
                }
              }}
              disabled={disableMu.isPending}
            >
              {disableMu.isPending ? 'Deactivating…' : 'Deactivate company'}
            </Button>
          ) : (
            <Button
              className="w-full sm:w-auto"
              onClick={() => {
                if (confirm(`Reactivate ${companyQ.data?.name}? Full access will be restored.`)) {
                  activateMu.mutate();
                }
              }}
              disabled={activateMu.isPending}
            >
              {activateMu.isPending ? 'Activating…' : 'Activate company'}
            </Button>
          ))}
      </div>

      {companyQ.data && (
        <Card>
          <CardContent className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              <Switch
                id="company-visible"
                aria-label="Company visible in discovery APIs"
                checked={companyQ.data.visible}
                disabled={visibilityMu.isPending}
                onCheckedChange={(v) => visibilityMu.mutate(v)}
              />
              <div>
                <label htmlFor="company-visible" className="text-sm font-medium">
                  Visible in API
                </label>
                <p className="text-sm text-muted-foreground">
                  When off, this company is hidden from discovery/list APIs (e.g. the source-facing
                  list of companies). Its data is fully retained.
                </p>
              </div>
            </div>
            <Badge variant={companyQ.data.visible ? 'success' : 'secondary'}>
              {companyQ.data.visible ? 'Visible' : 'Hidden'}
            </Badge>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Deposits"
          value={
            overviewQ.data
              ? `${fmt(overviewQ.data.volume.deposits.completedTotal)} ${chartCurrency}`
              : '—'
          }
          hint={
            overviewQ.data
              ? inflightHint(overviewQ.data.volume.deposits, chartCurrency)
              : rangeLabel(range)
          }
        />
        <KpiCard
          label="Withdrawals"
          value={
            overviewQ.data
              ? `${fmt(overviewQ.data.volume.withdrawals.completedTotal)} ${chartCurrency}`
              : '—'
          }
          hint={
            overviewQ.data ? inflightHint(overviewQ.data.volume.withdrawals, chartCurrency) : ''
          }
        />
        <KpiCard
          label="Loads"
          value={
            overviewQ.data
              ? `${fmt(overviewQ.data.volume.loads.completedTotal)} ${chartCurrency}`
              : '—'
          }
          hint={overviewQ.data ? inflightHint(overviewQ.data.volume.loads, chartCurrency) : ''}
        />
        <KpiCard
          label="Payouts"
          value={
            overviewQ.data
              ? `${fmt(overviewQ.data.volume.payouts.completedTotal)} ${chartCurrency}`
              : '—'
          }
          hint={overviewQ.data ? inflightHint(overviewQ.data.volume.payouts, chartCurrency) : ''}
        />
        {/* Platform fees — admin-only. The company never sees this aggregate,
            only the fee on each individual transaction. */}
        <KpiCard
          label="Platform fees"
          value={
            overviewQ.data?.kpi.totalFees
              ? `${fmt(overviewQ.data.kpi.totalFees)} ${chartCurrency}`
              : '—'
          }
          hint={`Commission earned · ${rangeLabel(range)}`}
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
              <DateRangeControls value={range} onChange={setRange} />
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
          <CardTitle>By source</CardTitle>
          <CardDescription>
            Every source this company transacted through over {rangeLabel(range)} ({chartCurrency}).
            Click a source for its full breakdown.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <DataTable<SourceRow>
            columns={sourceColumns}
            rows={overviewQ.data?.topSources}
            isLoading={overviewQ.isLoading}
            rowKey={(s) => s.sourceId}
            empty={
              <div className="py-6 text-center text-muted-foreground">
                No transactions in this range.
              </div>
            }
          />
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

// KPI sub-line: settled count, the net vs. fee split of the completed total
// (gross = net + fee; per-flow fees tie out to the Platform fees card), plus
// any money still in-flight for that operation type.
function inflightHint(m: VolumeMetric, currency: string): string {
  const parts = [`${m.completedCount.toLocaleString()} completed`];
  if (Number(m.completedFees) > 0) {
    parts.push(`${fmt(m.completedNet)} net`, `${fmt(m.completedFees)} fee`);
  }
  if (m.pendingCount > 0 || Number(m.pendingTotal) > 0) {
    parts.push(`${fmt(m.pendingTotal)} ${currency} in-flight`);
  }
  return parts.join(' · ');
}
