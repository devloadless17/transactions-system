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
    { "id": "uuid", "slug": "acme",   "name": "Acme Corp",  "defaultCurrency": "USD" },
    { "id": "uuid", "slug": "globex", "name": "Globex",     "defaultCurrency": "EUR" }
  ]
}`;

const INGEST_CURL = `curl -X POST ${API_BASE}/ingest/omt/transactions \\
  -H "Authorization: Bearer tsk_<source-key>" \\
  -H "Content-Type: application/json" \\
  -d '{
    "companyId": "00000000-0000-0000-0000-000000000000",
    "externalTransactionId": "omt-id-12345",
    "amount": "200.00",
    "currency": "USD",
    "payload": {
      "customer": "Alice",
      "target": "Bob",
      "phone": "+961-3-000000",
      "note": "monthly bill"
    },
    "idempotencyKey": "optional-uuid-or-stable-key"
  }'`;

const COMPANY_READ_CURL = `# Company API keys (managed by an admin on your behalf) are READ-ONLY.
# Use them for dashboards, exports, and internal integrations.

curl ${API_BASE}/company/transactions \\
  -H "Authorization: Bearer tsk_<company-key>"

curl ${API_BASE}/company/wallets \\
  -H "Authorization: Bearer tsk_<company-key>"`;

export function ApiDocsView() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">API integration</h1>
        <p className="text-sm text-muted-foreground">
          Two distinct integration paths share this API. External providers (OMT, Wish, banks…) use{' '}
          <strong>source API keys</strong> to ingest transactions. Your company uses a{' '}
          <strong>company API key</strong> for read-only programmatic access to your own data.
        </p>
      </div>

      <div className="rounded-md border-l-4 border-primary bg-primary/5 p-4 text-sm">
        <p className="font-medium">Quick reference</p>
        <ul className="mt-1 space-y-1 text-muted-foreground">
          <li>
            <strong>Source key</strong> (Wish, OMT, …): can <code>POST</code> transactions on behalf
            of any company and can <code>GET /ingest/companies</code> for discovery. Issued by the
            platform admin.
          </li>
          <li>
            <strong>Company key</strong> (your company): read-only. Cannot ingest. Use it to fetch
            your transactions, wallets, ledger, withdrawals, etc. programmatically.
          </li>
        </ul>
      </div>

      <h2 className="border-b pb-2 text-lg font-semibold">For external providers</h2>

      <Card>
        <CardHeader>
          <CardTitle>1. Authentication</CardTitle>
          <CardDescription>
            Source keys are issued by the platform admin, one per source (OMT, Wish, …). Send the
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
            Before posting a transaction you need the <code className="font-mono">companyId</code>{' '}
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
            carries the destination <code className="font-mono">companyId</code> and the financial
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
                <code className="font-mono">target</code> — the <em>recipient</em> / beneficiary
                name
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
            On success you get the persisted transaction back. Commission is computed by the
            resolver and the wallet is updated atomically.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CodeBlock
            code={`{
  "id": "uuid",
  "companyId": "uuid",
  "sourceId": "uuid",
  "sourceCode": "omt",
  "externalTransactionId": "your-id-12345",
  "amount": "200",
  "currency": "USD",
  "commissionAmount": "5",
  "netAmount": "195",
  "status": "COMPLETED",
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

      <Card>
        <CardHeader>
          <CardTitle>Read-only programmatic access</CardTitle>
          <CardDescription>
            If you need to fetch your own transactions, wallets, or ledger entries from a script or
            internal tool, ask your platform admin to issue a company API key for you. These keys
            are strictly <strong>read-only</strong> — they cannot ingest transactions (use a source
            key for that).
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CodeBlock code={COMPANY_READ_CURL} />
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
