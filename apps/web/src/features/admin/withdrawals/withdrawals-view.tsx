'use client';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  type PaginatedResponse,
  type WithdrawalResponse,
  type WithdrawalStatus,
} from '@app/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
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

export function AdminWithdrawalsView({ config }: { config: AdminProcessConfig }) {
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

  const columns: Column<WithdrawalResponse>[] = [
    { key: 'company', header: 'Company', cell: (w) => companyName(w.companyId) },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      className: 'font-mono',
      // Total charged = net + fee (Amount = Net + Fee on every row; for an
      // ON_TOP fee this exceeds the requested amount).
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
      <div>
        <h1 className="text-2xl font-semibold">{config.heading}</h1>
        <p className="text-sm text-muted-foreground">{config.subhead}</p>
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
  onClose,
  onDone,
}: {
  review: ReviewState | null;
  config: AdminProcessConfig;
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
                ? `Send ${trimAmount(review.withdrawal.netAmount)} ${review.withdrawal.currency} to the recipient out-of-band, then record the reference here.`
                : `Reserved ${trimAmount(review.withdrawal.totalAmount)} ${review.withdrawal.currency} returns to available.`)}
          </DialogDescription>
        </DialogHeader>

        {review && (
          <div className="space-y-1 rounded-md border bg-muted/30 p-3 text-sm">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">Amount</span>
              <span className="font-mono">
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
              <span className="text-xs text-muted-foreground">Net</span>
              <span className="font-mono">
                {trimAmount(review.withdrawal.netAmount)} {review.withdrawal.currency}
              </span>
            </div>
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
