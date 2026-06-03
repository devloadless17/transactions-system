'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  LedgerAccountType,
  SUPPORTED_CURRENCIES,
  type LedgerEntryResponse,
  type PaginatedResponse,
} from '@app/shared';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { DataTable, type Column } from '@/components/ui/data-table';
import { Pagination } from '@/components/ui/pagination';
import { apiFetch } from '@/lib/api.client';
import { trimAmount } from '@/lib/format';

const PAGE_SIZE = 50;

export function LedgerView() {
  const [page, setPage] = useState(1);
  const [currency, setCurrency] = useState<string>('');
  const [accountType, setAccountType] = useState<LedgerAccountType | ''>('');

  const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
  if (currency) params.set('currency', currency);
  if (accountType) params.set('accountType', accountType);

  const listQ = useQuery({
    queryKey: ['company', 'ledger', params.toString()],
    queryFn: () =>
      apiFetch<PaginatedResponse<LedgerEntryResponse>>(`/company/ledger?${params.toString()}`),
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
      cell: (e) => (
        <>
          {e.transactionId && `tx:${e.transactionId.slice(0, 8)}`}
          {e.withdrawalId && `wd:${e.withdrawalId.slice(0, 8)}`}
        </>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Ledger</h1>
        <p className="text-sm text-muted-foreground">
          Append-only record of every financial event. Reconcile against your wallets.
        </p>
      </div>

      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="space-y-1">
              <Label className="text-xs">Currency</Label>
              <select
                value={currency}
                onChange={(e) => {
                  setCurrency(e.target.value);
                  setPage(1);
                }}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
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
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
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
    </div>
  );
}
