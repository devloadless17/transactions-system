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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { apiFetch } from '@/lib/api.client';
import { ApiClientError } from '@/lib/api';
import { KpiCard } from '@/features/analytics/kpi-card';
import { VolumeChart } from '@/features/analytics/volume-chart';

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

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
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
              slug: <span className="font-mono">{companyQ.data.slug}</span> · default currency:{' '}
              {companyQ.data.defaultCurrency} · created{' '}
              {new Date(companyQ.data.createdAt).toLocaleDateString()}
            </p>
          )}
        </div>
        {companyQ.data?.status === 'ACTIVE' && (
          <Button
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

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
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
          <div className="flex items-end justify-between gap-3">
            <div>
              <CardTitle>Activity</CardTitle>
              <CardDescription>Daily completed transaction volume.</CardDescription>
            </div>
            <div className="flex gap-2">
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Currency</TableHead>
                <TableHead className="text-right">Available</TableHead>
                <TableHead className="text-right">Pending</TableHead>
                <TableHead className="text-right">Reserved</TableHead>
                <TableHead>Updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {walletsQ.data?.data.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-6 text-center text-muted-foreground">
                    No wallets yet.
                  </TableCell>
                </TableRow>
              )}
              {walletsQ.data?.data.map((w) => (
                <TableRow key={w.id}>
                  <TableCell className="font-medium">{w.currency}</TableCell>
                  <TableCell className="text-right font-mono">
                    {trimAmount(w.availableBalance)}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {trimAmount(w.pendingBalance)}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {trimAmount(w.reservedBalance)}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(w.updatedAt).toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent transactions</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>External</TableHead>
                <TableHead>Source</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-right">Fee</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {txQ.data?.data.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-6 text-center text-muted-foreground">
                    No transactions.
                  </TableCell>
                </TableRow>
              )}
              {txQ.data?.data.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-mono text-xs">{t.externalTransactionId}</TableCell>
                  <TableCell>{t.sourceCode}</TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {trimAmount(t.amount)} {t.currency}
                  </TableCell>
                  <TableCell className="text-right font-mono text-xs">
                    {trimAmount(t.commissionAmount)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={t.status === 'COMPLETED' ? 'success' : 'secondary'}>
                      {t.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(t.createdAt).toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Audit log</CardTitle>
          <CardDescription>Mutating actions tied to this company.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Entity</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {auditQ.data?.data.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="py-6 text-center text-muted-foreground">
                    No audit entries.
                  </TableCell>
                </TableRow>
              )}
              {auditQ.data?.data.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(a.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-xs">{a.actorEmail ?? '—'}</TableCell>
                  <TableCell className="font-mono text-xs">{a.action}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {a.entityType}
                    {a.entityId ? `:${a.entityId.slice(0, 8)}` : ''}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
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
