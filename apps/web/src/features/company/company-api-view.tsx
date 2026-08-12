'use client';
import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CodeBlock } from '@/components/ui/code-block';
import { publicApiBase } from '@/lib/api';

const API_BASE = typeof window !== 'undefined' ? publicApiBase() : 'http://localhost:3001/v1';

const WALLETS_CURL = `curl ${API_BASE}/company/wallets \\
  -H "Authorization: Bearer tsk_<company-key>"

# Response — the wallets array is at data.data (the envelope wraps the list body)
{
  "success": true,
  "statusCode": 200,
  "data": {
    "data": [
      {
        "currency": "USD",
        "availableBalance": "1250.00",
        "pendingBalance": "0",
        "reservedBalance": "200.00"
      }
    ]
  }
}`;

const TRANSACTIONS_CURL = `curl "${API_BASE}/company/transactions?page=1&pageSize=20" \\
  -H "Authorization: Bearer tsk_<company-key>"
# The list array is at data.data, with paging info at meta.
# Page with ?page=N&pageSize=M (pageSize max 100).`;

const WITHDRAWAL_CASH_CURL = `curl -X POST ${API_BASE}/company/withdrawals \\
  -H "Authorization: Bearer tsk_<company-key>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "amount": "500.00",
    "currency": "USD",
    "notes": "Weekly settlement",
    "payout": {
      "method": "CASH",
      "recipientName": "Acme Ltd",
      "recipientPhone": "+961-3-000-000"
    }
  }'`;

const WITHDRAWAL_WISH_CURL = `curl -X POST ${API_BASE}/company/withdrawals \\
  -H "Authorization: Bearer tsk_<company-key>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "amount": "200.00",
    "currency": "USD",
    "payout": {
      "method": "WISH",
      "recipientName": "John Doe",
      "recipientPhone": "+961-70-000-000"
    }
  }'`;

const WITHDRAWAL_CRYPTO_CURL = `curl -X POST ${API_BASE}/company/withdrawals \\
  -H "Authorization: Bearer tsk_<company-key>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "amount": "100.00",
    "currency": "USD",
    "payout": {
      "method": "CRYPTO",
      "network": "TRC20",
      "walletAddress": "TXyz...abc"
    }
  }'`;

const WITHDRAWAL_RESPONSE = `{
  "success": true,
  "statusCode": 201,
  "data": {
    "id": "d4f2a1c0-...",
    "status": "PENDING",
    "amount": "500.00",
    "currency": "USD",
    "feeAmount": "5.00",            // the platform fee on this payout
    "feeApplication": "DEDUCTED",   // DEDUCTED or ON_TOP (see below)
    "netAmount": "495.00",          // what the recipient receives
    "totalAmount": "500.00",        // what leaves your wallet (net + fee)
    "payoutMethod": "CASH",
    "createdAt": "2026-06-10T10:00:00.000Z"
  }
}
# Fees are returned up front. DEDUCTED → recipient gets netAmount (amount − fee).
# ON_TOP → recipient gets the full amount and the fee is added, so totalAmount = amount + fee.`;

const STATUS_CURL = `curl ${API_BASE}/company/withdrawals/<id> \\
  -H "Authorization: Bearer tsk_<company-key>"

# Response — the live status and the full fee breakdown.
# (Same path shape for payouts and loads: /company/payouts/<id>, /company/loads/<id>.)
{
  "success": true,
  "statusCode": 200,
  "data": {
    "id": "d4f2a1c0-...",
    "status": "COMPLETED",
    "amount": "500.00",
    "currency": "USD",
    "feeAmount": "5.00",                 // the platform fee we charged
    "feeApplication": "DEDUCTED",
    "netAmount": "495.00",               // what the recipient received
    "totalAmount": "500.00",             // what left your wallet (net + fee)
    "payoutMethod": "CASH",
    "externalReference": "WIRE-88231",   // our proof we sent it (set on approval)
    "notes": "Weekly settlement",        // your original request note (never overwritten)
    "adminNotes": null,                  // set to the reason if a request is REJECTED
    "createdAt": "2026-06-10T10:00:00.000Z",
    "processedAt": "2026-06-10T11:30:00.000Z"
  }
}`;

