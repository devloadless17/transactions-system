'use client';
import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import {
  LedgerAccountType,
  SUPPORTED_CURRENCIES,
  type ActivityKind,
  type LedgerEntryResponse,
  type PaginatedResponse,
} from '@app/shared';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { DataTable, type Column } from '@/components/ui/data-table';
import { Pagination } from '@/components/ui/pagination';
import {
  DateRangePicker,
  type PickedRange,
  type RangePreset,
} from '@/components/ui/date-range-picker';
import { apiFetch } from '@/lib/api.client';
import { trimAmount } from '@/lib/format';
import { ExportCsvButton } from '@/components/export-csv-button';
import { EntityDetailDrawer } from '@/features/activity/activity-detail-drawer';

const PAGE_SIZE = 50;

// Local YYYY-MM-DD, n days before today (0 = today).
function dayKey(daysAgo = 0): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

// Build an inclusive ISO bound from a date (YYYY-MM-DD) + optional time (HH:mm).
// Returns undefined for a malformed value so `.toISOString()` can't throw.
function isoBound(date: string, time: string | undefined, endOfDay: boolean): string | undefined {
  const t = time || (endOfDay ? '23:59' : '00:00');
  const d = new Date(`${date}T${t}:${endOfDay ? '59.999' : '00'}`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function LedgerView() {
  const [page, setPage] = useState(1);
  const [currency, setCurrency] = useState<string>('');
  const [accountType, setAccountType] = useState<LedgerAccountType | ''>('');
  const [range, setRange] = useState<PickedRange>({});
  // The operation whose detail drawer is open (clicked from a "Linked" cell).
  const [entityTarget, setEntityTarget] = useState<{ kind: ActivityKind; id: string } | null>(null);

  const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
  if (currency) params.set('currency', currency);
  if (accountType) params.set('accountType', accountType);
  // Expand the picked dates/times to inclusive ISO bounds the API expects.
  if (range.from) {
    const fromIso = isoBound(range.from, range.fromTime, false);
    if (fromIso) params.set('from', fromIso);
  }
  if (range.to) {
    const toIso = isoBound(range.to, range.toTime, true);
    if (toIso) params.set('to', toIso);
  }

  const datePresets: RangePreset[] = [
    { label: 'Today', from: dayKey(0), to: dayKey(0) },
    { label: 'Last 7 days', from: dayKey(6), to: dayKey(0) },
    { label: 'Last 30 days', from: dayKey(29), to: dayKey(0) },
  ].map((p) => ({
    label: p.label,
    active: range.from === p.from && range.to === p.to && !range.fromTime && !range.toTime,
    onSelect: () => {
      setRange({ from: p.from, to: p.to });
      setPage(1);
    },
  }));

  const listQ = useQuery({
    queryKey: ['company', 'ledger', params.toString()],
    queryFn: () =>
      apiFetch<PaginatedResponse<LedgerEntryResponse>>(`/company/ledger?${params.toString()}`),
    placeholderData: keepPreviousData,
  });

  const columns: Column<LedgerEntryResponse>[] = [
    {
      key: 'when',
      header: 'When',
      className: 'text-xs text-muted-foreground',
      cell: (e) => new Date(e.createdAt).toLocaleString(),
    },
    {
      key: 'account',
      header: 'Account',
      cell: (e) => <Badge variant="secondary">{e.accountType}</Badge>,
    },
    {
      key: 'direction',
      header: 'Direction',
      cell: (e) => (
        <Badge variant={e.direction === 'DEBIT' ? 'warning' : 'success'}>{e.direction}</Badge>
      ),
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      className: 'font-mono',
      cell: (e) => trimAmount(e.amount),
    },
    { key: 'currency', header: 'Currency', cell: (e) => e.currency },
    {
      key: 'linked',
      header: 'Linked',
      className: 'font-mono text-xs break-all',
      cell: (e) => {
        const label = linkedLabel(e);
        const target = linkedTarget(e);
        if (!label) return '—';
        // Click a linked reference to open the originating operation's full
        // detail — trace any ledger line back to its transaction in one click.
        return target ? (
          <button
            type="button"
            onClick={() => setEntityTarget(target)}
            className="text-primary underline-offset-2 hover:underline"
            title="View full details"
          >
            {label}
          </button>
        ) : (
          label
        );
      },
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Ledger</h1>
          <p className="text-sm text-muted-foreground">
            Append-only record of every financial event. Reconcile against your wallets.
          </p>
        </div>
        <ExportCsvButton path="/company/ledger/export.csv" params={params} filename="ledger" />
      </div>

      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Date range</Label>
              <DateRangePicker
                value={range}
                presets={datePresets}
                placeholder="All dates"
                className="w-64"
                onChange={(v) => {
                  setRange(v);
                  setPage(1);
                }}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Currency</Label>
              <select
                value={currency}
                onChange={(e) => {
                  setCurrency(e.target.value);
                  setPage(1);
                }}
                className="flex h-10 rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">All</option>
                {SUPPORTED_CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Account type</Label>
              <select
                value={accountType}
                onChange={(e) => {
                  setAccountType((e.target.value as LedgerAccountType) || '');
                  setPage(1);
                }}
                className="flex h-10 rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">All</option>
                {Object.values(LedgerAccountType).map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <DataTable<LedgerEntryResponse>
            columns={columns}
            rows={listQ.data?.data}
            isLoading={listQ.isLoading}
            error={listQ.error}
            rowKey={(e) => e.id}
            empty={<div className="py-8 text-center text-muted-foreground">No entries.</div>}
          />
        </CardContent>
      </Card>

      {listQ.data && (
        <Pagination
          page={listQ.data.meta.page}
          totalPages={listQ.data.meta.totalPages}
          total={listQ.data.meta.total}
          onPageChange={setPage}
        />
      )}

      <EntityDetailDrawer
        scope="company"
        target={entityTarget}
        onClose={() => setEntityTarget(null)}
      />
    </div>
  );
}

// The short, prefixed reference to whatever originating row this entry is tied to.
// Exactly one of these ids is set per entry (or none, for a pure EXTERNAL leg).
function linkedLabel(e: LedgerEntryResponse): string | null {
  if (e.transactionId) return `tx:${e.transactionId.slice(0, 8)}`;
  if (e.withdrawalId) return `wd:${e.withdrawalId.slice(0, 8)}`;
  if (e.payoutId) return `po:${e.payoutId.slice(0, 8)}`;
  if (e.loadId) return `ld:${e.loadId.slice(0, 8)}`;
  return null;
}

// The originating operation (kind + id) a ledger entry is tied to, for the
// click-through detail drawer. Exactly one id is set per linked entry.
function linkedTarget(e: LedgerEntryResponse): { kind: ActivityKind; id: string } | null {
  if (e.transactionId) return { kind: 'DEPOSIT', id: e.transactionId };
  if (e.withdrawalId) return { kind: 'WITHDRAWAL', id: e.withdrawalId };
  if (e.payoutId) return { kind: 'PAYOUT', id: e.payoutId };
  if (e.loadId) return { kind: 'LOAD', id: e.loadId };
  return null;
}
