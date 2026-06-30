'use client';
import { useEffect, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Controller, useForm, type UseFormReturn } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from '@/lib/toast';
import {
  createWithdrawalSchema,
  PayoutMethod,
  SUPPORTED_CURRENCIES,
  SUPPORTED_PAYOUT_METHODS,
  WithdrawalStatus,
  type CreateWithdrawalInput,
  type FeeApplication,
  type PaginatedResponse,
  type WalletResponse,
  type WithdrawalResponse,
} from '@app/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { DataTable, type Column } from '@/components/ui/data-table';
import { Pagination } from '@/components/ui/pagination';
import { CopyText } from '@/components/copy-text';
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
import { PhoneInput } from '@/components/ui/phone-input';
import { DateRangePicker, type RangePreset } from '@/components/ui/date-range-picker';
import { CompanyFilter } from '@/features/admin/company-filter';
import { ExportCsvButton } from '@/components/export-csv-button';
import { apiFetch } from '@/lib/api.client';
import { ApiClientError } from '@/lib/api';
import { trimAmount } from '@/lib/format';

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

// Shared filter bar for the load / withdrawal / payout lists (company + admin).
// All filters are backend-supported query params; an empty value means "any".
export interface FlowFilters {
  status: WithdrawalStatus | '';
  currency: string;
  method: PayoutMethod | '';
  from: string; // YYYY-MM-DD
  to: string; // YYYY-MM-DD
  fromTime?: string; // HH:mm (optional; whole-day window when absent)
  toTime?: string; // HH:mm
  companyId: string; // admin-only
}

export const EMPTY_FLOW_FILTERS: FlowFilters = {
  status: '',
  currency: '',
  method: '',
  from: '',
  to: '',
  fromTime: undefined,
  toTime: undefined,
  companyId: '',
};

