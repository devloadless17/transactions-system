'use client';
import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CodeBlock } from '@/components/ui/code-block';
import { publicApiBase } from '@/lib/api';

const API_BASE = typeof window !== 'undefined' ? publicApiBase() : 'http://localhost:3001/v1';

const ENVELOPE_SUCCESS = `{
  "success": true,
  "statusCode": 200,
  "data": { /* your payload */ }
}`;

const ENVELOPE_ERROR = `{
  "success": false,
  "statusCode": 400,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "amount must be a positive decimal",
    "details": { /* optional, field-level */ }
  }
}`;

const FIRST_CALL = `# 1) Is the API up?  (no key needed)
curl ${API_BASE}/health

# 2) Read your balances  (company key)
curl ${API_BASE}/company/wallets \\
  -H "Authorization: Bearer tsk_<company-key>"`;

const ERRORS: [string, number, string][] = [
  ['VALIDATION_ERROR', 400, 'The request body or query failed validation.'],
  ['UNAUTHORIZED', 401, 'Missing, invalid, or revoked API key.'],
  ['FORBIDDEN', 403, 'The key is valid but not allowed to do this.'],
  ['NOT_FOUND', 404, 'No such resource for your company.'],
  ['CONFLICT', 409, 'Duplicate or conflicting request (e.g. reused id).'],
  ['NO_COMMISSION_RULE', 422, 'No active commission rule covers this amount.'],
  ['RATE_LIMITED', 429, 'Too many requests — slow down and retry.'],
];

export function GettingStartedView() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Getting started</h1>
        <p className="text-sm text-muted-foreground">
          Everything you need to call the API: one base URL, a single Bearer key, and the same
          response shape everywhere. Plain HTTPS and JSON — no SDK required.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Base URL</CardTitle>
          <CardDescription>
            Every endpoint lives under this base. All paths in these docs are written relative to it
            and are prefixed with{' '}
            <code className="font-mono font-semibold text-foreground">/v1</code>.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CodeBlock code={API_BASE} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Authentication</CardTitle>
          <CardDescription>
            Send your key as a Bearer token on every request. No cookies and no CSRF header — these
            are server-to-server keys.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <CodeBlock code={`Authorization: Bearer tsk_<prefix>_<secret>`} />
          <div className="space-y-3">
            <KeyType
              name="Company key"
              who="You — the company"
              desc="Full access to your own company's money and data: wallets, transactions, withdrawals, payouts, loads, Whish Pay, and activity. This is the key you'll use for every call in the Company API tab."
            />
          </div>
          <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
            <ul className="ml-4 list-disc space-y-1">
              <li>
                <strong className="text-foreground">Management actions are dashboard-only.</strong>{' '}
                Minting/rotating/revoking keys, managing team members, and setting or clearing your
                CRM webhook config need a signed-in dashboard session — an API key gets{' '}
                <code className="font-mono">403 FORBIDDEN</code>. That way a leaked key can never
                mint more keys, add users, or redirect your CRM traffic.
              </li>
              <li>
                <strong className="text-foreground">Send the header exactly as shown</strong> — it
                is case-sensitive. <code className="font-mono">bearer tsk_…</code>,{' '}
                <code className="font-mono">Bearer TSK_…</code>, or a bare key with no scheme are
                not recognised and return <code className="font-mono">401 UNAUTHORIZED</code>. If
                one call 401s while others with the same key work, compare that request&apos;s
                header before rotating the key.
              </li>
              <li>
                <strong className="text-foreground">No IP allowlisting.</strong> There is nothing to
                register and no IP check — call us from any server. Your credential is the key; our
                webhooks prove themselves with an HMAC signature, not a source IP.
              </li>
            </ul>
          </div>
          <p className="text-xs text-muted-foreground">
            Secrets are shown once, at creation. Keys don&apos;t expire unless you set an expiry.
            Mint, rotate, or revoke a company key under{' '}
            <Link href="/app/settings" className="text-primary hover:underline">
              Settings → API keys
            </Link>
            .
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Every response has the same shape</CardTitle>
          <CardDescription>
            Success or failure, responses come back wrapped in an envelope. Read your payload from{' '}
            <code className="font-mono">data</code>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div>
            <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">Success</p>
            <CodeBlock code={ENVELOPE_SUCCESS} />
          </div>
          <div>
            <p className="mb-1 text-xs font-medium uppercase text-muted-foreground">Error</p>
            <CodeBlock code={ENVELOPE_ERROR} />
          </div>
          <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
            <ul className="ml-4 list-disc space-y-1">
              <li>
                <strong className="text-foreground">Lists</strong> nest one level deeper — the array
                is at <code className="font-mono">data.data</code> alongside a total count.
              </li>
              <li>
                <strong className="text-foreground">A few endpoints</strong> return raw bodies (no
                envelope): CSV exports (
                <code className="font-mono font-semibold text-foreground">/export.csv</code>), the
                health check, and inbound webhook/callback acknowledgements.
              </li>
            </ul>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Error codes</CardTitle>
          <CardDescription>
            Branch on the stable <code className="font-mono">error.code</code>, never on the
            message.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-1 text-sm">
            {ERRORS.map(([code, status, desc]) => (
              <div key={code} className="grid grid-cols-12 gap-2 border-b py-2 last:border-0">
                <code className="col-span-4 font-mono text-xs">{code}</code>
                <span className="col-span-1 text-xs text-muted-foreground">{status}</span>
                <span className="col-span-7 text-xs">{desc}</span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Rate limits</CardTitle>
          <CardDescription>
            The per-key integration endpoints —{' '}
            <code className="font-mono">/v1/integrations/whish</code> and transaction ingest — allow{' '}
            <strong>300 requests per 60 seconds, per key</strong>. Go over and you get a{' '}
            <code className="font-mono">429 RATE_LIMITED</code> with the limit echoed in{' '}
            <code className="font-mono">error.details</code>, plus{' '}
            <code className="font-mono">RateLimit-*</code> headers to pace against. Everything under{' '}
            <code className="font-mono">/v1/company/*</code> — including{' '}
            <code className="font-mono">/company/whish/payments</code> — uses the global throttle
            instead: <strong>100 requests per 60 seconds, per IP</strong>, with no{' '}
            <code className="font-mono">RateLimit-*</code> headers.
          </CardDescription>
        </CardHeader>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Your first call</CardTitle>
          <CardDescription>
            Check connectivity (no key needed), then read your balances with your company key.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CodeBlock code={FIRST_CALL} />
        </CardContent>
      </Card>
    </div>
  );
}

function KeyType({ name, who, desc }: { name: string; who: string; desc: string }) {
  return (
    <div className="rounded-md border p-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{name}</p>
        <span className="text-xs text-muted-foreground">{who}</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">{desc}</p>
    </div>
  );
}
