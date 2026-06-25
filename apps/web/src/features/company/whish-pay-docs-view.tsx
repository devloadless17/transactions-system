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
    "paidAt": null,
    "createdAt": "2026-06-04T12:00:00.000Z"
  }
}
# needsAttention=true means Whish took the money but settlement into your wallet
# failed (e.g. a commission rule changed) — contact support if you see it.`;

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
        <strong className="text-foreground">No need to poll:</strong> every payment — pending, paid,
        or failed — is pushed to your CRM automatically (see the{' '}
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
      'Decimal string, e.g. "25.00". A commission rule (set by your platform admin) must cover this amount, otherwise you get 422 NO_COMMISSION_RULE.',
    ],
    ['currency', 'Currency code. Whish is USD only.'],
    ['invoice', 'Your own order/reference label (1–200 chars). Shown back on the payment.'],
    [
      'idempotencyKey',
      'Optional (8–120 chars). A retried create with the same key returns the original link instead of minting a duplicate — safe to retry on a network error.',
    ],
    [
      'successRedirectUrl',
      'Optional (http/https). Where your customer is sent after a successful payment — overrides your saved default for this one link. We append ?ref=<externalId> so your page can identify it.',
    ],
    ['failureRedirectUrl', 'Optional. Same, for a failed or abandoned payment.'],
  ];
  const statuses: [string, string][] = [
    ['PENDING', 'Link created, waiting for the customer to pay.'],
    ['PAID', 'Customer paid — settled into your wallet (net of commission); transactionId is set.'],
    [
      'FAILED',
      'The payment did not go through — declined, or the link lapsed unpaid. (Whish reports no separate “expired”, so both arrive as FAILED.)',
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
        </div>
      </CardContent>
    </Card>
  );
}
