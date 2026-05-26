#!/usr/bin/env node
/**
 * Light load test for the ingestion path.
 *
 * Usage (from repo root):
 *   pnpm exec tsx scripts/loadtest.ts \
 *     --base http://localhost:3001/v1--concurrency 20 --count 500
 *
 * Defaults are listed below. The script:
 *   1. logs in as the seed admin
 *   2. creates a throwaway company + API key
 *   3. fans out `count` ingestion requests with `concurrency` workers
 *   4. prints p50/p95/p99 + counts of 2xx / 4xx / 429 / 5xx
 *   5. queries the wallet to confirm ledger consistency at the end
 */
import { setTimeout as wait } from 'node:timers/promises';

interface Args {
  base: string;
  concurrency: number;
  count: number;
  email: string;
  password: string;
  source: string;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (k: string, def: string) => {
    const i = argv.indexOf(k);
    return i >= 0 ? (argv[i + 1] ?? def) : def;
  };
  return {
    base: get('--base', 'http://localhost:3001/v1'),
    concurrency: Number(get('--concurrency', '20')),
    count: Number(get('--count', '500')),
    email: get('--email', 'admin@example.com'),
    password: get('--password', 'AdminPassw0rd!'),
    source: get('--source', 'omt'),
  };
}

async function jsonFetch<T>(
  url: string,
  init: RequestInit & { cookies?: string; csrf?: string } = {},
): Promise<{ status: number; body: T; setCookies: string[] }> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(init.body ? { 'content-type': 'application/json' } : {}),
    ...(init.cookies ? { cookie: init.cookies } : {}),
    ...(init.csrf ? { 'x-csrf-token': init.csrf } : {}),
    ...(init.headers as Record<string, string> | undefined),
  };
  const res = await fetch(url, { ...init, headers });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep as text */
  }
  return {
    status: res.status,
    body: body as T,
    setCookies: res.headers.getSetCookie?.() ?? [],
  };
}

function parseCookies(setCookies: string[]): { jar: string; csrf?: string } {
  const pairs = setCookies.map((c) => c.split(';')[0]!).filter(Boolean);
  const jar = pairs.join('; ');
  const csrf = pairs.find((p) => p.startsWith('csrf-token='))?.split('=')[1];
  return { jar, csrf };
}

function pct(sortedMs: number[], p: number): number {
  if (sortedMs.length === 0) return 0;
  const idx = Math.min(sortedMs.length - 1, Math.floor((sortedMs.length - 1) * p));
  return sortedMs[idx]!;
}

async function main() {
  const args = parseArgs();
  console.log(
    `Loadtest: ${args.count} requests, concurrency ${args.concurrency}, base ${args.base}`,
  );

  // 1. Login as admin.
  const login = await jsonFetch<unknown>(`${args.base}/auth/login`, {
    method: 'POST',
    body: JSON.stringify({ email: args.email, password: args.password }),
  });
  if (login.status !== 200) {
    console.error(`login failed: ${login.status}`, login.body);
    process.exit(1);
  }
  const adminCookies = parseCookies(login.setCookies);
  if (!adminCookies.csrf) {
    console.error('admin login did not return csrf cookie');
    process.exit(1);
  }

  // 2. Create a throwaway company.
  const slug = `lt-${Date.now().toString(36)}`;
  const create = await jsonFetch<{
    company: { id: string };
    owner: { email: string; temporaryPassword: string };
  }>(`${args.base}/admin/companies`, {
    method: 'POST',
    cookies: adminCookies.jar,
    csrf: adminCookies.csrf,
    body: JSON.stringify({
      name: `Loadtest ${slug}`,
      slug,
      defaultCurrency: 'USD',
      ownerEmail: `${slug}@loadtest.local`,
    }),
  });
  if (create.status !== 201 && create.status !== 200) {
    console.error(`create company failed: ${create.status}`, create.body);
    process.exit(1);
  }
  const { owner } = create.body;

  // 3. Owner login.
  const ownerLogin = await jsonFetch<unknown>(`${args.base}/auth/login`, {
    method: 'POST',
    body: JSON.stringify({ email: owner.email, password: owner.temporaryPassword }),
  });
  const ownerCookies = parseCookies(ownerLogin.setCookies);
  if (!ownerCookies.csrf) {
    console.error('owner login did not return csrf cookie');
    process.exit(1);
  }

  // 4. Mint API key.
  const keyRes = await jsonFetch<{ plaintext: string }>(`${args.base}/company/api-keys`, {
    method: 'POST',
    cookies: ownerCookies.jar,
    csrf: ownerCookies.csrf,
    body: JSON.stringify({ name: 'loadtest' }),
  });
  if (keyRes.status !== 201 && keyRes.status !== 200) {
    console.error(`api key failed: ${keyRes.status}`, keyRes.body);
    process.exit(1);
  }
  const apiKey = keyRes.body.plaintext;

  // 5. Fan out ingestion calls.
  const buckets = { ok: 0, rateLimited: 0, clientErr: 0, serverErr: 0 };
  const durations: number[] = [];
  const tStart = Date.now();

  async function worker(workerId: number) {
    while (true) {
      const i = nextId();
      if (i === null) return;
      const t0 = performance.now();
      const res = await fetch(`${args.base}/ingest/transactions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          sourceCode: args.source,
          externalTransactionId: `lt-${slug}-${i}`,
          amount: '2',
          currency: 'USD',
          payload: { worker: workerId, i },
        }),
      });
      const dt = performance.now() - t0;
      durations.push(dt);
      if (res.status >= 200 && res.status < 300) buckets.ok++;
      else if (res.status === 429) buckets.rateLimited++;
      else if (res.status >= 400 && res.status < 500) buckets.clientErr++;
      else buckets.serverErr++;
    }
  }

  let cursor = 0;
  function nextId(): number | null {
    if (cursor >= args.count) return null;
    return cursor++;
  }

  const workers = Array.from({ length: args.concurrency }, (_, i) => worker(i));
  await Promise.all(workers);
  const elapsedMs = Date.now() - tStart;

  // 6. Final wallet check.
  await wait(500);
  const wallets = await jsonFetch<{ data: { currency: string; availableBalance: string }[] }>(
    `${args.base}/company/wallets`,
    { cookies: ownerCookies.jar },
  );
  const usd = wallets.body.data.find((w) => w.currency === 'USD');

  const sorted = [...durations].sort((a, b) => a - b);

  console.log('');
  console.log('=== Results ===');
  console.log(`Elapsed:        ${elapsedMs} ms`);
  console.log(`Throughput:     ${((args.count / elapsedMs) * 1000).toFixed(1)} req/s`);
  console.log(`Latency p50:    ${pct(sorted, 0.5).toFixed(1)} ms`);
  console.log(`Latency p95:    ${pct(sorted, 0.95).toFixed(1)} ms`);
  console.log(`Latency p99:    ${pct(sorted, 0.99).toFixed(1)} ms`);
  console.log(`Latency max:    ${pct(sorted, 1.0).toFixed(1)} ms`);
  console.log('');
  console.log(`Succeeded:      ${buckets.ok}`);
  console.log(`Rate-limited:   ${buckets.rateLimited}`);
  console.log(`Client errors:  ${buckets.clientErr}`);
  console.log(`Server errors:  ${buckets.serverErr}`);
  console.log('');
  if (usd) {
    const expectedAvail = (buckets.ok * 1).toFixed(0); // each tx: 2 amount - 1 fee = 1 net
    console.log(`USD wallet:     ${usd.availableBalance} (expected ${expectedAvail})`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
