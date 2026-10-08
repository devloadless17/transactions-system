'use client';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { toast } from '@/lib/toast';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  setCrmConfigSchema,
  type CrmConfigResponse,
  type CrmDemoEventResponse,
  type CrmEventStatus,
  type PayoutDetails,
  type SetCrmConfigInput,
} from '@app/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { CodeBlock } from '@/components/ui/code-block';
import { apiFetch } from '@/lib/api.client';
import { ApiClientError } from '@/lib/api';

const CONFIG_KEY = ['company', 'crm', 'config'] as const;
const INBOX_KEY = ['company', 'crm'] as const;

function statusVariant(s: CrmEventStatus) {
  if (s === 'COMPLETED') return 'success' as const;
  if (s === 'FAILED' || s === 'EXPIRED' || s === 'REVERSED' || s === 'REJECTED')
    return 'destructive' as const;
  return 'secondary' as const; // PENDING, CANCELLED
}

// The human-readable destination label for a withdrawal, derived from its
// payoutDetails (the payload's single source of truth): recipient name for
// cash / Whish, account holder for a bank transfer, wallet address for crypto.
function payoutName(d: PayoutDetails | null): string | null {
  if (!d) return null;
  switch (d.method) {
    case 'CASH':
    case 'WISH':
      return d.recipientName;
    case 'BANK_TRANSFER':
      return d.accountHolder;
    case 'CRYPTO':
      return d.walletAddress;
    case 'OTHER':
      return d.description;
    default:
      return null;
  }
}

export function CrmView() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">CRM integration</h1>
        <p className="text-sm text-muted-foreground">
          We POST every deposit and withdrawal to your CRM as its status changes — a deposit moves
          pending → completed (or failed if it doesn&apos;t go through / lapses, and reversed); a
          withdrawal moves pending → completed, rejected, or cancelled. Records are matched by a
          stable <span className="font-mono">reference</span>, so your CRM updates the same row in
          place. (Payouts and loads are managed over the API only — they are not pushed here.)
        </p>
      </div>

      <ConfigCard />
      <ContractCard />
      <DemoInbox />
    </div>
  );
}

