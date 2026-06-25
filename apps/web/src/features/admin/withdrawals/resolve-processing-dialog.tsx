'use client';
import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import type { WithdrawalResponse } from '@app/shared';
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
import { toast } from '@/lib/toast';

/**
 * Operator escape hatch for a withdrawal stuck in PROCESSING (an ambiguous /
 * UNKNOWN auto-transfer). After reconciling against Whish by hand, the operator
 * either CONFIRMS the money moved (settle → COMPLETED) or REVERTS it to the
 * manual queue (money did NOT move).
 */
export function ResolveProcessingDialog({
  withdrawal,
  onClose,
  onDone,
}: {
  withdrawal: WithdrawalResponse | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [action, setAction] = useState<'complete' | 'revert'>('complete');
  const [externalReference, setExternalReference] = useState('');
  const [notes, setNotes] = useState('');

  useEffect(() => {
    setAction('complete');
    setExternalReference(withdrawal?.autoApproval?.status === 'SUCCESS' ? '' : '');
    setNotes('');
  }, [withdrawal?.id]);

  const mu = useMutation({
    mutationFn: () => {
      if (!withdrawal) throw new Error('no withdrawal');
      return apiFetch<WithdrawalResponse>(
        `/admin/withdrawals/${withdrawal.id}/resolve-processing`,
        {
          method: 'POST',
          body:
            action === 'complete'
              ? { action, externalReference: externalReference.trim(), notes: notes || undefined }
              : { action, notes: notes || undefined },
        },
      );
    },
    onSuccess: () => {
      toast.success(action === 'complete' ? 'Withdrawal completed' : 'Reverted to pending');
      onDone();
    },
    onError: (e) => toast.error(e instanceof ApiClientError ? e.message : 'Failed'),
  });

  const completeValid = action !== 'complete' || externalReference.trim().length >= 2;

  return (
    <Dialog open={!!withdrawal} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Resolve stuck transfer</DialogTitle>
          <DialogDescription>
            This withdrawal&apos;s auto-transfer was ambiguous (the result was not confirmed).
            Reconcile it against Whish, then confirm whether the money actually moved.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex gap-2">
            <Button
              type="button"
              variant={action === 'complete' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setAction('complete')}
            >
              Money moved → complete
            </Button>
            <Button
              type="button"
              variant={action === 'revert' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setAction('revert')}
            >
              Did not move → revert
            </Button>
          </div>

          {action === 'complete' ? (
            <div className="space-y-1">
              <Label htmlFor="rp-ref" className="text-xs">
                Whish reference / proof
              </Label>
              <Input
                id="rp-ref"
                value={externalReference}
                onChange={(e) => setExternalReference(e.target.value)}
                placeholder="e.g. the W2W reference or trace id"
              />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">
              Sends it back to the manual queue (PENDING) so you can retry or reject it. Only do
              this if you have confirmed no money left the Whish account.
            </p>
          )}

          <div className="space-y-1">
            <Label htmlFor="rp-notes" className="text-xs">
              Notes (optional)
            </Label>
            <Input id="rp-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={mu.isPending}>
            Cancel
          </Button>
          <Button onClick={() => mu.mutate()} disabled={!completeValid || mu.isPending}>
            {action === 'complete' ? 'Complete withdrawal' : 'Revert to pending'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
