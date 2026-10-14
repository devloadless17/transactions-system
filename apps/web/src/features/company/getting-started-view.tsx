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
    "message": "Request validation failed",
    "details": [{ "path": ["amount"], "message": "must be a positive decimal" }]
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
  [
    'INSUFFICIENT_BALANCE',
    409,
    "Your available balance can't cover the request. error.details gives required, available and shortfall.",
  ],
  ['NO_COMMISSION_RULE', 422, 'No active commission rule covers this amount.'],
  ['RATE_LIMITED', 429, 'Too many requests — slow down and retry.'],
  [
    'INTERNAL_ERROR',
    500,
    'Something failed on our side — safe to retry a read; for a create, check whether it went through first.',
  ],
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
            <strong>Deposits are never rate-limited.</strong> However many of your customers pay at
            the same moment, nothing refuses them: Whish&apos;s payment confirmations are never
            limited, and creating payment links has no per-IP limit. What is limited answers{' '}
            <code className="font-mono">429 RATE_LIMITED</code>:
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="ml-4 list-disc space-y-2 text-sm text-muted-foreground">
            <li>
              <strong className="text-foreground">
                Whish Pay API — <code className="font-mono">/v1/integrations/whish</code>, per API
                key, no per-IP limit.
              </strong>{' '}
              Creating a link: <strong>60,000 a minute</strong> (1,000 a second). Refreshing a
              status from Whish: <strong>60,000 a minute</strong>. Looking a payment up:{' '}
              <strong>300,000 a minute</strong>. Each has its own counter, so polling never uses up
              your link creation. The same brakes cover a link&apos;s own calls on{' '}
              <code className="font-mono">/v1/company/whish/payments</code> (create, look up,
              refresh). These are brakes against a flood, not ceilings for real customers: they sit
              above what the platform itself serves, so your customers are never refused by them.{' '}
              <code className="font-mono">RateLimit-*</code> headers on every response.
            </li>
            <li>
              <strong className="text-foreground">Every other endpoint — per IP.</strong>{' '}
              <strong>100 requests per 60 seconds, per IP</strong>, counted separately for each
              endpoint, across the rest of <code className="font-mono">/v1/company/*</code>,
              including the payment-link list and CSV. Only{' '}
              <code className="font-mono">/v1/company/analytics</code> is exempt. Its 429 carries no{' '}
              <code className="font-mono">error.details</code>; wait the number of seconds in its{' '}
              <code className="font-mono">Retry-After</code> header (every response also carries{' '}
              <code className="font-mono">X-RateLimit-*</code> headers).
            </li>
            <li>
              <strong className="text-foreground">Wrong API keys — per IP.</strong> A missing,
              malformed or invalid key counts as a failed attempt: 20 a minute per key from one IP
              (100 per IP), then 429. A working key never counts.
            </li>
          </ul>
          <p className="mt-2 text-xs text-muted-foreground">
            All of these header values are in seconds.
          </p>
        </CardContent>
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
