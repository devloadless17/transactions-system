'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MONEY_SCALE,
  SUPPORTED_CURRENCIES,
  type ManualDepositPreview,
  type SourceResponse,
  type TransactionResponse,
} from '@app/shared';
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
import { CompanyFilter, useCompanyNames } from '@/features/admin/company-filter';

type Currency = (typeof SUPPORTED_CURRENCIES)[number];

interface DepositForm {
  sourceId: string;
  companyId: string;
  externalTransactionId: string;
  amount: string;
  currency: Currency;
  customer: string;
  target: string;
  phone: string;
  note: string;
}

const EMPTY: DepositForm = {
  sourceId: '',
  companyId: '',
  externalTransactionId: '',
  amount: '',
  currency: SUPPORTED_CURRENCIES[0],
  customer: '',
  target: '',
  phone: '',
  note: '',
};

// Mirrors the server rule (moneyAmountSchema): a person is typing it, so the
// amount is whole cents and positive — a sub-cent value is a typo to fix, not
// something to round silently.
const validAmount = (v: string) =>
  /^\d+(\.\d+)?$/.test(v) && (v.split('.')[1]?.length ?? 0) <= MONEY_SCALE && Number(v) > 0;

/**
 * Record by hand a deposit a source made but is not yet sending through the
 * ingest API. Two steps: fill in the deposit, then confirm against the server's
 * preview — the same pricing the booking uses, so the fee and the credited net
 * shown are exactly what gets booked. Super admins only (the API enforces it).
 */
