'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@/lib/toast';
import Link from 'next/link';
import { AlertTriangle, Pencil } from 'lucide-react';
import {
  SUPPORTED_CURRENCIES,
  companyNameSchema,
  slugSchema,
  type AuditLogResponse,
  type CompanyDetailResponse,
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
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DataTable, type Column } from '@/components/ui/data-table';
import { NetworkFeeLine } from '@/components/network-fee-line';
import { apiFetch } from '@/lib/api.client';
import { granularityWord } from '@/lib/date-presets';
import { ApiClientError } from '@/lib/api';
import { formatNumber as fmt, isPositiveAmount, trimAmount } from '@/lib/format';
import { KpiCard } from '@/features/analytics/kpi-card';
import { VolumeChart } from '@/features/analytics/volume-chart.lazy';
import {
  DateRangeControls,
  analyticsRangeParams,
  DEFAULT_RANGE,
  isRangeReady,
  rangeKey,
  rangeLabel,
  rangePhrase,
  type DateRange,
} from '@/features/analytics/date-range';
import { AuditChangesCell } from '@/features/admin/audit/audit-changes';
import { CompanyUsersCard } from './company-users-card';
import { NetworkFeeCard } from './network-fee-card';

export function CompanyDetailView({
  companyId,
  canEditIdentity = false,
  canEditNetworkFee = false,
}: {
  companyId: string;
  /** SUPER_ADMIN: may rename the company and change its slug. */
  canEditIdentity?: boolean;
  /** SUPER_ADMIN: may change the network fee (others see it read-only). */
  canEditNetworkFee?: boolean;
}) {
  const qc = useQueryClient();
  const [chartCurrency, setChartCurrency] = useState<string>('USD');
  const [range, setRange] = useState<DateRange>(DEFAULT_RANGE);
  const [slugDialogOpen, setSlugDialogOpen] = useState(false);
  const [slugDraft, setSlugDraft] = useState('');
  // Validated with the SHARED schema (same rule the API enforces) so the
  // dialog shows the real error inline instead of a post-submit 400 toast.
  const slugParse = slugSchema.safeParse(slugDraft);
  const slugError =
    slugDraft.trim() && !slugParse.success ? slugParse.error.issues[0]?.message : null;
  const [nameDialogOpen, setNameDialogOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const nameParse = companyNameSchema.safeParse(nameDraft);
  const nameError =
    nameDraft.trim() && !nameParse.success ? nameParse.error.issues[0]?.message : null;

  const companyQ = useQuery({
    queryKey: ['admin', 'company', companyId],
    queryFn: () => apiFetch<CompanyDetailResponse>(`/admin/companies/${companyId}`),
  });

  const overviewQ = useQuery({
    queryKey: ['admin', 'company', companyId, 'overview', chartCurrency, rangeKey(range)],
    queryFn: () => {
      const params = analyticsRangeParams(range, { currency: chartCurrency });
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

  const nameMu = useMutation({
    mutationFn: (name: string) =>
      apiFetch<CompanyResponse>(`/admin/companies/${companyId}`, {
        method: 'PATCH',
        body: { name },
      }),
    onSuccess: (c) => {
      toast.success(`Renamed to ${c.name}`);
      setNameDialogOpen(false);
      qc.invalidateQueries({ queryKey: ['admin', 'company', companyId] });
      // Prefix match, so this also refreshes the companies list, the picker and
      // ['admin','companies','names',…] — the lookup behind every company filter.
      qc.invalidateQueries({ queryKey: ['admin', 'companies'] });
    },
    onError: (err) => toast.error(err instanceof ApiClientError ? err.message : 'Failed'),
  });

  const slugMu = useMutation({
    mutationFn: (slug: string) =>
      apiFetch<CompanyResponse>(`/admin/companies/${companyId}`, {
        method: 'PATCH',
        body: { slug },
      }),
    onSuccess: (c) => {
      toast.success(`Slug changed to ${c.slug}`);
      setSlugDialogOpen(false);
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
      cell: (t) => (
        <>
          {trimAmount(t.commissionAmount)}
          <NetworkFeeLine amount={t.networkFeeAmount} />
        </>
      ),
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
    // A rename is legible right where it happened.
    { key: 'changes', header: 'Changes', cell: (a) => <AuditChangesCell metadata={a.metadata} /> },
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
          <h1 className="mt-1 flex items-center gap-3 text-2xl font-semibold">
            {companyQ.data ? (
              <>
                {companyQ.data.name}
                <Badge variant={companyQ.data.status === 'ACTIVE' ? 'success' : 'destructive'}>
                  {companyQ.data.status}
                </Badge>
                {canEditIdentity && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground hover:text-foreground"
                    aria-label="Rename company"
                    title="Rename company"
                    onClick={() => {
                      setNameDraft(companyQ.data?.name ?? '');
                      setNameDialogOpen(true);
                    }}
                  >
                    <Pencil className="h-4 w-4" />
                  </Button>
                )}
              </>
            ) : companyQ.isError ? null : (
              // Reserve the H1's height while loading so the name doesn't pop in
              // and shift the page (no "Loading…" text swap).
              <Skeleton className="h-7 w-48" />
            )}
          </h1>
          {companyQ.data ? (
            <p className="text-sm text-muted-foreground">
              slug: <span className="break-all font-mono">{companyQ.data.slug}</span>
              {canEditIdentity && (
                <Button
                  variant="ghost"
                  size="icon"
                  // Smaller than the name's: this one sits inline in a line of
                  // small print, where an h-8 control would tower over the text.
                  className="ml-0.5 h-6 w-6 translate-y-0.5 text-muted-foreground hover:text-foreground"
                  aria-label="Edit slug"
                  title="Edit slug"
                  onClick={() => {
                    setSlugDraft(companyQ.data?.slug ?? '');
                    setSlugDialogOpen(true);
                  }}
                >
                  <Pencil className="h-3 w-3" />
                </Button>
              )}{' '}
              · default currency: {companyQ.data.defaultCurrency} · created{' '}
              {new Date(companyQ.data.createdAt).toLocaleDateString()}
            </p>
          ) : companyQ.isError ? null : (
            <Skeleton className="mt-1 h-4 w-72" />
          )}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <DateRangeControls value={range} onChange={setRange} className="w-full sm:w-auto" />
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
      </div>

      {canEditIdentity && (
        <Dialog open={nameDialogOpen} onOpenChange={setNameDialogOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Rename company</DialogTitle>
              <DialogDescription>
                Changes the display name shown across the admin, notifications and exports.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="company-name">Company name</Label>
              <Input
                id="company-name"
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                placeholder="Acme Corp"
                autoComplete="off"
              />
              {nameError ? (
                <p className="text-xs text-destructive">{nameError}</p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  2–120 characters. Names don&apos;t have to be unique.
                </p>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setNameDialogOpen(false)}>
                Cancel
              </Button>
              <Button
                // Send the PARSED value, so the trimmed name is what's saved.
                onClick={() => nameParse.success && nameMu.mutate(nameParse.data)}
                disabled={
                  nameMu.isPending ||
                  !nameParse.success ||
                  (nameParse.success && nameParse.data === companyQ.data?.name)
                }
              >
                {nameMu.isPending ? 'Saving…' : 'Save name'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {canEditIdentity && (
        <Dialog open={slugDialogOpen} onOpenChange={setSlugDialogOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Edit slug</DialogTitle>
              <DialogDescription>
                The public identifier external sources ingest with.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="company-slug">Slug</Label>
                <Input
                  id="company-slug"
                  className="font-mono"
                  value={slugDraft}
                  onChange={(e) => setSlugDraft(e.target.value)}
                  placeholder="acme-corp"
                  autoComplete="off"
                />
                {slugError ? (
                  <p className="text-xs text-destructive">{slugError}</p>
                ) : (
                  <p className="text-xs text-muted-foreground">
                    2–50 characters, lowercase letters, numbers and dashes.
                  </p>
                )}
              </div>
              {/* A real change breaks live ingestion until every source is
                  updated, so it gets the same treatment as the app's other
                  destructive paths — and only once the value actually differs. */}
              {slugParse.success && slugParse.data !== companyQ.data?.slug && (
                <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                  <span>
                    Sources posting to <span className="font-mono">{companyQ.data?.slug}</span> will
                    start failing when you save.
                  </span>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setSlugDialogOpen(false)}>
                Cancel
              </Button>
              <Button
                onClick={() => slugParse.success && slugMu.mutate(slugParse.data)}
                disabled={
                  slugMu.isPending ||
                  !slugParse.success ||
                  (slugParse.success && slugParse.data === companyQ.data?.slug)
                }
              >
                {slugMu.isPending ? 'Saving…' : 'Save slug'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

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

      {companyQ.data?.networkFee && (
        <NetworkFeeCard
          companyId={companyId}
          companyName={companyQ.data.name}
          config={companyQ.data.networkFee}
          canEdit={canEditNetworkFee}
        />
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
        {/* Network fees — admin-only like the card above. Shown while the
            company is charged one, or once it has earned some in the range. */}
        {(companyQ.data?.networkFee?.enabled ||
          isPositiveAmount(overviewQ.data?.kpi.totalNetworkFees)) && (
          <KpiCard
            label="Network fees"
            value={
              overviewQ.data?.kpi.totalNetworkFees
                ? `${fmt(overviewQ.data.kpi.totalNetworkFees)} ${chartCurrency}`
                : '—'
            }
            hint={`Network fee earned · ${rangeLabel(range)}`}
          />
        )}
      </div>

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <CardTitle>Activity</CardTitle>
              <CardDescription>
                {granularityWord(overviewQ.data?.daily.granularity ?? 'day')} completed transaction
                volume.
              </CardDescription>
            </div>
            <div className="flex flex-wrap gap-2">
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
            <VolumeChart
              buckets={overviewQ.data.daily.buckets}
              currency={chartCurrency}
              granularity={overviewQ.data.daily.granularity}
            />
          ) : (
            <div className="h-72 w-full animate-pulse rounded bg-muted" />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>By source</CardTitle>
          <CardDescription>
            Every source this company transacted through {rangePhrase(range)} ({chartCurrency}).
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
// (gross = net + fee + network fee; per-flow fees tie out to the Platform fees
// card, network fees to the Network fees card), plus any money still in-flight
// for that operation type. The network part only appears once one is charged.
function inflightHint(m: VolumeMetric, currency: string): string {
  const parts = [`${m.completedCount.toLocaleString()} completed`];
  const hasFee = Number(m.completedFees) > 0;
  const hasNetworkFee = isPositiveAmount(m.completedNetworkFees);
  if (hasFee || hasNetworkFee) {
    parts.push(`${fmt(m.completedNet)} net`);
    if (hasFee) parts.push(`${fmt(m.completedFees)} fee`);
    if (hasNetworkFee) parts.push(`${fmt(m.completedNetworkFees)} network`);
  }
  if (m.pendingCount > 0 || Number(m.pendingTotal) > 0) {
    parts.push(`${fmt(m.pendingTotal)} ${currency} in-flight`);
  }
  return parts.join(' · ');
}
