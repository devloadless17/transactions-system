'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  WithdrawalStatus,
  type CompanyResponse,
  type PaginatedResponse,
  type WithdrawalResponse,
} from '@app/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
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
import { PayoutInstructions, prettyMethod } from '@/features/company/withdrawals-view';

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
  const [filter, setFilter] = useState<WithdrawalStatus | ''>('PENDING');
  const [review, setReview] = useState<ReviewState | null>(null);

  const params = new URLSearchParams({ pageSize: '50' });
  if (filter) params.set('status', filter);

  const listQ = useQuery({
    queryKey: [...config.queryKey, params.toString()],
    queryFn: () =>
      apiFetch<PaginatedResponse<WithdrawalResponse>>(
        `${config.listEndpoint}?${params.toString()}`,
      ),
  });

  const companiesQ = useQuery({
    queryKey: ['admin', 'companies', 'all'],
    queryFn: () => apiFetch<PaginatedResponse<CompanyResponse>>('/admin/companies?pageSize=100'),
  });
  const companyName = (id: string) =>
    companiesQ.data?.data.find((c) => c.id === id)?.name ?? id.slice(0, 8);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{config.heading}</h1>
        <p className="text-sm text-muted-foreground">{config.subhead}</p>
      </div>

      <Card>
        <CardContent className="space-y-4 p-4">
          <div className="space-y-1">
            <Label className="text-xs">Status</Label>
            <select
              value={filter}
              onChange={(e) => setFilter((e.target.value as WithdrawalStatus) || '')}
              className="h-10 rounded-md border border-input bg-background px-3 text-sm"
            >
              <option value="">All</option>
              {Object.values(WithdrawalStatus).map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Company</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Currency</TableHead>
                <TableHead>Method</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Requested</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {listQ.isLoading && (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {listQ.data?.data.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-8 text-center text-muted-foreground">
                    Nothing to review.
                  </TableCell>
                </TableRow>
              )}
              {listQ.data?.data.map((w) => (
                <TableRow
                  key={w.id}
                  className="cursor-pointer"
                  onClick={() => setReview({ withdrawal: w, action: 'approve' })}
                >
                  <TableCell>{companyName(w.companyId)}</TableCell>
                  <TableCell className="text-right font-mono">{trimAmount(w.amount)}</TableCell>
                  <TableCell>{w.currency}</TableCell>
                  <TableCell className="text-xs">{prettyMethod(w.payoutMethod)}</TableCell>
                  <TableCell>
                    <Badge variant={statusVariant(w.status)}>{w.status}</Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {new Date(w.createdAt).toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right" onClick={(e) => e.stopPropagation()}>
                    {w.status === 'PENDING' && (
                      <div className="flex justify-end gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setReview({ withdrawal: w, action: 'reject' })}
                        >
                          Reject
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => setReview({ withdrawal: w, action: 'approve' })}
                        >
                          Approve
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

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

  // Reset form whenever the targeted row/action changes so we don't
  // carry stale text from a previous one.
  const lastId = review?.withdrawal.id + '-' + review?.action;

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
              `${trimAmount(review.withdrawal.amount)} ${review.withdrawal.currency} — ${
                review.action === 'approve'
                  ? 'Send the money out-of-band, then record the reference here.'
                  : 'Reserved funds will return to available.'
              }`}
          </DialogDescription>
        </DialogHeader>

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
