'use client';
import { useEffect, useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from '@/lib/toast';
import { ExternalLink } from 'lucide-react';
import {
  createWhishPaymentSchema,
  setWhishRedirectConfigSchema,
  type CreateWhishPaymentInput,
  type PaginatedResponse,
  type WhishClientConfig,
  type WhishPaymentResponse,
  type WhishRedirectConfig,
} from '@app/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { DataTable, type Column } from '@/components/ui/data-table';
import { Pagination } from '@/components/ui/pagination';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiFetch } from '@/lib/api.client';
import { ApiClientError } from '@/lib/api';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { ExportCsvButton } from '@/components/export-csv-button';
import { WhishPaymentDetailDrawer } from '@/features/admin/whish/whish-payment-detail-drawer';
import {
  WhishFilterBar,
  whishFilterParams,
  whishFiltersActive,
  EMPTY_WHISH_FILTERS,
  type WhishFilters,
} from '@/features/admin/whish/whish-filter-bar';

const PAGE_SIZE = 20;

function statusVariant(s: WhishPaymentResponse['status']) {
  if (s === 'PAID') return 'success' as const;
  if (s === 'FAILED' || s === 'EXPIRED') return 'destructive' as const;
  return 'secondary' as const;
}

export function WhishView() {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);
  const [detail, setDetail] = useState<WhishPaymentResponse | null>(null);
  const [filters, setFilters] = useState<WhishFilters>(EMPTY_WHISH_FILTERS);
  const [search, setSearch] = useState('');
  // Debounce the search box so we don't refetch on every keystroke.
  const debouncedSearch = useDebouncedValue(search, 300);

  const params = whishFilterParams(filters, debouncedSearch, {
    page: String(page),
    pageSize: String(PAGE_SIZE),
  });
  const filtersOn = whishFiltersActive(filters, debouncedSearch);

  const listQ = useQuery({
    queryKey: ['company', 'whish', 'list', params.toString()],
    queryFn: () =>
      apiFetch<PaginatedResponse<WhishPaymentResponse>>(
        `/company/whish/payments?${params.toString()}`,
      ),
    placeholderData: keepPreviousData,
  });

  // Clamp back if the filtered set shrinks below the current page so the user
  // isn't stranded on an empty page with the pagination controls hidden.
  useEffect(() => {
    const tp = listQ.data?.meta.totalPages;
    if (tp && page > tp) setPage(tp);
  }, [listQ.data, page]);

  const refreshMu = useMutation({
    mutationFn: (id: string) =>
      apiFetch<WhishPaymentResponse>(`/company/whish/payments/${id}/refresh-status`, {
        method: 'POST',
      }),
    onSuccess: (p) => {
      toast.success(`Status: ${p.status}`);
      qc.invalidateQueries({ queryKey: ['company', 'whish'] });
    },
    onError: (err) => toast.error(err instanceof ApiClientError ? err.message : 'Failed'),
  });

  const data = listQ.data;

  const columns: Column<WhishPaymentResponse>[] = [
    {
      key: 'reference',
      header: 'Reference',
      className: 'font-mono text-xs',
      cell: (p) => `#${p.externalId}`,
    },
    { key: 'invoice', header: 'Invoice', cell: (p) => p.invoice },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      className: 'font-mono',
      cell: (p) => `${p.amount} ${p.currency}`,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (p) => <Badge variant={statusVariant(p.status)}>{p.status}</Badge>,
    },
    {
      key: 'link',
      header: 'Link',
      cell: (p) =>
        p.collectUrl ? (
          <div className="flex items-center gap-2">
            <a
              href={p.collectUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              Open <ExternalLink className="h-3 w-3" />
            </a>
            <Button
              variant="ghost"
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                navigator.clipboard?.writeText(p.collectUrl!);
                toast.success('Link copied');
              }}
            >
              Copy
            </Button>
          </div>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: 'created',
      header: 'Created',
      className: 'text-xs text-muted-foreground',
      cell: (p) => new Date(p.createdAt).toLocaleString(),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (p) =>
        p.transactionId ? (
          <span className="font-mono text-xs text-muted-foreground">
            txn {p.transactionId.slice(0, 8)}
          </span>
        ) : p.status === 'PENDING' ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={refreshMu.isPending}
            onClick={(e) => {
              e.stopPropagation();
              refreshMu.mutate(p.id);
            }}
          >
            Refresh
          </Button>
        ) : null,
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Whish Pay</h1>
          <p className="text-sm text-muted-foreground">
            Generate a Whish payment link, share it with your customer, and the payment settles into
            your wallet automatically once confirmed.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <ExportCsvButton
            path="/company/whish/payments/export.csv"
            params={params}
            filename="whish-payments"
          />
          <Button className="w-full sm:w-auto" onClick={() => setCreateOpen(true)}>
            New payment link
          </Button>
        </div>
      </div>

      <WhishFilterBar
        value={filters}
        onChange={(f) => {
          setFilters(f);
          setPage(1);
        }}
        search={search}
        onSearchChange={(s) => {
          setSearch(s);
          setPage(1);
        }}
      />

      <Card>
        <CardContent className="p-0">
          <DataTable<WhishPaymentResponse>
            columns={columns}
            rows={data?.data}
            isLoading={listQ.isLoading}
            error={
              listQ.error
                ? listQ.error instanceof ApiClientError
                  ? listQ.error.message
                  : 'Failed to load'
                : undefined
            }
            rowKey={(p) => p.id}
            onRowClick={(p) => setDetail(p)}
            empty={
              <div className="py-8 text-center text-muted-foreground">
                {filtersOn
                  ? 'No payments match your filters.'
                  : 'No payment links yet. Create one to get started.'}
              </div>
            }
          />
          <WhishPaymentDetailDrawer payment={detail} onClose={() => setDetail(null)} />
        </CardContent>
      </Card>

      {data && (
        <Pagination
          page={data.meta.page}
          totalPages={data.meta.totalPages}
          total={data.meta.total}
          onPageChange={setPage}
        />
      )}

      <WhishRedirectSettings />

      <CreatePaymentDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onCreated={() => qc.invalidateQueries({ queryKey: ['company', 'whish'] })}
      />
    </div>
  );
}

