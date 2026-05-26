'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import type { CompanyResponse, PaginatedResponse } from '@app/shared';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Card, CardContent } from '@/components/ui/card';
import { apiFetch } from '@/lib/api.client';
import { ApiClientError } from '@/lib/api';
import { EmptyState } from '@/components/empty-state';
import { Building2 } from 'lucide-react';
import { CreateCompanyDialog } from './create-company-dialog';

const PAGE_SIZE = 20;

export function CompaniesView() {
  const router = useRouter();
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin', 'companies', { page }],
    queryFn: () =>
      apiFetch<PaginatedResponse<CompanyResponse>>(
        `/admin/companies?page=${page}&pageSize=${PAGE_SIZE}`,
      ),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Companies</h1>
          <p className="text-sm text-muted-foreground">
            Tenants on the platform. Create a company to provision its owner and a default wallet.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>New company</Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Slug</TableHead>
                <TableHead>Default currency</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {error && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-destructive">
                    {error instanceof ApiClientError ? error.message : 'Failed to load'}
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && data && data.data.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5}>
                    <EmptyState
                      icon={Building2}
                      title="No companies yet"
                      description="Provision the first tenant. You'll get an owner login and a default-currency wallet seeded automatically."
                      action={{ label: 'New company', onClick: () => setCreateOpen(true) }}
                    />
                  </TableCell>
                </TableRow>
              )}
              {data?.data.map((c) => (
                <TableRow
                  key={c.id}
                  className="cursor-pointer"
                  onClick={() => router.push(`/admin/companies/${c.id}`)}
                >
                  <TableCell className="font-medium">{c.name}</TableCell>
                  <TableCell className="text-muted-foreground">{c.slug}</TableCell>
                  <TableCell>{c.defaultCurrency}</TableCell>
                  <TableCell>{c.status}</TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(c.createdAt).toLocaleDateString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {data && data.meta.totalPages > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            Page {data.meta.page} of {data.meta.totalPages} · {data.meta.total} total
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= data.meta.totalPages}
              onClick={() => setPage((p) => p + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}

      <CreateCompanyDialog
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
