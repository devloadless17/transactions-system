'use client';
import { useQuery } from '@tanstack/react-query';
import type { TransactionDetailResponse, TransactionResponse } from '@app/shared';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
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
import { trimAmount } from '@/lib/format';

interface Props {
  scope: 'admin' | 'company';
  transaction: TransactionResponse | null;
  onClose: () => void;
}

export function TransactionDetailDrawer({ scope, transaction, onClose }: Props) {
  const path =
    scope === 'admin'
      ? `/admin/transactions/${transaction?.id}/detail`
      : `/company/transactions/${transaction?.id}/detail`;

  const detailQ = useQuery({
    queryKey: [scope, 'transaction', transaction?.id, 'detail'],
    queryFn: () => apiFetch<TransactionDetailResponse>(path),
    enabled: !!transaction,
  });

  const tx = detailQ.data?.transaction ?? transaction;

  return (
    <Sheet open={!!transaction} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Transaction</SheetTitle>
          <SheetDescription className="font-mono text-xs break-all">{tx?.id}</SheetDescription>
        </SheetHeader>

        {tx && (
          <div className="space-y-6 text-sm">
            <section className="space-y-2">
              <h3 className="text-xs font-medium uppercase text-muted-foreground">Summary</h3>
              <DetailRow label="External ID" value={tx.externalTransactionId} mono />
              <DetailRow label="Source" value={tx.sourceCode} />
              <DetailRow
                label="Status"
                value={
                  <Badge variant={tx.status === 'COMPLETED' ? 'success' : 'secondary'}>
                    {tx.status}
                  </Badge>
                }
              />
              <DetailRow label="Currency" value={tx.currency} />
              <DetailRow label="Amount" value={`${trimAmount(tx.amount)}`} mono />
              <DetailRow label="Fee" value={`${trimAmount(tx.commissionAmount)}`} mono />
              <DetailRow label="Net" value={`${trimAmount(tx.netAmount)}`} mono />
              <DetailRow
                label="Processed at"
                value={tx.processedAt ? new Date(tx.processedAt).toLocaleString() : '—'}
              />
              <DetailRow label="Created at" value={new Date(tx.createdAt).toLocaleString()} />
            </section>

            {detailQ.data && (
              <>
                <section className="space-y-2">
                  <h3 className="text-xs font-medium uppercase text-muted-foreground">
                    Idempotency
                  </h3>
                  <DetailRow
                    label="Key"
                    value={
                      detailQ.data.transaction.idempotencyKey ??
                      '(natural dedup via source+external id)'
                    }
                    mono
                  />
                </section>

                <section className="space-y-2">
                  <h3 className="text-xs font-medium uppercase text-muted-foreground">
                    Provider payload
                  </h3>
                  <pre className="overflow-x-auto rounded-md border bg-muted/30 p-3 font-mono text-xs">
                    {JSON.stringify(detailQ.data.transaction.payload, null, 2)}
                  </pre>
                </section>

                <section className="space-y-2">
                  <h3 className="text-xs font-medium uppercase text-muted-foreground">
                    Ledger entries ({detailQ.data.ledgerEntries.length})
                  </h3>
                  <div className="rounded-md border">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Account</TableHead>
                          <TableHead>Dir</TableHead>
                          <TableHead className="text-right">Amount</TableHead>
                          <TableHead>Kind</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {detailQ.data.ledgerEntries.map((e) => (
                          <TableRow key={e.id}>
                            <TableCell className="font-mono text-xs">{e.accountType}</TableCell>
                            <TableCell>
                              <Badge variant={e.direction === 'CREDIT' ? 'success' : 'warning'}>
                                {e.direction}
                              </Badge>
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs">
                              {trimAmount(e.amount)} {e.currency}
                            </TableCell>
                            <TableCell className="text-xs text-muted-foreground">
                              {(e.metadata as { kind?: string } | null)?.kind ?? 'ingest'}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </section>
              </>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

function DetailRow({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3 border-b py-1 last:border-0">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className={`text-right text-sm ${mono ? 'font-mono break-all' : ''}`}>{value}</span>
    </div>
  );
}
