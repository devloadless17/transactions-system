'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  SUPPORTED_CURRENCIES,
  type PaginatedResponse,
  type TransactionResponse,
  type WalletResponse,
  type WalletSummaryResponse,
} from '@app/shared';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { apiFetch } from '@/lib/api.client';
import { formatMoney, formatNumber } from '@/lib/format';
import { useOverview } from '@/features/analytics/use-overview';
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

export function OverviewView() {
  const [currency, setCurrency] = useState('USD');
  const [range, setRange] = useState<DateRange>(DEFAULT_RANGE);

  // Date-ranged analytics power the chart + by-source breakdown below.
  const overviewQ = useOverview({ scope: 'company', currency, range });
  // Reconciliation totals for the cards, scoped to the selected range so the
  // date picker drives them (the wallet balance tile below stays all-time/live).
  // For an all-time window: deposits.net + loads.net − withdrawals.total −
  // payouts.total = wallet available balance.
  const summaryQ = useQuery({
    queryKey: ['company', 'analytics', 'wallet-summary', currency, rangeKey(range)],
    queryFn: () => {
      const { from, to } = resolveRange(range);
      const params = new URLSearchParams({ currency, from, to });
      return apiFetch<WalletSummaryResponse>(
        `/company/analytics/wallet-summary?${params.toString()}`,
      );
    },
    enabled: isRangeReady(range),
    // Freshness comes from the Socket.IO bridge (it invalidates ['company',
    // 'analytics'|'wallets'|'transactions'] the instant anything changes and
    // does a full refetch on reconnect), so these no longer poll on a timer.
  });
  const walletsQ = useQuery({
    queryKey: ['company', 'wallets'],
    queryFn: () => apiFetch<{ data: WalletResponse[] }>('/company/wallets'),
  });
  const txQ = useQuery({
    queryKey: ['company', 'transactions', 'recent'],
    queryFn: () =>
      apiFetch<PaginatedResponse<TransactionResponse>>('/company/transactions?pageSize=5'),
  });

  const data = overviewQ.data;
  const sum = summaryQ.data;
  const wallet = walletsQ.data?.data.find((w) => w.currency === currency);
  const available = wallet?.availableBalance ?? '0';
  const reserved = wallet?.reservedBalance ?? '0';
  // Money owed back to the platform after a reversed-deposit clawback shortfall.
  // Normally "0"; included so the identity ties out exactly even after a reversal.
  const receivable = sum?.receivable ?? '0';
  const hasReceivable = Number(receivable) > 0;

  // Label money with the currency the value is actually FOR — not the in-flight
  // <select> state. With keepPreviousData, switching currency briefly shows the
  // prior response's amounts, which must keep THEIR currency label until the new
  // data lands. The wallet balance is recomputed client-side from walletsQ for the
  // selected currency, so it correctly uses `currency`; the reconciliation cards
  // come from summaryQ, so they use that response's currency (`sumCcy`).
  const sumCcy = sum?.currency ?? currency;
  // Balances/reconciliation figures use full-precision formatMoney (never rounds
  // up) so a displayed amount can never exceed the real wallet value.
  const money = (s: string | undefined, ccy: string = currency) =>
    s !== undefined ? `${formatMoney(s)} ${ccy}` : '—';
  // Outflows: shown with a leading minus so the right-hand column reads as a
  // literal subtraction (Net deposit + Net load − Withdrawals − Payouts = wallet).
  const outMoney = (s: string | undefined, ccy: string = currency) => {
    if (s === undefined) return '—';
    const sign = Number(s) > 0 ? '− ' : '';
    return `${sign}${formatMoney(s)} ${ccy}`;
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Overview</h1>
          <p className="text-sm text-muted-foreground">Your wallet balance, money in and out.</p>
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

      {/* Wallet balance — the figure the cards below reconcile to. */}
      <Card className="border-primary/30">
        <CardHeader className="pb-2">
          <CardDescription>Wallet balance</CardDescription>
          <CardTitle className="font-mono text-3xl sm:text-4xl">
            {/* Distinguish a load FAILURE from a genuine zero balance: never render a
                fake "0 USD" when the query errored — that misreports the single most
                trust-sensitive number on the page. */}
            {walletsQ.isError ? (
              <span className="text-base font-normal text-destructive">
                Couldn&apos;t load balance — retrying…
              </span>
            ) : !walletsQ.data ? (
              <span className="text-base font-normal text-muted-foreground">Loading…</span>
            ) : (
              money(available)
            )}
          </CardTitle>
        </CardHeader>
        {!walletsQ.isError && Number(reserved) > 0 && (
          <CardContent className="pt-0 text-xs text-muted-foreground">
            {formatMoney(reserved)} {currency} reserved for in-flight withdrawals / payouts
          </CardContent>
        )}
      </Card>

      {/* All-time reconciliation. The right-hand column is the company's check on
          its own wallet: the net IN figures (Net deposit, Net load) are right-
          aligned, and the money-OUT rows (Withdrawals, Payouts) are full-width with
          their value on the same right edge — so the whole column reads straight
          down as Net deposit + Net load − Withdrawals − Payouts = wallet. */}
      <div className="space-y-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <KpiCard label="Deposit" value={money(sum?.deposits.gross, sumCcy)} />
          <KpiCard label="Net deposit" value={money(sum?.deposits.net, sumCcy)} align="right" />
          <KpiCard label="Loads" value={money(sum?.loads.gross, sumCcy)} />
          <KpiCard label="Net loads" value={money(sum?.loads.net, sumCcy)} align="right" />
        </div>
        <FlowRowCard
          label="Withdrawals"
          hint="includes in-flight"
          value={outMoney(sum?.withdrawals.total, sumCcy)}
        />
        <FlowRowCard
          label="Payouts"
          hint="includes in-flight"
          value={outMoney(sum?.payouts.total, sumCcy)}
        />
      </div>
      <div className="text-xs text-muted-foreground">
        <p>
          Totals for {rangeLabel(range)}. Net deposit + Net load − Withdrawals − Payouts
          {hasReceivable ? ' + receivable' : ''}. Over an all-time range this equals your live
          wallet balance above.
        </p>
        {hasReceivable && (
          <p className="mt-1 text-foreground">
            + {money(receivable, sumCcy)} receivable — owed back to the platform from a reversed
            deposit (included so the math ties out).
          </p>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Volume</CardTitle>
          <CardDescription>
            Daily completed transactions over {rangeLabel(range)} ({data?.currency ?? currency}).
          </CardDescription>
        </CardHeader>
        <CardContent>
          {data ? (
            <VolumeChart buckets={data.daily.buckets} currency={data.currency} />
          ) : (
            <Skeleton />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>By source</CardTitle>
          <CardDescription>
            Volume and transaction count per source over {rangeLabel(range)} (
            {data?.currency ?? currency}
            ).
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
                <div className="text-right font-mono">
                  {formatNumber(t.netAmount)} {t.currency}
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
    </div>
  );
}

// Full-width money-out row: label (+ hint) on the left, value on the far right so
// it lines up directly under the right-aligned Net deposit / Net load figures.
function FlowRowCard({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="flex items-center justify-between gap-4 px-6 py-5">
        <div className="space-y-0.5">
          <CardDescription>{label}</CardDescription>
          {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
        </div>
        <span className="font-mono text-2xl">{value}</span>
      </CardContent>
    </Card>
  );
}

function Skeleton() {
  return <div className="h-72 w-full animate-pulse rounded bg-muted" />;
}
