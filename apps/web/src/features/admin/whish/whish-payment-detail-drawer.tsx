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
import { whishStatusVariant } from './whish-status';

/**
 * Read-only detail drawer for a Whish Pay collect link. The list row already
 * carries the full record, so no fetch is needed — this just lays it out, plus the
 * reason when the payment needs attention (e.g. a paid link that couldn't be
 * booked, or a refund Whish has not confirmed). Reused by the admin and company
 * Whish views; `operator` adds what an admin's Refresh can do about it.
 */
export function WhishPaymentDetailDrawer({
  payment,
  onClose,
  operator = false,
}: {
  payment: WhishPaymentResponse | null;
  onClose: () => void;
  operator?: boolean;
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
                value={<Badge variant={whishStatusVariant(payment.status)}>{payment.status}</Badge>}
              />
              {payment.payerPhoneNumber && (
                <DetailRow label="Paid by" value={payment.payerPhoneNumber} mono />
              )}
              <DetailRow label="Created at" value={new Date(payment.createdAt).toLocaleString()} />
              <DetailRow
                label="Paid at"
                value={payment.paidAt ? new Date(payment.paidAt).toLocaleString() : '—'}
              />
              {payment.refundedAt && (
                <DetailRow
                  label="Refunded at"
                  value={new Date(payment.refundedAt).toLocaleString()}
                />
              )}
            </section>

            {payment.status === 'REFUNDED' && (
              <p className="rounded-md border p-3 text-xs text-muted-foreground">
                Refunded to the payer through Whish (the full amount). The deposit was reversed: the
                net credited to the wallet came back out and both fees were returned.
              </p>
            )}

            {payment.needsAttention && (
              <section className="space-y-2">
                <h3 className="text-xs font-medium uppercase text-muted-foreground">
                  Needs attention
                </h3>
                <p className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-xs">
                  {payment.settlementError ?? 'Paid at Whish but not settled into the ledger.'}
                  {operator
                    ? ' Refresh re-checks it with Whish: it settles a paid link once the cause is fixed, books a refund Whish has confirmed, and releases a refund Whish did not make.'
                    : payment.status === 'PENDING'
                      ? ' Use Refresh to re-check it with Whish.'
                      : ''}
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
