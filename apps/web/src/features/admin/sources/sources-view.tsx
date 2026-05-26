'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import Link from 'next/link';
import type { PaginatedResponse, SourceResponse } from '@app/shared';
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
import { EmptyState } from '@/components/empty-state';
import { Boxes } from 'lucide-react';
import { CreateSourceDialog } from './create-source-dialog';

export function SourcesView() {
  const [createOpen, setCreateOpen] = useState(false);
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['admin', 'sources'],
    queryFn: () => apiFetch<PaginatedResponse<SourceResponse>>('/admin/sources?pageSize=100'),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Sources</h1>
          <p className="text-sm text-muted-foreground">
            Catalog of external providers that submit transactions to the platform.
          </p>
        </div>
        <Button onClick={() => setCreateOpen(true)}>New source</Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Code</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && (
                <TableRow>
                  <TableCell colSpan={4} className="py-8 text-center text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {error && (
                <TableRow>
                  <TableCell colSpan={4} className="py-8 text-center text-destructive">
                    {error instanceof ApiClientError ? error.message : 'Failed to load'}
                  </TableCell>
                </TableRow>
              )}
              {!isLoading && data?.data.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4}>
                    <EmptyState
                      icon={Boxes}
                      title="No sources defined"
                      description="Add the external providers (omt, bank, crypto gateway, etc.) you want to ingest from."
                      action={{ label: 'New source', onClick: () => setCreateOpen(true) }}
                    />
                  </TableCell>
                </TableRow>
              )}
              {data?.data.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.name}</TableCell>
                  <TableCell className="font-mono text-xs">{s.code}</TableCell>
                  <TableCell>
                    <Badge variant={s.status === 'ACTIVE' ? 'success' : 'secondary'}>
                      {s.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(s.createdAt).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <Button asChild variant="ghost" size="sm">
                      <Link href={`/admin/sources/${s.id}/api-keys`}>API keys</Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <CreateSourceDialog
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
