'use client';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CodeBlock } from '@/components/ui/code-block';
import { publicApiBase } from '@/lib/api';

const API_BASE = typeof window !== 'undefined' ? publicApiBase() : 'http://localhost:3001/v1';

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

const INGEST_RESPONSE = `{
  "id": "uuid",
  "operatingId": "uuid",
  "sourceId": "uuid",
  "sourceCode": "omt",
  "externalTransactionId": "omt-id-12345",
  "amount": "200",
  "currency": "USD",
  "status": "COMPLETED",
  "customer": "Alice",
  "tradingAccount": "Bob",
  "phone": "+961-3-000000",
  "note": "monthly bill",
  "processedAt": "2026-05-26T11:24:19.659Z",
  "createdAt": "2026-05-26T11:24:19.660Z"
}`;

export function SourcesApiView() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Sources API</h1>
        <p className="text-sm text-muted-foreground">
          For external providers — OMT, Whish, banks, and the like. A <strong>source key</strong>,
          issued by the platform admin, lets you push transactions into the platform on behalf of
          any company. One key belongs to one source.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>1. Authentication</CardTitle>
          <CardDescription>
            Send your source key as a Bearer token. The URL names the source; the key proves it.
            Source keys are issued by the platform admin, one per source (OMT, Whish, …).
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
            of the company it belongs to. Call this once at startup and cache the ids.
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
            <code className="font-mono font-semibold text-foreground">
              /ingest/&lt;sourceCode&gt;/transactions
            </code>
            ); the body carries the destination <code className="font-mono">operatingId</code> and
            the financial fields. The{' '}
            <code className="font-mono">(source, externalTransactionId)</code> pair is a natural
            dedup key, so retries are safe — you can also supply your own{' '}
            <code className="font-mono">idempotencyKey</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <CodeBlock code={INGEST_CURL} />
          <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
            <p className="mb-1 font-medium text-foreground">Payload conventions</p>
            <p>
              These <strong>plain string</strong> fields inside{' '}
              <code className="font-mono">payload</code> are recognised so dashboards and exports
              render them consistently:
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
            On success you get the persisted transaction back and the company&apos;s wallet is
            updated atomically.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CodeBlock code={INGEST_RESPONSE} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>5. Errors</CardTitle>
          <CardDescription>Stable error codes for clients to branch on.</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2 text-sm">
            <ErrorRow code="VALIDATION_ERROR" status={400} desc="Request body failed validation." />
            <ErrorRow code="UNAUTHORIZED" status={401} desc="Missing or invalid API key." />
            <ErrorRow
              code="FORBIDDEN"
              status={403}
              desc="Key is not a source key, or it's bound to a different source than the URL."
            />
            <ErrorRow
              code="CONFLICT"
              status={409}
              desc="(source, externalTransactionId) already used by a different company, or the wallet would go negative."
            />
            <ErrorRow
              code="NO_COMMISSION_RULE"
              status={422}
              desc="No active commission rule covers this amount."
            />
            <ErrorRow
              code="RATE_LIMITED"
              status={429}
              desc="Per-key throttle (300 req / 60s) or the global IP throttle was hit."
            />
          </div>
        </CardContent>
      </Card>
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
