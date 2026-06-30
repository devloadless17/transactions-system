'use client';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Send, AlertTriangle, KeyRound } from 'lucide-react';
import type { PaginatedResponse, WhishSessionStatus, WhishTransferResponse } from '@app/shared';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
import { apiFetch } from '@/lib/api.client';
import { ApiClientError } from '@/lib/api';
import { toast } from '@/lib/toast';

const PAGE_SIZE = 20;
const CURRENCY = 'USD';

function statusVariant(s: WhishTransferResponse['status']) {
  if (s === 'SUCCESS') return 'success' as const;
  if (s === 'FAILED') return 'destructive' as const;
  if (s === 'UNKNOWN') return 'destructive' as const;
  return 'secondary' as const; // PENDING
}

export function TransferMoneyView() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Transfer Money</h1>
        <p className="text-sm text-muted-foreground">
          Send a Whish-to-Whish transfer from the platform account straight to a phone number. This
          moves real money and is not tied to any company wallet.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <SendCard />
        <SessionCard />
      </div>

      <HistoryCard />
    </div>
  );
}

function SendCard() {
  const qc = useQueryClient();
  const [amount, setAmount] = useState('');
  const [phone, setPhone] = useState('');
  const [confirmOpen, setConfirmOpen] = useState(false);

  const valid =
    /^\d+(\.\d+)?$/.test(amount.trim()) && Number(amount) > 0 && /^\+?\d{6,15}$/.test(phone.trim());

  const mu = useMutation({
    mutationFn: () =>
      apiFetch<WhishTransferResponse>('/admin/whish/transfers', {
        method: 'POST',
        body: { amount: amount.trim(), recipientPhone: phone.trim(), currency: CURRENCY },
      }),
    onSuccess: (t) => {
      if (t.status === 'SUCCESS') {
        toast.success(`Sent ${t.amount} ${t.currency} to ${t.recipientPhone}`);
      } else if (t.status === 'UNKNOWN') {
        toast.error(
          `Transfer status is UNKNOWN — the money may have been sent. Reconcile manually before retrying (ref ${t.reference}).`,
        );
      } else {
        toast.error(`Transfer failed: ${t.upstreamMessage ?? 'see history'}`);
      }
      qc.invalidateQueries({ queryKey: ['admin', 'whish', 'transfers'] });
      setConfirmOpen(false);
      setAmount('');
      setPhone('');
    },
    onError: (e) => {
      toast.error(e instanceof ApiClientError ? e.message : 'Failed to send the transfer');
      setConfirmOpen(false);
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Send className="h-4 w-4" /> Send a transfer
        </CardTitle>
        <CardDescription>
          The amount you enter is the exact amount the recipient receives.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
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
          <Label className="text-xs">Recipient phone</Label>
          <Input
            inputMode="tel"
            placeholder="71505894"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </div>
        <Button
          className="w-full gap-1.5"
          disabled={!valid || mu.isPending}
          onClick={() => setConfirmOpen(true)}
        >
          <Send className="h-4 w-4" />
          Send transfer
        </Button>
      </CardContent>

      <Dialog open={confirmOpen} onOpenChange={(v) => !mu.isPending && setConfirmOpen(v)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm transfer</DialogTitle>
            <DialogDescription>
              Send{' '}
              <span className="font-semibold">
                {amount} {CURRENCY}
              </span>{' '}
              to <span className="font-mono">{phone}</span>? This moves real money out of the
              platform Whish account and cannot be undone here.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={mu.isPending}>
              Cancel
            </Button>
            <Button onClick={() => mu.mutate()} disabled={mu.isPending}>
              {mu.isPending ? 'Sending…' : `Send ${amount} ${CURRENCY}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function SessionCard() {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['admin', 'whish', 'w2w', 'session'],
    queryFn: () => apiFetch<WhishSessionStatus>('/admin/whish/w2w/session'),
    retry: false,
  });
  const [open, setOpen] = useState(false);

  const s = q.data;
  const expired = !!s && (!s.configured || !!s.lastAuthFailureAt);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="h-4 w-4" /> Whish session
        </CardTitle>
        <CardDescription>
          The captured Whish app session that signs transfers. It expires — re-paste a fresh one
          when transfers start failing.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {q.isLoading ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : (
          <>
            {!s?.configured && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 text-destructive" />
                <span>No session configured yet. Add one before sending transfers.</span>
              </div>
            )}
            {s?.configured && s.lastAuthFailureAt && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
                <AlertTriangle className="mt-0.5 h-4 w-4 text-destructive" />
                <span>
                  Whish rejected the session as expired/invalid (last seen{' '}
                  {new Date(s.lastAuthFailureAt).toLocaleString()}). Re-capture and update it.
                </span>
              </div>
            )}
            {s?.configured && (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                <dt className="text-muted-foreground">Device ID</dt>
                <dd className="font-mono">{s.deviceId}</dd>
                <dt className="text-muted-foreground">Server ID</dt>
                <dd className="font-mono">{s.serverId}</dd>
                <dt className="text-muted-foreground">itel version</dt>
                <dd className="font-mono">{s.itelVersion}</dd>
                <dt className="text-muted-foreground">Session counter</dt>
                <dd className="font-mono">{s.sessionCounter}</dd>
                <dt className="text-muted-foreground">Rotated</dt>
                <dd>{s.lastRotatedAt ? new Date(s.lastRotatedAt).toLocaleString() : '—'}</dd>
              </dl>
            )}
            <Button
              variant={expired ? 'default' : 'outline'}
              className="w-full"
              onClick={() => setOpen(true)}
            >
              {s?.configured ? 'Update session credentials' : 'Add session credentials'}
            </Button>
          </>
        )}
      </CardContent>

      <SessionDialog
        open={open}
        onOpenChange={setOpen}
        seed={s}
        onSaved={() => {
          qc.invalidateQueries({ queryKey: ['admin', 'whish', 'w2w', 'session'] });
          setOpen(false);
        }}
      />
    </Card>
  );
}

const SESSION_FIELDS = [
  { key: 'token', label: 'token', secret: true },
  { key: 'uid', label: 'uid', secret: true },
  { key: 'sessionId', label: 'sessionid', secret: true },
  { key: 'deviceId', label: 'deviceId', secret: false },
  { key: 'serverId', label: 'serverid', secret: false },
  { key: 'itelVersion', label: 'itelVersion', secret: false },
  { key: 'osVersion', label: 'osVersion', secret: false },
  { key: 'operatingSystem', label: 'operatingSystem', secret: false },
  { key: 'userAgent', label: 'User-Agent', secret: false },
] as const;

type SessionForm = Record<(typeof SESSION_FIELDS)[number]['key'], string> & {
  sessionCounter: string;
};

function SessionDialog({
  open,
  onOpenChange,
  seed,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  seed: WhishSessionStatus | undefined;
  onSaved: () => void;
}) {
  const empty: SessionForm = {
    token: '',
    uid: '',
    sessionId: '',
    deviceId: '',
    serverId: '',
    itelVersion: '',
    osVersion: '',
    operatingSystem: '',
    userAgent: '',
    sessionCounter: '',
  };
  const [form, setForm] = useState<SessionForm>(empty);

  // Pre-fill the non-secret fields from the current session when the dialog opens.
  useEffect(() => {
    if (open) {
      setForm({
        ...empty,
        deviceId: seed?.deviceId ?? '',
        serverId: seed?.serverId ?? '',
        itelVersion: seed?.itelVersion ?? '',
        sessionCounter: seed?.sessionCounter != null ? String(seed.sessionCounter) : '',
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const set = (k: keyof SessionForm, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const valid =
    SESSION_FIELDS.every((f) => form[f.key].trim().length > 0) &&
    /^\d+$/.test(form.sessionCounter.trim());

  const mu = useMutation({
    mutationFn: () =>
      apiFetch<WhishSessionStatus>('/admin/whish/w2w/session', {
        method: 'PUT',
        body: {
          token: form.token.trim(),
          uid: form.uid.trim(),
          sessionId: form.sessionId.trim(),
          deviceId: form.deviceId.trim(),
          serverId: form.serverId.trim(),
          itelVersion: form.itelVersion.trim(),
          osVersion: form.osVersion.trim(),
          operatingSystem: form.operatingSystem.trim(),
          userAgent: form.userAgent.trim(),
          sessionCounter: Number(form.sessionCounter.trim()),
        },
      }),
    onSuccess: () => {
      toast.success('Whish session updated');
      onSaved();
    },
    onError: (e) =>
      toast.error(e instanceof ApiClientError ? e.message : 'Failed to update session'),
  });

  return (
    <Dialog open={open} onOpenChange={(v) => !mu.isPending && onOpenChange(v)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Whish session credentials</DialogTitle>
          <DialogDescription>
            Paste the headers from a freshly captured, logged-in Whish app session. Secrets are
            encrypted at rest and never shown again.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          {SESSION_FIELDS.map((f) => (
            <div key={f.key} className="space-y-1">
              <Label className="text-xs">{f.label}</Label>
              <Input
                className="font-mono text-xs"
                value={form[f.key]}
                placeholder={f.secret ? '••••••' : undefined}
                onChange={(e) => set(f.key, e.target.value)}
              />
            </div>
          ))}
          <div className="space-y-1">
            <Label className="text-xs">sessionCounter (starting value from the capture)</Label>
            <Input
              inputMode="numeric"
              className="font-mono text-xs"
              value={form.sessionCounter}
              onChange={(e) => set('sessionCounter', e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={mu.isPending}>
            Cancel
          </Button>
          <Button onClick={() => mu.mutate()} disabled={!valid || mu.isPending}>
            {mu.isPending ? 'Saving…' : 'Save session'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function HistoryCard() {
  const [page, setPage] = useState(1);
  const q = useQuery({
    queryKey: ['admin', 'whish', 'transfers', { page }],
    queryFn: () =>
      apiFetch<PaginatedResponse<WhishTransferResponse>>(
        `/admin/whish/transfers?page=${page}&pageSize=${PAGE_SIZE}`,
      ),
  });
  const data = q.data;

  useEffect(() => {
    const tp = data?.meta.totalPages;
    if (tp && page > tp) setPage(tp);
  }, [data, page]);

  const columns: Column<WhishTransferResponse>[] = [
    {
      key: 'created',
      header: 'When',
      className: 'text-xs text-muted-foreground whitespace-nowrap',
      cell: (t) => new Date(t.createdAt).toLocaleString(),
    },
    {
      key: 'phone',
      header: 'Recipient',
      className: 'font-mono text-sm',
      cell: (t) => t.recipientPhone,
    },
    {
      key: 'amount',
      header: 'Amount',
      align: 'right',
      className: 'font-mono',
      cell: (t) => `${t.amount} ${t.currency}`,
    },
    {
      key: 'status',
      header: 'Status',
      cell: (t) => (
        <div className="flex items-center gap-2">
          <Badge
            variant={statusVariant(t.status)}
            title={
              t.status === 'UNKNOWN' ? 'May have been sent — reconcile before retrying' : undefined
            }
          >
            {t.status}
          </Badge>
          {t.upstreamMessage && t.status !== 'SUCCESS' && (
            <span className="truncate text-xs text-muted-foreground" title={t.upstreamMessage}>
              {t.upstreamMessage}
            </span>
          )}
        </div>
      ),
    },
    {
      key: 'ref',
      header: 'Reference / trace',
      className: 'font-mono text-xs text-muted-foreground',
      cell: (t) => (
        <div className="flex flex-col">
          <span>{t.reference}</span>
          {t.traceId && <span className="opacity-70">trace {t.traceId}</span>}
        </div>
      ),
    },
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Transfer history</CardTitle>
        <CardDescription>Every transfer attempt, newest first.</CardDescription>
      </CardHeader>
      <CardContent className="p-0">
        <DataTable<WhishTransferResponse>
          columns={columns}
          rows={data?.data}
          isLoading={q.isLoading}
          error={q.error}
          rowKey={(t) => t.id}
          empty={<div className="py-8 text-center text-muted-foreground">No transfers yet.</div>}
        />
      </CardContent>
      {data && (
        <div className="p-4">
          <Pagination
            page={data.meta.page}
            total={data.meta.total}
            totalPages={data.meta.totalPages}
            onPageChange={setPage}
          />
        </div>
      )}
    </Card>
  );
}
