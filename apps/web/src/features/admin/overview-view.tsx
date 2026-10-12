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
import { granularityWord } from '@/lib/date-presets';
import { formatNumber as fmt, isNonZeroAmount, isPositiveAmount } from '@/lib/format';
import { NetworkFeeLine } from '@/components/network-fee-line';
import { KpiCard } from '@/features/analytics/kpi-card';
import { FlowsChart } from '@/features/analytics/flows-chart.lazy';
import {
  DateRangeControls,
  analyticsRangeParams,
  DEFAULT_RANGE,
  rangeKey,
  rangeLabel,
  rangePhrase,
  type DateRange,
} from '@/features/analytics/date-range';

// Realtime (Socket.IO) is the PRIMARY freshness mechanism: every money event
// invalidates ['admin','analytics'], so these tiles update LIVE, and a socket
// reconnect refetches them to catch up on anything missed while disconnected.
// This interval is therefore only a slow safety net — for a silently-dropped
// socket and to roll the time-window boundary forward — so the dashboard no
// longer visibly re-fetches every minute. Skipped while the tab is hidden.
const LIVE_FALLBACK_POLL_MS = 5 * 60_000;

export function AdminOverview() {
  const [range, setRange] = useState<DateRange>(DEFAULT_RANGE);
  const [flowsCurrency, setFlowsCurrency] = useState<string>('USD');

  // Absolute bounds for the platform/flows queries. resolveRange anchors a
  // preset's upper bound to the next minute so the backend's per-window cache
  // stays stable across auto-refresh; rangeKey keys the queries so switching
  // the window (preset or custom) refetches.
  const rangeParams = () => analyticsRangeParams(range);
  const rk = rangeKey(range);

  const platformQ = useQuery({
    queryKey: ['admin', 'analytics', 'platform', rk],
    queryFn: () =>
      apiFetch<PlatformAnalyticsResponse>(`/admin/analytics/platform?${rangeParams().toString()}`),
    refetchInterval: LIVE_FALLBACK_POLL_MS,
    refetchIntervalInBackground: false,
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
    refetchInterval: LIVE_FALLBACK_POLL_MS,
    refetchIntervalInBackground: false,
  });

  const currencies = platformQ.data?.byCurrency.map((c) => c.currency) ?? [];
  // Hero KPIs pick the "primary" currency: first with any fees, else first in the list.
  const primary =
    platformQ.data?.byCurrency.find(
      (c) => Number(c.feesEarned) > 0 || isPositiveAmount(c.networkFeesEarned),
    ) ?? platformQ.data?.byCurrency[0];
  // Network-fee revenue only exists once some company is charged the optional
  // network fee; until then its card and column don't render at all. The test
  // is NON-ZERO, not positive: this is a signed sum over the window, so an
  // earlier network-fee deposit reversed inside it makes it negative — and net
  // revenue counts it either way, so it has to be shown for the cards to add up.
  const primaryNetworkFees = isNonZeroAmount(primary?.networkFeesEarned);
  const anyNetworkFees =
    platformQ.data?.byCurrency.some((c) => isNonZeroAmount(c.networkFeesEarned)) ?? false;

  // Per-source cost (what each source charged the platform) in the By-source
  // currency, joined onto topSources by id — keeps the company-shared topSource
  // schema clean while still showing "Whish · $X cost" to admins.
  const sourceFeeById = new Map(
    (platformQ.data?.sourceFeeBreakdown ?? [])
      .filter((b) => b.currency === flowsCurrency)
      .map((b) => [b.sourceId, b.fees]),
  );

  type CurrencyRow = PlatformAnalyticsResponse['byCurrency'][number];
  type SourceRow = FlowsResponse['topSources'][number];

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
      header: 'Revenue',
      align: 'right',
      className: 'font-mono',
      cell: (c) => fmt(c.feesEarned),
    },
    ...(anyNetworkFees
      ? [
          {
            key: 'networkFeesEarned',
            header: 'Network fees',
            align: 'right',
            className: 'font-mono',
            cell: (c: CurrencyRow) => fmt(c.networkFeesEarned),
          } as Column<CurrencyRow>,
        ]
      : []),
    {
      key: 'sourceFees',
      header: 'Source fees',
      align: 'right',
      className: 'font-mono text-muted-foreground',
      cell: (c) => fmt(c.sourceFees),
    },
    {
      key: 'netRevenue',
      header: 'Net revenue',
      align: 'right',
      className: 'font-mono font-medium',
      cell: (c) => fmt(c.netRevenue),
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
      header: 'Revenue',
      align: 'right',
      className: 'font-mono text-muted-foreground',
      // Commission, with the network fee on those same deposits underneath —
      // the Volume beside it already includes both.
      cell: (s) => (
        <>
          {fmt(s.fees)}
          <NetworkFeeLine amount={s.networkFees} />
        </>
      ),
    },
    {
      key: 'sourceFee',
      header: 'Source fee (cost)',
      align: 'right',
      className: 'font-mono text-muted-foreground',
      cell: (s) => fmt(sourceFeeById.get(s.sourceId) ?? '0'),
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

      {/* Revenue trio: platform revenue − source fees = net revenue. Once there
          is network-fee revenue in the range (negative included — a reversal)
          it joins as a fourth card (+ network fees). */}
      <div
        className={`grid grid-cols-1 gap-4 sm:grid-cols-2 ${primaryNetworkFees ? 'lg:grid-cols-4' : 'lg:grid-cols-3'}`}
      >
        <KpiCard
          label="Platform revenue"
          value={primary ? `${fmt(primary.feesEarned)} ${primary.currency}` : '—'}
          hint={
            `Fees earned · ${rangeLabel(range)}` +
            (currencies.length > 1 ? ` (primary: ${primary?.currency})` : '')
          }
        />
        {primary && primaryNetworkFees && (
          <KpiCard
            label="Network fees"
            value={`${fmt(primary.networkFeesEarned)} ${primary.currency}`}
            hint={`Network fees earned · ${rangeLabel(range)}`}
          />
        )}
        <KpiCard
          label="Source fees"
          value={primary ? `− ${fmt(primary.sourceFees)} ${primary.currency}` : '—'}
          hint="What sources (e.g. Whish) charge the platform on deposits"
        />
        <KpiCard
          label="Net revenue"
          value={primary ? `${fmt(primary.netRevenue)} ${primary.currency}` : '—'}
          hint={
            primaryNetworkFees
              ? 'Platform revenue + network fees − source fees (your real take-home)'
              : 'Platform revenue − source fees (your real take-home)'
          }
        />
      </div>

      {/* Activity KPIs */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
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
          value={
            opsQ.data
              ? String(
                  opsQ.data.pendingWithdrawalsCount +
                    opsQ.data.pendingPayoutsCount +
                    opsQ.data.pendingLoadsCount,
                )
              : '—'
          }
          hint={
            opsQ.data
              ? `${opsQ.data.pendingWithdrawalsCount} withdrawals · ${opsQ.data.pendingPayoutsCount} payouts · ${opsQ.data.pendingLoadsCount} loads`
              : 'awaiting approval'
          }
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
            error={platformQ.error}
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
                Volume, transaction count, and platform fees per source {rangePhrase(range)} (
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
            rows={flowsQ.data?.topSources}
            isLoading={flowsQ.isLoading}
            error={flowsQ.error}
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
                {granularityWord(flowsQ.data?.granularity ?? 'day')} in (above axis) vs out (below)
                with platform fees overlaid.
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
          {flowsQ.isError ? (
            <div className="flex h-80 w-full items-center justify-center text-sm text-destructive">
              Couldn&apos;t load flows — retrying…
            </div>
          ) : flowsQ.data ? (
            <FlowsChart
              buckets={flowsQ.data.buckets}
              currency={flowsQ.data.currency}
              granularity={flowsQ.data.granularity}
            />
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
          {opsQ.isError && !opsQ.data && (
            <p className="p-6 text-sm text-destructive">
              Couldn&apos;t load the action queue — retrying…
            </p>
          )}
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

type OpsKind = 'withdrawal_pending' | 'payout_pending' | 'load_pending' | 'transaction_reversed';

function OpsIcon({ kind }: { kind: OpsKind }) {
  if (kind === 'withdrawal_pending' || kind === 'payout_pending' || kind === 'load_pending') {
    const label =
      kind === 'withdrawal_pending' ? 'Withdrawal' : kind === 'payout_pending' ? 'Payout' : 'Load';
    return (
      <Badge variant="warning" className="mt-0.5 gap-1">
        <ArrowUpFromLine className="h-3 w-3" />
        {label}
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="mt-0.5 gap-1">
      <RotateCcw className="h-3 w-3" />
      Reversed
    </Badge>
  );
}

function OpsAction({ kind }: { kind: OpsKind; companyId: string }) {
  const reviewHref =
    kind === 'withdrawal_pending'
      ? '/admin/withdrawals'
      : kind === 'payout_pending'
        ? '/admin/payouts'
        : kind === 'load_pending'
          ? '/admin/loads'
          : null;
  if (reviewHref) {
    return (
      <Button variant="outline" size="sm" asChild>
        <Link href={reviewHref}>Review</Link>
      </Button>
    );
  }
  return (
    <Button variant="ghost" size="sm" asChild>
      <Link href="/admin/deposits">View</Link>
    </Button>
  );
}
