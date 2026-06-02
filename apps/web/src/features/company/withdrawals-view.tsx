'use client';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from 'sonner';
import {
  createWithdrawalSchema,
  PayoutMethod,
  SUPPORTED_CURRENCIES,
  WithdrawalStatus,
  type CreateWithdrawalInput,
  type PaginatedResponse,
  type WalletResponse,
  type WithdrawalResponse,
} from '@app/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { DataTable, type Column } from '@/components/ui/data-table';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiFetch } from '@/lib/api.client';
import { ApiClientError } from '@/lib/api';

// Withdrawal/Payout/Load have the same response shape; we type the
// shared UI against WithdrawalResponse and the per-process endpoint
// returns one of the three.
export interface ProcessConfig {
  // Backend path under /v1, e.g. "/company/withdrawals", "/company/payouts".
  endpoint: string;
  // React Query key prefix used for cache scoping.
  queryKey: readonly string[];
  // Page heading.
  heading: string;
  // Sub-heading paragraph.
  subhead: string;
  // CTA label, e.g. "New withdrawal".
  newButton: string;
  // Empty-state copy.
  emptyState: string;
  // New-row dialog title + description.
  dialogTitle: string;
  dialogDescription: string;
  // What we call one row in user-facing copy (e.g. "withdrawal", "payout").
  noun: string;
}

