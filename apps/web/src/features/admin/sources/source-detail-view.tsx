'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import {
  SUPPORTED_CURRENCIES,
  type SourceOverviewResponse,
  type SourceResponse,
} from '@app/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { DataTable, type Column } from '@/components/ui/data-table';
import { apiFetch } from '@/lib/api.client';
import { formatNumber as fmt } from '@/lib/format';
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

export function SourceDetailView({ sourceId }: { sourceId: string }) {
  const [currency, setCurrency] = useState<string>('USD');
  const [range, setRange] = useState<DateRange>(DEFAULT_RANGE);

  const sourceQ = useQuery({
    queryKey: ['admin', 'source', sourceId],
    queryFn: () => apiFetch<SourceResponse>(`/admin/sources/${sourceId}`),
  });

  const overviewQ = useQuery({
    queryKey: ['admin', 'source', sourceId, 'overview', currency, rangeKey(range)],
    queryFn: () => {
      const { from, to } = resolveRange(range);
      const params = new URLSearchParams({ from, to, currency });
      return apiFetch<SourceOverviewResponse>(
        `/admin/analytics/sources/${sourceId}/overview?${params.toString()}`,
      );
    },
    enabled: isRangeReady(range),
  });

  type CompanyRow = SourceOverviewResponse['byCompany'][number];
  const companyColumns: Column<CompanyRow>[] = [
    {
      key: 'company',
      header: 'Company',
      className: 'font-medium',
      cell: (c) => (
        <Link href={`/admin/companies/${c.companyId}`} className="hover:underline">
          {c.companyName}
        </Link>
      ),
    },
    {
      key: 'count',
      header: 'Count',
      align: 'right',
      className: 'font-mono',
      cell: (c) => c.count.toLocaleString(),
    },
    {
      key: 'volume',
      header: 'Volume',
      align: 'right',
      className: 'font-mono',
      cell: (c) => fmt(c.volume),
    },
    {
      key: 'fees',
      header: 'Fees',
      align: 'right',
      className: 'font-mono text-muted-foreground',
      cell: (c) => fmt(c.fees),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <Link href="/admin/sources" className="text-xs text-muted-foreground hover:underline">
            ← All sources
          </Link>
          <h1 className="mt-1 text-2xl font-semibold">
            {sourceQ.data?.name ?? 'Loading…'}
            {sourceQ.data && (
              <Badge
                className="ml-3 align-middle"
                variant={sourceQ.data.status === 'ACTIVE' ? 'success' : 'secondary'}
              >
                {sourceQ.data.status}
              </Badge>
            )}
          </h1>
          {sourceQ.data && (
            <p className="text-sm text-muted-foreground">
              code: <span className="font-mono">{sourceQ.data.code}</span> · created{' '}
              {new Date(sourceQ.data.createdAt).toLocaleDateString()}
            </p>
          )}
        </div>
        <Button variant="outline" size="sm" asChild className="w-full sm:w-auto">
          <Link href={`/admin/sources/${sourceId}/api-keys`}>API keys</Link>
        </Button>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Volume"
          value={overviewQ.data ? `${fmt(overviewQ.data.kpi.totalVolume)} ${currency}` : '—'}
          hint={`Completed ingestion · ${rangeLabel(range)}`}
        />
        <KpiCard
          label="Fees earned"
          value={overviewQ.data ? `${fmt(overviewQ.data.kpi.totalFees ?? '0')} ${currency}` : '—'}
          hint="Platform fees on this source"
        />
        <KpiCard
          label="Transactions"
          value={overviewQ.data ? overviewQ.data.kpi.transactionCount.toLocaleString() : '—'}
        />
        <KpiCard
          label="Average tx"
          value={overviewQ.data ? `${fmt(overviewQ.data.kpi.averageAmount)} ${currency}` : '—'}
        />
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <CardTitle>Activity</CardTitle>
              <CardDescription>Daily completed volume through this source.</CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
              <DateRangeControls value={range} onChange={setRange} />
              <select
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
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
            <VolumeChart buckets={overviewQ.data.daily.buckets} currency={currency} />
          ) : (
            <div className="h-72 w-full animate-pulse rounded bg-muted" />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>By company</CardTitle>
          <CardDescription>
            Every company that transacted through this source over {rangeLabel(range)} ({currency}).
            Click a company for its full breakdown.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <DataTable<CompanyRow>
            columns={companyColumns}
            rows={overviewQ.data?.byCompany}
            isLoading={overviewQ.isLoading}
            rowKey={(c) => c.companyId}
            empty={
              <div className="py-6 text-center text-muted-foreground">
                No transactions in this range.
              </div>
            }
          />
        </CardContent>
      </Card>
    </div>
  );
}
