'use client';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { WhishPaymentResponse } from '@app/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiFetch } from '@/lib/api.client';
import { ApiClientError } from '@/lib/api';
import { trimAmount } from '@/lib/format';
import { toast } from '@/lib/toast';

const REASON_MIN = 3;
const REASON_MAX = 255;

/**
 * Confirm a refund of a paid Whish payment. Whish sends the FULL amount back to
 * the payer (its refund call takes no amount), then the deposit is reversed.
 * Real money leaves the platform's Whish account and it can't be undone, so the
 * dialog spells both out and asks for a reason, which Whish receives as the
 * refund reason.
 *
 * Stays open on an error: a refusal can be retried, and the list is refreshed
 * either way because an unconfirmed refund flags the payment.
 */
export function RefundPaymentDialog({
  target,
  companyName,
  onClose,
}: {
  target: WhishPaymentResponse | null;
  companyName: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();
  const amount = target ? `${trimAmount(target.amount)} ${target.currency}` : '';

  const mu = useMutation({
    mutationFn: () => {
      if (!target) throw new Error('no target');
      return apiFetch<WhishPaymentResponse>(`/admin/whish/payments/${target.id}/refund`, {
        method: 'POST',
        body: { reason: trimmed },
      });
    },
    onSuccess: (p) => {
      toast.success(`#${p.externalId} refunded — ${amount} sent back to the payer`);
      setReason('');
      onClose();
    },
    onError: (err) => toast.error(err instanceof ApiClientError ? err.message : 'Refund failed'),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['admin', 'whish'] });
      // The deposit it settled is reversed — refresh the Deposits list too.
      qc.invalidateQueries({ queryKey: ['admin', 'transactions'] });
    },
  });

  const close = () => {
    if (mu.isPending) return; // the money call is in flight — don't drop its outcome
    setReason('');
    onClose();
  };

  return (
    <Dialog open={!!target} onOpenChange={(v) => !v && close()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Refund payment {target ? `#${target.externalId}` : ''}</DialogTitle>
          <DialogDescription>
            Whish sends the full {amount} back to the payer&apos;s Whish account. This moves real
            money out of the platform&apos;s Whish account and can&apos;t be undone.
          </DialogDescription>
        </DialogHeader>

        {target && (
          <div className="space-y-1 rounded-md border p-3 text-sm">
            <Row label="Company" value={companyName} />
            <Row label="Payer" value={target.payerPhoneNumber ?? '—'} mono />
            <Row label="Amount" value={amount} mono />
            <Row label="Invoice" value={target.invoice} />
          </div>
        )}

        <p className="text-xs text-muted-foreground">
          The deposit is then reversed: the net credited to {companyName}&apos;s wallet comes back
          out and both fees are returned. If the wallet no longer holds it, the rest is recorded as
          owed to the platform.
        </p>

        <div className="space-y-2">
          <Label htmlFor="refund-reason">Reason</Label>
          <Input
            id="refund-reason"
            value={reason}
            maxLength={REASON_MAX}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Customer cancelled the order"
          />
          <p className="text-xs text-muted-foreground">
            Sent to Whish as the refund reason. At least {REASON_MIN} characters.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={close} disabled={mu.isPending}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={mu.isPending || trimmed.length < REASON_MIN}
            onClick={() => mu.mutate()}
          >
            {mu.isPending ? 'Refunding…' : `Refund ${amount}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className={`text-right ${mono ? 'font-mono break-all' : 'break-words'}`}>{value}</span>
    </div>
  );
}