export function WithdrawalsView({ config }: { config: ProcessConfig }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<WithdrawalResponse | null>(null);

  const listQ = useQuery({
    queryKey: [...config.queryKey, 'list'],
    queryFn: () =>
      apiFetch<PaginatedResponse<WithdrawalResponse>>(`${config.endpoint}?pageSize=50`),
  });

  const cancelMu = useMutation({
    mutationFn: (id: string) =>
      apiFetch<WithdrawalResponse>(`${config.endpoint}/${id}/cancel`, { method: 'POST', body: {} }),
    onSuccess: () => {
      toast.success(`${capitalize(config.noun)} cancelled`);
      setDetail(null);
      qc.invalidateQueries({ queryKey: config.queryKey });
      qc.invalidateQueries({ queryKey: ['company', 'wallets'] });
    },
    onError: (err) => toast.error(err instanceof ApiClientError ? err.message : 'Failed'),
  });

  const rows = listQ.data?.data ?? [];

  const columns: Column<WithdrawalResponse>[] = [
    {
      key: 'created',
      header: 'Created',
      className: 'text-xs text-muted-foreground',
      cell: (w) => new Date(w.createdAt).toLocaleString(),
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      className: 'font-mono',
      cell: (w) => trimAmount(w.amount),
    },
    {
      key: 'fee',
      header: 'Fee',
      align: 'right',
      className: 'font-mono text-xs text-muted-foreground',
      cell: (w) => (trimAmount(w.feeAmount) === '0' ? '—' : trimAmount(w.feeAmount)),
    },
    {
      key: 'net',
      header: 'Net',
      align: 'right',
      className: 'font-mono text-xs',
      cell: (w) => trimAmount(w.netAmount),
    },
    { key: 'currency', header: 'Currency', cell: (w) => w.currency },
    {
      key: 'method',
      header: 'Method',
      className: 'text-xs',
      cell: (w) => prettyMethod(w.payoutMethod),
    },
    {
      key: 'status',
      header: 'Status',
      cell: (w) => <Badge variant={statusVariant(w.status)}>{w.status}</Badge>,
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (w) =>
        w.status === 'PENDING' ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={cancelMu.isPending}
            onClick={(e) => {
              e.stopPropagation();
              cancelMu.mutate(w.id);
            }}
          >
            Cancel
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{config.heading}</h1>
          <p className="text-sm text-muted-foreground">{config.subhead}</p>
        </div>
        <Button onClick={() => setOpen(true)}>{config.newButton}</Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <DataTable<WithdrawalResponse>
            columns={columns}
            rows={rows}
            isLoading={listQ.isLoading}
            error={listQ.error}
            rowKey={(w) => w.id}
            onRowClick={(w) => setDetail(w)}
            empty={
              <div className="py-8 text-center text-muted-foreground">{config.emptyState}</div>
            }
          />
        </CardContent>
      </Card>

      <NewRowDialog
        open={open}
        config={config}
        onOpenChange={setOpen}
        onCreated={() => {
          setOpen(false);
          qc.invalidateQueries({ queryKey: config.queryKey });
          qc.invalidateQueries({ queryKey: ['company', 'wallets'] });
        }}
      />

      <DetailDrawer withdrawal={detail} onClose={() => setDetail(null)} />
    </div>
  );
}

// ============================================================
// New-row dialog (shared across the three processes — the body
// shape is identical, only the endpoint and copy differ)
// ============================================================
function NewRowDialog({
  open,
  config,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  config: ProcessConfig;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
}) {
  const walletsQ = useQuery({
    queryKey: ['company', 'wallets'],
    queryFn: () => apiFetch<{ data: WalletResponse[] }>('/company/wallets'),
    enabled: open,
  });

  // The three create-schemas are structurally identical so we use
  // createWithdrawalSchema everywhere as the validation source of truth.
  // The backend re-validates with its own create*Schema per route.
  const form = useForm<CreateWithdrawalInput>({
    resolver: zodResolver(createWithdrawalSchema),
    defaultValues: {
      amount: '0',
      currency: 'USD',
      notes: '',
      payout: {
        method: PayoutMethod.CRYPTO,
        network: '',
        walletAddress: '',
      },
    },
  });

  const { register, handleSubmit, setValue, watch, formState, reset } = form;

  useEffect(() => {
    if (open) {
      reset({
        amount: '0',
        currency: 'USD',
        notes: '',
        payout: {
          method: PayoutMethod.CRYPTO,
          network: '',
          walletAddress: '',
        },
      });
      setMethod(PayoutMethod.CRYPTO);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const currency = watch('currency');
  // Drive the method selector from local state so clicking Cash/Crypto
  // re-renders immediately. (setValue on the nested object alone doesn't
  // reliably notify a watch() subscriber, which made the button appear to
  // need a second, unrelated click to "apply".)
  const [method, setMethod] = useState<PayoutMethod>(PayoutMethod.CRYPTO);
  const wallet = walletsQ.data?.data.find((w) => w.currency === currency);

  const createMu = useMutation({
    mutationFn: (input: CreateWithdrawalInput) =>
      apiFetch<WithdrawalResponse>(config.endpoint, { method: 'POST', body: input }),
    onSuccess: () => {
      toast.success(`${capitalize(config.noun)} requested`);
      reset();
      onCreated();
    },
    onError: (err) => toast.error(err instanceof ApiClientError ? err.message : 'Failed'),
  });

  function switchMethod(next: PayoutMethod) {
    const fresh: CreateWithdrawalInput['payout'] =
      next === PayoutMethod.CASH
        ? {
            method: PayoutMethod.CASH,
            recipientName: '',
            recipientPhone: '',
            pickupLocation: '',
          }
        : { method: PayoutMethod.CRYPTO, network: '', walletAddress: '' };
    setValue('payout', fresh, { shouldValidate: false, shouldDirty: true });
    setMethod(next);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{config.dialogTitle}</DialogTitle>
          <DialogDescription>{config.dialogDescription}</DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit((values) => createMu.mutate(values))} className="space-y-5">
          <section className="space-y-3 rounded-md border p-4">
            <h3 className="text-xs font-medium uppercase text-muted-foreground">Amount</h3>
            <div className="space-y-2">
              <Label>Currency</Label>
              <div className="flex flex-wrap gap-2">
                {SUPPORTED_CURRENCIES.map((c) => (
                  <Button
                    key={c}
                    type="button"
                    variant={c === currency ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setValue('currency', c, { shouldValidate: true })}
                  >
                    {c}
                  </Button>
                ))}
              </div>
              {wallet && (
                <p className="text-xs text-muted-foreground">
                  Available {wallet.currency}:{' '}
                  <span className="font-mono">{trimAmount(wallet.availableBalance)}</span>
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="amount">Amount</Label>
              <Input id="amount" {...register('amount')} />
              {formState.errors.amount && (
                <p className="text-sm text-destructive">{formState.errors.amount.message}</p>
              )}
            </div>
          </section>

          <section className="space-y-3 rounded-md border p-4">
            <div className="flex items-center justify-between">
              <h3 className="text-xs font-medium uppercase text-muted-foreground">
                {config.noun === 'load' ? 'How the money arrived' : 'Payout method'}
              </h3>
            </div>
            <div className="flex flex-wrap gap-2">
              {METHOD_OPTIONS.map((m) => (
                <Button
                  key={m}
                  type="button"
                  variant={method === m ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => switchMethod(m)}
                >
                  {prettyMethod(m)}
                </Button>
              ))}
            </div>

            {method === PayoutMethod.CRYPTO && <CryptoFields form={form} />}
            {method === PayoutMethod.CASH && <CashFields form={form} />}
          </section>

          <div className="space-y-2">
            <Label htmlFor="notes">Notes (optional)</Label>
            <Input id="notes" {...register('notes')} placeholder="Any context for the admin" />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={createMu.isPending}>
              {createMu.isPending ? 'Requesting…' : 'Request'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// Only cash and crypto are offered. Operators settle every flow off-platform
// via cash handover or crypto transfer.
const METHOD_OPTIONS: ReadonlyArray<PayoutMethod> = [PayoutMethod.CRYPTO, PayoutMethod.CASH];

// ============================================================
// Per-method field groups
// ============================================================
function CryptoFields({ form }: { form: UseFormReturn<CreateWithdrawalInput> }) {
  const { register, formState } = form as unknown as UseFormReturn<{
    payout: { network: string; walletAddress: string; memo?: string; instructions?: string };
  }>;
  const err = (formState.errors.payout ?? {}) as Record<string, { message?: string } | undefined>;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label="Network" error={err.network?.message}>
        <Input {...register('payout.network')} placeholder="BTC, ETH, TRC20, SOL, …" />
      </Field>
      <Field label="Memo / tag (optional)" error={err.memo?.message}>
        <Input {...register('payout.memo')} />
      </Field>
      <div className="sm:col-span-2">
        <Field label="Wallet address" error={err.walletAddress?.message}>
          <Input className="font-mono text-xs" {...register('payout.walletAddress')} />
        </Field>
      </div>
      <div className="sm:col-span-2">
        <Field label="Instructions (optional)" error={err.instructions?.message}>
          <Input {...register('payout.instructions')} />
        </Field>
      </div>
    </div>
  );
}

function CashFields({ form }: { form: UseFormReturn<CreateWithdrawalInput> }) {
  const { register, formState } = form as unknown as UseFormReturn<{
    payout: {
      recipientName: string;
      recipientPhone: string;
      pickupLocation: string;
      instructions?: string;
    };
  }>;
  const err = (formState.errors.payout ?? {}) as Record<string, { message?: string } | undefined>;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label="Recipient name" error={err.recipientName?.message}>
        <Input {...register('payout.recipientName')} />
      </Field>
      <Field label="Recipient phone" error={err.recipientPhone?.message}>
        <Input {...register('payout.recipientPhone')} />
      </Field>
      <div className="sm:col-span-2">
        <Field label="Pickup location" error={err.pickupLocation?.message}>
          <Input {...register('payout.pickupLocation')} />
        </Field>
      </div>
      <div className="sm:col-span-2">
        <Field label="Instructions (optional)" error={err.instructions?.message}>
          <Input {...register('payout.instructions')} />
        </Field>
      </div>
    </div>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label className="text-xs">{label}</Label>
      {children}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

// ============================================================
// Detail drawer
// ============================================================
function DetailDrawer({
  withdrawal,
  onClose,
}: {
  withdrawal: WithdrawalResponse | null;
  onClose: () => void;
}) {
  return (
    <Sheet open={!!withdrawal} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Detail</SheetTitle>
          <SheetDescription className="font-mono text-xs">{withdrawal?.id}</SheetDescription>
        </SheetHeader>

        {withdrawal && (
          <div className="space-y-6 text-sm">
            <section className="space-y-2">
              <h3 className="text-xs font-medium uppercase text-muted-foreground">Summary</h3>
              <DetailRow
                label="Status"
                value={
                  <Badge variant={statusVariant(withdrawal.status)}>{withdrawal.status}</Badge>
                }
              />
              <DetailRow
                label="Amount"
                value={`${trimAmount(withdrawal.amount)} ${withdrawal.currency}`}
                mono
              />
              {trimAmount(withdrawal.feeAmount) !== '0' && (
                <DetailRow
                  label="Fee"
                  value={`${trimAmount(withdrawal.feeAmount)} ${withdrawal.currency}`}
                  mono
                />
              )}
              <DetailRow
                label="Net"
                value={`${trimAmount(withdrawal.netAmount)} ${withdrawal.currency}`}
                mono
              />
              <DetailRow label="Method" value={prettyMethod(withdrawal.payoutMethod)} />
              <DetailRow
                label="Requested"
                value={new Date(withdrawal.createdAt).toLocaleString()}
              />
              <DetailRow
                label="Processed"
                value={
                  withdrawal.processedAt ? new Date(withdrawal.processedAt).toLocaleString() : '—'
                }
              />
              {withdrawal.externalReference && (
                <DetailRow label="External reference" value={withdrawal.externalReference} mono />
              )}
              {withdrawal.notes && <DetailRow label="Notes" value={withdrawal.notes} />}
            </section>

            <PayoutInstructions w={withdrawal} />
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

export function PayoutInstructions({ w }: { w: WithdrawalResponse }) {
  const d = w.payoutDetails;
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-medium uppercase text-muted-foreground">Payout instructions</h3>
      <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-sm">
        {!d && <p className="text-muted-foreground">(none recorded)</p>}
        {d?.method === 'BANK_TRANSFER' && (
          <>
            <KV k="Account holder" v={d.accountHolder} />
            <KV k="Bank" v={d.bankName} />
            <KV k="Account / IBAN" v={d.accountNumber} mono />
            {d.swiftBic && <KV k="SWIFT / BIC" v={d.swiftBic} mono />}
            {d.routingNumber && <KV k="Routing" v={d.routingNumber} mono />}
            {d.instructions && <KV k="Instructions" v={d.instructions} />}
          </>
        )}
        {d?.method === 'CRYPTO' && (
          <>
            <KV k="Network" v={d.network} />
            <KV k="Wallet" v={d.walletAddress} mono />
            {d.memo && <KV k="Memo / tag" v={d.memo} mono />}
            {d.instructions && <KV k="Instructions" v={d.instructions} />}
          </>
        )}
        {d?.method === 'CASH' && (
          <>
            <KV k="Recipient" v={d.recipientName} />
            <KV k="Phone" v={d.recipientPhone} />
            <KV k="Pickup" v={d.pickupLocation} />
            {d.instructions && <KV k="Instructions" v={d.instructions} />}
          </>
        )}
        {d?.method === 'WISH' && (
          <>
            <KV k="Recipient" v={d.recipientName} />
            <KV k="Whish phone" v={d.recipientPhone} mono />
            {d.instructions && <KV k="Instructions" v={d.instructions} />}
          </>
        )}
        {d?.method === 'OTHER' && (
          <>
            <KV k="Description" v={d.description} />
            {d.instructions && <KV k="Instructions" v={d.instructions} />}
          </>
        )}
      </div>
    </section>
  );
}

function KV({ k, v, mono }: { k: string; v: string; mono?: boolean }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <span className="text-xs text-muted-foreground">{k}</span>
      <span className={`text-right text-sm ${mono ? 'font-mono break-all' : ''}`}>{v}</span>
    </div>
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
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={`text-right text-sm ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}

export function prettyMethod(m: PayoutMethod): string {
  switch (m) {
    case 'BANK_TRANSFER':
      // Kept for rows persisted before bank transfer was removed from the UI.
      return 'Bank transfer';
    case 'CRYPTO':
      return 'Crypto';
    case 'CASH':
      return 'Cash';
    case 'WISH':
      return 'Whish Money';
    default:
      return 'Other';
  }
}

function trimAmount(s: string): string {
  if (!s.includes('.')) return s;
  return s.replace(/\.?0+$/, '');
}

function statusVariant(s: WithdrawalStatus): 'success' | 'warning' | 'destructive' | 'secondary' {
  switch (s) {
    case 'COMPLETED':
      return 'success';
    case 'PENDING':
    case 'PROCESSING':
    case 'APPROVED':
      return 'warning';
    case 'REJECTED':
    case 'CANCELLED':
      return 'destructive';
    default:
      return 'secondary';
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
