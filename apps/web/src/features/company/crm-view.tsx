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
  type CrmTransactionStatus,
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

function statusVariant(s: CrmTransactionStatus) {
  if (s === 'COMPLETED') return 'success' as const;
  if (s === 'FAILED' || s === 'EXPIRED' || s === 'REVERSED') return 'destructive' as const;
  return 'secondary' as const;
}

export function CrmView() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">CRM integration</h1>
        <p className="text-sm text-muted-foreground">
          We POST every transaction to your CRM as its status changes — pending when it starts, then
          completed once it settles (and failed / expired / reversed). Records are matched by a
          stable <span className="font-mono">reference</span>, so your CRM updates the same row in
          place.
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
  const example = `POST https://your-crm.com/api/transactions
Authorization: Bearer <your-api-key>
Content-Type: application/json
x-crm-event: transaction.completed

{
  "event": "transaction.completed",
  "reference": "whish:10231",
  "sentAt": "2026-06-04T12:00:00.000Z",
  "transaction": {
    "id": "0e1c…",
    "status": "COMPLETED",
    "source": "whish",
    "externalTransactionId": "10231",
    "amount": "25.00",
    "currency": "USD",
    "netAmount": "24.50",
    "commissionAmount": "0.50",
    "customer": "John Doe",
    "tradingAccount": null,
    "phone": "+961…",
    "note": "Order #1234",
    "occurredAt": "2026-06-04T12:00:00.000Z"
  }
}`;
  const events: [string, string][] = [
    ['transaction.pending', 'A transaction was created and is awaiting settlement.'],
    ['transaction.completed', 'It settled — funds credited.'],
    ['transaction.failed', 'The transaction did not go through.'],
    ['transaction.expired', 'A pending collection lapsed unpaid.'],
    ['transaction.reversed', 'A settled transaction was reversed.'],
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>What we send</CardTitle>
        <CardDescription>
          Each event is a POST carrying the full transaction and a stable{' '}
          <span className="font-mono">reference</span>. Upsert by reference so one record moves
          PENDING → COMPLETED in place. We send your saved key as{' '}
          <span className="font-mono">Authorization: Bearer &lt;key&gt;</span> and name the event in
          the <span className="font-mono">x-crm-event</span> header.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <CodeBlock code={example} />
        <div>
          <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">Events</p>
          <div className="space-y-1">
            {events.map(([e, d]) => (
              <div
                key={e}
                className="grid grid-cols-12 gap-2 border-b py-1.5 text-xs last:border-0"
              >
                <code className="col-span-4 font-mono">{e}</code>
                <span className="col-span-8 text-muted-foreground">{d}</span>
              </div>
            ))}
          </div>
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
            No events yet. Enable the demo CRM above, then create a Whish payment link or ingest a
            transaction.
          </div>
        ) : (
          <ul className="space-y-2">
            {events.map((e) => (
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
                    {e.transaction.customer ?? e.transaction.note ?? '—'}
                    <span className="text-muted-foreground"> · {e.transaction.source}</span>
                  </div>
                </div>
                <div className="shrink-0 text-right">
                  <div className="font-mono text-sm">
                    {e.transaction.amount} {e.transaction.currency}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {new Date(e.receivedAt).toLocaleTimeString()}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
