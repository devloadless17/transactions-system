'use client';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  LedgerAccountType,
  SUPPORTED_CURRENCIES,
  type LedgerEntryResponse,
  type PaginatedResponse,
} from '@app/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { apiFetch } from '@/lib/api.client';

const PAGE_SIZE = 50;

export function LedgerView() {
  const [page, setPage] = useState(1);
  const [currency, setCurrency] = useState<string>('');
  const [accountType, setAccountType] = useState<LedgerAccountType | ''>('');

  const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
  if (currency) params.set('currency', currency);
  if (accountType) params.set('accountType', accountType);

  const listQ = useQuery({
    queryKey: ['company', 'ledger', params.toString()],
    queryFn: () =>
      apiFetch<PaginatedResponse<LedgerEntryResponse>>(`/company/ledger?${params.toString()}`),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Ledger</h1>
        <p className="text-sm text-muted-foreground">
          Append-only record of every financial event. Reconcile against your wallets.
        </p>
      </div>

      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="space-y-1">
              <Label className="text-xs">Currency</Label>
              <select
                value={currency}
                onChange={(e) => {
                  setCurrency(e.target.value);
                  setPage(1);
                }}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">All</option>
                {SUPPORTED_CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Account type</Label>
              <select
                value={accountType}
                onChange={(e) => {
                  setAccountType((e.target.value as LedgerAccountType) || '');
                  setPage(1);
                }}
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                <option value="">All</option>
                {Object.values(LedgerAccountType).map((a) => (
                  <option key={a} value={a}>
                    {a}
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
                <TableHead>Account</TableHead>
                <TableHead>Direction</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Currency</TableHead>
                <TableHead>Linked</TableHead>
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
                    No entries.
                  </TableCell>
                </TableRow>
              )}
              {listQ.data?.data.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(e.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{e.accountType}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={e.direction === 'DEBIT' ? 'warning' : 'success'}>
                      {e.direction}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right font-mono">{trimAmount(e.amount)}</TableCell>
                  <TableCell>{e.currency}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {e.transactionId && `tx:${e.transactionId.slice(0, 8)}`}
                    {e.withdrawalId && `wd:${e.withdrawalId.slice(0, 8)}`}
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

function trimAmount(s: string): string {
  if (!s.includes('.')) return s;
  return s.replace(/\.?0+$/, '');
}