// Inclusive ISO bound from a date (YYYY-MM-DD) + optional time (HH:mm). Returns
// undefined for a malformed value so the query-string build can't throw.
function isoBound(date: string, time: string | undefined, endOfDay: boolean): string | undefined {
  const t = time || (endOfDay ? '23:59' : '00:00');
  const d = new Date(`${date}T${t}:${endOfDay ? '59.999' : '00'}`);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

// YYYY-MM-DD for `offsetDays` ago (local), for the quick-range presets.
function dayKey(offsetDays: number): string {
  const d = new Date();
  d.setDate(d.getDate() - offsetDays);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

/** Build the list query string from the active filters (+ any base params). */
export function flowFilterParams(f: FlowFilters, base: Record<string, string>): URLSearchParams {
  const p = new URLSearchParams(base);
  if (f.status) p.set('status', f.status);
  if (f.currency) p.set('currency', f.currency);
  if (f.method) p.set('payoutMethod', f.method);
  if (f.companyId) p.set('companyId', f.companyId);
  if (f.from) {
    const iso = isoBound(f.from, f.fromTime, false);
    if (iso) p.set('from', iso);
  }
  if (f.to) {
    const iso = isoBound(f.to, f.toTime, true);
    if (iso) p.set('to', iso);
  }
  return p;
}

export function FlowFilterBar({
  value,
  onChange,
  showCompanyFilter,
}: {
  value: FlowFilters;
  onChange: (f: FlowFilters) => void;
  /** Admin-only: show a searchable company filter (company-scoped views omit it). */
  showCompanyFilter?: boolean;
}) {
  const set = (patch: Partial<FlowFilters>) => onChange({ ...value, ...patch });
  const selectClass =
    'h-9 w-full rounded-md border border-input bg-background px-3 text-sm sm:w-auto';
  const active = Object.values(value).some((v) => Boolean(v));
  const datePresets: RangePreset[] = [
    { label: 'Today', from: dayKey(0), to: dayKey(0) },
    { label: 'Last 7 days', from: dayKey(6), to: dayKey(0) },
    { label: 'Last 30 days', from: dayKey(29), to: dayKey(0) },
  ].map((p) => ({
    label: p.label,
    active: value.from === p.from && value.to === p.to && !value.fromTime && !value.toTime,
    onSelect: () => set({ from: p.from, to: p.to, fromTime: undefined, toTime: undefined }),
  }));
  return (
    <Card>
      <CardContent className="flex flex-wrap items-end gap-3 p-4">
        <Field label="Status">
          <select
            className={selectClass}
            value={value.status}
            onChange={(e) => set({ status: (e.target.value as WithdrawalStatus) || '' })}
          >
            <option value="">All</option>
            {Object.values(WithdrawalStatus).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Currency">
          <select
            className={selectClass}
            value={value.currency}
            onChange={(e) => set({ currency: e.target.value })}
          >
            <option value="">All</option>
            {SUPPORTED_CURRENCIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Method">
          <select
            className={selectClass}
            value={value.method}
            onChange={(e) => set({ method: (e.target.value as PayoutMethod) || '' })}
          >
            <option value="">All</option>
            {SUPPORTED_PAYOUT_METHODS.map((m) => (
              <option key={m} value={m}>
                {prettyMethod(m)}
              </option>
            ))}
          </select>
        </Field>
        {showCompanyFilter && (
          <Field label="Company">
            <CompanyFilter value={value.companyId} onChange={(companyId) => set({ companyId })} />
          </Field>
        )}
        <Field label="Date">
          <DateRangePicker
            value={{
              from: value.from || undefined,
              to: value.to || undefined,
              fromTime: value.fromTime,
              toTime: value.toTime,
            }}
            onChange={(v) =>
              set({
                from: v.from ?? '',
                to: v.to ?? '',
                fromTime: v.fromTime,
                toTime: v.toTime,
              })
            }
            presets={datePresets}
            align="end"
            placeholder="Any date"
          />
        </Field>
        {active && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => onChange(EMPTY_FLOW_FILTERS)}
          >
            Clear
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

export function WithdrawalsView({ config }: { config: ProcessConfig }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [detail, setDetail] = useState<WithdrawalResponse | null>(null);
  const [filters, setFilters] = useState<FlowFilters>(EMPTY_FLOW_FILTERS);
  const [page, setPage] = useState(1);

  const params = flowFilterParams(filters, { pageSize: '20', page: String(page) });
  const listQ = useQuery({
    queryKey: [...config.queryKey, 'list', params.toString()],
    queryFn: () =>
      apiFetch<PaginatedResponse<WithdrawalResponse>>(`${config.endpoint}?${params.toString()}`),
    placeholderData: keepPreviousData,
  });

  // If the result set shrinks (rows cancelled/approved out of the current filter)
  // while parked on a later page, clamp back so the user isn't stranded on an empty
  // page with the pagination controls hidden (totalPages collapses to 1).
  useEffect(() => {
    const tp = listQ.data?.meta.totalPages;
    if (tp && page > tp) setPage(tp);
  }, [listQ.data, page]);

  // Deep-link from a notification (e.g. "Withdrawal approved" links to
  // /app/withdrawals?selected=<id>): fetch that exact row by id and open its
  // detail panel once, so the user lands directly on it instead of scanning the
  // list. By-id fetch works even when the row isn't on the current page/filter.
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selectedId = searchParams.get('selected');
  const selectedQ = useQuery({
    queryKey: [...config.queryKey, 'detail', selectedId],
    queryFn: () => apiFetch<WithdrawalResponse>(`${config.endpoint}/${selectedId}`),
    enabled: !!selectedId,
  });
  const openedRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedId && selectedQ.data && openedRef.current !== selectedId) {
      openedRef.current = selectedId;
      setDetail(selectedQ.data);
    }
  }, [selectedId, selectedQ.data]);

  // Close the detail drawer cleanly: drop the row AND strip ?selected from the
  // URL, so a refresh won't re-pop the drawer and re-clicking the SAME
  // notification re-opens it (the deep-link effect keys off `selected` changing).
  function closeDetail() {
    setDetail(null);
    openedRef.current = null;
    if (searchParams.get('selected')) {
      const sp = new URLSearchParams(searchParams.toString());
      sp.delete('selected');
      router.replace(`${pathname}${sp.toString() ? `?${sp.toString()}` : ''}`, { scroll: false });
    }
  }

  const cancelMu = useMutation({
    mutationFn: (id: string) =>
      apiFetch<WithdrawalResponse>(`${config.endpoint}/${id}/cancel`, { method: 'POST', body: {} }),
    onSuccess: () => {
      toast.success(`${capitalize(config.noun)} cancelled`);
      closeDetail();
      qc.invalidateQueries({ queryKey: config.queryKey });
      qc.invalidateQueries({ queryKey: ['company', 'wallets'] });
    },
    onError: (err) => toast.error(err instanceof ApiClientError ? err.message : 'Failed'),
  });

  const rows = listQ.data?.data ?? [];

  // A load is money coming INTO the wallet (the company pays in, the wallet is
  // credited the net); a withdrawal/payout is money going OUT (the wallet is
  // debited, the recipient gets the net). Directional column labels keep the
  // figures unambiguous instead of a bare "Amount".
  const isLoad = config.noun === 'load';
  const columns: Column<WithdrawalResponse>[] = [
    {
      key: 'created',
      header: 'Created',
      className: 'text-xs text-muted-foreground',
      cell: (w) => new Date(w.createdAt).toLocaleString(),
    },
    {
      key: 'amount',
      // Gross = net + fee. For a load it's what the company pays in; for a
      // withdrawal/payout it's what's debited from the wallet.
      header: isLoad ? 'You pay' : 'Debited',
      align: 'right',
      className: 'font-mono',
      cell: (w) => trimAmount(w.totalAmount),
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
      // Net = gross − fee. For a load it's what lands in the wallet; for a
      // withdrawal/payout it's what the recipient receives.
      header: isLoad ? 'Credited' : 'Recipient gets',
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
              if (
                !window.confirm(
                  'Cancel this request? Reserved funds return to your available balance.',
                )
              )
                return;
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
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <ExportCsvButton
            path={`${config.endpoint}/export.csv`}
            params={params}
            filename={config.noun}
          />
          <Button className="w-full sm:w-auto" onClick={() => setOpen(true)}>
            {config.newButton}
          </Button>
        </div>
      </div>

      <FlowFilterBar
        value={filters}
        onChange={(f) => {
          setFilters(f);
          setPage(1);
        }}
      />

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

      {listQ.data && (
        <Pagination
          page={listQ.data.meta.page}
          total={listQ.data.meta.total}
          totalPages={listQ.data.meta.totalPages}
          onPageChange={setPage}
        />
      )}

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

      <DetailDrawer withdrawal={detail} noun={config.noun} onClose={closeDetail} />
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
        method: PayoutMethod.CASH,
        recipientName: '',
        recipientPhone: '',
        pickupLocation: '',
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
          method: PayoutMethod.CASH,
          recipientName: '',
          recipientPhone: '',
          pickupLocation: '',
        },
      });
      setMethod(PayoutMethod.CASH);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const currency = watch('currency');
  // Drive the method selector from local state so clicking a method button
  // re-renders immediately. (setValue on the nested object alone doesn't
  // reliably notify a watch() subscriber, which made the button appear to
  // need a second, unrelated click to "apply".)
  const [method, setMethod] = useState<PayoutMethod>(PayoutMethod.CASH);
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
        ? { method: PayoutMethod.CASH, recipientName: '', recipientPhone: '', pickupLocation: '' }
        : next === PayoutMethod.WISH
          ? { method: PayoutMethod.WISH, recipientName: '', recipientPhone: '' }
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

            {method === PayoutMethod.CASH && <CashFields form={form} />}
            {method === PayoutMethod.WISH && <WishFields form={form} />}
            {method === PayoutMethod.CRYPTO && <CryptoFields form={form} />}
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

// Offered methods, in display order (cash is the default). Operators settle
// every flow off-platform — cash handover, Whish transfer, or crypto.
const METHOD_OPTIONS: ReadonlyArray<PayoutMethod> = [
  PayoutMethod.CASH,
  PayoutMethod.WISH,
  PayoutMethod.CRYPTO,
];

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
        <Field label="Pickup location (optional)" error={err.pickupLocation?.message}>
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

function WishFields({ form }: { form: UseFormReturn<CreateWithdrawalInput> }) {
  const { register, control, formState } = form as unknown as UseFormReturn<{
    payout: { recipientName: string; recipientPhone: string; instructions?: string };
  }>;
  const err = (formState.errors.payout ?? {}) as Record<string, { message?: string } | undefined>;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Field label="Recipient name" error={err.recipientName?.message}>
        <Input {...register('payout.recipientName')} />
      </Field>
      <Field label="Whish phone" error={err.recipientPhone?.message}>
        <Controller
          control={control}
          name="payout.recipientPhone"
          render={({ field }) => (
            <PhoneInput
              value={field.value ?? ''}
              onChange={field.onChange}
              placeholder="71 505 894"
            />
          )}
        />
      </Field>
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
  noun,
  onClose,
}: {
  withdrawal: WithdrawalResponse | null;
  noun: string;
  onClose: () => void;
}) {
  // A load is money coming INTO the wallet (you pay in, the wallet is credited);
  // a withdrawal/payout is money going OUT (the wallet is debited, the recipient
  // receives the net). Directional labels avoid a bare, ambiguous "Amount".
  const isLoad = noun === 'load';
  const rejected = withdrawal?.status === 'REJECTED';
  return (
    <Sheet open={!!withdrawal} onOpenChange={(v) => !v && onClose()}>
      <SheetContent className="overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Detail</SheetTitle>
          <SheetDescription className="font-mono text-xs">
            {withdrawal && <CopyText value={withdrawal.id} label="ID" />}
          </SheetDescription>
        </SheetHeader>

        {withdrawal && (
          <div className="space-y-6 text-sm">
            {/* The admin's note (admin_notes) — ALWAYS surfaced first so the
                company sees it immediately, whatever the outcome. Destructive
                colour + "rejection reason" wording when declined; a neutral
                accent for any other note (e.g. recorded on approval). Kept
                separate from the company's own note shown in the summary below. */}
            {withdrawal.adminNotes && (
              <div
                className={
                  rejected
                    ? 'space-y-1 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-destructive'
                    : 'space-y-1 rounded-md border border-primary/30 bg-primary/5 p-3'
                }
              >
                <p className="text-xs font-semibold uppercase tracking-wide opacity-80">
                  {rejected ? `Reason for ${capitalize(noun)} rejection` : 'Note from admin'}
                </p>
                <CopyText
                  value={withdrawal.adminNotes}
                  label="Note"
                  multiline
                  className="block text-sm"
                />
              </div>
            )}

            <section className="space-y-2">
              <h3 className="text-xs font-medium uppercase text-muted-foreground">Summary</h3>
              <DetailRow
                label="Status"
                value={
                  <Badge variant={statusVariant(withdrawal.status)}>{withdrawal.status}</Badge>
                }
              />
              <DetailRow
                label={isLoad ? 'You pay' : 'Debited from wallet'}
                value={`${trimAmount(withdrawal.totalAmount)} ${withdrawal.currency}`}
                mono
              />
              {trimAmount(withdrawal.feeAmount) !== '0' && (
                <DetailRow
                  label="Fee"
                  value={`${trimAmount(withdrawal.feeAmount)} ${withdrawal.currency} (${feeApplicationLabel(
                    withdrawal.feeApplication,
                  )})`}
                  mono
                />
              )}
              <DetailRow
                label={isLoad ? 'Credited to wallet' : 'Recipient receives'}
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
                <DetailRow
                  label="External reference"
                  value={<CopyText value={withdrawal.externalReference} label="Reference" />}
                  mono
                />
              )}
              {/* The company's own request note — always shown (kept intact even
                  after an admin actions the request). The admin's note is shown in
                  the prominent callout at the top, not repeated here. */}
              {withdrawal.notes && (
                <DetailRow
                  label="Your note"
                  value={<CopyText value={withdrawal.notes} label="Note" multiline />}
                />
              )}
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
            {d.pickupLocation && <KV k="Pickup" v={d.pickupLocation} />}
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
      <span className="shrink-0 text-xs text-muted-foreground">{k}</span>
      {/* Every payout-instruction field is click-to-copy (recipient, phone,
          wallet, IBAN, …) in both the admin review dialog and the company drawer. */}
      <CopyText
        value={v}
        label={k}
        multiline
        className={`text-sm ${mono ? 'font-mono break-all' : ''}`}
      />
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

// How the fee was applied. "Deducted" comes out of the amount (recipient gets
// amount − fee); "on top" is added to it (recipient gets the full amount, the
// company pays amount + fee). Either way the company is charged the fee.
export function feeApplicationLabel(app: FeeApplication): string {
  return app === 'ON_TOP' ? 'on top' : 'deducted';
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
