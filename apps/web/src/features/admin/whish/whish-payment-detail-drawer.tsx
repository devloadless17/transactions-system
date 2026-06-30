'use client';
import type { WhishPaymentResponse } from '@app/shared';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Badge } from '@/components/ui/badge';
import { trimAmount } from '@/lib/format';

function statusVariant(s: WhishPaymentResponse['status']) {
  if (s === 'PAID') return 'success' as const;
  if (s === 'FAILED' || s === 'EXPIRED') return 'destructive' as const;
  return 'secondary' as const;
}

/**
 * Read-only detail drawer for a Whish Pay collect link. The list row already
 * carries the full record, so no fetch is needed — this just lays it out, plus the
 * settlement-error reason when a paid link couldn't be booked (needs attention).
 * Reused by the admin and company Whish views.
 */
export function WhishPaymentDetailDrawer({
  payment,
  onClose,
}: {
  payment: WhishPaymentResponse | null;
  onClose: () => void;
}) {
  return (
    <Sheet open={!!payment} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Whish payment</SheetTitle>
          <SheetDescription className="font-mono text-xs">
            {payment ? `#${payment.externalId}` : ''}
          </SheetDescription>
        </SheetHeader>

        {payment && (
          <div className="space-y-6 text-sm">
            <section className="space-y-2">
              <h3 className="text-xs font-medium uppercase text-muted-foreground">Summary</h3>
              <DetailRow label="Invoice" value={payment.invoice} />
              <DetailRow
                label="Amount"
                value={`${trimAmount(payment.amount)} ${payment.currency}`}
                mono
              />
              <DetailRow
                label="Status"
                value={<Badge variant={statusVariant(payment.status)}>{payment.status}</Badge>}
              />
              {payment.payerPhoneNumber && (
                <DetailRow label="Paid by" value={payment.payerPhoneNumber} mono />
              )}
              <DetailRow label="Created at" value={new Date(payment.createdAt).toLocaleString()} />
              <DetailRow
                label="Paid at"
                value={payment.paidAt ? new Date(payment.paidAt).toLocaleString() : '—'}
              />
            </section>

            {payment.needsAttention && (
              <section className="space-y-2">
                <h3 className="text-xs font-medium uppercase text-muted-foreground">
                  Needs attention
                </h3>
                <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
                  Paid at Whish but not settled into the ledger.
                  {payment.settlementError ? ` Reason: ${payment.settlementError}` : ''} Use Refresh
                  once the cause is fixed to re-attempt settlement.
                </p>
              </section>
            )}

            <section className="space-y-2">
              <h3 className="text-xs font-medium uppercase text-muted-foreground">Settlement</h3>
              <DetailRow
                label="Booked transaction"
                value={payment.transactionId ?? '— (not yet settled)'}
                mono
              />
              {payment.collectUrl && (
                <DetailRow
                  label="Collect link"
                  value={
                    <a
                      href={payment.collectUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-primary underline break-all"
                    >
                      {payment.collectUrl}
                    </a>
                  }
                />
              )}
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
