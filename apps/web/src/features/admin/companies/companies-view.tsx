'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import type { CompanyResponse, PaginatedResponse } from '@app/shared';
import { Button } from '@/components/ui/button';
import { DataTable, type Column } from '@/components/ui/data-table';
import { Pagination } from '@/components/ui/pagination';
import { Card, CardContent } from '@/components/ui/card';
import { apiFetch } from '@/lib/api.client';
import { EmptyState } from '@/components/empty-state';
import { Building2 } from 'lucide-react';
import { CreateCompanyDialog } from './create-company-dialog';

const PAGE_SIZE = 20;

export function CompaniesView() {
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin', 'companies', { page }],
    queryFn: () =>
      apiFetch<PaginatedResponse<CompanyResponse>>(
        `/admin/companies?page=${page}&pageSize=${PAGE_SIZE}`,
      ),
  });

  const columns: Column<CompanyResponse>[] = [
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

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Companies</h1>
          <p className="text-sm text-muted-foreground">
            Tenants on the platform. Create a company to provision its owner and a default wallet.
          </p>
        </div>
        <Button className="w-full sm:w-auto" onClick={() => setCreateOpen(true)}>
          New company
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <DataTable<CompanyResponse>
            columns={columns}
            rows={data?.data}
            isLoading={isLoading}
            error={error}
            rowKey={(c) => c.id}
            onRowClick={(c) => router.push(`/admin/companies/${c.id}`)}
            empty={
              <EmptyState
                icon={Building2}
                title="No companies yet"
                description="Provision the first tenant. You'll get an owner login and a default-currency wallet seeded automatically."
                action={{ label: 'New company', onClick: () => setCreateOpen(true) }}
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

      <CreateCompanyDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => {
          setCreateOpen(false);
          void refetch();
        }}
      />
    </div>
  );
}