export function ManualDepositDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [form, setForm] = useState<DepositForm>(EMPTY);
  const [preview, setPreview] = useState<ManualDepositPreview | null>(null);
  const set = (patch: Partial<DepositForm>) => {
    setForm((f) => ({ ...f, ...patch }));
    setPreview(null); // any change invalidates a preview
  };

  const sourcesQ = useQuery({
    queryKey: ['sources', 'all'],
    queryFn: () => apiFetch<{ data: SourceResponse[] }>('/admin/sources/all'),
    enabled: open,
  });
  const sources = sourcesQ.data?.data ?? [];
  // One active source (the usual case while a single provider is pending): pick it.
  const sourceId = form.sourceId || (sources.length === 1 ? sources[0]!.id : '');
  const source = sources.find((s) => s.id === sourceId);
  const companyName = useCompanyNames([form.companyId]).get(form.companyId) ?? '…';

  const amount = form.amount.trim();
  const reference = form.externalTransactionId.trim();
  const ready = !!sourceId && !!form.companyId && reference.length > 0 && validAmount(amount);

  const previewMu = useMutation({
    mutationFn: () =>
      apiFetch<ManualDepositPreview>('/admin/deposits/preview', {
        method: 'POST',
        body: { sourceId, companyId: form.companyId, amount, currency: form.currency },
      }),
    onSuccess: setPreview,
    onError: (err) =>
      toast.error(err instanceof ApiClientError ? err.message : 'Could not price this deposit'),
  });

  const createMu = useMutation({
    mutationFn: () =>
      apiFetch<TransactionResponse>('/admin/deposits', {
        method: 'POST',
        body: {
          sourceId,
          companyId: form.companyId,
          externalTransactionId: reference,
          amount,
          currency: form.currency,
          customer: form.customer,
          target: form.target,
          phone: form.phone,
          note: form.note,
        },
      }),
    onSuccess: (t) => {
      toast.success(
        `Deposit recorded — ${companyName} credited ${trimAmount(t.netAmount)} ${t.currency}`,
      );
      setForm(EMPTY);
      setPreview(null);
      onClose();
    },
    onError: (err) =>
      toast.error(err instanceof ApiClientError ? err.message : 'Could not record the deposit'),
    onSettled: () => qc.invalidateQueries({ queryKey: ['admin', 'transactions'] }),
  });

  const close = () => {
    if (createMu.isPending) return; // a booking is in flight — keep its outcome on screen
    setForm(EMPTY);
    setPreview(null);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={(v) => !v && close()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        {!preview ? (
          <>
            <DialogHeader>
              <DialogTitle>New deposit</DialogTitle>
              <DialogDescription>
                Record a deposit the source made but hasn&apos;t sent through its API yet. It is
                booked exactly like the source&apos;s own API deposit.
              </DialogDescription>
            </DialogHeader>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Source">
                <select
                  className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
                  value={sourceId}
                  onChange={(e) => set({ sourceId: e.target.value })}
                >
                  {sources.length !== 1 && <option value="">Choose a source</option>}
                  {sources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Company">
                <CompanyFilter
                  value={form.companyId}
                  onChange={(companyId) => set({ companyId })}
                  allowAll={false}
                  placeholder="Choose a company"
                  className="w-full sm:w-full"
                />
              </Field>
              <Field
                label="Source transaction ID"
                hint="The source's own reference for this deposit. When the source starts sending through its API, a deposit with the same ID is recognised and never credited twice."
                className="sm:col-span-2"
              >
                <Input
                  value={form.externalTransactionId}
                  maxLength={200}
                  onChange={(e) => set({ externalTransactionId: e.target.value })}
                  placeholder="As shown in the source's records"
                />
              </Field>
              <Field label={`Amount (${form.currency})`}>
                <Input
                  inputMode="decimal"
                  placeholder="0.00"
                  value={form.amount}
                  onChange={(e) => set({ amount: e.target.value })}
                />
              </Field>
              <Field label="Customer (optional)">
                <Input
                  value={form.customer}
                  maxLength={200}
                  onChange={(e) => set({ customer: e.target.value })}
                />
              </Field>
              <Field label="Trading account (optional)">
                <Input
                  value={form.target}
                  maxLength={200}
                  onChange={(e) => set({ target: e.target.value })}
                />
              </Field>
              <Field label="Phone (optional)">
                <Input
                  type="tel"
                  value={form.phone}
                  maxLength={40}
                  onChange={(e) => set({ phone: e.target.value })}
                />
              </Field>
              <Field label="Note (optional)" className="sm:col-span-2">
                <Input
                  value={form.note}
                  maxLength={1000}
                  onChange={(e) => set({ note: e.target.value })}
                />
              </Field>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={close}>
                Cancel
              </Button>
              <Button disabled={!ready || previewMu.isPending} onClick={() => previewMu.mutate()}>
                {previewMu.isPending ? 'Pricing…' : 'Review'}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Confirm deposit</DialogTitle>
              <DialogDescription>
                This credits real money to {companyName}&apos;s wallet and sends
                transaction.completed to its CRM, like an API deposit.
              </DialogDescription>
            </DialogHeader>

            <dl className="space-y-1 rounded-md border p-3 text-sm">
              <Row label="Company" value={companyName} />
              <Row label="Source" value={source?.name ?? '—'} />
              <Row label="Source transaction ID" value={reference} mono />
              <Row
                label="Amount"
                value={`${trimAmount(preview.amount)} ${preview.currency}`}
                mono
              />
              <Row
                label={preview.feeApplication === 'ON_TOP' ? 'Fee (charged on top)' : 'Fee'}
                value={`${trimAmount(preview.commissionAmount)} ${preview.currency}`}
                mono
              />
              {Number(preview.networkFeeAmount) > 0 && (
                <Row
                  label="Network fee"
                  value={`${trimAmount(preview.networkFeeAmount)} ${preview.currency}`}
                  mono
                />
              )}
              <div className="border-t pt-1">
                <Row
                  label="Company is credited"
                  value={`${trimAmount(preview.netAmount)} ${preview.currency}`}
                  mono
                  strong
                />
              </div>
            </dl>

            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setPreview(null)}
                disabled={createMu.isPending}
              >
                Back
              </Button>
              <Button onClick={() => createMu.mutate()} disabled={createMu.isPending}>
                {createMu.isPending
                  ? 'Recording…'
                  : `Credit ${trimAmount(preview.netAmount)} ${preview.currency}`}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  hint,
  className,
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={`space-y-1 ${className ?? ''}`}>
      <Label className="text-xs">{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Row({
  label,
  value,
  mono,
  strong,
}: {
  label: string;
  value: string;
  mono?: boolean;
  strong?: boolean;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd
        className={`text-right ${mono ? 'font-mono break-all' : 'break-words'} ${strong ? 'font-semibold' : ''}`}
      >
        {value}
      </dd>
    </div>
  );
}