/** Company default redirect URLs: where the customer lands after paying. */
function WhishRedirectSettings() {
  const qc = useQueryClient();
  const cfgQ = useQuery({
    queryKey: ['company', 'whish', 'redirects'],
    queryFn: () => apiFetch<WhishRedirectConfig>('/company/whish/redirects'),
  });
  const [success, setSuccess] = useState('');
  const [failure, setFailure] = useState('');
  useEffect(() => {
    if (cfgQ.data) {
      setSuccess(cfgQ.data.successUrl ?? '');
      setFailure(cfgQ.data.failureUrl ?? '');
    }
  }, [cfgQ.data]);

  const mu = useMutation({
    mutationFn: (body: { successUrl: string | null; failureUrl: string | null }) =>
      apiFetch<WhishRedirectConfig>('/company/whish/redirects', { method: 'PUT', body }),
    onSuccess: () => {
      toast.success('Redirect settings saved');
      qc.invalidateQueries({ queryKey: ['company', 'whish', 'redirects'] });
    },
    onError: (err) => toast.error(err instanceof ApiClientError ? err.message : 'Failed'),
  });

  function save() {
    const body = { successUrl: success.trim() || null, failureUrl: failure.trim() || null };
    const parsed = setWhishRedirectConfigSchema.safeParse(body);
    if (!parsed.success) {
      toast.error(parsed.error.issues[0]?.message ?? 'Enter a valid URL');
      return;
    }
    mu.mutate(parsed.data);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Redirect after payment</CardTitle>
        <CardDescription>
          Where your customer is sent after they finish (or fail) a Whish payment. Leave blank to
          use our default confirmation pages. We append <code className="font-mono">?ref=</code>{' '}
          with the payment reference so your page can identify it. (You can also override these for
          a single link when you create it.)
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="redir-success">Success URL</Label>
          <Input
            id="redir-success"
            placeholder="https://yourstore.com/thank-you"
            value={success}
            onChange={(e) => setSuccess(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="redir-failure">Failure URL</Label>
          <Input
            id="redir-failure"
            placeholder="https://yourstore.com/payment-failed"
            value={failure}
            onChange={(e) => setFailure(e.target.value)}
          />
        </div>
        <div className="flex justify-end">
          <Button type="button" disabled={mu.isPending || cfgQ.isLoading} onClick={save}>
            {mu.isPending ? 'Saving…' : 'Save redirect settings'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function CreatePaymentDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
}) {
  const [created, setCreated] = useState<WhishPaymentResponse | null>(null);
  const {
    register,
    handleSubmit,
    reset,
    setValue,
    watch,
    formState: { errors },
  } = useForm<CreateWhishPaymentInput>({
    resolver: zodResolver(createWhishPaymentSchema),
    defaultValues: { amount: '', currency: 'USD', invoice: '' },
  });
  const currency = watch('currency');

  // Optional per-link redirect override (kept outside the RHF form so an empty
  // field stays "use my default" rather than failing URL validation).
  const [ovSuccess, setOvSuccess] = useState('');
  const [ovFailure, setOvFailure] = useState('');

  const cfgQ = useQuery({
    queryKey: ['company', 'whish', 'config'],
    queryFn: () => apiFetch<WhishClientConfig>('/company/whish/config'),
  });
  // Company defaults, shown as placeholders so it's clear what an empty field uses.
  const redirQ = useQuery({
    queryKey: ['company', 'whish', 'redirects'],
    queryFn: () => apiFetch<WhishRedirectConfig>('/company/whish/redirects'),
  });
  const currencies = (cfgQ.data?.enabledCurrencies ?? [
    'USD',
  ]) as CreateWhishPaymentInput['currency'][];
  // If the selected currency isn't enabled, snap to the first enabled one.
  useEffect(() => {
    if (currencies.length && !currencies.includes(currency)) {
      setValue('currency', currencies[0], { shouldValidate: true });
    }
  }, [currencies, currency, setValue]);

  const mu = useMutation({
    mutationFn: (input: CreateWhishPaymentInput) =>
      apiFetch<WhishPaymentResponse>('/company/whish/payments', { method: 'POST', body: input }),
    onSuccess: (res) => {
      reset();
      setCreated(res);
      onCreated();
    },
    onError: (err) => toast.error(err instanceof ApiClientError ? err.message : 'Failed'),
  });

  function handleOpenChange(v: boolean) {
    onOpenChange(v);
    if (!v) {
      setCreated(null);
      reset();
      setOvSuccess('');
      setOvFailure('');
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent>
        {created ? (
          <>
            <DialogHeader>
              <DialogTitle>Payment link ready</DialogTitle>
              <DialogDescription>
                Share this link with your customer (reference #{created.externalId}). It settles
                into your wallet once paid.
              </DialogDescription>
            </DialogHeader>
            {created.collectUrl ? (
              <div className="rounded-md border bg-muted/30 p-3 font-mono text-xs break-all">
                {created.collectUrl}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Link is being generated — refresh the list in a moment.
              </p>
            )}
            <DialogFooter>
              {created.collectUrl && (
                <Button
                  onClick={() => {
                    navigator.clipboard?.writeText(created.collectUrl!);
                    toast.success('Copied');
                  }}
                >
                  Copy link
                </Button>
              )}
              <Button variant="outline" onClick={() => handleOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>New payment link</DialogTitle>
              <DialogDescription>The customer pays on Whish&apos;s hosted page.</DialogDescription>
            </DialogHeader>
            <form
              onSubmit={handleSubmit((values) =>
                mu.mutate({
                  ...values,
                  successRedirectUrl: ovSuccess.trim() || undefined,
                  failureRedirectUrl: ovFailure.trim() || undefined,
                }),
              )}
              className="space-y-4"
            >
              <div className="space-y-2">
                <Label htmlFor="amount">Amount</Label>
                <Input id="amount" inputMode="decimal" placeholder="25" {...register('amount')} />
                {errors.amount && (
                  <p className="text-sm text-destructive">{errors.amount.message}</p>
                )}
              </div>
              <div className="space-y-2">
                <Label>Currency</Label>
                <div className="flex gap-2">
                  {currencies.map((c) => (
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
              </div>
              <div className="space-y-2">
                <Label htmlFor="invoice">Invoice / description</Label>
                <Input id="invoice" placeholder="Order #1234" {...register('invoice')} />
                {errors.invoice && (
                  <p className="text-sm text-destructive">{errors.invoice.message}</p>
                )}
              </div>
              <details className="rounded-md border bg-muted/20 p-3">
                <summary className="cursor-pointer text-sm font-medium">
                  Where to send the customer after paying (optional)
                </summary>
                <div className="mt-3 space-y-3">
                  <p className="text-xs text-muted-foreground">
                    Override your saved defaults for just this link. Leave blank to use them.
                  </p>
                  <div className="space-y-2">
                    <Label htmlFor="ov-success">Success URL</Label>
                    <Input
                      id="ov-success"
                      placeholder={redirQ.data?.successUrl ?? 'our default success page'}
                      value={ovSuccess}
                      onChange={(e) => setOvSuccess(e.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="ov-failure">Failure URL</Label>
                    <Input
                      id="ov-failure"
                      placeholder={redirQ.data?.failureUrl ?? 'our default failure page'}
                      value={ovFailure}
                      onChange={(e) => setOvFailure(e.target.value)}
                    />
                  </div>
                </div>
              </details>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
                  Cancel
                </Button>
                <Button type="submit" disabled={mu.isPending}>
                  {mu.isPending ? 'Generating…' : 'Generate link'}
                </Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
