import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CodeBlock } from '@/components/ui/code-block';
import { publicApiBase } from '@/lib/api';

const API_BASE = typeof window !== 'undefined' ? publicApiBase() : 'http://localhost:3001/v1';

const CREATE_CURL = `curl -X POST ${API_BASE}/integrations/whish/payments \\
  -H "Authorization: Bearer tsk_<company-key>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "amount": "25.00",
    "currency": "USD",
    "invoice": "Order #4821"
  }'`;

const CREATE_RESPONSE = `{
  "success": true,
  "statusCode": 201,
  "data": {
    "id": "6729acd0-16c4-40ff-8474-4ef864538587",
    "companyId": "b3f1c2d4-...-e9",
    "externalId": "1781018591",
    "status": "PENDING",
    "amount": "25.00",
    "currency": "USD",
    "invoice": "Order #4821",
    "collectUrl": "https://whish.money/collect/7kEo2a7",
    "payerPhoneNumber": null,
    "transactionId": null,
    "needsAttention": false,
    "settlementError": null,
    "paidAt": null,
    "createdAt": "2026-06-04T12:00:00.000Z"
  }
}
# needsAttention=true means Whish took the money but settlement into your wallet
# failed (e.g. a commission rule changed). settlementError holds the reason; once
# your platform admin fixes the cause, refresh the payment and it settles.`;

const STATUS_CURL = `curl ${API_BASE}/integrations/whish/payments/1781018591 \\
  -H "Authorization: Bearer tsk_<company-key>"
# Same shape as create. Watch \`status\` (and \`transactionId\` once PAID).
# This object shows only the GROSS amount. For the fee we took + your net, read the
# settled transaction (reference whish:<externalId>): GET /company/transactions returns
# commissionAmount + netAmount (also sent on the transaction.completed CRM event).`;

/**
 * Whish Pay — what it is, how it flows, and how to create links from your
 * backend. Day-to-day use is the no-code /app/whish page; the API section is for
 * companies that mint links from their own server. Every status change is pushed
 * to the CRM, so there is nothing to poll.
 */
export function WhishPayDocsView() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Whish Pay</h1>
        <p className="text-sm text-muted-foreground">
          Collect payments with a hosted link — by hand on the{' '}
          <Link href="/app/whish" className="text-primary hover:underline">
            Whish Pay
          </Link>{' '}
          page, or from your own backend via the API below. Share the link with your customer and
          the money settles into your wallet automatically once they pay — net of commission, with
          no card details ever touching your system.
        </p>
      </div>

      <HowItWorks />
      <ApiSection />

      <p className="rounded-md border-l-4 border-primary bg-primary/5 p-3 text-xs text-muted-foreground">
        <strong className="text-foreground">No need to poll:</strong> every payment is pushed to
        your CRM automatically — <code className="font-mono">transaction.pending</code> when the
        link is created, then <code className="font-mono">transaction.completed</code> once it
        settles (or <code className="font-mono">transaction.failed</code> if it is declined or
        lapses), all under the same <code className="font-mono">whish:&lt;externalId&gt;</code>{' '}
        reference (see the{' '}
        <Link href="/app/documentation?tab=crm" className="text-primary hover:underline">
          CRM
        </Link>{' '}
        tab). The status endpoint below is just for reconciliation or if you do not use a CRM.
      </p>
    </div>
  );
}

