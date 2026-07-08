'use client';
import { useEffect, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PaginatedResponse, WhishPaymentResponse } from '@app/shared';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DataTable, type Column } from '@/components/ui/data-table';
import { Pagination } from '@/components/ui/pagination';
import { apiFetch } from '@/lib/api.client';
import { ApiClientError } from '@/lib/api';
import { toast } from '@/lib/toast';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { ExportCsvButton } from '@/components/export-csv-button';
import { useCompanyNames } from '@/features/admin/company-filter';
import { WhishPaymentDetailDrawer } from './whish-payment-detail-drawer';
import {
  WhishFilterBar,
  whishFilterParams,
  whishFiltersActive,
  EMPTY_WHISH_FILTERS,
  type WhishFilters,
} from './whish-filter-bar';

const PAGE_SIZE = 20;

function statusVariant(s: WhishPaymentResponse['status']) {
  if (s === 'PAID') return 'success' as const;
  if (s === 'FAILED' || s === 'EXPIRED') return 'destructive' as const;
  return 'secondary' as const;
}

export function AdminWhishView() {
  const [page, setPage] = useState(1);
  const [detail, setDetail] = useState<WhishPaymentResponse | null>(null);
  const [filters, setFilters] = useState<WhishFilters>(EMPTY_WHISH_FILTERS);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebouncedValue(search, 300);
  const qc = useQueryClient();

  const params = whishFilterParams(filters, debouncedSearch, {
    page: String(page),
    pageSize: String(PAGE_SIZE),
  });
  const filtersOn = whishFiltersActive(filters, debouncedSearch);

  const paymentsQ = useQuery({
    queryKey: ['admin', 'whish', 'payments', params.toString()],
    queryFn: () =>
      apiFetch<PaginatedResponse<WhishPaymentResponse>>(
        `/admin/whish/payments?${params.toString()}`,
      ),
    placeholderData: keepPreviousData,
  });

  // Operator recovery: re-attempt settlement of one payment. The 60s poller skips
  // needsAttention rows, so a stuck (paid-but-unsettled) link only re-books when an
  // operator triggers this once the underlying cause is fixed.
  const refreshMu = useMutation({
    mutationFn: (id: string) =>
      apiFetch<WhishPaymentResponse>(`/admin/whish/payments/${id}/refresh-status`, {
        method: 'POST',
      }),
    onSuccess: (p) => {
      if (p.status === 'PAID') toast.success(`#${p.externalId} settled — booked to the ledger`);
      else if (p.needsAttention)
        toast.error(`#${p.externalId} still unsettled: ${p.settlementError ?? 'needs attention'}`);
      else toast.success(`#${p.externalId} refreshed — ${p.status}`);
    },
    onError: (err) => toast.error(err instanceof ApiClientError ? err.message : 'Refresh failed'),
    onSettled: () => qc.invalidateQueries({ queryKey: ['admin', 'whish'] }),
  });

  const data = paymentsQ.data;

  // Clamp back if the payment set shrinks below the current page so the operator
  // isn't left on an empty page with the pagination controls hidden.
  useEffect(() => {
    const tp = data?.meta.totalPages;
    if (tp && page > tp) setPage(tp);
  }, [data, page]);

  // Resolve companyId -> name for just the companies on this page (no bulk fetch).
  const companyNames = useCompanyNames(data?.data.map((p) => p.companyId) ?? []);
  const companyName = (id: string) => companyNames.get(id) ?? id.slice(0, 8);

  const columns: Column<WhishPaymentResponse>[] = [
    {
      key: 'reference',
      header: 'Reference',
      className: 'font-mono text-xs',
      cell: (p) => `#${p.externalId}`,
    },
    {
      key: 'company',
      header: 'Company',
      cell: (p) => companyName(p.companyId),
    },
    { key: 'invoice', header: 'Invoice', cell: (p) => p.invoice },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      className: 'font-mono',
      cell: (p) => `${p.amount} ${p.currency}`,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (p) => (
        <div className="flex items-center gap-2">
          <Badge variant={statusVariant(p.status)}>{p.status}</Badge>
          {p.needsAttention && (
            <Badge
              variant="destructive"
              title={
                p.settlementError
                  ? `Paid at Whish but not settled: ${p.settlementError}`
                  : 'Paid at Whish but not settled — needs operator attention'
              }
            >
              Needs attention
            </Badge>
          )}
        </div>
      ),
    },
    {
      key: 'created',
      header: 'Created',
      className: 'text-xs text-muted-foreground',
      cell: (p) => new Date(p.createdAt).toLocaleString(),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (p) => (
        <Button
          variant="ghost"
          size="sm"
          disabled={refreshMu.isPending && refreshMu.variables === p.id}
          onClick={(e) => {
            e.stopPropagation(); // don't also open the row's detail drawer
            refreshMu.mutate(p.id);
          }}
          title="Ask Whish for the latest status and settle if collected"
        >
          {refreshMu.isPending && refreshMu.variables === p.id ? 'Refreshing…' : 'Refresh'}
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Whish Pay</h1>
          <p className="text-sm text-muted-foreground">
            Platform account balance and every Whish payment across companies.
          </p>
        </div>
        <ExportCsvButton
          path="/admin/whish/payments/export.csv"
          params={params}
          filename="whish-payments"
        />
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <BalanceCard currency="USD" />
      </div>

      <WhishFilterBar
        value={filters}
        onChange={(f) => {
          setFilters(f);
          setPage(1);
        }}
        search={search}
        onSearchChange={(s) => {
          setSearch(s);
          setPage(1);
        }}
        showCompanyFilter
        showNeedsAttention
      />

      <Card>
        <CardHeader>
          <CardTitle>Payments</CardTitle>
          <CardDescription>All companies, newest first.</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <DataTable<WhishPaymentResponse>
            columns={columns}
            rows={data?.data}
            isLoading={paymentsQ.isLoading}
            error={paymentsQ.error}
            rowKey={(p) => p.id}
            onRowClick={(p) => setDetail(p)}
            empty={
              <div className="py-8 text-center text-muted-foreground">
                {filtersOn ? 'No payments match your filters.' : 'No Whish payments yet.'}
              </div>
            }
          />
          <WhishPaymentDetailDrawer payment={detail} onClose={() => setDetail(null)} />
        </CardContent>
      </Card>

      {data && (
        <Pagination
          page={data.meta.page}
          total={data.meta.total}
          totalPages={data.meta.totalPages}
          onPageChange={setPage}
        />
      )}
    </div>
  );
}

function BalanceCard({ currency }: { currency: 'USD' }) {
  const q = useQuery({
    queryKey: ['admin', 'whish', 'balance', currency],
    queryFn: () =>
      apiFetch<{ currency: string; balance: number }>(`/admin/whish/balance?currency=${currency}`),
    retry: false,
  });
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardDescription>Platform balance · {currency}</CardDescription>
        <CardTitle className="text-2xl">
          {q.isLoading ? '…' : q.error ? '—' : `${q.data?.balance.toLocaleString()} ${currency}`}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {q.error && (
          <p className="text-xs text-muted-foreground">
            {q.error instanceof ApiClientError ? q.error.message : 'Unavailable'}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
