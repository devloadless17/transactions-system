'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  SUPPORTED_CURRENCIES,
  type PaginatedResponse,
  type TransactionResponse,
  type VolumeMetric,
  type WalletResponse,
} from '@app/shared';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiFetch } from '@/lib/api.client';
import { useOverview } from '@/features/analytics/use-overview';
import { KpiCard } from '@/features/analytics/kpi-card';
import { VolumeChart } from '@/features/analytics/volume-chart';
import {
  DateRangeControls,
  DEFAULT_RANGE,
  rangeLabel,
  type DateRange,
} from '@/features/analytics/date-range';

export function OverviewView() {
  const [currency, setCurrency] = useState('USD');
  const [range, setRange] = useState<DateRange>(DEFAULT_RANGE);

  const overviewQ = useOverview({ scope: 'company', currency, range });
  const walletsQ = useQuery({
    queryKey: ['company', 'wallets'],
    queryFn: () => apiFetch<{ data: WalletResponse[] }>('/company/wallets'),
    refetchInterval: 30_000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    staleTime: 0,
  });
  const txQ = useQuery({
    queryKey: ['company', 'transactions', 'recent'],
    queryFn: () =>
      apiFetch<PaginatedResponse<TransactionResponse>>('/company/transactions?pageSize=5'),
    refetchInterval: 30_000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    staleTime: 0,
  });

  const data = overviewQ.data;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Overview</h1>
          <p className="text-sm text-muted-foreground">
            Your wallets, activity, and recent transactions.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
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

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Deposits"
          value={data ? `${formatNumber(data.volume.deposits.completedTotal)} ${currency}` : '—'}
          hint={data ? inflightHint(data.volume.deposits, currency) : rangeLabel(range)}
        />
        <KpiCard
          label="Withdrawals"
          value={data ? `${formatNumber(data.volume.withdrawals.completedTotal)} ${currency}` : '—'}
          hint={data ? inflightHint(data.volume.withdrawals, currency) : rangeLabel(range)}
        />
        <KpiCard
          label="Loads"
          value={data ? `${formatNumber(data.volume.loads.completedTotal)} ${currency}` : '—'}
          hint={data ? inflightHint(data.volume.loads, currency) : rangeLabel(range)}
        />
        <KpiCard
          label="Payouts"
          value={data ? `${formatNumber(data.volume.payouts.completedTotal)} ${currency}` : '—'}
          hint={data ? inflightHint(data.volume.payouts, currency) : rangeLabel(range)}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Volume</CardTitle>
          <CardDescription>Daily completed transactions ({currency})</CardDescription>
        </CardHeader>
        <CardContent>
          {data ? <VolumeChart buckets={data.daily.buckets} currency={currency} /> : <Skeleton />}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>By source</CardTitle>
          <CardDescription>
            Volume and transaction count per source over {rangeLabel(range)} ({currency}).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!data ? (
            <Skeleton />
          ) : data.topSources.length === 0 ? (
            <p className="text-sm text-muted-foreground">No transactions in this range.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              <li className="grid grid-cols-[1fr_auto_auto] gap-4 border-b pb-1 text-xs font-medium text-muted-foreground">
                <span>Source</span>
                <span className="text-right">Count</span>
                <span className="text-right">Volume</span>
              </li>
              {data.topSources.map((s) => (
                <li
                  key={s.sourceId}
                  className="grid grid-cols-[1fr_auto_auto] gap-4 border-b py-1 last:border-b-0"
                >
                  <span className="font-mono text-xs">{s.sourceCode}</span>
                  <span className="text-right font-mono">{s.count}</span>
                  <span className="text-right font-mono">{formatNumber(s.volume)}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Wallets</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {walletsQ.data?.data.length === 0 && (
                <li className="text-muted-foreground">No wallets yet.</li>
              )}
              {walletsQ.data?.data.map((w) => (
                <li
                  key={w.id}
                  className="flex items-center justify-between border-b py-1 last:border-b-0"
                >
                  <span>{w.currency}</span>
                  <span className="text-right">
                    <span className="font-mono">{formatNumber(w.availableBalance)}</span>{' '}
                    <span className="text-xs text-muted-foreground">avail</span>
                    {' · '}
                    <span className="font-mono">{formatNumber(w.reservedBalance)}</span>{' '}
                    <span className="text-xs text-muted-foreground">reserved</span>
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent transactions</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2 text-sm">
              {txQ.data?.data.length === 0 && (
                <li className="text-muted-foreground">
                  No transactions yet. Use one of your API keys to send the first one.
                </li>
              )}
              {txQ.data?.data.map((t) => (
                <li
                  key={t.id}
                  className="flex items-start justify-between border-b py-1 last:border-b-0"
                >
                  <div>
                    <div className="font-mono text-xs">{t.externalTransactionId}</div>
                    <div className="text-xs text-muted-foreground">
                      {t.sourceCode} · {new Date(t.createdAt).toLocaleString()}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-mono">
                      {formatNumber(t.netAmount)} {t.currency}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      fee {formatNumber(t.commissionAmount)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function Skeleton() {
  return <div className="h-72 w-full animate-pulse rounded bg-muted" />;
}

// KPI sub-line: how many settled, plus any money still in-flight (pending
// approval / processing) so the company knows what hasn't landed yet.
function inflightHint(m: VolumeMetric, currency: string): string {
  const base = `${m.completedCount.toLocaleString()} completed`;
  if (m.pendingCount > 0 || Number(m.pendingTotal) > 0) {
    return `${base} · ${formatNumber(m.pendingTotal)} ${currency} in-flight`;
  }
  return base;
}

function formatNumber(s: string): string {
  const n = Number(s);
  if (Number.isNaN(n)) return s;
  if (n === 0) return '0';
  if (Math.abs(n) >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return n.toString();
}
