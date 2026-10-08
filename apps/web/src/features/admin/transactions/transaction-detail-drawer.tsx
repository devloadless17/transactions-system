'use client';
import { useQuery } from '@tanstack/react-query';
import { type TransactionDetailResponse, type TransactionResponse } from '@app/shared';
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
import { isPositiveAmount, trimAmount } from '@/lib/format';

interface Props {
  scope: 'admin' | 'company';
  transaction: TransactionResponse | null;
  onClose: () => void;
  // BACKOFFICE sees the one figure its deposits list shows — what the customer
  // paid — and never a platform fee: no fee/net breakdown and no ledger legs.
  // The API already strips them for back office (common/backoffice-view.ts);
  // this keeps the UI from rendering an empty breakdown. Full admins and the
  // company are unchanged.
  backoffice?: boolean;
}

export function TransactionDetailDrawer({
  scope,
  transaction,
  onClose,
  backoffice = false,
}: Props) {
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
  // No ledger section for back office: EXTERNAL next to AVAILABLE would reveal the fee.
  const ledgerEntries = backoffice ? undefined : detailQ.data?.ledgerEntries;

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
              {backoffice ? (
                <DetailRow label="Amount" value={`${trimAmount(tx.amount)}`} mono />
              ) : (
                <>
                  <DetailRow label="Amount" value={`${trimAmount(tx.amount)}`} mono />
                  <DetailRow label="Fee" value={`${trimAmount(tx.commissionAmount)}`} mono />
                  {isPositiveAmount(tx.networkFeeAmount) && (
                    <DetailRow
                      label="Network fee"
                      value={`${trimAmount(tx.networkFeeAmount)}`}
                      mono
                    />
                  )}
                  <DetailRow label="Net" value={`${trimAmount(tx.netAmount)}`} mono />
                </>
              )}
              <DetailRow
                label="Processed at"
                value={tx.processedAt ? new Date(tx.processedAt).toLocaleString() : '—'}
              />
              <DetailRow label="Created at" value={new Date(tx.createdAt).toLocaleString()} />
            </section>

            {(tx.customer || tx.target || tx.phone || tx.note) && (
              <section className="space-y-2">
                <h3 className="text-xs font-medium uppercase text-muted-foreground">Details</h3>
                {tx.customer && <DetailRow label="Customer" value={tx.customer} />}
                {tx.target && <DetailRow label="Target" value={tx.target} />}
                {tx.phone && <DetailRow label="Phone" value={tx.phone} mono />}
                {tx.note && <DetailRow label="Note" value={tx.note} />}
              </section>
            )}

            {detailQ.data && ledgerEntries && (
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
                    Ledger entries ({ledgerEntries.length})
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
                        {ledgerEntries.map((e) => (
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
