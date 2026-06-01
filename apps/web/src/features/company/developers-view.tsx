'use client';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { toast } from 'sonner';
import type { WhishClientConfig, WhishWebhookConfig } from '@app/shared';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { apiFetch } from '@/lib/api.client';
import { ApiClientError } from '@/lib/api';

const API_BASE =
  (typeof window !== 'undefined' && process.env.NEXT_PUBLIC_API_BASE_URL) ||
  'http://localhost:3001/v1';

type Lang = 'curl' | 'python' | 'node' | 'dotnet' | 'java';
const LANGS: { id: Lang; label: string }[] = [
  { id: 'curl', label: 'cURL' },
  { id: 'python', label: 'Python' },
  { id: 'node', label: 'Node.js' },
  { id: 'dotnet', label: '.NET (C#)' },
  { id: 'java', label: 'Java' },
];

// ---- Code snippets (templated with the live API base) ----
const snippets = (base: string): Record<Lang, string> => ({
  curl: `# 1) Create a payment link
curl -X POST ${base}/integrations/whish/payments \\
  -H "Authorization: Bearer $WHISH_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{"amount":"25.00","currency":"USD","invoice":"Order #4821"}'

# 2) Poll status by reference (externalId)
curl ${base}/integrations/whish/payments/3 \\
  -H "Authorization: Bearer $WHISH_KEY"

# 3) Force a status refresh (missed callback)
curl -X POST ${base}/integrations/whish/payments/3/refresh \\
  -H "Authorization: Bearer $WHISH_KEY"`,

  python: `import os, requests

BASE = "${base}"
KEY  = os.environ["WHISH_KEY"]          # tsk_XXXXXXXX_your_secret
HEADERS = {"Authorization": f"Bearer {KEY}"}

# 1) Create a payment link
resp = requests.post(
    f"{BASE}/integrations/whish/payments",
    headers=HEADERS,
    json={"amount": "25.00", "currency": "USD", "invoice": "Order #4821"},
)
resp.raise_for_status()
data = resp.json()
collect_url = data["collectUrl"]        # send to your customer
reference   = data["externalId"]        # store against your order
print(collect_url, reference)

# 2) Poll status later
status = requests.get(
    f"{BASE}/integrations/whish/payments/{reference}", headers=HEADERS
).json()
print(status["status"])                 # PENDING | PAID | FAILED | EXPIRED`,

  node: `const BASE = "${base}";
const KEY  = process.env.WHISH_KEY;      // tsk_XXXXXXXX_your_secret
const auth = { Authorization: \`Bearer \${KEY}\`, "Content-Type": "application/json" };

// 1) Create a payment link
const res = await fetch(\`\${BASE}/integrations/whish/payments\`, {
  method: "POST",
  headers: auth,
  body: JSON.stringify({ amount: "25.00", currency: "USD", invoice: "Order #4821" }),
});
if (!res.ok) throw new Error(\`HTTP \${res.status}\`);
const data = await res.json();
console.log(data.collectUrl, data.externalId);   // share collectUrl; store externalId

// 2) Poll status
const ref = data.externalId;
const status = await (await fetch(
  \`\${BASE}/integrations/whish/payments/\${ref}\`, { headers: auth }
)).json();
console.log(status.status);`,

  dotnet: `using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text.Json;

var http = new HttpClient { BaseAddress = new Uri("${base}/") };
http.DefaultRequestHeaders.Authorization =
    new AuthenticationHeaderValue("Bearer", Environment.GetEnvironmentVariable("WHISH_KEY"));

// 1) Create a payment link
var resp = await http.PostAsJsonAsync("integrations/whish/payments", new {
    amount   = "25.00",
    currency = "USD",
    invoice  = "Order #4821"
});
resp.EnsureSuccessStatusCode();
var data = await resp.Content.ReadFromJsonAsync<JsonElement>();
var collectUrl = data.GetProperty("collectUrl").GetString();   // share with customer
var reference  = data.GetProperty("externalId").GetString();   // store against order
Console.WriteLine($"{collectUrl} {reference}");

// 2) Poll status
var status = await http.GetFromJsonAsync<JsonElement>($"integrations/whish/payments/{reference}");
Console.WriteLine(status.GetProperty("status").GetString());`,

  java: `import java.net.URI;
import java.net.http.*;

var client = HttpClient.newHttpClient();
String base = "${base}";
String key  = System.getenv("WHISH_KEY");   // tsk_XXXXXXXX_your_secret

// 1) Create a payment link
String body = "{\\"amount\\":\\"25.00\\",\\"currency\\":\\"USD\\",\\"invoice\\":\\"Order #4821\\"}";
HttpRequest create = HttpRequest.newBuilder(URI.create(base + "/integrations/whish/payments"))
    .header("Authorization", "Bearer " + key)
    .header("Content-Type", "application/json")
    .POST(HttpRequest.BodyPublishers.ofString(body))
    .build();
HttpResponse<String> resp = client.send(create, HttpResponse.BodyHandlers.ofString());
System.out.println(resp.statusCode());
System.out.println(resp.body());            // contains collectUrl + externalId

// 2) Poll status (reference = externalId from the response above)
HttpRequest status = HttpRequest.newBuilder(URI.create(base + "/integrations/whish/payments/3"))
    .header("Authorization", "Bearer " + key)
    .GET().build();
System.out.println(client.send(status, HttpResponse.BodyHandlers.ofString()).body());`,
});

