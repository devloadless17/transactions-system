'use client';
import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CodeBlock } from '@/components/ui/code-block';

const API_BASE =
  typeof window !== 'undefined'
    ? (process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001/v1')
    : 'http://localhost:3001/v1';

const WALLETS_CURL = `curl ${API_BASE}/company/wallets \\
  -H "Authorization: Bearer tsk_<company-key>"

# Response
{
  "success": true,
  "data": [
    {
      "currency": "USD",
      "availableBalance": "1250.00",
      "pendingBalance": "0",
      "reservedBalance": "200.00"
    }
  ]
}`;

const TRANSACTIONS_CURL = `curl "${API_BASE}/company/transactions?limit=20" \\
  -H "Authorization: Bearer tsk_<company-key>"
# The list array is at data.data; add ?cursor=... to page.`;

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
    "payoutMethod": "CASH",
    "createdAt": "2026-06-10T10:00:00.000Z"
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
              status="APPROVED"
              desc="Admin approved — funds are being processed externally."
            />
            <StatusRow status="COMPLETED" desc="Funds delivered. Ledger entry finalised." />
            <StatusRow
              status="REJECTED"
              desc="Admin rejected the request. Reserved funds released."
            />
            <StatusRow
              status="CANCELLED"
              desc="You cancelled it (only possible while PENDING). Reserved funds released."
            />
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
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
        <CardContent>
          <CodeBlock code={TRANSACTIONS_CURL} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>All endpoints at a glance</CardTitle>
          <CardDescription>
            Every <code className="font-mono font-semibold text-foreground">company/*</code> route
            accepts your company key. Whish Pay and CRM have their own tabs.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-1 text-sm">
            <EndpointGroup label="Wallets" endpoints="GET /company/wallets" />
            <EndpointGroup
              label="Transactions"
              endpoints="GET /company/transactions · /:id · /:id/detail · /export.csv"
            />
            <EndpointGroup label="Ledger" endpoints="GET /company/ledger" />
            <EndpointGroup
              label="Analytics"
              endpoints="GET /company/analytics/overview · /wallet-summary"
            />
            <EndpointGroup
              label="Withdrawals"
              endpoints="GET · POST /company/withdrawals · POST /:id/cancel"
            />
            <EndpointGroup
              label="Payouts"
              endpoints="GET · POST /company/payouts · POST /:id/cancel"
            />
            <EndpointGroup label="Loads" endpoints="GET · POST /company/loads · POST /:id/cancel" />
            <EndpointGroup
              label="API keys"
              endpoints="GET · POST /company/api-keys · POST /:id/rotate · /:id/revoke"
            />
            <EndpointGroup
              label="Team"
              endpoints="GET · POST /company/team · PATCH · DELETE /:id"
            />
          </div>
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