const CANCEL_CURL = `curl -X POST ${API_BASE}/company/withdrawals/<id>/cancel \\
  -H "Authorization: Bearer tsk_<company-key>" \\
  -H "Content-Type: application/json" \\
  -d '{ "notes": "No longer needed" }'`;

export function CompanyApiView() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Company API</h1>
        <p className="text-sm text-muted-foreground">
          Your company key unlocks your whole account over plain HTTPS — read transactions, wallets,
          ledger, and analytics, and request withdrawals, payouts, and loads. Authentication and the
          response envelope are covered in{' '}
          <Link href="/app/documentation" className="text-primary hover:underline">
            Getting started
          </Link>
          .
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>1. Check your balances</CardTitle>
          <CardDescription>
            Returns <code className="font-mono">availableBalance</code> (spendable) and{' '}
            <code className="font-mono">reservedBalance</code> (held for pending outflows) per
            currency. Check this before requesting a withdrawal to avoid an insufficient-funds
            error.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CodeBlock code={WALLETS_CURL} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>2. Request a withdrawal, payout, or load</CardTitle>
          <CardDescription>
            All three share the same body — only the path differs:{' '}
            <code className="font-mono font-semibold text-foreground">/company/withdrawals</code>,{' '}
            <code className="font-mono font-semibold text-foreground">/company/payouts</code>, or{' '}
            <code className="font-mono font-semibold text-foreground">/company/loads</code>.
            Requests land in <strong>PENDING</strong> and need platform-admin approval before any
            funds move.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-md border bg-muted/30 p-3">
            <p className="mb-2 text-xs font-medium">Payout method — choose one</p>
            <div className="space-y-1 text-xs">
              <MethodRow
                method="CASH"
                required="recipientName, recipientPhone"
                optional="pickupLocation, instructions"
              />
              <MethodRow
                method="WISH"
                required="recipientName, recipientPhone"
                optional="instructions"
              />
              <MethodRow
                method="CRYPTO"
                required="network, walletAddress"
                optional="memo, instructions"
              />
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              <strong className="text-foreground">recipientPhone format:</strong> the formatting in
              these examples is illustrative — send 6–15 digits with optional{' '}
              <code className="font-mono">+</code>, spaces, dashes or parens (plain international
              like <code className="font-mono">+96170000000</code> is simplest). One extra rule on
              create for <strong>Lebanese</strong> numbers: after the{' '}
              <code className="font-mono">961</code> country code there must be exactly{' '}
              <strong>8 digits</strong>, or <strong>7</strong> when the national part starts with{' '}
              <code className="font-mono">3</code> — so{' '}
              <code className="font-mono">9617075183</code> is rejected with{' '}
              <code className="font-mono">400 VALIDATION_ERROR</code>. CASH recipient phones are
              free-form.
            </p>
          </div>

          <div>
            <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">CASH example</p>
            <CodeBlock code={WITHDRAWAL_CASH_CURL} />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">WISH example</p>
            <CodeBlock code={WITHDRAWAL_WISH_CURL} />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">
              CRYPTO example
            </p>
            <CodeBlock code={WITHDRAWAL_CRYPTO_CURL} />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">
              Response (201 Created)
            </p>
            <CodeBlock code={WITHDRAWAL_RESPONSE} />
          </div>
          <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
            <ul className="ml-4 list-disc space-y-1">
              <li>
                <strong className="text-foreground">
                  You can&apos;t choose feeApplication per request.
                </strong>{' '}
                It comes from the commission rule your platform admin configures; sending it in the
                body has no effect. Want recipients to receive the full amount with the fee billed
                to your wallet? Ask your account manager to set that rule to{' '}
                <code className="font-mono">ON_TOP</code>.
              </li>
              <li>
                <strong className="text-foreground">
                  No idempotency key, and no field for your own order number.
                </strong>{' '}
                Retrying a create after a timeout makes a <em>second</em> request and reserves the
                funds again — so on an ambiguous failure, call{' '}
                <code className="font-mono">GET /company/withdrawals?status=PENDING</code> and match
                before retrying. Carry your own reference in{' '}
                <code className="font-mono">notes</code> (≤ 500 chars): it is stored immutably,
                returned on every read, and echoed on the matching CRM event.
              </li>
              <li>
                <strong className="text-foreground">Determining success:</strong> a create succeeded
                when the response is <code className="font-mono">success: true</code> with{' '}
                <code className="font-mono">statusCode 201</code>. The two never disagree, so
                testing <code className="font-mono">success</code> alone is enough.
              </li>
            </ul>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>3. Status lifecycle</CardTitle>
          <CardDescription>
            Every withdrawal, payout, and load moves through these statuses.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-1 text-sm">
            <StatusRow status="PENDING" desc="Submitted — awaiting platform-admin review." />
            <StatusRow
              status="PROCESSING"
              desc="Withdrawals only: a transfer is in flight. Transient — it settles to COMPLETED, or returns to PENDING if the transfer doesn't go through. You cannot cancel while PROCESSING (409 CONFLICT); wait for it to leave the state."
            />
            <StatusRow
              status="COMPLETED"
              desc="Admin approved and funds delivered — approval settles in one step. Ledger entry finalised."
            />
            <StatusRow
              status="REJECTED"
              desc="Admin rejected the request. Reserved funds released."
            />
            <StatusRow
              status="CANCELLED"
              desc="You cancelled it (only possible while PENDING). Reserved funds released."
            />
            <StatusRow
              status="APPROVED"
              desc="Exists in the status enum but is not produced today — approvals settle straight to COMPLETED. Accepted as a ?status= filter, it simply matches nothing."
            />
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            Handle unknown statuses gracefully rather than failing, so a future status can&apos;t
            break your integration. These are the same values the CRM events carry, so polling and
            webhooks never need translating — but note Whish payment links use a different set (
            <code className="font-mono">PENDING</code> / <code className="font-mono">PAID</code> /{' '}
            <code className="font-mono">FAILED</code>).
          </p>
          <p className="mt-4 rounded-md border-l-4 border-primary bg-primary/5 p-3 text-xs text-muted-foreground">
            <strong className="text-foreground">Withdrawals push to your CRM.</strong> Every
            withdrawal status change — pending, completed, rejected, cancelled — is delivered to
            your{' '}
            <Link href="/app/documentation?tab=crm" className="text-primary hover:underline">
              CRM webhook
            </Link>{' '}
            in real time, carrying the same <code className="font-mono">feeAmount</code> /{' '}
            <code className="font-mono">netAmount</code> /{' '}
            <code className="font-mono">totalAmount</code> breakdown, so you never have to poll.
            Payouts and loads are managed over this API only — read their status with the GET below.
          </p>
          <p className="mt-4 text-xs font-medium text-foreground">Check a request&apos;s status</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Fetch a single request by id anytime to read its current{' '}
            <code className="font-mono">status</code>:{' '}
            <code className="font-mono font-semibold text-foreground">
              GET /company/withdrawals/:id
            </code>{' '}
            (same shape for <code className="font-mono">payouts</code> and{' '}
            <code className="font-mono">loads</code>). For a rejected request the reason is in{' '}
            <code className="font-mono">adminNotes</code>; your original request note stays in{' '}
            <code className="font-mono">notes</code>. You can also list and filter by status, e.g.{' '}
            <code className="font-mono">GET /company/withdrawals?status=PENDING</code>.
          </p>
          <div className="mt-3">
            <CodeBlock code={STATUS_CURL} />
          </div>
          <p className="mt-4 text-xs text-muted-foreground">
            Cancel while still PENDING:{' '}
            <code className="font-mono font-semibold text-foreground">
              POST /company/withdrawals/:id/cancel
            </code>{' '}
            (same path shape for payouts and loads).
          </p>
          <div className="mt-3">
            <CodeBlock code={CANCEL_CURL} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>4. Read your data</CardTitle>
          <CardDescription>
            Transactions, ledger, and analytics are all read with a simple GET. Lists are paginated
            (the array is at <code className="font-mono">data.data</code>); CSV exports stream the
            raw file.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <CodeBlock code={TRANSACTIONS_CURL} />
          <p className="rounded-md border-l-4 border-primary bg-primary/5 p-3 text-xs text-muted-foreground">
            <strong className="text-foreground">Fees are transparent.</strong> Every transaction
            returns <code className="font-mono">amount</code> (gross),{' '}
            <code className="font-mono">commissionAmount</code> (the platform fee we took), and{' '}
            <code className="font-mono">netAmount</code> (what you were credited). Withdrawals,
            payouts and loads return the same breakdown as{' '}
            <code className="font-mono">totalAmount</code> /{' '}
            <code className="font-mono">feeAmount</code> /{' '}
            <code className="font-mono">netAmount</code> — so after any completed transaction you
            always know exactly what we charged.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>All endpoints at a glance</CardTitle>
          <CardDescription>
            These <code className="font-mono font-semibold text-foreground">company/*</code> routes
            accept your company key, except the dashboard-only ones noted below. Whish Pay and CRM
            have their own tabs.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-1 text-sm">
            <EndpointGroup label="Wallets" endpoints="GET /company/wallets" />
            <EndpointGroup
              label="Transactions"
              endpoints="GET /company/transactions · /:id · /:id/detail · /export.csv"
            />
            <EndpointGroup label="Ledger" endpoints="GET /company/ledger · /export.csv" />
            <EndpointGroup
              label="Analytics"
              endpoints="GET /company/analytics/overview · /wallet-summary"
            />
            <EndpointGroup
              label="Activity"
              endpoints="GET /company/activity · /operations/counts"
            />
            <EndpointGroup
              label="Withdrawals"
              endpoints="GET /company/withdrawals · GET /:id · POST · POST /:id/cancel"
            />
            <EndpointGroup
              label="Payouts"
              endpoints="GET /company/payouts · GET /:id · POST · POST /:id/cancel"
            />
            <EndpointGroup
              label="Loads"
              endpoints="GET /company/loads · GET /:id · POST · POST /:id/cancel"
            />
            <EndpointGroup
              label="API keys (dashboard session only)"
              endpoints="GET · POST /company/api-keys · POST /:id/rotate · /:id/revoke"
            />
            <EndpointGroup
              label="Team (dashboard session only)"
              endpoints="GET · POST /company/team · PATCH · DELETE /:id"
            />
          </div>
          <p className="mt-3 rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
            <strong className="text-foreground">
              Dashboard session only — these reject an API key with 403 FORBIDDEN:
            </strong>{' '}
            <code className="font-mono">company/api-keys</code>,{' '}
            <code className="font-mono">company/team</code>, <code className="font-mono">PUT</code>/
            <code className="font-mono">DELETE</code>{' '}
            <code className="font-mono">/company/crm/config</code>, and{' '}
            <code className="font-mono">POST /company/crm/demo/enable</code>. Reading the CRM config
            with a key does work. This is deliberate: a leaked key must not be able to mint keys,
            add users, or redirect your CRM traffic.
          </p>
          <p className="mt-3 text-xs text-muted-foreground">
            Collecting payments?{' '}
            <Link href="/app/documentation?tab=whish" className="text-primary hover:underline">
              Whish Pay tab
            </Link>
            . Pushing transactions to your CRM?{' '}
            <Link href="/app/documentation?tab=crm" className="text-primary hover:underline">
              CRM tab
            </Link>
            .
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Health check</CardTitle>
          <CardDescription>A no-auth, no-side-effects sanity check.</CardDescription>
        </CardHeader>
        <CardContent>
          <CodeBlock code={`curl ${API_BASE}/health`} />
        </CardContent>
      </Card>
    </div>
  );
}

function EndpointGroup({ label, endpoints }: { label: string; endpoints: string }) {
  return (
    <div className="grid grid-cols-12 gap-2 border-b py-2 last:border-0">
      <span className="col-span-3 text-xs font-medium">{label}</span>
      <span className="col-span-9 font-mono text-xs text-muted-foreground">{endpoints}</span>
    </div>
  );
}

function MethodRow({
  method,
  required,
  optional,
}: {
  method: string;
  required: string;
  optional: string;
}) {
  return (
    <div className="grid grid-cols-12 gap-2 border-b py-1.5 last:border-0">
      <code className="col-span-2 font-mono font-semibold">{method}</code>
      <span className="col-span-5 text-muted-foreground">
        <span className="text-foreground">required: </span>
        {required}
      </span>
      <span className="col-span-5 text-muted-foreground">
        <span className="text-foreground">optional: </span>
        {optional}
      </span>
    </div>
  );
}

function StatusRow({ status, desc }: { status: string; desc: string }) {
  return (
    <div className="grid grid-cols-12 gap-2 border-b py-2 last:border-0">
      <code className="col-span-3 font-mono text-xs font-semibold">{status}</code>
      <span className="col-span-9 text-xs text-muted-foreground">{desc}</span>
    </div>
  );
}
