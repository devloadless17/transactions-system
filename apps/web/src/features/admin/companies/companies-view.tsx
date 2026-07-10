'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import type { CompanyBalance, CompanyListItem, CompanyListResponse } from '@app/shared';
import { Button } from '@/components/ui/button';
import { DataTable, type Column } from '@/components/ui/data-table';
import { Pagination } from '@/components/ui/pagination';
import { Card, CardContent } from '@/components/ui/card';
import { TableCell, TableRow } from '@/components/ui/table';
import { apiFetch } from '@/lib/api.client';
import { formatMoney } from '@/lib/format';
import { EmptyState } from '@/components/empty-state';
import { Building2 } from 'lucide-react';
import { CreateCompanyDialog } from './create-company-dialog';

const PAGE_SIZE = 20;

/**
 * Available balance, one line per currency. Only USD exists today, so this
 * renders a single line — but a company may hold a wallet per currency, and
 * summing across currencies would be meaningless, so they stay separate.
 */
function Balances({ balances }: { balances: CompanyBalance[] }) {
  if (balances.length === 0) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex flex-col items-end gap-0.5">
      {balances.map((b) => (
        <span key={b.currency}>
          {formatMoney(b.availableBalance)}{' '}
          <span className="text-muted-foreground">{b.currency}</span>
        </span>
      ))}
    </div>
  );
}

// `canManage` is false for BACKOFFICE: it may see which companies exist but not
// create one or drill into a company's detail/analytics.
// `canViewBalances` is SUPER_ADMIN-only — the API omits the figures for everyone
// else, so this merely avoids rendering an always-empty column.
export function CompaniesView({
  canManage,
  canViewBalances,
}: {
  canManage: boolean;
  canViewBalances: boolean;
}) {
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);

  // Balances are opt-in per request (they cost a wallet aggregation) AND
  // SUPER_ADMIN-only server-side. Keyed on the flag so a role change can't serve
  // a cached balance-less page as if it were the real thing.
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin', 'companies', { page, withBalances: canViewBalances }],
    queryFn: () =>
      apiFetch<CompanyListResponse>(
        `/admin/companies?page=${page}&pageSize=${PAGE_SIZE}` +
          (canViewBalances ? '&withBalances=true' : ''),
      ),
  });

  const columns: Column<CompanyListItem>[] = [
    { key: 'name', header: 'Name', className: 'font-medium', cell: (c) => c.name },
    { key: 'slug', header: 'Slug', className: 'text-muted-foreground', cell: (c) => c.slug },
    { key: 'currency', header: 'Default currency', cell: (c) => c.defaultCurrency },
    { key: 'status', header: 'Status', cell: (c) => c.status },
    {
      key: 'created',
      header: 'Created',
      className: 'text-muted-foreground',
      cell: (c) => new Date(c.createdAt).toLocaleDateString(),
    },
  ];

  if (canViewBalances) {
    columns.push({
      key: 'balance',
      header: 'Available balance',
      align: 'right',
      className: 'font-mono tabular-nums',
      cell: (c) => <Balances balances={c.balances ?? []} />,
    });
  }

  // `totals` covers EVERY company matching the query, not just this page — say so,
  // otherwise a reader on page 2 of 5 would take it for a page subtotal.
  const totalCompanies = data?.meta.total ?? 0;
  const totalsRow =
    canViewBalances && data?.totals ? (
      <TableRow>
        <TableCell colSpan={columns.length - 1}>
          Total available — all {totalCompanies} {totalCompanies === 1 ? 'company' : 'companies'}
        </TableCell>
        <TableCell className="text-right font-mono tabular-nums">
          <Balances balances={data.totals} />
        </TableCell>
      </TableRow>
    ) : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Companies</h1>
          <p className="text-sm text-muted-foreground">
            {canManage
              ? 'Tenants on the platform. Create a company to provision its owner and a default wallet.'
              : 'Tenants on the platform.'}
          </p>
        </div>
        {canManage && (
          <Button className="w-full sm:w-auto" onClick={() => setCreateOpen(true)}>
            New company
          </Button>
        )}
      </div>

      <Card>
        <CardContent className="p-0">
          <DataTable<CompanyListItem>
            columns={columns}
            rows={data?.data}
            isLoading={isLoading}
            error={error}
            rowKey={(c) => c.id}
            footer={totalsRow}
            onRowClick={canManage ? (c) => router.push(`/admin/companies/${c.id}`) : undefined}
            empty={
              <EmptyState
                icon={Building2}
                title="No companies yet"
                description={
                  canManage
                    ? "Provision the first tenant. You'll get an owner login and a default-currency wallet seeded automatically."
                    : 'No tenants on the platform yet.'
                }
                action={
                  canManage
                    ? { label: 'New company', onClick: () => setCreateOpen(true) }
                    : undefined
                }
              />
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

      {canManage && (
        <CreateCompanyDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          onCreated={() => {
            setCreateOpen(false);
            void refetch();
          }}
        />
      )}
    </div>
  );
}
