'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from '@/lib/toast';
import {
  COMPANY_ROLE_VALUES,
  inviteTeamMemberSchema,
  UserRole,
  UserStatus,
  type InviteTeamMemberInput,
  type InviteTeamMemberResponse,
  type TeamMemberResponse,
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

const prettyRole = (r: string) => r.replace('COMPANY_', '');

export function CompanyUsersCard({ companyId }: { companyId: string }) {
  const qc = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState<TeamMemberResponse | null>(null);
  const queryKey = ['admin', 'company', companyId, 'users'] as const;

  const listQ = useQuery({
    queryKey,
    queryFn: () => apiFetch<{ data: TeamMemberResponse[] }>(`/admin/companies/${companyId}/users`),
  });

  const updateMu = useMutation({
    mutationFn: (args: { id: string; role?: UserRole; status?: UserStatus }) =>
      apiFetch<TeamMemberResponse>(`/admin/companies/${companyId}/users/${args.id}`, {
        method: 'PATCH',
        body: { role: args.role, status: args.status },
      }),
    onSuccess: () => {
      toast.success('Updated');
      qc.invalidateQueries({ queryKey });
    },
    onError: (err) => toast.error(err instanceof ApiClientError ? err.message : 'Failed'),
  });

  const columns: Column<TeamMemberResponse>[] = [
    { key: 'email', header: 'Email', className: 'font-medium', cell: (m) => m.email },
    {
      key: 'role',
      header: 'Role',
      cell: (m) => (
        <select
          value={m.role}
          onChange={(e) => updateMu.mutate({ id: m.id, role: e.target.value as UserRole })}
          className="h-8 rounded-md border border-input bg-background px-2 text-sm"
        >
          {COMPANY_ROLE_VALUES.map((r) => (
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
      cell: (m) => (
        <Badge variant={m.status === 'ACTIVE' ? 'success' : 'destructive'}>{m.status}</Badge>
      ),
    },
    {
      key: 'lastLogin',
      header: 'Last login',
      className: 'text-xs text-muted-foreground',
      cell: (m) => (m.lastLoginAt ? new Date(m.lastLoginAt).toLocaleString() : 'never'),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (m) => (
        <div className="flex items-center justify-end gap-1">
          <Button variant="ghost" size="sm" onClick={() => setResetTarget(m)}>
            Reset password
          </Button>
          {m.status === 'ACTIVE' ? (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => updateMu.mutate({ id: m.id, status: UserStatus.DISABLED })}
            >
              Disable
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => updateMu.mutate({ id: m.id, status: UserStatus.ACTIVE })}
            >
              Reactivate
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>Users</CardTitle>
            <CardDescription>
              Members of this company. New users get a one-time temporary password.
            </CardDescription>
          </div>
          <Button className="w-full sm:w-auto" size="sm" onClick={() => setAddOpen(true)}>
            Add user
          </Button>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <DataTable<TeamMemberResponse>
          columns={columns}
          rows={listQ.data?.data}
          isLoading={listQ.isLoading}
          rowKey={(m) => m.id}
          pageSize={10}
          empty={<div className="py-6 text-center text-muted-foreground">No users yet.</div>}
        />
      </CardContent>

      <AddUserDialog
        companyId={companyId}
        open={addOpen}
        onOpenChange={setAddOpen}
        onAdded={() => qc.invalidateQueries({ queryKey })}
      />

      <ResetPasswordDialog
        companyId={companyId}
        target={resetTarget}
        onClose={() => setResetTarget(null)}
      />
    </Card>
  );
}

function ResetPasswordDialog({
  companyId,
  target,
  onClose,
}: {
  companyId: string;
  target: TeamMemberResponse | null;
  onClose: () => void;
}) {
  const [result, setResult] = useState<InviteTeamMemberResponse | null>(null);

  const mu = useMutation({
    mutationFn: () =>
      apiFetch<InviteTeamMemberResponse>(
        `/admin/companies/${companyId}/users/${target!.id}/reset-password`,
        { method: 'POST' },
      ),
    onSuccess: (res) => setResult(res),
    onError: (err) => toast.error(err instanceof ApiClientError ? err.message : 'Failed'),
  });

  function handleOpenChange(v: boolean) {
    if (!v) {
      setResult(null);
      onClose();
    }
  }

  return (
    <Dialog open={!!target} onOpenChange={handleOpenChange}>
      <DialogContent>
        {result ? (
          <>
            <DialogHeader>
              <DialogTitle>Temporary password</DialogTitle>
              <DialogDescription>
                Share this one-time password with {result.member.email}. It is shown only once and
                must be changed on their next login.
              </DialogDescription>
            </DialogHeader>
            <div className="rounded-md border bg-muted/30 p-3 font-mono text-xs break-all">
              {result.temporaryPassword}
            </div>
            <DialogFooter>
              <Button
                onClick={() => {
                  navigator.clipboard?.writeText(result.temporaryPassword);
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
              <DialogTitle>Reset password?</DialogTitle>
              <DialogDescription>
                {target?.email} will get a new one-time temporary password and be signed out of all
                sessions. They must set a new password on their next login.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                Cancel
              </Button>
              <Button onClick={() => mu.mutate()} disabled={mu.isPending}>
                {mu.isPending ? 'Resetting…' : 'Reset password'}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function AddUserDialog({
  companyId,
  open,
  onOpenChange,
  onAdded,
}: {
  companyId: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onAdded: () => void;
}) {
  const [created, setCreated] = useState<InviteTeamMemberResponse | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors },
  } = useForm<InviteTeamMemberInput>({
    resolver: zodResolver(inviteTeamMemberSchema),
    defaultValues: { email: '', role: UserRole.COMPANY_MANAGER },
  });
  const role = watch('role');

  const mu = useMutation({
    mutationFn: (input: InviteTeamMemberInput) =>
      apiFetch<InviteTeamMemberResponse>(`/admin/companies/${companyId}/users`, {
        method: 'POST',
        body: input,
      }),
    onSuccess: (res) => {
      reset();
      setCreated(res);
      onAdded();
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
              <DialogTitle>User created</DialogTitle>
              <DialogDescription>
                Share the temporary password with {created.member.email}. It is shown only once and
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
              <DialogTitle>Add a user</DialogTitle>
              <DialogDescription>
                A temporary password is generated and shown once. Share it with the new user.
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
                  {COMPANY_ROLE_VALUES.map((r) => (
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
                  {mu.isPending ? 'Adding…' : 'Add user'}
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