function HowItWorks() {
  const steps: [string, string][] = [
    [
      'Create a link',
      'On the Whish Pay page (or via the API below), enter the amount and an invoice label.',
    ],
    ['Share it', 'Send the generated link to your customer — they pay on the secure Whish page.'],
    [
      'It settles automatically',
      'Once paid, we verify with Whish, apply your commission, and credit your wallet with the net.',
    ],
    [
      'Stay in sync',
      'The transaction is pushed to your CRM at every step (pending, then paid or failed), so your records update on their own.',
    ],
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>How it works</CardTitle>
        <CardDescription>Four steps, end to end.</CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="space-y-3">
          {steps.map(([t, d], i) => (
            <li key={t} className="flex gap-3">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground">
                {i + 1}
              </span>
              <div>
                <p className="text-sm font-medium">{t}</p>
                <p className="text-xs text-muted-foreground">{d}</p>
              </div>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

function ApiSection() {
  const fields: [string, string][] = [
    [
      'amount',
      'A decimal string in quotes — "25.00", never the bare number 25.00. Whish recommends at most 2 decimal places (cents) and a minimum of 1.00 for USD; other amounts are still accepted. A commission rule (set by your platform admin) must cover it, otherwise you get 422 NO_COMMISSION_RULE. The amount is fixed on the hosted page: your customer cannot pay more or less, so partial and over-payments are impossible and every callback carries this exact figure.',
    ],
    [
      'currency',
      'Exactly "USD" (uppercase) — the only currency this platform currently enables for Whish links. Anything else is a 400 VALIDATION_ERROR.',
    ],
    [
      'invoice',
      'Required. Your own order/reference label (1–200 chars). Shown back on the payment.',
    ],
    [
      'idempotencyKey',
      'Optional (8–120 chars). A retried create with the same key returns the original link instead of minting a duplicate — safe to retry on a network error. Matching is on the key alone: reuse it with a different amount and you silently get the first payment back, so use a fresh key per order.',
    ],
    [
      'successRedirectUrl',
      'Optional (http/https). Where your customer is sent after a successful payment — overrides your saved default for this one link. We append ?ref=<externalId> so your page can identify it. Must be publicly reachable — localhost / 127.0.0.1 are rejected, because a payer browser (and Whish itself) cannot open them. Leave empty while developing locally to use the platform pages.',
    ],
    ['failureRedirectUrl', 'Optional. Same, for a failed or abandoned payment.'],
  ];
  const statuses: [string, string][] = [
    [
      'PENDING',
      'Link created, waiting for the customer to pay. A failed attempt does not close the link — the customer can try again on the same link until it lapses.',
    ],
    ['PAID', 'Customer paid — settled into your wallet (net of commission); transactionId is set.'],
    [
      'FAILED',
      'The payment will not be collected — the link lapsed unpaid, or a completed payment was refunded. (Whish reports no separate “expired”, so a lapsed link also arrives as FAILED.)',
    ],
  ];
  const errors: [string, string][] = [
    [
      '400 VALIDATION_ERROR',
      'A field is malformed — most often amount sent as a number instead of a "string", a currency other than "USD", or a missing invoice. The error body names the offending field.',
    ],
    [
      '422 NO_COMMISSION_RULE',
      'No commission rule covers this amount for your company, so the link is refused before any customer pays. Ask your platform admin to add a rule covering your amounts.',
    ],
    [
      '422 COMMISSION_EXCEEDS_AMOUNT',
      'The configured fee for this amount is larger than the amount itself, so the link is refused before any customer pays. Ask your platform admin to review the rule for small amounts.',
    ],
    [
      '401 / 403',
      'Auth failed. Send your company key as Authorization: Bearer tsk_… — these are server-to-server (no cookies/session).',
    ],
    [
      '502 WHISH_ERROR',
      'Whish itself errored or was unreachable. Safe to retry (reuse your idempotencyKey); if it persists, contact support.',
    ],
    [
      '502 WHISH_PENDING',
      'We could not confirm the outcome with Whish — do NOT treat this as a failure, and do NOT create a second payment under a new key. error.details carries externalId and paymentId. Retry the create with the SAME idempotencyKey and we re-attempt the same payment (returning it with its collectUrl once Whish answers), or look it up by paymentId.',
    ],
    [
      'needsAttention: true',
      'Created and paid, but settlement into your wallet failed — read settlementError for the reason. Once the cause is fixed, refresh the payment and it settles.',
    ],
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Create links from your backend (API)</CardTitle>
        <CardDescription>
          Authenticate with your company key (see{' '}
          <Link href="/app/documentation" className="text-primary hover:underline">
            Getting started
          </Link>
          ). These are server-to-server endpoints — Bearer key, no cookies, no CSRF.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div>
          <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">
            1. Create a payment link
          </p>
          <CodeBlock code={CREATE_CURL} />
        </div>

        <div>
          <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">Request fields</p>
          <div className="space-y-1">
            {fields.map(([f, d]) => (
              <div
                key={f}
                className="grid grid-cols-12 gap-2 border-b py-1.5 text-xs last:border-0"
              >
                <code className="col-span-3 font-mono">{f}</code>
                <span className="col-span-9 text-muted-foreground">{d}</span>
              </div>
            ))}
          </div>
        </div>

        <div>
          <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">Response</p>
          <CodeBlock code={CREATE_RESPONSE} />
          <p className="mt-2 text-xs text-muted-foreground">
            Send <code className="font-mono">collectUrl</code> to your customer and store{' '}
            <code className="font-mono">externalId</code> on your order — it is the reference you
            use to look the payment up and the same id every CRM event carries.
          </p>
        </div>

        <div className="rounded-md border-l-4 border-primary bg-primary/5 p-3 text-xs text-muted-foreground">
          <strong className="text-foreground">Where your customer lands after paying:</strong> set
          default success / failure pages once on the{' '}
          <Link href="/app/whish" className="text-primary hover:underline">
            Whish Pay
          </Link>{' '}
          page, or override per link with <code className="font-mono">successRedirectUrl</code> /{' '}
          <code className="font-mono">failureRedirectUrl</code> above. Set neither and we use our
          own confirmation pages. We always append{' '}
          <code className="font-mono">?ref=&lt;externalId&gt;</code> so your page knows which
          payment it was. (These are customer redirects only — the money reaches you via the CRM /
          status, not these URLs.)
        </div>

        <div>
          <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">
            2. Check a payment&apos;s status
          </p>
          <CodeBlock code={STATUS_CURL} />
          <p className="mt-2 text-xs text-muted-foreground">
            Force a fresh pull from Whish (e.g. after a missed callback) with{' '}
            <code className="font-mono">
              POST /integrations/whish/payments/&#123;externalId&#125;/refresh
            </code>
            .
          </p>
        </div>

        <div>
          <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">Statuses</p>
          <div className="space-y-1">
            {statuses.map(([s, d]) => (
              <div
                key={s}
                className="grid grid-cols-12 gap-2 border-b py-1.5 text-xs last:border-0"
              >
                <code className="col-span-3 font-mono">{s}</code>
                <span className="col-span-9 text-muted-foreground">{d}</span>
              </div>
            ))}
          </div>
          <p className="mt-2 rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
            <strong className="text-foreground">These are payment-link statuses.</strong> The same
            deposit also exists as a ledger transaction with different names: link{' '}
            <code className="font-mono">PAID</code> = transaction{' '}
            <code className="font-mono">COMPLETED</code> (event{' '}
            <code className="font-mono">transaction.completed</code>), link{' '}
            <code className="font-mono">FAILED</code> = event{' '}
            <code className="font-mono">transaction.failed</code>, link{' '}
            <code className="font-mono">PENDING</code> = event{' '}
            <code className="font-mono">transaction.pending</code> (no transaction row yet). There
            is no <code className="font-mono">EXPIRED</code> status in practice — nothing writes it.
            Withdrawals use a third set again (<code className="font-mono">PENDING</code>,{' '}
            <code className="font-mono">PROCESSING</code>,{' '}
            <code className="font-mono">COMPLETED</code>,{' '}
            <code className="font-mono">REJECTED</code>,{' '}
            <code className="font-mono">CANCELLED</code>), so a withdrawal is never{' '}
            <code className="font-mono">PAID</code> and a link is never{' '}
            <code className="font-mono">CANCELLED</code>.
          </p>
        </div>

        <div>
          <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">Common errors</p>
          <div className="space-y-1">
            {errors.map(([s, d]) => (
              <div
                key={s}
                className="grid grid-cols-12 gap-2 border-b py-1.5 text-xs last:border-0"
              >
                <code className="col-span-4 font-mono">{s}</code>
                <span className="col-span-8 text-muted-foreground">{d}</span>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
