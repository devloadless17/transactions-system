'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import type { PaginatedResponse, SourceResponse } from '@app/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { DataTable, type Column } from '@/components/ui/data-table';
import { apiFetch } from '@/lib/api.client';
import { EmptyState } from '@/components/empty-state';
import { Boxes } from 'lucide-react';
import { CreateSourceDialog } from './create-source-dialog';

export function SourcesView() {
  const [createOpen, setCreateOpen] = useState(false);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin', 'sources'],
    queryFn: () => apiFetch<PaginatedResponse<SourceResponse>>('/admin/sources?pageSize=100'),
  });

  const columns: Column<SourceResponse>[] = [
    { key: 'name', header: 'Name', className: 'font-medium', cell: (s) => s.name },
    { key: 'code', header: 'Code', className: 'font-mono text-xs', cell: (s) => s.code },
    {
      key: 'status',
      header: 'Status',
      cell: (s) => (
        <Badge variant={s.status === 'ACTIVE' ? 'success' : 'secondary'}>{s.status}</Badge>
      ),
    },
    {
      key: 'created',
      header: 'Created',
      className: 'text-muted-foreground',
      cell: (s) => new Date(s.createdAt).toLocaleDateString(),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (s) => (
        <Button asChild variant="ghost" size="sm">
          <Link href={`/admin/sources/${s.id}/api-keys`}>API keys</Link>
        </Button>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Sources</h1>
          <p className="text-sm text-muted-foreground">
            Catalog of external providers that submit transactions to the platform.
          </p>
        </div>
        <Button className="w-full sm:w-auto" onClick={() => setCreateOpen(true)}>
          New source
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <DataTable<SourceResponse>
            columns={columns}
            rows={data?.data}
            isLoading={isLoading}
            error={error}
            rowKey={(s) => s.id}
            empty={
              <EmptyState
                icon={Boxes}
                title="No sources defined"
                description="Add the external providers (omt, bank, crypto gateway, etc.) you want to ingest from."
                action={{ label: 'New source', onClick: () => setCreateOpen(true) }}
              />
            }
          />
        </CardContent>
      </Card>

      <CreateSourceDialog
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
