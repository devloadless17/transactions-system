'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AuditLogResponse, CompanyResponse, PaginatedResponse } from '@app/shared';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
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
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>When</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Company</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Entity</TableHead>
                <TableHead>IP</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {listQ.isLoading && (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {listQ.data?.data.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                    No audit logs yet.
                  </TableCell>
                </TableRow>
              )}
              {listQ.data?.data.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(a.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell>{a.actorEmail ?? '—'}</TableCell>
                  <TableCell>{companyName(a.companyId)}</TableCell>
                  <TableCell className="font-mono text-xs">{a.action}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {a.entityType}
                    {a.entityId ? `:${a.entityId.slice(0, 8)}` : ''}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {a.ipAddress ?? '—'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {listQ.data && listQ.data.meta.totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            Page {listQ.data.meta.page} of {listQ.data.meta.totalPages} · {listQ.data.meta.total}{' '}
            total
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => p - 1)}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= listQ.data.meta.totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
