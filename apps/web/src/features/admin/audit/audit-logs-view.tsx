'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AuditLogResponse, CompanyResponse, PaginatedResponse } from '@app/shared';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { DataTable, type Column } from '@/components/ui/data-table';
import { Pagination } from '@/components/ui/pagination';
import { apiFetch } from '@/lib/api.client';

const PAGE_SIZE = 50;

export function AuditLogsView() {
  const [page, setPage] = useState(1);
  const [entityType, setEntityType] = useState('');
  const [action, setAction] = useState('');
  const [companyId, setCompanyId] = useState('');

  const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
  if (entityType) params.set('entityType', entityType);
  if (action) params.set('action', action);
  if (companyId) params.set('companyId', companyId);

  const listQ = useQuery({
    queryKey: ['admin', 'audit-logs', params.toString()],
    queryFn: () =>
      apiFetch<PaginatedResponse<AuditLogResponse>>(`/admin/audit-logs?${params.toString()}`),
  });

  const companiesQ = useQuery({
    queryKey: ['admin', 'companies', 'all'],
    queryFn: () => apiFetch<PaginatedResponse<CompanyResponse>>('/admin/companies?pageSize=100'),
  });
  const companyName = (id: string | null) =>
    !id ? '—' : (companiesQ.data?.data.find((c) => c.id === id)?.name ?? id.slice(0, 8));

  const columns: Column<AuditLogResponse>[] = [
    {
      key: 'when',
      header: 'When',
      className: 'text-xs text-muted-foreground',
      cell: (a) => new Date(a.createdAt).toLocaleString(),
    },
    { key: 'actor', header: 'Actor', cell: (a) => a.actorEmail ?? '—' },
    { key: 'company', header: 'Company', cell: (a) => companyName(a.companyId) },
    {
      key: 'action',
      header: 'Action',
      className: 'font-mono text-xs',
      cell: (a) => a.action,
    },
    {
      key: 'entity',
      header: 'Entity',
      className: 'font-mono text-xs',
      cell: (a) => (
        <>
          {a.entityType}
          {a.entityId ? `:${a.entityId.slice(0, 8)}` : ''}
        </>
      ),
    },
    {
      key: 'ip',
      header: 'IP',
      className: 'text-xs text-muted-foreground',
      cell: (a) => a.ipAddress ?? '—',
    },
  ];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Audit Logs</h1>
        <p className="text-sm text-muted-foreground">Immutable record of mutating operations.</p>
      </div>

      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="space-y-1">
              <Label className="text-xs">Entity type</Label>
              <Input
                placeholder="company"
                value={entityType}
                onChange={(e) => setEntityType(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Action</Label>
              <Input
                placeholder="company.created"
                value={action}
                onChange={(e) => setAction(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Company</Label>
              <select
                value={companyId}
                onChange={(e) => setCompanyId(e.target.value)}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">All</option>
                {companiesQ.data?.data.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <DataTable<AuditLogResponse>
            columns={columns}
            rows={listQ.data?.data}
            isLoading={listQ.isLoading}
            error={listQ.error}
            rowKey={(a) => a.id}
            empty={<div className="py-8 text-center text-muted-foreground">No audit logs yet.</div>}
          />
        </CardContent>
      </Card>

      {listQ.data && (
        <Pagination
          page={listQ.data.meta.page}
          total={listQ.data.meta.total}
          totalPages={listQ.data.meta.totalPages}
          onPageChange={setPage}
        />
      )}
    </div>
  );
}
