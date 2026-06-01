'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type {
  CommissionRuleResponse,
  CompanyResponse,
  PaginatedResponse,
  SourceResponse,
} from '@app/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { DataTable, type Column } from '@/components/ui/data-table';
import { apiFetch } from '@/lib/api.client';
import { ApiClientError } from '@/lib/api';
import { CreateCommissionRuleDialog } from './create-commission-rule-dialog';
import { EditCommissionRuleDialog } from './edit-commission-rule-dialog';

export function CommissionsView() {
  const qc = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<CommissionRuleResponse | null>(null);

  const deactivateMu = useMutation({
    mutationFn: (id: string) =>
      apiFetch<CommissionRuleResponse>(`/admin/commission-rules/${id}/deactivate`, {
        method: 'POST',
      }),
    onSuccess: () => {
      toast.success('Rule deactivated');
      qc.invalidateQueries({ queryKey: ['admin', 'commission-rules'] });
    },
    onError: (err) => toast.error(err instanceof ApiClientError ? err.message : 'Failed'),
  });

  const reactivateMu = useMutation({
    mutationFn: (id: string) =>
      apiFetch<CommissionRuleResponse>(`/admin/commission-rules/${id}`, {
        method: 'PATCH',
        body: { active: true },
      }),
    onSuccess: () => {
      toast.success('Rule reactivated');
      qc.invalidateQueries({ queryKey: ['admin', 'commission-rules'] });
    },
    onError: (err) => toast.error(err instanceof ApiClientError ? err.message : 'Failed'),
  });

  const rulesQ = useQuery({
    queryKey: ['admin', 'commission-rules'],
    queryFn: () =>
      apiFetch<PaginatedResponse<CommissionRuleResponse>>('/admin/commission-rules?pageSize=100'),
  });
  const sourcesQ = useQuery({
    queryKey: ['admin', 'sources', 'all'],
    queryFn: () => apiFetch<{ data: SourceResponse[] }>('/admin/sources/all'),
  });
  const companiesQ = useQuery({
    queryKey: ['admin', 'companies', 'all'],
    queryFn: () => apiFetch<PaginatedResponse<CompanyResponse>>('/admin/companies?pageSize=100'),
  });

  const companyNameById = new Map(companiesQ.data?.data.map((c) => [c.id, c.name]) ?? []);
  const sourceCodeById = new Map(sourcesQ.data?.data.map((s) => [s.id, s.code]) ?? []);

  const columns: Column<CommissionRuleResponse>[] = [
    {
      key: 'scope',
      header: 'Scope',
      cell: (r) => (
        <div className="space-y-1">
          <div className="text-sm">
            company:{' '}
            {r.companyId ? (
              <span className="font-medium">{companyNameById.get(r.companyId) ?? r.companyId}</span>
            ) : (
              <span className="text-muted-foreground">global</span>
            )}
          </div>
          <div className="text-xs text-muted-foreground">
            source: {r.sourceId ? (sourceCodeById.get(r.sourceId) ?? r.sourceId) : 'global'}
          </div>
        </div>
      ),
    },
    {
      key: 'operation',
      header: 'Operation',
      cell: (r) => (
        <div className="space-y-0.5">
          <div className="text-sm">
            {r.operationType.charAt(0) + r.operationType.slice(1).toLowerCase()}
          </div>
          {r.operationType !== 'TRANSACTION' && (
            <div className="text-xs text-muted-foreground">
              {r.feeApplication === 'ON_TOP' ? 'on top' : 'deducted'}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'range',
      header: 'Range',
      className: 'font-mono text-xs',
      cell: (r) => `${trimDecimal(r.minAmount)} – ${trimDecimal(r.maxAmount)}`,
    },
    { key: 'type', header: 'Type', cell: (r) => r.commissionType },
    {
      key: 'value',
      header: 'Value',
      className: 'font-mono text-xs',
      cell: (r) =>
        r.commissionType === 'PERCENTAGE'
          ? `${trimDecimal(r.commissionValue)}%`
          : trimDecimal(r.commissionValue),
    },
    { key: 'priority', header: 'Priority', cell: (r) => r.priority },
    {
      key: 'active',
      header: 'Active',
      cell: (r) => (
        <Badge variant={r.active ? 'success' : 'secondary'}>{r.active ? 'on' : 'off'}</Badge>
      ),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (r) => (
        <div className="flex justify-end gap-1">
          <Button variant="ghost" size="sm" onClick={() => setEditing(r)}>
            Edit
          </Button>
          {r.active ? (
            <Button
              variant="ghost"
              size="sm"
              disabled={deactivateMu.isPending}
              onClick={() => deactivateMu.mutate(r.id)}
            >
              Disable
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              disabled={reactivateMu.isPending}
              onClick={() => reactivateMu.mutate(r.id)}
            >
              Reactivate
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Commission Rules</h1>
          <p className="text-sm text-muted-foreground">
            Rules are matched by specificity (company+source &gt; company &gt; source &gt; global),
            then by priority. First match wins.
          </p>
        </div>
        <Button className="w-full sm:w-auto" onClick={() => setCreateOpen(true)}>
          New rule
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <DataTable<CommissionRuleResponse>
            columns={columns}
            rows={rulesQ.data?.data}
            isLoading={rulesQ.isLoading}
            error={rulesQ.error}
            rowKey={(r) => r.id}
          />
        </CardContent>
      </Card>

      <CreateCommissionRuleDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        sources={sourcesQ.data?.data ?? []}
        companies={companiesQ.data?.data ?? []}
        onCreated={() => {
          setCreateOpen(false);
          void rulesQ.refetch();
        }}
      />

      <EditCommissionRuleDialog
        rule={editing}
        onClose={() => setEditing(null)}
        onSaved={() => {
          setEditing(null);
          void rulesQ.refetch();
        }}
      />
    </div>
  );
}

function trimDecimal(s: string): string {
  if (!s.includes('.')) return s;
  return s.replace(/\.?0+$/, '');
}
