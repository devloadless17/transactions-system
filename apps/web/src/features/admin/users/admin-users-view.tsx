'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from '@/lib/toast';
import { ShieldCheck } from 'lucide-react';
import {
  ADMIN_ROLE_VALUES,
  createAdminUserSchema,
  UserRole,
  UserStatus,
  type AdminUserResponse,
  type CreateAdminUserInput,
  type CreateAdminUserResponse,
  type PaginatedResponse,
} from '@app/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { DataTable, type Column } from '@/components/ui/data-table';
import { Pagination } from '@/components/ui/pagination';
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
import { EmptyState } from '@/components/empty-state';
import { apiFetch } from '@/lib/api.client';
import { ApiClientError } from '@/lib/api';

const PAGE_SIZE = 20;
const prettyRole = (r: string) => r.replace('_', ' ');

export function AdminUsersView() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const queryKey = ['admin', 'users', { page }] as const;

  const listQ = useQuery({
    queryKey,
    queryFn: () =>
      apiFetch<PaginatedResponse<AdminUserResponse>>(
        `/admin/users?page=${page}&pageSize=${PAGE_SIZE}`,
      ),
  });

  const updateMu = useMutation({
    mutationFn: (args: { id: string; role?: UserRole; status?: UserStatus }) =>
      apiFetch<AdminUserResponse>(`/admin/users/${args.id}`, {
        method: 'PATCH',
        body: { role: args.role, status: args.status },
      }),
    onSuccess: () => {
      toast.success('Updated');
      qc.invalidateQueries({ queryKey: ['admin', 'users'] });
    },
    onError: (err) => toast.error(err instanceof ApiClientError ? err.message : 'Failed'),
  });

  const data = listQ.data;

  const columns: Column<AdminUserResponse>[] = [
    { key: 'email', header: 'Email', className: 'font-medium', cell: (u) => u.email },
    {
      key: 'role',
      header: 'Role',
      cell: (u) => (
        <select
          value={u.role}
          onChange={(e) => updateMu.mutate({ id: u.id, role: e.target.value as UserRole })}
          className="h-8 rounded-md border border-input bg-background px-2 text-sm"
        >
          {ADMIN_ROLE_VALUES.map((r) => (
            <option key={r} value={r}>
              {prettyRole(r)}
            </option>
          ))}
        </select>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (u) => (
        <Badge variant={u.status === 'ACTIVE' ? 'success' : 'destructive'}>{u.status}</Badge>
      ),
    },
    {
      key: 'lastLogin',
      header: 'Last login',
      className: 'text-xs text-muted-foreground',
      cell: (u) => (u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString() : 'never'),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (u) => {
        // The super admin is the system owner and can never be disabled, so
        // there's no disable/reactivate action for it.
        if (u.role === UserRole.SUPER_ADMIN) return null;
        return u.status === 'ACTIVE' ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => updateMu.mutate({ id: u.id, status: UserStatus.DISABLED })}
          >
            Disable
          </Button>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => updateMu.mutate({ id: u.id, status: UserStatus.ACTIVE })}
          >
            Reactivate
          </Button>
        );
      },
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Platform admins</h1>
          <p className="text-sm text-muted-foreground">
            Super admins and operators. New admins get a one-time temporary password and must change
            it on first login.
          </p>
        </div>
        <Button className="w-full sm:w-auto" onClick={() => setCreateOpen(true)}>
          New admin
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <DataTable<AdminUserResponse>
            columns={columns}
            rows={data?.data}
            isLoading={listQ.isLoading}
            error={listQ.error}
            rowKey={(u) => u.id}
            empty={
              <EmptyState
                icon={ShieldCheck}
                title="No platform admins"
                description="Create an operator or super admin to manage the platform."
                action={{ label: 'New admin', onClick: () => setCreateOpen(true) }}
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

      <CreateAdminDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => qc.invalidateQueries({ queryKey: ['admin', 'users'] })}
      />
    </div>
  );
}

function CreateAdminDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
}) {
  const [created, setCreated] = useState<CreateAdminUserResponse | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors },
  } = useForm<CreateAdminUserInput>({
    resolver: zodResolver(createAdminUserSchema),
    defaultValues: { email: '', role: UserRole.ADMIN_OPERATOR },
  });
  const role = watch('role');

  const mu = useMutation({
    mutationFn: (input: CreateAdminUserInput) =>
      apiFetch<CreateAdminUserResponse>('/admin/users', { method: 'POST', body: input }),
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
              <DialogTitle>Admin created</DialogTitle>
              <DialogDescription>
                Share the temporary password with {created.user.email}. It is shown only once and
                must be changed on first login.
              </DialogDescription>
            </DialogHeader>
            <div className="rounded-md border bg-muted/30 p-3 font-mono text-xs break-all">
              {created.temporaryPassword}
            </div>
            <DialogFooter>
              <Button
                onClick={() => {
                  navigator.clipboard?.writeText(created.temporaryPassword);
                  toast.success('Copied');
                }}
              >
                Copy
              </Button>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Create platform admin</DialogTitle>
              <DialogDescription>
                A temporary password is generated and shown once. Share it with the new admin.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={handleSubmit((values) => mu.mutate(values))} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">Email</Label>
                <Input id="email" type="email" {...register('email')} />
                {errors.email && <p className="text-sm text-destructive">{errors.email.message}</p>}
              </div>
              <div className="space-y-2">
                <Label>Role</Label>
                <div className="flex flex-wrap gap-2">
                  {ADMIN_ROLE_VALUES.map((r) => (
                    <Button
                      key={r}
                      type="button"
                      variant={r === role ? 'default' : 'outline'}
                      size="sm"
                      onClick={() => setValue('role', r, { shouldValidate: true })}
                    >
                      {prettyRole(r)}
                    </Button>
                  ))}
                </div>
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
