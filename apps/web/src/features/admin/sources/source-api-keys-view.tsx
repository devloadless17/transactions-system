'use client';
import { useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import {
  createApiKeySchema,
  type ApiKeyResponse,
  type CreateApiKeyInput,
  type CreateApiKeyResponse,
  type SourceResponse,
} from '@app/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { DataTable, type Column } from '@/components/ui/data-table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiFetch } from '@/lib/api.client';
import { ApiClientError } from '@/lib/api';
import { ChevronLeft } from 'lucide-react';

export function SourceApiKeysView({ sourceId }: { sourceId: string }) {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [createdKey, setCreatedKey] = useState<CreateApiKeyResponse | null>(null);

  const sourceQ = useQuery({
    queryKey: ['admin', 'source', sourceId],
    queryFn: () => apiFetch<SourceResponse>(`/admin/sources/${sourceId}`),
  });

  const listQ = useQuery({
    queryKey: ['admin', 'sources', sourceId, 'api-keys'],
    queryFn: () => apiFetch<{ data: ApiKeyResponse[] }>(`/admin/sources/${sourceId}/api-keys`),
  });

  const revokeMu = useMutation({
    mutationFn: (id: string) =>
      apiFetch<ApiKeyResponse>(`/admin/sources/${sourceId}/api-keys/${id}/revoke`, {
        method: 'POST',
      }),
    onSuccess: () => {
      toast.success('Key revoked');
      qc.invalidateQueries({ queryKey: ['admin', 'sources', sourceId, 'api-keys'] });
    },
    onError: (err) => toast.error(err instanceof ApiClientError ? err.message : 'Failed to revoke'),
  });

  const columns: Column<ApiKeyResponse>[] = [
    { key: 'name', header: 'Name', className: 'font-medium', cell: (k) => k.name },
    {
      key: 'prefix',
      header: 'Prefix',
      className: 'font-mono text-xs',
      cell: (k) => `tsk_${k.keyPrefix}_…`,
    },
    {
      key: 'lastUsed',
      header: 'Last used',
      className: 'text-xs text-muted-foreground',
      cell: (k) => (k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : '—'),
    },
    {
      key: 'created',
      header: 'Created',
      className: 'text-xs text-muted-foreground',
      cell: (k) => new Date(k.createdAt).toLocaleString(),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (k) =>
        k.revokedAt ? (
          <Badge variant="destructive">revoked</Badge>
        ) : (
          <Badge variant="success">active</Badge>
        ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (k) =>
        !k.revokedAt && (
          <Button
            variant="ghost"
            size="sm"
            disabled={revokeMu.isPending}
            onClick={() => revokeMu.mutate(k.id)}
          >
            Revoke
          </Button>
        ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <Link
            href="/admin/sources"
            className="inline-flex items-center text-xs text-muted-foreground hover:text-foreground"
          >
            <ChevronLeft className="h-3 w-3" /> All sources
          </Link>
          <h1 className="text-2xl font-semibold">
            API keys
            {sourceQ.data ? (
              <span className="ml-2 text-base font-normal text-muted-foreground">
                · {sourceQ.data.name}{' '}
                <span className="font-mono text-xs">({sourceQ.data.code})</span>
              </span>
            ) : null}
          </h1>
          <p className="text-sm text-muted-foreground">
            Keys held by this source. The provider sends them on{' '}
            <code className="text-xs">POST /v1/ingest/transactions</code> with a{' '}
            <code className="text-xs">companyId</code> in the body.
          </p>
        </div>
        <Button className="w-full sm:w-auto" onClick={() => setCreateOpen(true)}>
          New key
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <DataTable<ApiKeyResponse>
            columns={columns}
            rows={listQ.data?.data}
            isLoading={listQ.isLoading}
            rowKey={(k) => k.id}
            empty={
              <div className="py-8 text-center text-muted-foreground">
                No keys yet for this source.
              </div>
            }
          />
        </CardContent>
      </Card>

      <CreateSourceApiKeyDialog
        sourceId={sourceId}
        open={createOpen}
        onOpenChange={(v) => {
          setCreateOpen(v);
          if (!v) setCreatedKey(null);
        }}
        createdKey={createdKey}
        onCreated={(k) => {
          setCreatedKey(k);
          qc.invalidateQueries({ queryKey: ['admin', 'sources', sourceId, 'api-keys'] });
        }}
      />
    </div>
  );
}

function CreateSourceApiKeyDialog({
  sourceId,
  open,
  onOpenChange,
  createdKey,
  onCreated,
}: {
  sourceId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  createdKey: CreateApiKeyResponse | null;
  onCreated: (k: CreateApiKeyResponse) => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CreateApiKeyInput>({
    resolver: zodResolver(createApiKeySchema),
    defaultValues: { name: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setSubmitting(true);
    try {
      const res = await apiFetch<CreateApiKeyResponse>(`/admin/sources/${sourceId}/api-keys`, {
        method: 'POST',
        body: values,
      });
      onCreated(res);
      reset();
    } catch (err) {
      toast.error(err instanceof ApiClientError ? err.message : 'Failed to create');
    } finally {
      setSubmitting(false);
    }
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {createdKey ? (
          <>
            <DialogHeader>
              <DialogTitle>Key created</DialogTitle>
              <DialogDescription>
                Copy this now — it will not be shown again. Hand it to the source provider so they
                can authenticate ingest requests.
              </DialogDescription>
            </DialogHeader>
            <div className="rounded-md border bg-muted/30 p-3 font-mono text-xs break-all">
              {createdKey.plaintext}
            </div>
            <DialogFooter>
              <Button
                onClick={() => {
                  navigator.clipboard?.writeText(createdKey.plaintext);
                  toast.success('Copied');
                }}
              >
                Copy
              </Button>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>New source API key</DialogTitle>
              <DialogDescription>
                Give it a memorable name (e.g. "prod", "staging").
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input id="name" {...register('name')} />
                {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={submitting}>
                  {submitting ? 'Creating…' : 'Create'}
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
