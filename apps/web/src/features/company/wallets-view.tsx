'use client';
import { useQuery } from '@tanstack/react-query';
import type { WalletResponse } from '@app/shared';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { apiFetch } from '@/lib/api.client';

export function WalletsView() {
  const { data, isLoading } = useQuery({
    queryKey: ['company', 'wallets'],
    queryFn: () => apiFetch<{ data: WalletResponse[] }>('/company/wallets'),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Wallets</h1>
        <p className="text-sm text-muted-foreground">
          One wallet per currency. Created automatically on first transaction.
        </p>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Currency</TableHead>
                <TableHead className="text-right">Available</TableHead>
                <TableHead className="text-right">Pending</TableHead>
                <TableHead className="text-right">Reserved</TableHead>
                <TableHead>Updated</TableHead>
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
              {data?.data.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                    No wallets yet.
                  </TableCell>
                </TableRow>
              )}
              {data?.data.map((w) => (
                <TableRow key={w.id}>
                  <TableCell className="font-medium">{w.currency}</TableCell>
                  <TableCell className="text-right font-mono">
                    {trimAmount(w.availableBalance)}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {trimAmount(w.pendingBalance)}
                  </TableCell>
                  <TableCell className="text-right font-mono">
                    {trimAmount(w.reservedBalance)}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(w.updatedAt).toLocaleString()}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function trimAmount(s: string): string {
  if (!s.includes('.')) return s;
  return s.replace(/\.?0+$/, '');
}
