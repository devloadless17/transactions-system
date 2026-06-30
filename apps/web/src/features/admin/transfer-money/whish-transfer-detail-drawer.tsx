'use client';
import type { WhishTransferResponse } from '@app/shared';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { trimAmount } from '@/lib/format';

function statusVariant(s: WhishTransferResponse['status']) {
  if (s === 'SUCCESS') return 'success' as const;
  if (s === 'FAILED') return 'destructive' as const;
  if (s === 'UNKNOWN') return 'warning' as const;
  return 'secondary' as const;
}

/**
 * Read-only detail drawer for one Whish W2W transfer (SUPER_ADMIN). The list row
 * carries the full record, so no fetch is needed. Shows whether it was an
 * auto-transfer settling a withdrawal (with a jump to that withdrawal) or a manual
 * admin transfer, plus the failure reason for a FAILED/UNKNOWN attempt.
 */
export function WhishTransferDetailDrawer({
  transfer,
  companyName,
  onOpenWithdrawal,
  onClose,
}: {
  transfer: WhishTransferResponse | null;
  companyName: (id: string) => string;
  onOpenWithdrawal: (withdrawalId: string) => void;
  onClose: () => void;
}) {
  return (
    <Sheet open={!!transfer} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Whish transfer</SheetTitle>
          <SheetDescription className="font-mono text-xs break-all">
            {transfer?.reference ?? ''}
          </SheetDescription>
        </SheetHeader>

        {transfer && (
          <div className="space-y-6 text-sm">
            <section className="space-y-2">
              <h3 className="text-xs font-medium uppercase text-muted-foreground">Summary</h3>
              <DetailRow
                label="Status"
                value={<Badge variant={statusVariant(transfer.status)}>{transfer.status}</Badge>}
              />
              <DetailRow
                label="Amount"
                value={`${trimAmount(transfer.amount)} ${transfer.currency}`}
                mono
              />
              <DetailRow label="Recipient" value={transfer.recipientPhone} mono />
              <DetailRow label="When" value={new Date(transfer.createdAt).toLocaleString()} />
            </section>

            <section className="space-y-2">
              <h3 className="text-xs font-medium uppercase text-muted-foreground">Source</h3>
              {transfer.source === 'WITHDRAWAL' && transfer.withdrawalId ? (
                <>
                  <DetailRow label="Type" value="Auto-transfer for a withdrawal" />
                  {transfer.companyId && (
                    <DetailRow label="Company" value={companyName(transfer.companyId)} />
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-1"
                    onClick={() => onOpenWithdrawal(transfer.withdrawalId!)}
                  >
                    View withdrawal
                  </Button>
                </>
              ) : (
                <DetailRow label="Type" value="Manual transfer (admin)" />
              )}
            </section>

            {(transfer.status === 'FAILED' || transfer.status === 'UNKNOWN') &&
              (transfer.errorDetail || transfer.upstreamMessage) && (
                <section className="space-y-2">
                  <h3 className="text-xs font-medium uppercase text-muted-foreground">
                    {transfer.status === 'UNKNOWN' ? 'Needs reconcile' : 'Failure reason'}
                  </h3>
                  <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
                    {transfer.status === 'UNKNOWN'
                      ? 'Outcome unconfirmed — the money may or may not have moved. Reconcile before retrying. '
                      : 'The transfer did not go through (money did not move). '}
                    {transfer.upstreamMessage ? `Whish: ${transfer.upstreamMessage}. ` : ''}
                    {transfer.errorDetail ? `(${transfer.errorDetail})` : ''}
                  </p>
                </section>
              )}

            <section className="space-y-2">
              <h3 className="text-xs font-medium uppercase text-muted-foreground">Reference</h3>
              <DetailRow label="Reference" value={transfer.reference} mono />
              <DetailRow label="Trace ID" value={transfer.traceId ?? '—'} mono />
            </section>
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
