'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { PaginatedResponse, WhishPaymentResponse } from '@app/shared';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { DataTable, type Column } from '@/components/ui/data-table';
import { Pagination } from '@/components/ui/pagination';
import { apiFetch } from '@/lib/api.client';
import { ApiClientError } from '@/lib/api';

const PAGE_SIZE = 20;

function statusVariant(s: WhishPaymentResponse['status']) {
  if (s === 'PAID') return 'success' as const;
  if (s === 'FAILED' || s === 'EXPIRED') return 'destructive' as const;
  return 'secondary' as const;
}

export function AdminWhishView() {
  const [page, setPage] = useState(1);

  const paymentsQ = useQuery({
    queryKey: ['admin', 'whish', 'payments', { page }],
    queryFn: () =>
      apiFetch<PaginatedResponse<WhishPaymentResponse>>(
        `/admin/whish/payments?page=${page}&pageSize=${PAGE_SIZE}`,
      ),
  });

  const data = paymentsQ.data;

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
      className: 'font-mono text-xs text-muted-foreground',
      cell: (p) => p.companyId.slice(0, 8),
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
      cell: (p) => <Badge variant={statusVariant(p.status)}>{p.status}</Badge>,
    },
    {
      key: 'created',
      header: 'Created',
      className: 'text-xs text-muted-foreground',
      cell: (p) => new Date(p.createdAt).toLocaleString(),
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Whish Pay</h1>
        <p className="text-sm text-muted-foreground">
          Platform account balance and every Whish payment across companies.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <BalanceCard currency="USD" />
      </div>

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
            empty={
              <div className="py-8 text-center text-muted-foreground">No Whish payments yet.</div>
            }
          />
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
