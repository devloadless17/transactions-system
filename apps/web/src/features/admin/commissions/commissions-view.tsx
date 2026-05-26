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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Commission Rules</h1>
          <p className="text-sm text-muted-foreground">
            Rules are matched by specificity (company+source &gt; company &gt; source &gt; global),
            then by priority. First match wins.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>New rule</Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Scope</TableHead>
                <TableHead>Range</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Value</TableHead>
                <TableHead>Priority</TableHead>
                <TableHead>Active</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rulesQ.isLoading && (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {rulesQ.error && (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-destructive">
                    {rulesQ.error instanceof ApiClientError
                      ? rulesQ.error.message
                      : 'Failed to load'}
                  </TableCell>
                </TableRow>
              )}
              {rulesQ.data?.data.map((r) => (
                <TableRow key={r.id}>
                  <TableCell>
                    <div className="space-y-1">
                      <div className="text-sm">
                        company:{' '}
                        {r.companyId ? (
                          <span className="font-medium">
                            {companyNameById.get(r.companyId) ?? r.companyId}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">global</span>
                        )}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        source:{' '}
                        {r.sourceId ? (sourceCodeById.get(r.sourceId) ?? r.sourceId) : 'global'}
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {trimDecimal(r.minAmount)} – {trimDecimal(r.maxAmount)}
                  </TableCell>
                  <TableCell>{r.commissionType}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {r.commissionType === 'PERCENTAGE'
                      ? `${trimDecimal(r.commissionValue)}%`
                      : trimDecimal(r.commissionValue)}
                  </TableCell>
                  <TableCell>{r.priority}</TableCell>
                  <TableCell>
                    <Badge variant={r.active ? 'success' : 'secondary'}>
                      {r.active ? 'on' : 'off'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
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
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
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
