'use client';
import { useQuery } from '@tanstack/react-query';
import type { WalletResponse } from '@app/shared';
import { Card, CardContent } from '@/components/ui/card';
import { DataTable, type Column } from '@/components/ui/data-table';
import { apiFetch } from '@/lib/api.client';

export function WalletsView() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['company', 'wallets'],
    queryFn: () => apiFetch<{ data: WalletResponse[] }>('/company/wallets'),
  });

  const columns: Column<WalletResponse>[] = [
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Wallets</h1>
        <p className="text-sm text-muted-foreground">
          One wallet per currency. Created automatically on first transaction.
        </p>
      </div>

      <Card>
        <CardContent className="p-0">
          <DataTable<WalletResponse>
            columns={columns}
            rows={data?.data}
            isLoading={isLoading}
            error={error}
            rowKey={(w) => w.id}
            empty={<div className="py-8 text-center text-muted-foreground">No wallets yet.</div>}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function trimAmount(s: string): string {
  if (!s.includes('.')) return s;
  return s.replace(/\.?0+$/, '');
}
