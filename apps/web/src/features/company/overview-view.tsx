'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  SUPPORTED_CURRENCIES,
  type PaginatedResponse,
  type TransactionResponse,
  type WalletResponse,
} from '@app/shared';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api.client';
import { useOverview } from '@/features/analytics/use-overview';
import { KpiCard } from '@/features/analytics/kpi-card';
import { VolumeChart } from '@/features/analytics/volume-chart';

const RANGE_OPTIONS = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
];

export function OverviewView() {
  const [currency, setCurrency] = useState('USD');
  const [days, setDays] = useState(30);

  const overviewQ = useOverview({ scope: 'company', currency, days });
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
      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Overview</h1>
          <p className="text-sm text-muted-foreground">
            Your wallets, activity, and recent transactions.
          </p>
        </div>
        <div className="flex gap-3">
          <div className="flex items-center gap-1 rounded-md border bg-background p-1">
            {RANGE_OPTIONS.map((r) => (
              <Button
                key={r.days}
                variant={days === r.days ? 'default' : 'ghost'}
                size="sm"
                onClick={() => setDays(r.days)}
              >
                {r.label}
              </Button>
            ))}
          </div>
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

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Volume"
          value={data ? `${formatNumber(data.kpi.totalVolume)} ${data.kpi.currency}` : '—'}
          hint={`Last ${days} days`}
        />
        <KpiCard
          label="Fees paid"
          value={data ? `${formatNumber(data.kpi.totalFees)} ${data.kpi.currency}` : '—'}
        />
        <KpiCard
          label="Transactions"
          value={data ? data.kpi.transactionCount.toLocaleString() : '—'}
        />
        <KpiCard
          label="Average tx"
          value={data ? `${formatNumber(data.kpi.averageAmount)} ${data.kpi.currency}` : '—'}
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
            Volume, transaction count, and fees per source over the last {days} days ({currency}).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {!data ? (
            <Skeleton />
          ) : data.topSources.length === 0 ? (
            <p className="text-sm text-muted-foreground">No transactions in this range.</p>
          ) : (
            <ul className="space-y-1 text-sm">
              <li className="grid grid-cols-[1fr_auto_auto_auto] gap-4 border-b pb-1 text-xs font-medium text-muted-foreground">
                <span>Source</span>
                <span className="text-right">Count</span>
                <span className="text-right">Volume</span>
                <span className="text-right">Fees</span>
              </li>
              {data.topSources.map((s) => (
                <li
                  key={s.sourceId}
                  className="grid grid-cols-[1fr_auto_auto_auto] gap-4 border-b py-1 last:border-b-0"
                >
                  <span className="font-mono text-xs">{s.sourceCode}</span>
                  <span className="text-right font-mono">{s.count}</span>
                  <span className="text-right font-mono">{formatNumber(s.volume)}</span>
                  <span className="text-right font-mono text-muted-foreground">
                    {formatNumber(s.fees)}
                  </span>
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

function formatNumber(s: string): string {
  const n = Number(s);
  if (Number.isNaN(n)) return s;
  if (n === 0) return '0';
  if (Math.abs(n) >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return n.toString();
}