function ConfigCard() {
  const qc = useQueryClient();
  const cfgQ = useQuery({
    queryKey: CONFIG_KEY,
    queryFn: () => apiFetch<CrmConfigResponse>('/company/crm/config'),
  });
  const cfg = cfgQ.data;

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<SetCrmConfigInput>({
    resolver: zodResolver(setCrmConfigSchema),
    defaultValues: { apiUrl: '', apiKey: '' },
  });

  // Reflect the saved URL once it loads (the key itself is never returned).
  useEffect(() => {
    if (cfg) reset({ apiUrl: cfg.apiUrl ?? '', apiKey: '' });
  }, [cfg, reset]);

  const saveMu = useMutation({
    mutationFn: (input: SetCrmConfigInput) =>
      apiFetch<CrmConfigResponse>('/company/crm/config', { method: 'PUT', body: input }),
    onSuccess: () => {
      toast.success('CRM connected');
      qc.invalidateQueries({ queryKey: INBOX_KEY });
    },
    onError: (err) => toast.error(err instanceof ApiClientError ? err.message : 'Failed'),
  });

  const clearMu = useMutation({
    mutationFn: () => apiFetch<CrmConfigResponse>('/company/crm/config', { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('CRM disconnected');
      qc.invalidateQueries({ queryKey: INBOX_KEY });
    },
    onError: (err) => toast.error(err instanceof ApiClientError ? err.message : 'Failed'),
  });

  // Type-to-confirm guard for "Try the demo CRM": enabling the demo OVERWRITES
  // the company's real CRM URL + key, which is unrecoverable. Companies were
  // doing this by accident and silently losing their live CRM connection.
  const [demoOpen, setDemoOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');

  const demoMu = useMutation({
    mutationFn: () => apiFetch<CrmConfigResponse>('/company/crm/demo/enable', { method: 'POST' }),
    onSuccess: () => {
      toast.success('Demo CRM connected — trigger a transaction to see it land below');
      setDemoOpen(false);
      setConfirmText('');
      qc.invalidateQueries({ queryKey: INBOX_KEY });
      qc.invalidateQueries({ queryKey: CONFIG_KEY });
    },
    onError: (err) => toast.error(err instanceof ApiClientError ? err.message : 'Failed'),
  });

  const usingDemo = !!cfg?.demoUrl && cfg.apiUrl === cfg.demoUrl;
  // A real (non-demo) CRM is configured and would be destroyed by enabling demo.
  const hasRealCrm = !usingDemo && (!!cfg?.apiUrl || !!cfg?.hasApiKey);
  const CONFIRM_WORD = 'REPLACE';
  const confirmOk = !hasRealCrm || confirmText.trim().toUpperCase() === CONFIRM_WORD;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle>Your CRM endpoint</CardTitle>
            <CardDescription>
              The POST URL of your CRM and the API key it expects. We send the key as{' '}
              <span className="font-mono">Authorization: Bearer &lt;key&gt;</span> on every request.
              Setting or clearing this config is <strong>dashboard-only</strong> — an API key can
              read it but gets <span className="font-mono">403 FORBIDDEN</span> on writes, so a
              leaked key can never repoint your event stream.
            </CardDescription>
          </div>
          <Badge variant={cfg?.enabled ? 'success' : 'secondary'}>
            {cfg?.enabled ? (usingDemo ? 'DEMO ACTIVE' : 'CONNECTED') : 'NOT CONNECTED'}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <form onSubmit={handleSubmit((values) => saveMu.mutate(values))} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="apiUrl">CRM POST URL</Label>
            <Input
              id="apiUrl"
              placeholder="https://your-crm.com/api/transactions"
              {...register('apiUrl')}
            />
            {errors.apiUrl && <p className="text-sm text-destructive">{errors.apiUrl.message}</p>}
          </div>
          <div className="space-y-2">
            <Label htmlFor="apiKey">API key</Label>
            <Input
              id="apiKey"
              type="password"
              placeholder={
                cfg?.hasApiKey ? '•••••••• (saved — type to replace)' : 'Your CRM API key'
              }
              {...register('apiKey')}
            />
            {errors.apiKey && <p className="text-sm text-destructive">{errors.apiKey.message}</p>}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={saveMu.isPending}>
              {saveMu.isPending ? 'Saving…' : 'Save & connect'}
            </Button>
            {cfg?.enabled && (
              <Button
                type="button"
                variant="outline"
                disabled={clearMu.isPending}
                onClick={() => clearMu.mutate()}
              >
                Disconnect
              </Button>
            )}
            <Button
              type="button"
              variant="secondary"
              disabled={demoMu.isPending}
              onClick={() => {
                setConfirmText('');
                setDemoOpen(true);
              }}
            >
              {demoMu.isPending ? 'Enabling…' : 'Try the demo CRM'}
            </Button>
          </div>
        </form>

        <Dialog
          open={demoOpen}
          onOpenChange={(v) => {
            setDemoOpen(v);
            if (!v) setConfirmText('');
          }}
        >
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>
                {hasRealCrm ? 'Replace your CRM with the demo?' : 'Enable the demo CRM?'}
              </DialogTitle>
              <DialogDescription>
                The demo CRM is a built-in preview that receives your events so you can see the
                integration live.
              </DialogDescription>
            </DialogHeader>

            {hasRealCrm ? (
              <div className="space-y-3">
                <div className="space-y-1 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                  <p className="font-semibold">This overwrites your real CRM connection.</p>
                  <p>
                    Your current CRM URL{cfg?.hasApiKey ? ' and API key' : ''} will be replaced by
                    the demo and <strong>cannot be recovered</strong> — your live CRM stops
                    receiving events until you re-enter and save its details.
                  </p>
                  {cfg?.apiUrl && (
                    <p className="break-all font-mono text-xs">Current: {cfg.apiUrl}</p>
                  )}
                </div>
                <div className="space-y-1">
                  <Label htmlFor="demoConfirm">
                    Type <span className="font-mono font-semibold">{CONFIRM_WORD}</span> to confirm
                  </Label>
                  <Input
                    id="demoConfirm"
                    autoComplete="off"
                    value={confirmText}
                    onChange={(e) => setConfirmText(e.target.value)}
                    placeholder={CONFIRM_WORD}
                  />
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                You don&apos;t have a CRM connected, so nothing will be lost. You can switch to your
                own CRM anytime by entering its URL and key above.
              </p>
            )}

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setDemoOpen(false)}>
                Cancel
              </Button>
              <Button
                type="button"
                variant={hasRealCrm ? 'destructive' : 'default'}
                disabled={!confirmOk || demoMu.isPending}
                onClick={() => demoMu.mutate()}
              >
                {demoMu.isPending
                  ? 'Enabling…'
                  : hasRealCrm
                    ? 'Replace with demo CRM'
                    : 'Enable demo CRM'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        {usingDemo && (
          <p className="text-xs text-muted-foreground">
            You&apos;re pointed at the built-in demo CRM. Trigger a transaction (e.g. create a Whish
            payment link) and watch it arrive in the inbox below, exactly as your own CRM would
            receive it.
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function ContractCard() {
  const depositExample = `POST https://your-crm.com/api/transactions
Authorization: Bearer <your-api-key>
Content-Type: application/json
x-crm-event: transaction.completed
x-crm-timestamp: 1781018591
x-crm-signature: t=1781018591,sha256=<hex>

{
  "event": "transaction.completed",
  "reference": "whish:10231",
  "sentAt": "2026-06-04T12:00:00.000Z",
  "transaction": {
    "id": "0e1c…",
    "status": "COMPLETED",
    "source": "whish",
    "externalTransactionId": "10231",
    "amount": "25",
    "currency": "USD",
    "netAmount": "24.5",
    "commissionAmount": "0.5",
    "networkFeeAmount": "0",
    "customer": "John Doe",
    "tradingAccount": null,
    "phone": "+961…",
    "note": "Order #1234",
    "occurredAt": "2026-06-04T12:00:00.000Z"
  }
}`;
  const withdrawalExample = `x-crm-event: withdrawal.completed
(same Authorization / x-crm-timestamp / x-crm-signature headers as above)

{
  "event": "withdrawal.completed",
  "reference": "withdrawal:d4f2a1c0-…",
  "sentAt": "2026-06-10T11:30:00.000Z",
  "withdrawal": {
    "id": "d4f2a1c0-…",
    "status": "COMPLETED",              // approved by an admin & paid out
    "amount": "500",                    // the amount you requested
    "totalAmount": "500",               // what left your wallet (net + fee + network fee)
    "feeAmount": "5",                   // the platform fee we charged
    "networkFeeAmount": "0",            // the optional network fee ("0" if not charged)
    "netAmount": "495",                 // what the recipient received
    "feeApplication": "DEDUCTED",       // DEDUCTED or ON_TOP (applies to both fees)
    "currency": "USD",
    "payoutMethod": "CASH",
    "payoutDetails": {                  // recipient + all instructions, one place
      "method": "CASH",
      "recipientName": "Acme Ltd",
      "recipientPhone": "+961-3-000-000",
      "pickupLocation": "Beirut – Hamra",
      "instructions": "Call on arrival"
    },
    "note": "Weekly settlement",        // your request note (immutable)
    "adminNote": "Verified",            // admin's note (the reason if REJECTED)
    "externalReference": "WIRE-88231",  // proof of payment (set once approved)
    "createdAt": "2026-06-10T10:00:00.000Z",  // when you requested it
    "processedAt": "2026-06-10T11:30:00.000Z", // when the admin decided (null if PENDING)
    "occurredAt": "2026-06-10T11:30:00.000Z"
  }
}`;
  const depositEvents: [string, string][] = [
    ['transaction.pending', 'A deposit was created and is awaiting settlement.'],
    ['transaction.completed', 'It settled — funds credited.'],
    [
      'transaction.failed',
      'The collection did not go through — declined, or the payment link lapsed unpaid. (Whish reports no separate “expired”, so both arrive as failed.)',
    ],
    ['transaction.reversed', 'A settled deposit was reversed.'],
  ];
  const withdrawalEvents: [string, string][] = [
    ['withdrawal.pending', 'Requested — status PENDING, awaiting an admin’s decision.'],
    [
      'withdrawal.completed',
      'Approved by an admin and paid out — status COMPLETED, with externalReference as proof.',
    ],
    [
      'withdrawal.rejected',
      'Rejected by an admin — status REJECTED, the reason in adminNote. Reserved funds released.',
    ],
    [
      'withdrawal.cancelled',
      'Cancelled by the company while still pending — status CANCELLED. Reserved funds released.',
    ],
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>What we send</CardTitle>
        <CardDescription>
          Each event is a POST carrying a stable <span className="font-mono">reference</span> and
          one body — <span className="font-mono">transaction</span> for deposit events (
          <span className="font-mono">transaction.*</span>) or{' '}
          <span className="font-mono">withdrawal</span> for withdrawal events (
          <span className="font-mono">withdrawal.*</span>). Upsert by reference so one record moves
          through its lifecycle in place. We send your saved key as{' '}
          <span className="font-mono">Authorization: Bearer &lt;key&gt;</span>, name the event in
          the <span className="font-mono">x-crm-event</span> header, and sign every request:{' '}
          <span className="font-mono">
            x-crm-signature: t=&lt;unixSeconds&gt;,sha256=&lt;hex&gt;
          </span>{' '}
          is an HMAC-SHA256 of{' '}
          <span className="font-mono">&#123;timestamp&#125;.&#123;rawBody&#125;</span> keyed by your
          API key (timestamp also in <span className="font-mono">x-crm-timestamp</span>) — recompute
          and compare it, and reject stale timestamps, to verify the call came from us.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div>
          <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">
            Deposit event — body: <span className="font-mono lowercase">transaction</span>
          </p>
          <CodeBlock code={depositExample} />
          <div className="mt-2 rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
            <p className="mb-1 font-medium text-foreground">Which id to match on</p>
            <ul className="ml-4 list-disc space-y-1">
              <li>
                <code className="font-mono">reference</code> — our stable key for the record&apos;s
                whole lifecycle:{' '}
                <code className="font-mono">
                  &quot;&lt;source&gt;:&lt;externalTransactionId&gt;&quot;
                </code>{' '}
                for deposits, always{' '}
                <code className="font-mono">&quot;withdrawal:&lt;id&gt;&quot;</code> for
                withdrawals. <strong className="text-foreground">Match on this.</strong>
              </li>
              <li>
                <code className="font-mono">externalTransactionId</code> — the provider&apos;s id
                (for Whish, the <code className="font-mono">externalId</code> from create, and the
                tail of <code className="font-mono">reference</code>).
              </li>
              <li>
                <code className="font-mono">id</code> — our ledger transaction UUID. It is{' '}
                <strong className="text-foreground">
                  null on transaction.pending and transaction.failed
                </strong>{' '}
                (no ledger row exists until the money settles), so never use it as a match key.
              </li>
            </ul>
            <p className="mt-2">
              Statuses on events are the same values the REST endpoints return, so webhooks and
              polling never need translating.
            </p>
          </div>
        </div>
        <div>
          <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">
            Withdrawal event — body: <span className="font-mono lowercase">withdrawal</span>
          </p>
          <CodeBlock code={withdrawalExample} />
          <p className="mt-2 text-xs text-muted-foreground">
            The withdrawal body mirrors the{' '}
            <code className="font-mono">GET /company/withdrawals/:id</code> resource
            field-for-field.{' '}
            <strong className="text-foreground">
              The decision is in <code className="font-mono">status</code>:
            </strong>{' '}
            <code className="font-mono">COMPLETED</code> = approved &amp; paid (proof in{' '}
            <code className="font-mono">externalReference</code>),{' '}
            <code className="font-mono">REJECTED</code> = declined (reason in{' '}
            <code className="font-mono">adminNote</code>),{' '}
            <code className="font-mono">CANCELLED</code> = you cancelled it — and{' '}
            <code className="font-mono">processedAt</code> is when it was decided (null while{' '}
            <code className="font-mono">PENDING</code>). The full payout instructions — phone,
            pickup, wallet / bank details — are in <code className="font-mono">payoutDetails</code>.
            Money:{' '}
            <code className="font-mono">
              totalAmount − feeAmount − networkFeeAmount = netAmount
            </code>
            .
          </p>
          <p className="mt-2 text-xs text-muted-foreground">
            <strong className="text-foreground">Fees on events.</strong> Both bodies carry{' '}
            <code className="font-mono">networkFeeAmount</code>, the optional network fee (
            <code className="font-mono">&quot;0&quot;</code> if you&apos;re not charged one). On
            deposit events it is <code className="font-mono">null</code> until the deposit
            completes, exactly like <code className="font-mono">commissionAmount</code> and{' '}
            <code className="font-mono">netAmount</code>; on withdrawal events it is always a
            string. An event queued before the field existed may omit it — treat a missing{' '}
            <code className="font-mono">networkFeeAmount</code> as{' '}
            <code className="font-mono">&quot;0&quot;</code>.
          </p>
        </div>
        <div>
          <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">Deposit events</p>
          <div className="space-y-1">
            {depositEvents.map(([e, d]) => (
              <EventRow key={e} event={e} desc={d} />
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            <code className="font-mono">transaction.expired</code> exists in our shared enums but is
            never emitted — a lapsed link arrives as{' '}
            <code className="font-mono">transaction.failed</code>. There is also no event for the
            transient <code className="font-mono">PROCESSING</code> withdrawal state. Ignore event
            names you don&apos;t recognise rather than erroring.
          </p>
        </div>
        <div>
          <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">
            Withdrawal events
          </p>
          <div className="space-y-1">
            {withdrawalEvents.map(([e, d]) => (
              <EventRow key={e} event={e} desc={d} />
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Payouts and loads are <strong>not</strong> pushed to your CRM — manage those over the
            REST API.
          </p>
        </div>
        <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
          <p className="mb-1 font-medium text-foreground">Delivery &amp; retries</p>
          Respond <strong>2xx</strong> to acknowledge. We attempt delivery up to 6 times — one
          immediate, then 5 retries with backoff. Only transient failures (timeouts, 429, and 5xx)
          are retried; a 4xx is treated as permanent and stops further attempts.
        </div>
      </CardContent>
    </Card>
  );
}

function EventRow({ event, desc }: { event: string; desc: string }) {
  return (
    <div className="grid grid-cols-12 gap-2 border-b py-1.5 text-xs last:border-0">
      <code className="col-span-5 font-mono">{event}</code>
      <span className="col-span-7 text-muted-foreground">{desc}</span>
    </div>
  );
}

function DemoInbox() {
  const inboxQ = useQuery({
    queryKey: INBOX_KEY,
    queryFn: () => apiFetch<CrmDemoEventResponse[]>('/company/crm/demo/inbox'),
  });
  const events = inboxQ.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Demo CRM inbox</CardTitle>
        <CardDescription>
          A live preview of the events we POST. This is the exact payload your CRM would receive —
          watch records flip from pending to completed in real time.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {events.length === 0 ? (
          <div className="py-10 text-center text-sm text-muted-foreground">
            No events yet. Enable the demo CRM above, then create a Whish payment link or wait for
            the next provider deposit.
          </div>
        ) : (
          <ul className="space-y-2">
            {events.map((e) => {
              // Each event carries exactly one body — a deposit `transaction` or
              // a `withdrawal`. Normalize both to a single display row.
              const t = e.transaction;
              const w = e.withdrawal;
              const label = t
                ? (t.customer ?? t.note ?? '—')
                : (payoutName(w?.payoutDetails ?? null) ?? w?.note ?? '—');
              const kind = t ? t.source : `withdrawal · ${w?.payoutMethod ?? ''}`;
              const amount = t ? t.amount : (w?.totalAmount ?? '');
              const currency = t ? t.currency : (w?.currency ?? '');
              return (
                <li
                  key={e.reference}
                  className="flex items-center justify-between gap-3 rounded-md border p-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs text-muted-foreground">{e.reference}</span>
                      <Badge variant={statusVariant(e.status)}>{e.status}</Badge>
                    </div>
                    <div className="mt-1 truncate text-sm">
                      {label}
                      <span className="text-muted-foreground"> · {kind}</span>
                    </div>
                  </div>
                  <div className="shrink-0 text-right">
                    <div className="font-mono text-sm">
                      {amount} {currency}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {new Date(e.receivedAt).toLocaleTimeString()}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
