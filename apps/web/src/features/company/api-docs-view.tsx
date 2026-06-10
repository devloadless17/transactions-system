'use client';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

const API_BASE =
  typeof window !== 'undefined'
    ? (process.env.NEXT_PUBLIC_API_BASE_URL ?? 'http://localhost:3001/v1')
    : 'http://localhost:3001/v1';

const DISCOVERY_CURL = `curl -X GET ${API_BASE}/ingest/companies \\
  -H "Authorization: Bearer tsk_<source-key>"`;

const DISCOVERY_RESPONSE = `{
  "data": [
    { "operatingId": "uuid", "slug": "acme",   "name": "Acme Corp", "defaultCurrency": "USD" },
    { "operatingId": "uuid", "slug": "globex", "name": "Globex",    "defaultCurrency": "USD" }
  ]
}`;

const INGEST_CURL = `curl -X POST ${API_BASE}/ingest/omt/transactions \\
  -H "Authorization: Bearer tsk_<source-key>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "operatingId": "00000000-0000-0000-0000-000000000000",
    "externalTransactionId": "omt-id-12345",
    "amount": "200.00",
    "currency": "USD",
    "payload": {
      "customer": "Alice",
      "tradingAccount": "Bob",
      "phone": "+961-3-000000",
      "note": "monthly bill"
    }
  }'`;

const COMPANY_AUTH_CURL = `Authorization: Bearer tsk_<prefix>_<secret>`;

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

const WHISH_PAYMENT_CURL = `curl -X POST ${API_BASE}/company/whish/payments \\
  -H "Authorization: Bearer tsk_<company-key>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "amount": "50.00",
    "currency": "USD",
    "invoice": "Order #9912"
  }'

# Response — share collectUrl with your customer (externalId is server-assigned)
{
  "data": {
    "id": "e3b1c2d0-...",
    "status": "PENDING",
    "collectUrl": "https://whish.money/collect/...",
    "amount": "50.00",
    "currency": "USD"
  }
}`;

