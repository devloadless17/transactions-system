'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import Link from 'next/link';
import type { PaginatedResponse, SourceResponse } from '@app/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { DataTable, type Column } from '@/components/ui/data-table';
import { apiFetch } from '@/lib/api.client';
import { ApiClientError } from '@/lib/api';
import { EmptyState } from '@/components/empty-state';
import { Boxes } from 'lucide-react';
import { CreateSourceDialog } from './create-source-dialog';

export function SourcesView() {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin', 'sources'],
    queryFn: () => apiFetch<PaginatedResponse<SourceResponse>>('/admin/sources?pageSize=100'),
  });

  const toggleMu = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      apiFetch<SourceResponse>(`/admin/sources/${id}`, {
        method: 'PATCH',
        body: { status: active ? 'ACTIVE' : 'INACTIVE' },
      }),
    onSuccess: (s) => {
      toast.success(s.status === 'ACTIVE' ? 'Source activated' : 'Source deactivated');
      qc.invalidateQueries({ queryKey: ['admin', 'sources'] });
    },
    onError: (err) => toast.error(err instanceof ApiClientError ? err.message : 'Failed'),
  });

  const columns: Column<SourceResponse>[] = [
    {
      key: 'name',
      header: 'Name',
      className: 'font-medium',
      cell: (s) => (
        <Link href={`/admin/sources/${s.id}`} className="hover:underline">
          {s.name}
        </Link>
      ),
    },
    { key: 'code', header: 'Code', className: 'font-mono text-xs', cell: (s) => s.code },
    {
      key: 'status',
      header: 'Status',
      cell: (s) => (
        <div className="flex items-center gap-3">
          <Switch
            aria-label={`Source ${s.name} active`}
            checked={s.status === 'ACTIVE'}
            disabled={toggleMu.isPending}
            onCheckedChange={(active) => toggleMu.mutate({ id: s.id, active })}
          />
          <Badge variant={s.status === 'ACTIVE' ? 'success' : 'secondary'}>{s.status}</Badge>
        </div>
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
        <div className="flex items-center justify-end gap-1">
          <Button asChild variant="ghost" size="sm">
            <Link href={`/admin/sources/${s.id}`}>View</Link>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link href={`/admin/sources/${s.id}/api-keys`}>API keys</Link>
          </Button>
        </div>
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
