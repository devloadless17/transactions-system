'use client';
import { useEffect, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@/lib/toast';
import Link from 'next/link';
import type { PaginatedResponse, SourceResponse } from '@app/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import { DataTable, type Column } from '@/components/ui/data-table';
import { Pagination } from '@/components/ui/pagination';
import { apiFetch } from '@/lib/api.client';
import { ApiClientError } from '@/lib/api';
import { EmptyState } from '@/components/empty-state';
import { Boxes } from 'lucide-react';
import { CreateSourceDialog } from './create-source-dialog';

const PAGE_SIZE = 20;

export function SourcesView() {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [page, setPage] = useState(1);
  // Page-scoped key: the optimistic toggle below mutates exactly the page in view.
  const listKey = ['admin', 'sources', page] as const;
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: listKey,
    queryFn: () =>
      apiFetch<PaginatedResponse<SourceResponse>>(
        `/admin/sources?page=${page}&pageSize=${PAGE_SIZE}`,
      ),
    placeholderData: keepPreviousData,
  });

  // Clamp back if the result set shrinks below the current page.
  useEffect(() => {
    const tp = data?.meta.totalPages;
    if (tp && page > tp) setPage(tp);
  }, [data, page]);

  const toggleMu = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      apiFetch<SourceResponse>(`/admin/sources/${id}`, {
        method: 'PATCH',
        body: { status: active ? 'ACTIVE' : 'INACTIVE' },
      }),
    // Optimistic: flip the switch in cache immediately so the toggle feels instant,
    // then reconcile (or roll back) once the server responds. The toggled row is on
    // the page in view, so we update just that page's cache entry.
    onMutate: async ({ id, active }) => {
      await qc.cancelQueries({ queryKey: ['admin', 'sources'] });
      const prev = qc.getQueryData<PaginatedResponse<SourceResponse>>(listKey);
      if (prev) {
        qc.setQueryData<PaginatedResponse<SourceResponse>>(listKey, {
          ...prev,
          data: prev.data.map((s) =>
            s.id === id ? { ...s, status: active ? 'ACTIVE' : 'INACTIVE' } : s,
          ),
        });
      }
      return { prev };
    },
    onError: (err, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(listKey, ctx.prev);
      toast.error(err instanceof ApiClientError ? err.message : 'Failed');
    },
    onSuccess: (s) => {
      toast.success(s.status === 'ACTIVE' ? 'Source activated' : 'Source deactivated');
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'sources'] });
    },
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
            // Guard only THIS row's in-flight toggle, not the whole column.
            disabled={toggleMu.isPending && toggleMu.variables?.id === s.id}
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

      {data && (
        <Pagination
          page={data.meta.page}
          total={data.meta.total}
          totalPages={data.meta.totalPages}
          onPageChange={setPage}
        />
      )}

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
