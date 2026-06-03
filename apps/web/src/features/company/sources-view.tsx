'use client';
import { useQuery } from '@tanstack/react-query';
import type { SourceResponse } from '@app/shared';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { DataTable, type Column } from '@/components/ui/data-table';
import { apiFetch } from '@/lib/api.client';

export function SourcesView() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['company', 'sources'],
    // TODO: this hits the admin-prefixed /admin/sources/all endpoint — there is
    // no company-scoped sources list endpoint yet. Swap to a /company/sources
    // route if/when the backend exposes one.
    queryFn: () => apiFetch<{ data: SourceResponse[] }>('/admin/sources/all'),
  });

  const columns: Column<SourceResponse>[] = [
    { key: 'name', header: 'Name', cell: (s) => s.name },
    { key: 'code', header: 'Code', className: 'font-mono text-xs', cell: (s) => s.code },
    {
      key: 'status',
      header: 'Status',
      cell: (s) => (
        <Badge variant={s.status === 'ACTIVE' ? 'success' : 'secondary'}>{s.status}</Badge>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Sources</h1>
        <p className="text-sm text-muted-foreground">
          Active providers you can send transactions from. Use the{' '}
          <code className="font-mono">code</code> field in the ingestion payload.
        </p>
      </div>
      <Card>
        <CardContent className="p-0">
          <DataTable<SourceResponse>
            columns={columns}
            rows={data?.data}
            isLoading={isLoading}
            error={error}
            rowKey={(s) => s.id}
            empty={<div className="py-8 text-center text-muted-foreground">No sources yet.</div>}
          />
        </CardContent>
      </Card>
    </div>
  );
}
