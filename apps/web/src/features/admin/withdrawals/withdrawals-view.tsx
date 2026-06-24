'use client';
import { useEffect, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from '@/lib/toast';
import {
  PayoutMethod,
  type PaginatedResponse,
  type WithdrawalResponse,
  type WithdrawalStatus,
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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiFetch } from '@/lib/api.client';
import { ApiClientError } from '@/lib/api';
import { trimAmount } from '@/lib/format';
import {
  EMPTY_FLOW_FILTERS,
  feeApplicationLabel,
  FlowFilterBar,
  flowFilterParams,
  PayoutInstructions,
  prettyMethod,
  type FlowFilters,
} from '@/features/company/withdrawals-view';
import { useCompanyNames } from '@/features/admin/company-filter';

interface ReviewState {
  withdrawal: WithdrawalResponse;
  action: 'approve' | 'reject';
}

// Per-process admin config. The three admin pages share this view; only
// the endpoint and copy differ. We deliberately use plain strings (no
// function props) so this object can cross the Server → Client Component
// boundary in the Next.js app router.
export interface AdminProcessConfig {
  // Backend list endpoint, e.g. "/admin/withdrawals", "/admin/payouts".
  // Action paths derive from this: `${listEndpoint}/${id}/${action}`.
  listEndpoint: string;
  // React Query key prefix.
  queryKey: readonly string[];
  // Page heading + subhead.
  heading: string;
  subhead: string;
  // Singular noun used in toasts, e.g. "withdrawal".
  noun: string;
}

export function AdminWithdrawalsView({
  config,
  headerAction,
  backoffice = false,
}: {
  config: AdminProcessConfig;
  headerAction?: ReactNode;
  // BACKOFFICE operators settle the recipient out-of-band: they see only the NET
  // (the money that actually leaves), never the platform fee or gross. Full
  // admins (SUPER_ADMIN / ADMIN_OPERATOR) see Amount + Fee + Net unchanged.
  backoffice?: boolean;
}) {
  const qc = useQueryClient();
  // Operators land on the pending queue by default; all other filters start "any".
  const [filters, setFilters] = useState<FlowFilters>({ ...EMPTY_FLOW_FILTERS, status: 'PENDING' });
  const [review, setReview] = useState<ReviewState | null>(null);
  const [page, setPage] = useState(1);

  const params = flowFilterParams(filters, { pageSize: '50', page: String(page) });

  const listQ = useQuery({
    queryKey: [...config.queryKey, params.toString()],
    queryFn: () =>
      apiFetch<PaginatedResponse<WithdrawalResponse>>(
        `${config.listEndpoint}?${params.toString()}`,
      ),
  });

  // Clamp back if the result set shrinks below the current page (e.g. a queue of
  // pending items gets approved) so the operator isn't stranded on an empty page.
  useEffect(() => {
    const tp = listQ.data?.meta.totalPages;
    if (tp && page > tp) setPage(tp);
  }, [listQ.data, page]);

  // Names for just the companies on this page (no bulk fetch of all companies).
  const companyNames = useCompanyNames(listQ.data?.data.map((w) => w.companyId) ?? []);
  const companyName = (id: string) => companyNames.get(id) ?? id.slice(0, 8);

  // Money columns: full admins see Amount (gross = net+fee) / Fee / Net; back
  // office sees only a single "Amount" — the money they physically handle — with
  // no fee/gross breakdown. For OUTbound flows (withdrawal/payout) that's the NET
  // they pay the recipient (platform keeps the fee). For INbound LOADS the company
  // hands them the GROSS (net + fee) to credit the wallet — back office collects
  // the fee too — so they must see the full total, not the net.
  const isLoad = config.noun === 'load';
  const moneyColumns: Column<WithdrawalResponse>[] = backoffice
    ? [
        {
          key: 'amount',
          header: 'Amount',
          align: 'right',
          className: 'font-mono',
          cell: (w) => trimAmount(isLoad ? w.totalAmount : w.netAmount),
        },
      ]
    : [
        {
          key: 'gross',
          // Gross = net + fee (the full amount; an ON_TOP fee makes it exceed the
          // requested amount). For a LOAD this is what the operator collects from
          // the company (fee included) — the actionable figure — so emphasise it;
          // for a withdrawal/payout it's just the wallet charge, so de-emphasise.
          header: isLoad ? 'To collect' : 'Gross',
          align: 'right',
          className: isLoad ? 'font-mono font-semibold' : 'font-mono text-xs text-muted-foreground',
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
          // Net = what the wallet nets out. For a withdrawal/payout this is what
          // the operator pays the recipient (the system already deducted the fee)
          // — the actionable figure — so emphasise it; for a LOAD it's just what
          // gets credited to the wallet, so de-emphasise.
          header: isLoad ? 'Credited' : 'To pay',
          align: 'right',
          className: isLoad ? 'font-mono text-xs text-muted-foreground' : 'font-mono font-semibold',
          cell: (w) => trimAmount(w.netAmount),
        },
      ];

  const columns: Column<WithdrawalResponse>[] = [
    { key: 'company', header: 'Company', cell: (w) => companyName(w.companyId) },
    ...moneyColumns,
    {
      // Recipient name + phone as their own columns, surfaced directly in the row
      // so the operator never has to open a request to see who to pay. Each is
      // click-to-copy (stops row-click so it won't open the review dialog).
      key: 'recipientName',
      header: 'Recipient',
      className: 'text-xs',
      cell: (w) => <CopyText value={recipientName(w.payoutDetails)} label="Name" />,
    },
    {
      key: 'recipientPhone',
      header: 'Phone',
      className: 'text-xs',
      cell: (w) => (
        <CopyText
          value={recipientContact(w.payoutDetails)}
          label="Phone"
          className="max-w-[20ch] font-mono"
        />
      ),
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
      key: 'requested',
      header: 'Requested',
      className: 'text-xs text-muted-foreground',
      cell: (w) => new Date(w.createdAt).toLocaleString(),
    },
    {
      key: 'actions',
      header: '',
      align: 'right',
      cell: (w) => (
        <span onClick={(e) => e.stopPropagation()}>
          {w.status === 'PENDING' && (
            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setReview({ withdrawal: w, action: 'reject' })}
              >
                Reject
              </Button>
              <Button size="sm" onClick={() => setReview({ withdrawal: w, action: 'approve' })}>
                Approve
              </Button>
            </div>
          )}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold">{config.heading}</h1>
          <p className="text-sm text-muted-foreground">{config.subhead}</p>
        </div>
        {headerAction}
      </div>

      <FlowFilterBar
        value={filters}
        onChange={(f) => {
          setFilters(f);
          setPage(1);
        }}
        showCompanyFilter
      />

      <Card>
        <CardContent className="p-0">
          <DataTable<WithdrawalResponse>
            columns={columns}
            rows={listQ.data?.data}
            isLoading={listQ.isLoading}
            error={listQ.error}
            rowKey={(w) => w.id}
            onRowClick={(w) => setReview({ withdrawal: w, action: 'approve' })}
            empty={<div className="py-8 text-center text-muted-foreground">Nothing to review.</div>}
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

      <ReviewDialog
        review={review}
        config={config}
        backoffice={backoffice}
        onClose={() => setReview(null)}
        onDone={() => {
          setReview(null);
          qc.invalidateQueries({ queryKey: config.queryKey });
        }}
      />
    </div>
  );
}

function ReviewDialog({
  review,
  config,
  backoffice = false,
  onClose,
  onDone,
}: {
  review: ReviewState | null;
  config: AdminProcessConfig;
  backoffice?: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [notes, setNotes] = useState('');
  const [externalReference, setExternalReference] = useState('');

  // Reset the form whenever the targeted row/action changes so a previous
  // settlement's external reference / notes can NEVER carry into a different
  // approval — that would attach the wrong off-platform proof-of-payment to a
  // payout/withdrawal/load and corrupt the reconciliation trail. (The earlier
  // `key` on the confirm button only reset the button, not this form state.)
  const lastId = review?.withdrawal.id + '-' + review?.action;
  useEffect(() => {
    setNotes('');
    setExternalReference('');
  }, [lastId]);

  const mu = useMutation({
    mutationFn: () => {
      if (!review) throw new Error('no review');
      const path = `${config.listEndpoint}/${review.withdrawal.id}/${review.action}`;
      const body =
        review.action === 'approve'
          ? { externalReference, notes: notes || undefined }
          : { notes: notes || undefined };
      return apiFetch<WithdrawalResponse>(path, { method: 'POST', body });
    },
    onSuccess: () => {
      toast.success(`${capitalize(config.noun)} ${review?.action}d`);
      setNotes('');
      setExternalReference('');
      onDone();
    },
    onError: (err) => toast.error(err instanceof ApiClientError ? err.message : 'Failed'),
  });

  const canSubmit =
    review?.action === 'reject' ||
    (review?.action === 'approve' && externalReference.trim().length >= 2);

  // Loads are INbound (collect gross from the company, credit net); withdrawals
  // and payouts are OUTbound (pay net to the recipient, fee already taken).
  const isLoad = config.noun === 'load';

  return (
    <Dialog open={!!review} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            {review?.action === 'approve' ? 'Approve' : 'Reject'} {config.noun}
          </DialogTitle>
          <DialogDescription>
            {review &&
              (review.action === 'approve'
                ? isLoad
                  ? // INbound: the operator collects the gross (incl. fee) from the
                    // company, then approves to credit the wallet with the net.
                    `Confirm you received ${trimAmount(review.withdrawal.totalAmount)} ${review.withdrawal.currency} (fee included) from the company, then approve to credit their wallet with ${trimAmount(review.withdrawal.netAmount)} ${review.withdrawal.currency}.`
                  : // OUTbound: the operator pays the recipient the net; the system
                    // already deducted the fee from the wallet.
                    `Pay the recipient ${trimAmount(review.withdrawal.netAmount)} ${review.withdrawal.currency} out-of-band (the fee is already deducted), then record the reference here.`
                : `Reserved ${trimAmount(review.withdrawal.totalAmount)} ${review.withdrawal.currency} returns to available.`)}
          </DialogDescription>
        </DialogHeader>

        {review && (
          <div className="space-y-1 rounded-md border bg-muted/30 p-3 text-sm">
            {backoffice ? (
              // Back office sees a single amount, no fee/gross breakdown. Loads are
              // INbound: they COLLECT the gross (net + fee) from the company to
              // credit the wallet. Withdrawals/payouts are OUTbound: they PAY the
              // net to the recipient (the platform keeps the fee).
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  {config.noun === 'load' ? 'Amount to collect' : 'Amount to pay'}
                </span>
                <span className="font-mono">
                  {trimAmount(
                    config.noun === 'load'
                      ? review.withdrawal.totalAmount
                      : review.withdrawal.netAmount,
                  )}{' '}
                  {review.withdrawal.currency}
                </span>
              </div>
            ) : (
              <>
                {/* Directional labels + emphasis so the operator sees at a glance
                    WHAT to physically handle: gross for a load (collect), net for
                    a withdrawal/payout (pay). The other figures stay for context. */}
                <div className="flex items-center justify-between">
                  <span
                    className={
                      isLoad
                        ? 'text-xs font-medium text-foreground'
                        : 'text-xs text-muted-foreground'
                    }
                  >
                    {isLoad ? 'To collect from company' : 'Charged to wallet'}
                  </span>
                  <span className={isLoad ? 'font-mono font-semibold' : 'font-mono'}>
                    {trimAmount(review.withdrawal.totalAmount)} {review.withdrawal.currency}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-xs text-muted-foreground">Fee (platform revenue)</span>
                  <span className="font-mono">
                    {trimAmount(review.withdrawal.feeAmount) === '0'
                      ? '—'
                      : `${trimAmount(review.withdrawal.feeAmount)} ${review.withdrawal.currency} (${feeApplicationLabel(
                          review.withdrawal.feeApplication,
                        )})`}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span
                    className={
                      isLoad
                        ? 'text-xs text-muted-foreground'
                        : 'text-xs font-medium text-foreground'
                    }
                  >
                    {isLoad ? 'Credited to wallet' : 'To pay recipient'}
                  </span>
                  <span className={isLoad ? 'font-mono' : 'font-mono font-semibold'}>
                    {trimAmount(review.withdrawal.netAmount)} {review.withdrawal.currency}
                  </span>
                </div>
              </>
            )}
          </div>
        )}

        {/* The note the company left for the admin when they requested this. */}
        {review && review.withdrawal.notes && (
          <div className="space-y-1 rounded-md border bg-muted/30 p-3 text-sm">
            <span className="text-xs font-medium text-muted-foreground">Note from company</span>
            <CopyText value={review.withdrawal.notes} label="Note" multiline className="text-sm" />
          </div>
        )}

        {review && review.action === 'approve' && <PayoutInstructions w={review.withdrawal} />}

        {review?.action === 'approve' && (
          <div className="space-y-1 rounded-md border-2 border-primary/40 bg-primary/5 p-3">
            <Label htmlFor="reference" className="text-xs">
              External reference (required) — e.g. bank wire ID, crypto tx hash, receipt number
            </Label>
            <Input
              id="reference"
              value={externalReference}
              onChange={(e) => setExternalReference(e.target.value)}
              placeholder="REF-12345 / 0xabc…"
              autoFocus
            />
          </div>
        )}

        <div className="space-y-1">
          <Label htmlFor="notes" className="text-xs">
            Internal notes (optional)
          </Label>
          <Input id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={review?.action === 'reject' ? 'destructive' : 'default'}
            disabled={mu.isPending || !canSubmit}
            onClick={() => mu.mutate()}
            key={lastId}
          >
            {mu.isPending ? 'Submitting…' : `Confirm ${review?.action}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
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

// One-line "who to pay" for the list row. For cash/Whish that's name + phone
// (what the operator usually needs); other methods fall back to their key
// identifier. Returns '—' when there are no payout details.
// The recipient's NAME (primary identifier), per payout method.
function recipientName(d: WithdrawalResponse['payoutDetails']): string {
  if (!d) return '';
  switch (d.method) {
    case PayoutMethod.CASH:
    case PayoutMethod.WISH:
      return d.recipientName;
    case PayoutMethod.CRYPTO:
      return d.network;
    case PayoutMethod.BANK_TRANSFER:
      return d.accountHolder;
    case PayoutMethod.OTHER:
      return d.description;
    default:
      return '';
  }
}

// The recipient's CONTACT detail (phone for cash/Whish; the wallet/bank for the
// other methods). Shown in the "Phone" column and copied whole on click.
function recipientContact(d: WithdrawalResponse['payoutDetails']): string {
  if (!d) return '';
  switch (d.method) {
    case PayoutMethod.CASH:
    case PayoutMethod.WISH:
      return d.recipientPhone ?? '';
    case PayoutMethod.CRYPTO:
      return d.walletAddress;
    case PayoutMethod.BANK_TRANSFER:
      return d.bankName;
    default:
      return '';
  }
}
