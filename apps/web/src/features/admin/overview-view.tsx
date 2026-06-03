'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { ArrowUpFromLine, RotateCcw } from 'lucide-react';
import type { FlowsResponse, OperationsResponse, PlatformAnalyticsResponse } from '@app/shared';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { DataTable, type Column } from '@/components/ui/data-table';
import { apiFetch } from '@/lib/api.client';
import { formatNumber as fmt } from '@/lib/format';
import { KpiCard } from '@/features/analytics/kpi-card';
import { FlowsChart } from '@/features/analytics/flows-chart';
import { useOverview } from '@/features/analytics/use-overview';
import {
  DateRangeControls,
  DEFAULT_RANGE,
  rangeKey,
  rangeLabel,
  resolveRange,
  type DateRange,
} from '@/features/analytics/date-range';

export function AdminOverview() {
  const [range, setRange] = useState<DateRange>(DEFAULT_RANGE);
  const [flowsCurrency, setFlowsCurrency] = useState<string>('USD');

  // Absolute bounds for the platform/flows queries. resolveRange anchors a
  // preset's upper bound to the next minute so the backend's per-window cache
  // stays stable across auto-refresh; rangeKey keys the queries so switching
  // the window (preset or custom) refetches.
  const rangeParams = () => {
    const { from, to } = resolveRange(range);
    return new URLSearchParams({ from, to });
  };
  const rk = rangeKey(range);

  const platformQ = useQuery({
    queryKey: ['admin', 'analytics', 'platform', rk],
    queryFn: () =>
      apiFetch<PlatformAnalyticsResponse>(`/admin/analytics/platform?${rangeParams().toString()}`),
    refetchInterval: 60_000,
  });

  const flowsQ = useQuery({
    queryKey: ['admin', 'analytics', 'flows', rk, flowsCurrency],
    queryFn: () => {
      const params = rangeParams();
      params.set('currency', flowsCurrency);
      return apiFetch<FlowsResponse>(`/admin/analytics/flows?${params.toString()}`);
    },
  });

  const opsQ = useQuery({
    queryKey: ['admin', 'analytics', 'operations'],
    queryFn: () => apiFetch<OperationsResponse>('/admin/analytics/operations'),
    refetchInterval: 60_000,
  });

  const overviewQ = useOverview({ scope: 'admin', currency: flowsCurrency, range });

  const currencies = platformQ.data?.byCurrency.map((c) => c.currency) ?? [];
  // Hero KPIs pick the "primary" currency: first with any fees, else first in the list.
  const primary =
    platformQ.data?.byCurrency.find((c) => Number(c.feesEarned) > 0) ??
    platformQ.data?.byCurrency[0];

  type CurrencyRow = PlatformAnalyticsResponse['byCurrency'][number];
  type SourceRow = NonNullable<typeof overviewQ.data>['topSources'][number];

  const currencyColumns: Column<CurrencyRow>[] = [
    { key: 'currency', header: 'Currency', className: 'font-medium', cell: (c) => c.currency },
    {
      key: 'volumeIn',
      header: 'Volume in',
      align: 'right',
      className: 'font-mono',
      cell: (c) => fmt(c.volumeIn),
    },
    {
      key: 'volumeOut',
      header: 'Volume out',
      align: 'right',
      className: 'font-mono',
      cell: (c) => fmt(c.volumeOut),
    },
    {
      key: 'feesEarned',
      header: 'Fees earned',
      align: 'right',
      className: 'font-mono',
      cell: (c) => fmt(c.feesEarned),
    },
    {
      key: 'netHeld',
      header: 'Net held',
      align: 'right',
      className: 'font-mono',
      cell: (c) => fmt(c.netHeld),
    },
    {
      key: 'ingestCount',
      header: 'Ingest count',
      align: 'right',
      className: 'text-xs text-muted-foreground',
      cell: (c) => c.ingestCount.toLocaleString(),
    },
    {
      key: 'withdrawalCount',
      header: 'Withdrawal count',
      align: 'right',
      className: 'text-xs text-muted-foreground',
      cell: (c) => c.withdrawalCount.toLocaleString(),
    },
  ];

  const sourceColumns: Column<SourceRow>[] = [
    { key: 'source', header: 'Source', className: 'font-mono text-xs', cell: (s) => s.sourceCode },
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

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Platform Overview</h1>
          <p className="text-sm text-muted-foreground">
            Multi-currency view of everything flowing through the system.
          </p>
        </div>
        <DateRangeControls value={range} onChange={setRange} className="self-start sm:self-auto" />
      </div>

      {/* Hero KPIs */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Platform revenue"
          value={primary ? `${fmt(primary.feesEarned)} ${primary.currency}` : '—'}
          hint={
            `Fees earned · ${rangeLabel(range)}` +
            (currencies.length > 1 ? ` (primary: ${primary?.currency})` : '')
          }
        />
        <KpiCard
          label="Volume in"
          value={primary ? `${fmt(primary.volumeIn)} ${primary.currency}` : '—'}
          hint={`Deposits + loads · ${primary?.ingestCount ?? 0} ingested`}
        />
        <KpiCard
          label="Volume out"
          value={primary ? `${fmt(primary.volumeOut)} ${primary.currency}` : '—'}
          hint={`Withdrawals + payouts · ${primary?.withdrawalCount ?? 0} withdrawals`}
        />
        <KpiCard
          label="Pending actions"
          value={opsQ.data ? String(opsQ.data.pendingWithdrawalsCount) : '—'}
          hint={`${opsQ.data?.pendingWithdrawalsCount ?? 0} withdrawals`}
        />
      </div>

      {/* Multi-currency rollup table */}
      <Card>
        <CardHeader>
          <CardTitle>By currency</CardTitle>
          <CardDescription>
            Per-currency activity in the range, plus what's currently parked across all wallets.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <DataTable<CurrencyRow>
            columns={currencyColumns}
            rows={platformQ.data?.byCurrency}
            isLoading={platformQ.isLoading}
            rowKey={(c) => c.currency}
            empty={
              <div className="py-8 text-center text-muted-foreground">
                No activity in this range.
              </div>
            }
          />
        </CardContent>
      </Card>

      {/* By source — platform-wide breakdown in the chosen currency */}
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <CardTitle>By source</CardTitle>
              <CardDescription>
                Volume, transaction count, and platform fees per source over {rangeLabel(range)} (
                {flowsCurrency}).
              </CardDescription>
            </div>
            <select
              value={flowsCurrency}
              onChange={(e) => setFlowsCurrency(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm sm:w-auto"
              aria-label="By source currency"
            >
              {(currencies.length ? currencies : ['USD']).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
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

      {/* Flows chart with currency switcher */}
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <CardTitle>Flows</CardTitle>
              <CardDescription>
                Daily in (above axis) vs out (below) with platform fees overlaid.
              </CardDescription>
            </div>
            <select
              value={flowsCurrency}
              onChange={(e) => setFlowsCurrency(e.target.value)}
              className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm sm:w-auto"
            >
              {(currencies.length ? currencies : ['USD']).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
        </CardHeader>
        <CardContent>
          {flowsQ.data ? (
            <FlowsChart buckets={flowsQ.data.buckets} currency={flowsCurrency} />
          ) : (
            <div className="h-80 w-full animate-pulse rounded bg-muted" />
          )}
        </CardContent>
      </Card>

      {/* Action queue */}
      <Card>
        <CardHeader>
          <CardTitle>Action queue</CardTitle>
          <CardDescription>
            Things that need an operator: pending withdrawals, recent reversals.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          {opsQ.isLoading && <p className="p-6 text-sm text-muted-foreground">Loading…</p>}
          {opsQ.data && opsQ.data.items.length === 0 && (
            <p className="p-6 text-sm text-muted-foreground">All clear — no pending actions.</p>
          )}
          <ul className="divide-y">
            {opsQ.data?.items.map((it) => (
              <li key={`${it.kind}-${it.id}`} className="flex items-start gap-3 px-6 py-3">
                <OpsIcon kind={it.kind} />
                <div className="min-w-0 flex-1">
                  <div className="text-sm">{it.summary}</div>
                  <div className="text-xs text-muted-foreground">
                    {it.companyName} · {new Date(it.createdAt).toLocaleString()}
                  </div>
                </div>
                <OpsAction kind={it.kind} companyId={it.companyId} />
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

function OpsIcon({ kind }: { kind: 'withdrawal_pending' | 'transaction_reversed' }) {
  if (kind === 'withdrawal_pending')
    return (
      <Badge variant="warning" className="mt-0.5 gap-1">
        <ArrowUpFromLine className="h-3 w-3" />
        Withdrawal
      </Badge>
    );
  return (
    <Badge variant="secondary" className="mt-0.5 gap-1">
      <RotateCcw className="h-3 w-3" />
      Reversed
    </Badge>
  );
}

function OpsAction({
  kind,
}: {
  kind: 'withdrawal_pending' | 'transaction_reversed';
  companyId: string;
}) {
  if (kind === 'withdrawal_pending') {
    return (
      <Button variant="outline" size="sm" asChild>
        <Link href="/admin/withdrawals">Review</Link>
      </Button>
    );
  }
  return (
    <Button variant="ghost" size="sm" asChild>
      <Link href="/admin/transactions">View</Link>
    </Button>
  );
}
