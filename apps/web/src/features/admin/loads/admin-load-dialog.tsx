'use client';
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from '@/lib/toast';
import { Plus } from 'lucide-react';
import { SUPPORTED_CURRENCIES, SUPPORTED_PAYOUT_METHODS, type PayoutMethod } from '@app/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { CompanyFilter } from '@/features/admin/company-filter';
import { apiFetch } from '@/lib/api.client';

const CURRENCY = SUPPORTED_CURRENCIES[0];
const METHOD_LABEL: Record<PayoutMethod, string> = {
  CASH: 'Cash',
  WISH: 'Whish',
  CRYPTO: 'Crypto',
  BANK_TRANSFER: 'Bank transfer',
  OTHER: 'Other',
};

/**
 * Super-admin-only: load a company's wallet directly for funds received
 * off-platform. Submits to POST /admin/loads, which behaves exactly like the
 * company requesting a load and us accepting it (same commission + ledger +
 * wallet effect) — done in one step.
 */
export function AdminLoadDialog() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [companyId, setCompanyId] = useState('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<PayoutMethod>('CASH');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [network, setNetwork] = useState('');
  const [walletAddress, setWalletAddress] = useState('');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');

  function reset() {
    setCompanyId('');
    setAmount('');
    setMethod('CASH');
    setName('');
    setPhone('');
    setNetwork('');
    setWalletAddress('');
    setReference('');
    setNotes('');
  }

  const mu = useMutation({
    mutationFn: () => {
      const payout =
        method === 'CRYPTO'
          ? { method, network: network.trim(), walletAddress: walletAddress.trim() }
          : { method, recipientName: name.trim(), recipientPhone: phone.trim() };
      return apiFetch('/admin/loads', {
        method: 'POST',
        body: {
          companyId,
          amount: amount.trim(),
          currency: CURRENCY,
          payout,
          ...(reference.trim() ? { externalReference: reference.trim() } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
        },
      });
    },
    onSuccess: () => {
      toast.success(`Loaded ${amount} ${CURRENCY} to the company's wallet`);
      // Refresh the loads list + the unified activity feed.
      qc.invalidateQueries({ queryKey: ['admin', 'loads'] });
      qc.invalidateQueries({ queryKey: ['admin', 'activity'] });
      setOpen(false);
      reset();
    },
    onError: (e) => {
      toast.error(e instanceof Error ? e.message : 'Failed to load the company');
    },
  });

  const needsParty = method !== 'CRYPTO';
  const valid =
    !!companyId &&
    /^\d+(\.\d+)?$/.test(amount.trim()) &&
    Number(amount) > 0 &&
    (method === 'CRYPTO'
      ? network.trim().length >= 2 && walletAddress.trim().length >= 20
      : name.trim().length >= 2 && phone.trim().length >= 4);

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) reset();
      }}
    >
      <Button onClick={() => setOpen(true)} className="w-full gap-1.5 sm:w-auto">
        <Plus className="h-4 w-4" />
        Load a company
      </Button>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Load a company</DialogTitle>
          <DialogDescription>
            Credit a company&apos;s wallet for funds received off-platform. Applies the same
            commission and ledger entries as a company-requested load you accepted.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="space-y-1">
            <Label className="text-xs">Company</Label>
            <CompanyFilter value={companyId} onChange={setCompanyId} className="w-full" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs">Amount ({CURRENCY})</Label>
              <Input
                inputMode="decimal"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Method (how it arrived)</Label>
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value as PayoutMethod)}
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
              >
                {SUPPORTED_PAYOUT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {METHOD_LABEL[m]}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {needsParty ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Name</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Phone</Label>
                <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Network</Label>
                <Input value={network} onChange={(e) => setNetwork(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Wallet address</Label>
                <Input
                  className="font-mono text-xs"
                  value={walletAddress}
                  onChange={(e) => setWalletAddress(e.target.value)}
                />
              </div>
            </div>
          )}

          <div className="space-y-1">
            <Label className="text-xs">Reference (optional)</Label>
            <Input
              placeholder="Receipt #, transfer id…"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Notes (optional)</Label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button disabled={!valid || mu.isPending} onClick={() => mu.mutate()}>
            {mu.isPending ? 'Loading…' : 'Load wallet'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