async function callIntegration(
  key: string,
  path: string,
  method: 'GET' | 'POST',
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key.trim()}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

export function DevelopersView() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Developer tools</h1>
        <p className="text-sm text-muted-foreground">
          Integrate Whish Pay into your CRM. Generate a payment link from your own backend, share it
          with your customer, and the payment settles into your wallet automatically.
        </p>
      </div>

      <ProcessCard />
      <Tester />
      <WebhookCard />
      <CodeExamples />
      <ReferenceCard />
    </div>
  );
}

function WebhookCard() {
  const qc = useQueryClient();
  const [url, setUrl] = useState('');
  const [revealed, setRevealed] = useState<string | null>(null);
  const queryKey = ['company', 'whish', 'webhook'] as const;

  const cfgQ = useQuery({
    queryKey,
    queryFn: () => apiFetch<WhishWebhookConfig>('/company/whish/webhook'),
  });

  const onResult = (c: WhishWebhookConfig) => {
    if (c.secret) setRevealed(c.secret);
    qc.invalidateQueries({ queryKey });
  };
  const err = (e: unknown) => toast.error(e instanceof ApiClientError ? e.message : 'Failed');

  const saveMu = useMutation({
    mutationFn: (u: string) =>
      apiFetch<WhishWebhookConfig>('/company/whish/webhook', { method: 'PUT', body: { url: u } }),
    onSuccess: (c) => {
      toast.success('Webhook saved');
      setUrl('');
      onResult(c);
    },
    onError: err,
  });
  const rotateMu = useMutation({
    mutationFn: () =>
      apiFetch<WhishWebhookConfig>('/company/whish/webhook/rotate-secret', { method: 'POST' }),
    onSuccess: (c) => {
      toast.success('Secret rotated');
      onResult(c);
    },
    onError: err,
  });
  const clearMu = useMutation({
    mutationFn: () => apiFetch<WhishWebhookConfig>('/company/whish/webhook', { method: 'DELETE' }),
    onSuccess: () => {
      toast.success('Webhook disabled');
      setRevealed(null);
      qc.invalidateQueries({ queryKey });
    },
    onError: err,
  });

  const cfg = cfgQ.data;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Webhook (push, instead of polling)</CardTitle>
        <CardDescription>
          We POST a signed <code>whish.payment.paid</code> event to your URL when a payment settles.
          Verify the <code>X-Whish-Signature: sha256=&lt;hmac&gt;</code> header using your secret.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Current:</span>
          {cfg?.url ? (
            <>
              <code className="font-mono text-xs break-all">{cfg.url}</code>
              <Badge variant="success">active</Badge>
            </>
          ) : (
            <span className="text-muted-foreground">not configured</span>
          )}
        </div>

        <div className="flex flex-wrap items-end gap-2">
          <div className="w-full flex-1 space-y-2 sm:min-w-[260px]">
            <Label htmlFor="whurl">Webhook URL</Label>
            <Input
              id="whurl"
              placeholder="https://crm.example.com/hooks/whish"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>
          <Button disabled={saveMu.isPending || !url} onClick={() => saveMu.mutate(url)}>
            {cfg?.url ? 'Update' : 'Save'}
          </Button>
          {cfg?.url && (
            <>
              <Button
                variant="outline"
                disabled={rotateMu.isPending}
                onClick={() => rotateMu.mutate()}
              >
                Rotate secret
              </Button>
              <Button variant="ghost" disabled={clearMu.isPending} onClick={() => clearMu.mutate()}>
                Disable
              </Button>
            </>
          )}
        </div>

        {revealed && (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground">
              Signing secret — copy it now, it&apos;s shown only once:
            </p>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded-md border bg-muted/30 p-2 font-mono text-xs break-all">
                {revealed}
              </code>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  navigator.clipboard?.writeText(revealed);
                  toast.success('Copied');
                }}
              >
                Copy
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ProcessCard() {
  const steps = [
    ['Create a key', 'Mint a company API key in Settings → API keys. The secret is shown once.'],
    ['Generate a link', 'POST /integrations/whish/payments with amount + currency + invoice.'],
    [
      'Share collectUrl',
      'Send the returned collectUrl to your customer; store externalId on your order.',
    ],
    [
      'Settle automatically',
      'On payment, we verify with Whish, apply commission, and credit your wallet.',
    ],
    ['Know the result', 'Poll GET /integrations/whish/payments/{ref} until status is PAID/FAILED.'],
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Integration process</CardTitle>
        <CardDescription>Five steps, end to end.</CardDescription>
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
        <p className="mt-4 text-xs text-muted-foreground">
          Need a key?{' '}
          <Link href="/app/settings" className="text-primary hover:underline">
            Create one in Settings → API keys
          </Link>
          .
        </p>
      </CardContent>
    </Card>
  );
}

function Tester() {
  const [key, setKey] = useState('');
  const [amount, setAmount] = useState('25.00');
  const [currency, setCurrency] = useState<string>('USD');
  const [invoice, setInvoice] = useState('Order #4821');
  const cfgQ = useQuery({
    queryKey: ['company', 'whish', 'config'],
    queryFn: () => apiFetch<WhishClientConfig>('/company/whish/config'),
  });
  const currencies = cfgQ.data?.enabledCurrencies ?? ['USD'];
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ status: number; json: unknown } | null>(null);
  const [ref, setRef] = useState<string | null>(null);

  async function run(fn: () => Promise<{ status: number; json: unknown }>) {
    if (!key.trim()) {
      toast.error('Paste an API key first');
      return;
    }
    setBusy(true);
    try {
      const r = await fn();
      setResult(r);
      const j = r.json as { externalId?: string } | null;
      if (j?.externalId) setRef(j.externalId);
    } catch (e) {
      setResult({ status: 0, json: { error: e instanceof Error ? e.message : 'network error' } });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Live tester</CardTitle>
        <CardDescription>
          Run a real request against this API with your key — straight from the browser. Nothing is
          stored here; the key stays in this page.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="key">Company API key</Label>
          <Input
            id="key"
            placeholder="tsk_XXXXXXXX_your_secret"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            className="font-mono text-xs"
          />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="space-y-2">
            <Label htmlFor="amt">Amount</Label>
            <Input id="amt" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Currency</Label>
            <div className="flex gap-2">
              {currencies.map((c) => (
                <Button
                  key={c}
                  type="button"
                  size="sm"
                  variant={c === currency ? 'default' : 'outline'}
                  onClick={() => setCurrency(c)}
                >
                  {c}
                </Button>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="inv">Invoice</Label>
            <Input id="inv" value={invoice} onChange={(e) => setInvoice(e.target.value)} />
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            disabled={busy}
            onClick={() =>
              run(() =>
                callIntegration(key, '/integrations/whish/payments', 'POST', {
                  amount,
                  currency,
                  invoice,
                }),
              )
            }
          >
            {busy ? 'Running…' : 'POST create payment'}
          </Button>
          <Button
            variant="outline"
            disabled={busy || !ref}
            onClick={() =>
              run(() => callIntegration(key, `/integrations/whish/payments/${ref}`, 'GET'))
            }
          >
            GET status{ref ? ` (#${ref})` : ''}
          </Button>
          <Button
            variant="outline"
            disabled={busy || !ref}
            onClick={() =>
              run(() => callIntegration(key, `/integrations/whish/payments/${ref}/refresh`, 'POST'))
            }
          >
            POST refresh
          </Button>
        </div>

        {result && (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Response</span>
              <Badge
                variant={result.status >= 200 && result.status < 300 ? 'success' : 'destructive'}
              >
                HTTP {result.status || 'ERR'}
              </Badge>
            </div>
            <pre className="overflow-x-auto rounded-md border bg-muted/30 p-3 font-mono text-xs">
              {JSON.stringify(result.json, null, 2)}
            </pre>
            {result.status === 400 && JSON.stringify(result.json).includes('not configured') && (
              <p className="text-xs text-amber-600">
                Auth + routing work — this only means the platform&apos;s Whish credentials
                aren&apos;t set yet. A real key returns a <code>collectUrl</code>.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function CodeExamples() {
  const [lang, setLang] = useState<Lang>('curl');
  const code = snippets(API_BASE)[lang];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Code examples</CardTitle>
        <CardDescription>
          Authentication is the same everywhere:{' '}
          <code>Authorization: Bearer &lt;company key&gt;</code>. No cookies, no CSRF.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-1">
          {LANGS.map((l) => (
            <Button
              key={l.id}
              size="sm"
              variant={l.id === lang ? 'default' : 'ghost'}
              onClick={() => setLang(l.id)}
            >
              {l.label}
            </Button>
          ))}
        </div>
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
      </CardContent>
    </Card>
  );
}

function ReferenceCard() {
  const rows: [string, string, string][] = [
    ['POST', '/integrations/whish/payments', 'Create a payment link → { collectUrl, externalId }'],
    ['GET', '/integrations/whish/payments/{ref}', 'Get a payment by reference (externalId)'],
    ['POST', '/integrations/whish/payments/{ref}/refresh', 'Force-reconcile status with Whish'],
  ];
  const errs: [string, number, string][] = [
    ['UNAUTHORIZED', 401, 'Missing / invalid / revoked API key'],
    ['VALIDATION_ERROR', 400, 'Bad amount / currency / invoice, or bad reference'],
    ['NOT_FOUND', 404, 'Reference not found for your company'],
    ['WHISH_ERROR', 502, 'Whish unreachable or rejected the request'],
  ];
  return (
    <Card>
      <CardHeader>
        <CardTitle>Endpoint &amp; error reference</CardTitle>
        <CardDescription>
          All endpoints require a company key. <code>{'{ref}'}</code> is the numeric{' '}
          <code>externalId</code>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1">
          {rows.map(([m, p, d]) => (
            <div key={p} className="grid grid-cols-12 gap-2 border-b py-2 text-xs last:border-0">
              <span className="col-span-2 font-mono font-semibold">{m}</span>
              <code className="col-span-5 font-mono">{p}</code>
              <span className="col-span-5 text-muted-foreground">{d}</span>
            </div>
          ))}
        </div>
        <div className="space-y-1">
          {errs.map(([c, s, d]) => (
            <div key={c} className="grid grid-cols-12 gap-2 border-b py-2 text-xs last:border-0">
              <code className="col-span-3 font-mono">{c}</code>
              <span className="col-span-1 text-muted-foreground">{s}</span>
              <span className="col-span-8">{d}</span>
            </div>
          ))}
        </div>
        <div className="rounded-md border-l-4 border-primary bg-primary/5 p-3 text-xs text-muted-foreground">
          <strong className="text-foreground">Sandbox:</strong> pay with phone{' '}
          <code>96170902894</code> / OTP <code>111111</code> for success. The{' '}
          <code>externalId</code> is your reference and makes settlement idempotent — a duplicate
          callback never double-credits.
        </div>
      </CardContent>
    </Card>
  );
}
