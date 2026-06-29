'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from '@/lib/toast';
import {
  createApiKeySchema,
  type ApiKeyResponse,
  type CreateApiKeyInput,
  type CreateApiKeyResponse,
} from '@app/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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

export function ApiKeysCard() {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);

  const listQ = useQuery({
    queryKey: ['company', 'api-keys'],
    queryFn: () => apiFetch<{ data: ApiKeyResponse[] }>('/company/api-keys'),
  });

  const revokeMu = useMutation({
    mutationFn: (id: string) =>
      apiFetch<ApiKeyResponse>(`/company/api-keys/${id}/revoke`, { method: 'POST' }),
    onSuccess: () => {
      toast.success('Key revoked');
      qc.invalidateQueries({ queryKey: ['company', 'api-keys'] });
    },
    onError: (err) => toast.error(err instanceof ApiClientError ? err.message : 'Failed'),
  });

  const columns: Column<ApiKeyResponse>[] = [
    { key: 'name', header: 'Name', className: 'font-medium', cell: (k) => k.name },
    {
      key: 'prefix',
      header: 'Prefix',
      className: 'font-mono text-xs break-all',
      cell: (k) => `tsk_${k.keyPrefix}…`,
    },
    {
      key: 'lastUsed',
      header: 'Last used',
      className: 'text-xs text-muted-foreground',
      cell: (k) => (k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : 'never'),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (k) => (
        <Badge variant={k.revokedAt ? 'destructive' : 'success'}>
          {k.revokedAt ? 'REVOKED' : 'ACTIVE'}
        </Badge>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (k) =>
        !k.revokedAt ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={revokeMu.isPending}
            onClick={() => {
              if (confirm(`Revoke key "${k.name}"? Any CRM using it will stop working.`)) {
                revokeMu.mutate(k.id);
              }
            }}
          >
            Revoke
          </Button>
        ) : null,
    },
  ];

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>API keys</CardTitle>
            <CardDescription>
              Server-to-server keys for your CRM to generate Whish payment links. The secret is
              shown once at creation.
            </CardDescription>
          </div>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            Create key
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <DataTable<ApiKeyResponse>
          columns={columns}
          rows={listQ.data?.data}
          isLoading={listQ.isLoading}
          error={listQ.error}
          rowKey={(k) => k.id}
          pageSize={10}
          empty={<div className="py-6 text-center text-muted-foreground">No keys yet.</div>}
        />
      </CardContent>

      <CreateKeyDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => qc.invalidateQueries({ queryKey: ['company', 'api-keys'] })}
      />
    </Card>
  );
}

function CreateKeyDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
}) {
  const [created, setCreated] = useState<CreateApiKeyResponse | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CreateApiKeyInput>({
    resolver: zodResolver(createApiKeySchema),
    defaultValues: { name: '' },
  });

  const mu = useMutation({
    mutationFn: (input: CreateApiKeyInput) =>
      apiFetch<CreateApiKeyResponse>('/company/api-keys', { method: 'POST', body: input }),
    onSuccess: (res) => {
      reset();
      setCreated(res);
      onCreated();
    },
    onError: (err) => toast.error(err instanceof ApiClientError ? err.message : 'Failed'),
  });

  function handleOpenChange(v: boolean) {
    onOpenChange(v);
    if (!v) {
      setCreated(null);
      reset();
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Key created</DialogTitle>
              <DialogDescription>
                Copy it now — the secret is shown only once. Store it in your CRM as a secret.
              </DialogDescription>
            </DialogHeader>
            <div className="rounded-md border bg-muted/30 p-3 font-mono text-xs break-all">
              {created.plaintext}
            </div>
            <DialogFooter>
              <Button
                onClick={() => {
                  navigator.clipboard?.writeText(created.plaintext);
                  toast.success('Copied');
                }}
              >
                Copy key
              </Button>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Create API key</DialogTitle>
              <DialogDescription>Name it after the system that will use it.</DialogDescription>
            </DialogHeader>
            <form onSubmit={handleSubmit((values) => mu.mutate(values))} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input id="name" placeholder="CRM integration" {...register('name')} />
                {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={mu.isPending}>
                  {mu.isPending ? 'Creating…' : 'Create'}
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