export function ApiDocsView() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">API integration</h1>
        <p className="text-sm text-muted-foreground">
          Two distinct integration paths share this API. External providers (OMT, Whish, banks…) use{' '}
          <strong>source API keys</strong> to ingest transactions. Your company uses a{' '}
          <strong>company API key</strong> for full programmatic access to all your company data and
          operations — no browser session required.
        </p>
      </div>

      <div className="rounded-md border-l-4 border-primary bg-primary/5 p-4 text-sm">
        <p className="font-medium">Quick reference</p>
        <ul className="mt-1 space-y-1 text-muted-foreground">
          <li>
            <strong>Source key</strong> (Whish, OMT, …): can <code>POST</code> transactions on
            behalf of any company and can <code>GET /ingest/companies</code> for discovery. Issued
            by the platform admin.
          </li>
          <li>
            <strong>Company key</strong> (your company): full access to your company — read
            transactions, wallets, ledger, analytics; request withdrawals, payouts, loads; manage
            Whish payments and webhooks; manage team and API keys. Cannot ingest transactions (that
            is a source-key operation).
          </li>
        </ul>
      </div>

      <h2 className="border-b pb-2 text-lg font-semibold">For external providers</h2>

      <Card>
        <CardHeader>
          <CardTitle>1. Authentication</CardTitle>
          <CardDescription>
            Source keys are issued by the platform admin, one per source (OMT, Whish, …). Send the
            key as a Bearer token. The URL identifies the source; the key proves it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CodeBlock code={`Authorization: Bearer tsk_<prefix>_<secret>`} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>2. Discover companies</CardTitle>
          <CardDescription>
            Before posting a transaction you need the <code className="font-mono">operatingId</code>{' '}
            of the company it belongs to. Hit this endpoint once at startup and cache the ids.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <CodeBlock code={DISCOVERY_CURL} />
          <div>
            <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">Response</p>
            <CodeBlock code={DISCOVERY_RESPONSE} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>3. Send a transaction</CardTitle>
          <CardDescription>
            The source is named in the URL path (
            <code className="font-mono">/ingest/&lt;sourceCode&gt;/transactions</code>). The body
            carries the destination <code className="font-mono">operatingId</code> and the financial
            fields. Idempotent: the (source, externalTransactionId) pair acts as a natural dedup
            key, so retries are safe; you may also supply your own{' '}
            <code className="font-mono">idempotencyKey</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <CodeBlock code={INGEST_CURL} />
          <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
            <p className="mb-1 font-medium text-foreground">Payload conventions</p>
            <p>
              The API recognises these <strong>plain string</strong> fields in the{' '}
              <code className="font-mono">payload</code> so dashboards and exports render them
              consistently:
            </p>
            <ul className="mt-1 space-y-0.5">
              <li>
                <code className="font-mono">customer</code> — the <em>sender</em> / payer name
              </li>
              <li>
                <code className="font-mono">tradingAccount</code> — the <em>recipient</em> /
                beneficiary account
              </li>
              <li>
                <code className="font-mono">phone</code> — a contact phone number
              </li>
              <li>
                <code className="font-mono">note</code> — free-text comment from the provider
              </li>
              <li>any other keys are preserved as-is; add whatever your integration needs</li>
            </ul>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>4. Response shape</CardTitle>
          <CardDescription>
            On success you get the persisted transaction back and the wallet is updated atomically.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CodeBlock
            code={`{
  "id": "uuid",
  "operatingId": "uuid",
  "sourceId": "uuid",
  "sourceCode": "omt",
  "externalTransactionId": "your-id-12345",
  "amount": "200",
  "currency": "USD",
  "status": "COMPLETED",
  "customer": "Alice",
  "tradingAccount": "Bob",
  "phone": "+961-3-000000",
  "note": "monthly bill",
  "processedAt": "2026-05-26T11:24:19.659Z",
  "createdAt": "2026-05-26T11:24:19.660Z"
}`}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>5. Errors</CardTitle>
          <CardDescription>Stable error codes for clients to branch on.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2 text-sm">
            <ErrorRow
              code="VALIDATION_ERROR"
              status={400}
              desc="Request body failed Zod validation."
            />
            <ErrorRow code="UNAUTHORIZED" status={401} desc="Missing or invalid API key." />
            <ErrorRow
              code="FORBIDDEN"
              status={403}
              desc="API key is not a source key, or it's bound to a different source than the URL."
            />
            <ErrorRow
              code="CONFLICT"
              status={409}
              desc="(source, externalTransactionId) already used by a different company, or wallet would go negative."
            />
            <ErrorRow
              code="NO_COMMISSION_RULE"
              status={422}
              desc="No active commission rule covers this amount."
            />
            <ErrorRow
              code="RATE_LIMITED"
              status={429}
              desc="Per-API-key throttle (300 req/60s) or global IP throttle hit."
            />
          </div>
        </CardContent>
      </Card>

      <h2 className="border-b pb-2 pt-4 text-lg font-semibold">For your company</h2>

      {/* ── Authentication ── */}
      <Card>
        <CardHeader>
          <CardTitle>Authentication</CardTitle>
          <CardDescription>
            Add your company API key as a Bearer token on every request. No cookies, no CSRF header
            needed. Generate a key under <strong>Settings → API Keys</strong> in the dashboard.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CodeBlock code={COMPANY_AUTH_CURL} />
        </CardContent>
      </Card>

      {/* ── Wallets ── */}
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

      {/* ── Withdrawals / Payouts / Loads ── */}
      <Card>
        <CardHeader>
          <CardTitle>2. Request a withdrawal, payout, or load</CardTitle>
          <CardDescription>
            All three flows share the same body shape. The only difference is the path:{' '}
            <code className="font-mono">/company/withdrawals</code>,{' '}
            <code className="font-mono">/company/payouts</code>, or{' '}
            <code className="font-mono">/company/loads</code>. Requests land in{' '}
            <strong>PENDING</strong> status and require platform admin approval before funds move.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Payout method reference */}
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

      {/* ── Status lifecycle ── */}
      <Card>
        <CardHeader>
          <CardTitle>3. Status lifecycle</CardTitle>
          <CardDescription>
            Every withdrawal, payout, and load moves through these statuses.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-1 text-sm">
            <StatusRow status="PENDING" desc="Submitted — awaiting platform admin review." />
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
            <code className="font-mono">POST /company/withdrawals/:id/cancel</code> (same path for
            payouts and loads).
          </p>
          <div className="mt-3">
            <CodeBlock code={CANCEL_CURL} />
          </div>
        </CardContent>
      </Card>

      {/* ── Whish payment links ── */}
      <Card>
        <CardHeader>
          <CardTitle>4. Collect via Whish Pay</CardTitle>
          <CardDescription>
            Generate a hosted payment link, share the <code className="font-mono">collectUrl</code>{' '}
            with your customer, and the amount settles into your wallet automatically once paid.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CodeBlock code={WHISH_PAYMENT_CURL} />
        </CardContent>
      </Card>

      {/* ── All other endpoints ── */}
      <Card>
        <CardHeader>
          <CardTitle>All endpoints at a glance</CardTitle>
          <CardDescription>
            Every <code className="font-mono">company/*</code> route accepts your API key. All paths
            are prefixed with <code className="font-mono">/v1</code>.
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
              label="Whish Pay"
              endpoints="GET · POST /company/whish/payments · GET /:id · POST /:id/refresh-status"
            />
            <EndpointGroup
              label="Whish webhook"
              endpoints="GET · PUT · DELETE /company/whish/webhook · POST /rotate-secret"
            />
            <EndpointGroup label="CRM" endpoints="GET · PUT · DELETE /company/crm/config" />
            <EndpointGroup
              label="API keys"
              endpoints="GET · POST /company/api-keys · POST /:id/rotate · /:id/revoke"
            />
            <EndpointGroup
              label="Team"
              endpoints="GET · POST /company/team · PATCH · DELETE /:id"
            />
          </div>
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

function CodeBlock({ code }: { code: string }) {
  return (
    <div className="group relative rounded-md border bg-muted/30">
      <pre className="overflow-x-auto p-3 font-mono text-xs">{code}</pre>
      <Button
        variant="ghost"
        size="sm"
        className="absolute right-2 top-2 opacity-0 group-hover:opacity-100"
        onClick={() => {
          navigator.clipboard?.writeText(code);
          toast.success('Copied');
        }}
      >
        Copy
      </Button>
    </div>
  );
}

function ErrorRow({ code, status, desc }: { code: string; status: number; desc: string }) {
  return (
    <div className="grid grid-cols-12 gap-2 border-b py-2 last:border-0">
      <code className="col-span-3 font-mono text-xs">{code}</code>
      <span className="col-span-1 text-xs text-muted-foreground">{status}</span>
      <span className="col-span-8 text-xs">{desc}</span>
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
