'use client';
import { useEffect, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { ArrowDownLeft, ArrowUpRight, ListFilter, Search } from 'lucide-react';
import type { ActivityItem, ActivityKind, ActivityListResponse } from '@app/shared';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Pagination } from '@/components/ui/pagination';
import { EmptyState } from '@/components/empty-state';
import { apiFetch } from '@/lib/api.client';
import { formatMoney, isPositiveAmount, trimAmount } from '@/lib/format';
import { cn } from '@/lib/cn';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import {
  DateRangeControls,
  DEFAULT_RANGE,
  listRangeParams,
  rangeKey,
  type DateRange,
} from '@/features/analytics/date-range';
import { CompanyFilter } from '@/features/admin/company-filter';
import { ExportCsvButton } from '@/components/export-csv-button';
import { ActivityDetailDrawer } from './activity-detail-drawer';
import { activityHeadlineAmount, backofficeActivityAmount } from './headline-amount';

const PAGE_SIZE = 20;

type Direction = '' | 'IN' | 'OUT';
type KindFilter = '' | ActivityKind;

const KINDS: Array<{ value: KindFilter; label: string }> = [
  { value: '', label: 'All types' },
  { value: 'DEPOSIT', label: 'Deposits' },
  { value: 'LOAD', label: 'Loads' },
  { value: 'WITHDRAWAL', label: 'Withdrawals' },
  { value: 'PAYOUT', label: 'Payouts' },
];

/**
 * Unified activity feed across all four money operations. Money IN
 * (deposits + loads) shows green; money OUT (withdrawals + payouts) shows red —
 * the Whish-style "ins and outs" view. COMPLETED operations only. When a single
 * currency + no type/direction/search filter is active the API also returns a
 * running wallet balance per row (balance mode), shown under each amount.
 *
 * `backoffice` (admin scope only): BACKOFFICE never sees a platform fee — each
 * row leads with the single amount its own lists show, with no fee lines.
 */
