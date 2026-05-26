'use client';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import { ArrowUpFromLine, RotateCcw } from 'lucide-react';
import type { FlowsResponse, OperationsResponse, PlatformAnalyticsResponse } from '@app/shared';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { apiFetch } from '@/lib/api.client';
import { KpiCard } from '@/features/analytics/kpi-card';
import { FlowsChart } from '@/features/analytics/flows-chart';
import { useOverview } from '@/features/analytics/use-overview';

const RANGE_OPTIONS = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
];

export function AdminOverview() {
  const [days, setDays] = useState<number>(30);
  const [flowsCurrency, setFlowsCurrency] = useState<string>('USD');

  // Bucket "now" to whole minutes so the queryKey is stable across renders
  // (otherwise every render produced a fresh ISO timestamp and triggered a
  // refetch loop).
  const { from, to } = useMemo(() => {
    const now = Math.floor(Date.now() / 60_000) * 60_000;
    return {
      to: new Date(now).toISOString(),
      from: new Date(now - days * 24 * 3600 * 1000).toISOString(),
    };
  }, [days]);

  const rangeParams = new URLSearchParams({ from, to });

  const platformQ = useQuery({
    queryKey: ['admin', 'analytics', 'platform', days],
    queryFn: () =>
      apiFetch<PlatformAnalyticsResponse>(`/admin/analytics/platform?${rangeParams.toString()}`),
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: 1,
  });

  const flowsParams = new URLSearchParams(rangeParams);
  flowsParams.set('currency', flowsCurrency);

  const flowsQ = useQuery({
    queryKey: ['admin', 'analytics', 'flows', days, flowsCurrency],
    queryFn: () => apiFetch<FlowsResponse>(`/admin/analytics/flows?${flowsParams.toString()}`),
    staleTime: 30_000,
    retry: 1,
  });

  const opsQ = useQuery({
    queryKey: ['admin', 'analytics', 'operations'],
    queryFn: () => apiFetch<OperationsResponse>('/admin/analytics/operations'),
    refetchInterval: 60_000,
    staleTime: 30_000,
    retry: 1,
  });

  const overviewQ = useOverview({ scope: 'admin', currency: flowsCurrency, days });

  const currencies = platformQ.data?.byCurrency.map((c) => c.currency) ?? [];
  // Hero KPIs pick the "primary" currency: first with any fees, else first in the list.
  const primary =
    platformQ.data?.byCurrency.find((c) => Number(c.feesEarned) > 0) ??
    platformQ.data?.byCurrency[0];

  return (
    <div className="space-y-6">
      <div className="flex items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Platform Overview</h1>
          <p className="text-sm text-muted-foreground">
            Multi-currency view of everything flowing through the system.
          </p>
        </div>
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
      </div>

      {/* Hero KPIs */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Platform revenue"
          value={primary ? `${fmt(primary.feesEarned)} ${primary.currency}` : '—'}
          hint={
            `Fees earned · last ${days}d` +
            (currencies.length > 1 ? ` (primary: ${primary?.currency})` : '')
          }
        />
        <KpiCard
          label="Volume in"
          value={primary ? `${fmt(primary.volumeIn)} ${primary.currency}` : '—'}
          hint={`Completed ingestion · ${primary?.ingestCount ?? 0} txs`}
        />
        <KpiCard
          label="Volume out"
          value={primary ? `${fmt(primary.volumeOut)} ${primary.currency}` : '—'}
          hint={`Withdrawal payouts · ${primary?.withdrawalCount ?? 0}`}
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Currency</TableHead>
                <TableHead className="text-right">Volume in</TableHead>
                <TableHead className="text-right">Volume out</TableHead>
                <TableHead className="text-right">Fees earned</TableHead>
                <TableHead className="text-right">Net held</TableHead>
                <TableHead className="text-right">Ingest count</TableHead>
                <TableHead className="text-right">Withdrawal count</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {platformQ.isLoading && (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {platformQ.data?.byCurrency.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                    No activity in this range.
                  </TableCell>
                </TableRow>
              )}
              {platformQ.data?.byCurrency.map((c) => (
                <TableRow key={c.currency}>
                  <TableCell className="font-medium">{c.currency}</TableCell>
                  <TableCell className="text-right font-mono">{fmt(c.volumeIn)}</TableCell>
                  <TableCell className="text-right font-mono">{fmt(c.volumeOut)}</TableCell>
                  <TableCell className="text-right font-mono">{fmt(c.feesEarned)}</TableCell>
                  <TableCell className="text-right font-mono">{fmt(c.netHeld)}</TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">
                    {c.ingestCount.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right text-xs text-muted-foreground">
                    {c.withdrawalCount.toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* By source — platform-wide breakdown in the chosen currency */}
      <Card>
        <CardHeader>
          <div className="flex items-end justify-between">
            <div>
              <CardTitle>By source</CardTitle>
              <CardDescription>
                Volume, transaction count, and platform fees per source over the last {days} days (
                {flowsCurrency}).
              </CardDescription>
            </div>
            <select
              value={flowsCurrency}
              onChange={(e) => setFlowsCurrency(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Source</TableHead>
                <TableHead className="text-right">Count</TableHead>
                <TableHead className="text-right">Volume</TableHead>
                <TableHead className="text-right">Fees</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {overviewQ.isLoading && (
                <TableRow>
                  <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {overviewQ.data && overviewQ.data.topSources.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
                    No transactions in this range.
                  </TableCell>
                </TableRow>
              )}
              {overviewQ.data?.topSources.map((s) => (
                <TableRow key={s.sourceId}>
                  <TableCell className="font-mono text-xs">{s.sourceCode}</TableCell>
                  <TableCell className="text-right font-mono">{s.count.toLocaleString()}</TableCell>
                  <TableCell className="text-right font-mono">{fmt(s.volume)}</TableCell>
                  <TableCell className="text-right font-mono text-muted-foreground">
                    {fmt(s.fees)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Flows chart with currency switcher */}
      <Card>
        <CardHeader>
          <div className="flex items-end justify-between">
            <div>
              <CardTitle>Flows</CardTitle>
              <CardDescription>
                Daily in (above axis) vs out (below) with platform fees overlaid.
              </CardDescription>
            </div>
            <select
              value={flowsCurrency}
              onChange={(e) => setFlowsCurrency(e.target.value)}
              className="h-9 rounded-md border border-input bg-background px-3 text-sm"
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

function fmt(s: string): string {
  const n = Number(s);
  if (Number.isNaN(n)) return s;
  if (n === 0) return '0';
  if (Math.abs(n) >= 1) return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
  return n.toString();
}
