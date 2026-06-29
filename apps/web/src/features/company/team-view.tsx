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

export function TeamView() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [created, setCreated] = useState<InviteTeamMemberResponse | null>(null);

  const listQ = useQuery({
    queryKey: ['company', 'team'],
    queryFn: () => apiFetch<{ data: TeamMemberResponse[] }>('/company/team'),
  });

  const updateMu = useMutation({
    mutationFn: (args: { id: string; role?: UserRole; status?: UserStatus }) =>
      apiFetch<TeamMemberResponse>(`/company/team/${args.id}`, {
        method: 'PATCH',
        body: { role: args.role, status: args.status },
      }),
    onSuccess: () => {
      toast.success('Updated');
      qc.invalidateQueries({ queryKey: ['company', 'team'] });
    },
    onError: (err) => toast.error(err instanceof ApiClientError ? err.message : 'Failed'),
  });

  const columns: Column<TeamMemberResponse>[] = [
    { key: 'email', header: 'Email', className: 'break-all', cell: (m) => m.email },
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
              {r}
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
      cell: (m) =>
        m.status === 'ACTIVE' ? (
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
        ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Team</h1>
          <p className="text-sm text-muted-foreground">
            Invite teammates and manage roles. Only owners can invite or modify roles.
          </p>
        </div>
        <Button
          onClick={() => {
            setCreated(null);
            setOpen(true);
          }}
        >
          Invite member
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <DataTable<TeamMemberResponse>
            columns={columns}
            rows={listQ.data?.data}
            isLoading={listQ.isLoading}
            error={listQ.error}
            rowKey={(m) => m.id}
            pageSize={10}
          />
        </CardContent>
      </Card>

      <InviteDialog
        open={open}
        onOpenChange={(v) => {
          setOpen(v);
          if (!v) setCreated(null);
        }}
        created={created}
        onInvited={(res) => {
          setCreated(res);
          qc.invalidateQueries({ queryKey: ['company', 'team'] });
        }}
      />
    </div>
  );
}

function InviteDialog({
  open,
  onOpenChange,
  created,
  onInvited,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  created: InviteTeamMemberResponse | null;
  onInvited: (res: InviteTeamMemberResponse) => void;
}) {
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
      apiFetch<InviteTeamMemberResponse>('/company/team', { method: 'POST', body: input }),
    onSuccess: (res) => {
      reset();
      onInvited(res);
    },
    onError: (err) => toast.error(err instanceof ApiClientError ? err.message : 'Failed'),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Invite sent</DialogTitle>
              <DialogDescription>
                Share the temporary password with {created.member.email}. They will be required to
                change it on first login.
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
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Invite a team member</DialogTitle>
              <DialogDescription>
                A temporary password is generated and shown once. Share it with the invitee.
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
                      {r.replace('COMPANY_', '')}
                    </Button>
                  ))}
                </div>
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={mu.isPending}>
                  {mu.isPending ? 'Inviting…' : 'Invite'}
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