export function ActivityView({
  scope,
  backoffice = false,
}: {
  scope: 'admin' | 'company';
  backoffice?: boolean;
}) {
  const [direction, setDirection] = useState<Direction>('');
  const [kind, setKind] = useState<KindFilter>('');
  const [range, setRange] = useState<DateRange>(DEFAULT_RANGE);
  const [companyId, setCompanyId] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const search = useDebouncedValue(searchInput, 300);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<ActivityItem | null>(null);

  // Any filter change resets to the first page.
  useEffect(() => {
    setPage(1);
  }, [direction, kind, companyId, search, rangeKey(range)]);

  // Activity is a LIST endpoint: it applies no default window, so an all-time
  // range simply omits from/to (and must NOT send the analytics preset flag,
  // which this schema doesn't accept).
  const params = listRangeParams(range, {
    page: String(page),
    pageSize: String(PAGE_SIZE),
  });
  if (direction) params.set('direction', direction);
  if (kind) params.set('kind', kind);
  if (search) params.set('search', search);
  if (scope === 'admin' && companyId) params.set('companyId', companyId);

  const q = useQuery({
    queryKey: [scope, 'activity', params.toString()],
    queryFn: () => apiFetch<ActivityListResponse>(`/${scope}/activity?${params.toString()}`),
    placeholderData: keepPreviousData,
  });

  const items = q.data?.data ?? [];
  const meta = q.data?.meta;
  const balanceMode = meta?.balanceMode ?? false;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Transactions</h1>
          <p className="text-sm text-muted-foreground">
            Every completed operation — deposits and loads in, withdrawals and payouts out.
          </p>
        </div>
        <ExportCsvButton
          path={`/${scope}/activity/export.csv`}
          params={params}
          filename="transactions"
        />
      </div>

      <Card>
        <CardContent className="flex flex-col gap-3 py-4 lg:flex-row lg:flex-wrap lg:items-center">
          {/* In / Out segmented control */}
          <div className="inline-flex rounded-md border p-0.5">
            {(['', 'IN', 'OUT'] as Direction[]).map((d) => (
              <button
                key={d || 'all'}
                type="button"
                onClick={() => setDirection(d)}
                className={cn(
                  'rounded px-3 py-1 text-sm font-medium transition-colors',
                  direction === d
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {d === '' ? 'All' : d === 'IN' ? 'In' : 'Out'}
              </button>
            ))}
          </div>

          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as KindFilter)}
            aria-label="Operation type"
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            {KINDS.map((k) => (
              <option key={k.value || 'all'} value={k.value}>
                {k.label}
              </option>
            ))}
          </select>

          <DateRangeControls value={range} onChange={setRange} />

          {scope === 'admin' && <CompanyFilter value={companyId} onChange={setCompanyId} />}

          <div className="relative lg:ml-auto">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Phone, name, reference, id…"
              aria-label="Search by phone, name, reference or id"
              className="h-9 w-full pl-8 sm:w-60"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {q.isError ? (
            <div className="px-6 py-12 text-center text-sm text-destructive">
              Couldn&apos;t load activity — retrying…
            </div>
          ) : q.isLoading ? (
            <ul className="divide-y">
              {Array.from({ length: 8 }).map((_, i) => (
                <li key={i} className="flex items-center gap-4 px-4 py-3 sm:px-6">
                  <div className="h-10 w-10 shrink-0 animate-pulse rounded-full bg-muted" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 w-40 animate-pulse rounded bg-muted" />
                    <div className="h-3 w-24 animate-pulse rounded bg-muted" />
                  </div>
                  <div className="h-4 w-20 animate-pulse rounded bg-muted" />
                </li>
              ))}
            </ul>
          ) : items.length === 0 ? (
            <EmptyState
              icon={ListFilter}
              title="No activity in this range"
              description="Try a wider date range or clearing the filters."
            />
          ) : (
            <ul className="divide-y">
              {items.map((item) => (
                <FeedRow
                  key={item.id}
                  item={item}
                  scope={scope}
                  backoffice={backoffice}
                  balanceMode={balanceMode}
                  onSelect={setSelected}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {meta && (
        <Pagination
          page={meta.page}
          totalPages={meta.totalPages}
          total={meta.total}
          pageSize={meta.pageSize}
          onPageChange={setPage}
        />
      )}

      <ActivityDetailDrawer
        scope={scope}
        backoffice={backoffice}
        item={selected}
        onClose={() => setSelected(null)}
      />
    </div>
  );
}

const KIND_LABEL: Record<ActivityKind, string> = {
  DEPOSIT: 'Deposit',
  LOAD: 'Load',
  WITHDRAWAL: 'Withdrawal',
  PAYOUT: 'Payout',
};

// Source code (deposits) or payout method (the rest), lightly prettified.
function channel(item: ActivityItem): string {
  if (item.kind === 'DEPOSIT') return item.description.toUpperCase();
  const m = item.description.toUpperCase();
  if (m === 'WISH') return 'Whish';
  if (m === 'BANK_TRANSFER') return 'Bank';
  return m.charAt(0) + m.slice(1).toLowerCase();
}

function FeedRow({
  item,
  scope,
  backoffice,
  balanceMode,
  onSelect,
}: {
  item: ActivityItem;
  scope: 'admin' | 'company';
  backoffice: boolean;
  balanceMode: boolean;
  onSelect: (item: ActivityItem) => void;
}) {
  const isIn = item.direction === 'IN';
  const Icon = isIn ? ArrowDownLeft : ArrowUpRight;
  const subtitle = [item.details ?? item.reference, scope === 'admin' ? item.companyName : null]
    .filter(Boolean)
    .join(' · ');

  return (
    <li>
      <button
        type="button"
        onClick={() => onSelect(item)}
        className="flex w-full items-center gap-4 px-4 py-3 text-left transition-colors hover:bg-accent sm:px-6"
      >
        <span
          className={cn(
            'flex h-10 w-10 shrink-0 items-center justify-center rounded-full',
            isIn
              ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400'
              : 'bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-400',
          )}
        >
          <Icon className="h-5 w-5" />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="font-medium">{KIND_LABEL[item.kind]}</span>
            <span className="truncate text-xs text-muted-foreground">· {channel(item)}</span>
          </div>
          {subtitle && <div className="truncate text-sm text-muted-foreground">{subtitle}</div>}
          <div className="text-xs text-muted-foreground">
            {new Date(item.createdAt).toLocaleString()}
          </div>
        </div>

        <div className="shrink-0 text-right">
          <div
            className={cn(
              'font-mono font-semibold tabular-nums',
              isIn ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-600 dark:text-red-400',
            )}
          >
            {isIn ? '+' : '−'}
            {formatMoney(
              backoffice ? backofficeActivityAmount(item) : activityHeadlineAmount(item),
            )}{' '}
            {item.currency}
          </div>
          {!backoffice && Number(item.fee) > 0 && (
            <div className="text-xs text-muted-foreground">fee {trimAmount(item.fee)}</div>
          )}
          {!backoffice && isPositiveAmount(item.networkFee) && (
            <div className="text-xs text-muted-foreground">
              network fee {trimAmount(item.networkFee)}
            </div>
          )}
          {balanceMode && item.balanceAfter != null && (
            <div className="text-xs tabular-nums text-muted-foreground">
              bal {formatMoney(item.balanceAfter)} {item.currency}
            </div>
          )}
        </div>
      </button>
    </li>
  );
}
