#!/usr/bin/env node
/* eslint-disable no-console -- a command-line report: printing is its job */
/**
 * Load test for the Whish deposit path, end to end: many companies' customers
 * create payment links at once, most pay, the rest let the link expire, and
 * each company's CRM is told the outcome. Measures what a company feels:
 *
 *   - link creation: throughput, latency, refusals;
 *   - paid links: from the customer paying to the deposit being booked, and to
 *     the company's CRM being told (`transaction.completed`);
 *   - unpaid links: from Whish expiring the link to the company being told
 *     (`transaction.failed`).
 *
 * Runs against a LOCAL stack only — never staging or production. It needs:
 *   - the fake Whish in live mode:  node scripts/fake-whish.cjs
 *     (FAKE_WHISH_LATENCY_MS adds Whish's answer time; links expire unpaid
 *     after FAKE_WHISH_LINK_TTL_MS, 5 minutes by default, as Whish);
 *   - an API on a throwaway database, pointed at it (WHISH_BASE_URL), with
 *     THROTTLE_DISABLED=true for the setup logins;
 *   - psql, and --db: a superuser URL for that throwaway database (companies'
 *     CRMs are pointed at the API's built-in demo receiver directly in SQL, and
 *     the results are read from it).
 *
 *   pnpm exec tsx scripts/loadtest-whish.ts --api http://localhost:4011/v1 \
 *     --whish http://localhost:4100 --db postgresql://…/txn_e2e \
 *     --companies 50 --links 20000 --concurrency 200
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch {
  /* no .env present — rely on flags */
}

const argv = process.argv.slice(2);
const flag = (k: string, def: string) => {
  const i = argv.indexOf(k);
  return i >= 0 ? (argv[i + 1] ?? def) : def;
};
const args = {
  api: flag('--api', 'http://localhost:4011/v1'),
  whish: flag('--whish', 'http://localhost:4100'),
  db: flag('--db', process.env.LOADTEST_DB_URL ?? ''),
  companies: Number(flag('--companies', '50')),
  links: Number(flag('--links', '5000')),
  concurrency: Number(flag('--concurrency', '200')),
  payRatio: Number(flag('--pay-ratio', '0.85')),
  ttlMs: Number(flag('--ttl-ms', String(5 * 60_000))),
  email: flag('--email', process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com'),
  password: flag('--password', process.env.E2E_ADMIN_PASSWORD ?? 'AdminPassw0rd!'),
  waitMinutes: Number(flag('--wait-minutes', '25')),
};
if (!args.db) throw new Error('--db (or LOADTEST_DB_URL) is required');
if (/rivalpayments|187\.77\.177\.127/.test(`${args.api} ${args.db}`)) {
  throw new Error('loadtest-whish runs against a local stack only');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function psql(sql: string): string[][] {
  const out = execFileSync('psql', [args.db, '-X', '-At', '-F', '\t', '-v', 'ON_ERROR_STOP=1'], {
    input: `SET app.bypass_rls = 'on';\n${sql}`,
    encoding: 'utf8',
    maxBuffer: 512 * 1024 * 1024,
  });
  return out
    .split('\n')
    .filter((l) => l.length && l !== 'SET')
    .map((l) => l.split('\t'));
}

interface Res<T> {
  status: number;
  body: T;
  cookies: string[];
}
async function call<T = unknown>(
  url: string,
  init: { method?: string; body?: unknown; jar?: string; csrf?: string; bearer?: string } = {},
): Promise<Res<T>> {
  const res = await fetch(url, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: {
      accept: 'application/json',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.jar ? { cookie: init.jar } : {}),
      ...(init.csrf ? { 'x-csrf-token': init.csrf } : {}),
      ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  // The API wraps successful JSON in { success, data }.
  if (body && typeof body === 'object' && 'success' in body && 'data' in body) {
    body = (body as { data: unknown }).data;
  }
  return { status: res.status, body: body as T, cookies: res.headers.getSetCookie?.() ?? [] };
}

function pct(sorted: number[], p: number): number {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))]!;
}
const secs = (ms: number) => (Number.isNaN(ms) ? '—' : `${(ms / 1000).toFixed(1)}s`);
function summary(label: string, values: number[]): void {
  const s = [...values].sort((a, b) => a - b);
  console.log(
    `  ${label.padEnd(44)} n=${String(s.length).padStart(6)}  p50 ${secs(pct(s, 0.5)).padStart(7)}` +
      `  p95 ${secs(pct(s, 0.95)).padStart(7)}  p99 ${secs(pct(s, 0.99)).padStart(7)}  max ${secs(s.at(-1) ?? NaN).padStart(7)}`,
  );
}

// How long after creation a customer pays: production's own distribution
// (median 22s, 99% within ~160s) as a log-normal, always before expiry.
function payDelayMs(): number {
  const u1 = Math.random() || 1e-9;
  const u2 = Math.random();
  const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  const ms = Math.exp(Math.log(22) + 0.853 * z) * 1000;
  return Math.min(ms, args.ttlMs - 10_000);
}

async function main() {
  console.log(
    `loadtest-whish: ${args.companies} companies, ${args.links} links, ${args.concurrency} at once, ` +
      `${Math.round(args.payRatio * 100)}% paid, links expire after ${args.ttlMs / 1000}s`,
  );
  const reset = await call(`${args.whish}/__reset`);
  if (reset.status !== 200) throw new Error(`fake Whish not reachable at ${args.whish}`);
  await call(`${args.whish}/__set-status?s=live`);

  // --- setup: companies, keys, CRM receivers -------------------------------
  const login = await call(`${args.api}/auth/login`, {
    body: { email: args.email, password: args.password },
  });
  if (login.status !== 200 && login.status !== 201) {
    throw new Error(`admin login failed: ${login.status} ${JSON.stringify(login.body)}`);
  }
  const pairs = login.cookies.map((c) => c.split(';')[0]!);
  const jar = pairs.join('; ');
  const csrf = pairs.find((p) => p.startsWith('csrf-token='))?.split('=')[1];

  const run = `lt${Date.now().toString(36)}`;
  const companies: Array<{ id: string; key: string }> = [];
  for (let i = 0; i < args.companies; i++) {
    const slug = `${run}-${i}`;
    const co = await call<{ company: { id: string } }>(`${args.api}/admin/companies`, {
      jar,
      csrf,
      body: { name: `Load ${slug}`, slug, defaultCurrency: 'USD', ownerEmail: `${slug}@load.test` },
    });
    if (co.status >= 300)
      throw new Error(`create company: ${co.status} ${JSON.stringify(co.body)}`);
    const key = await call<{ plaintext: string }>(
      `${args.api}/admin/companies/${co.body.company.id}/api-keys`,
      { jar, csrf, body: { name: 'load' } },
    );
    if (key.status >= 300) throw new Error(`create key: ${key.status} ${JSON.stringify(key.body)}`);
    companies.push({ id: co.body.company.id, key: key.body.plaintext });
  }
  // Each company's CRM = the API's built-in receiver (in-process; a real CRM
  // must be https on a public address, which a local run cannot offer).
  const apiPublic = args.api.replace(/\/$/, '');
  psql(
    companies
      .map((c) => {
        const token = randomBytes(16).toString('hex');
        return (
          `UPDATE companies SET crm_enabled = true, crm_demo_token = '${token}', ` +
          `crm_api_url = '${apiPublic}/crm-demo/${token}/inbox', crm_api_key = '${randomBytes(16).toString('hex')}' ` +
          `WHERE id = '${c.id}';`
        );
      })
      .join('\n'),
  );
  const companyList = companies.map((c) => `'${c.id}'`).join(',');
  console.log(`setup: ${companies.length} companies ready (run ${run})`);

  // --- create the links -----------------------------------------------------
  const created: Array<{ ref: string; createdAt: number; pay: boolean }> = [];
  const createMs: number[] = [];
  const refusals = new Map<string, number>();
  let next = 0;
  const t0 = Date.now();
  const payTimers: Array<Promise<void>> = [];
  const paidAt = new Map<string, number>();
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= args.links) return;
      const co = companies[i % companies.length]!;
      const start = Date.now();
      let res: Res<{ reference?: string; externalId?: string }>;
      try {
        res = await call(`${args.api}/integrations/whish/payments`, {
          bearer: co.key,
          body: { amount: '25.00', currency: 'USD', invoice: `${run}-${i}` },
        });
      } catch {
        refusals.set('network', (refusals.get('network') ?? 0) + 1);
        continue;
      }
      createMs.push(Date.now() - start);
      if (res.status >= 300) {
        const err = res.body as { error?: { code?: string }; code?: string } | null;
        const k = `${res.status} ${err?.error?.code ?? err?.code ?? ''}`;
        refusals.set(k, (refusals.get(k) ?? 0) + 1);
        continue;
      }
      const ref = String(res.body.reference ?? res.body.externalId);
      const pay = Math.random() < args.payRatio;
      created.push({ ref, createdAt: Date.now(), pay });
      if (pay) {
        payTimers.push(
          sleep(payDelayMs()).then(async () => {
            const r = await call(`${args.whish}/__pay?externalId=${ref}`).catch(() => null);
            if (r?.status === 200) paidAt.set(ref, (r.body as { paidAt: number }).paidAt);
          }),
        );
      }
    }
  };
  await Promise.all(Array.from({ length: args.concurrency }, worker));
  const createSecs = (Date.now() - t0) / 1000;
  console.log(
    `created ${created.length}/${args.links} links in ${createSecs.toFixed(1)}s ` +
      `(${(created.length / createSecs).toFixed(0)} a second)`,
  );
  if (refusals.size) console.log(`  refused:`, Object.fromEntries(refusals));

  // --- wait for every outcome to reach the companies -----------------------
  let paymentsDone = false;
  void Promise.all(payTimers).then(() => (paymentsDone = true));
  const deadline = Date.now() + args.waitMinutes * 60_000;
  let last = '';
  for (;;) {
    await sleep(5_000);
    const [[open, paid, failed]] = psql(
      `SELECT count(*) FILTER (WHERE status = 'PENDING'), count(*) FILTER (WHERE status = 'PAID'), ` +
        `count(*) FILTER (WHERE status = 'FAILED') FROM whish_payments WHERE company_id IN (${companyList});`,
    ) as [string[]];
    const [[undelivered]] = psql(
      `SELECT count(*) FROM webhook_deliveries WHERE company_id IN (${companyList}) AND status <> 'DELIVERED';`,
    ) as [string[]];
    const line = `  open ${open}  paid ${paid}  failed ${failed}  CRM events not yet delivered ${undelivered}`;
    if (line !== last) {
      console.log(`${new Date().toISOString().slice(11, 19)}${line}`);
      last = line;
    }
    if (paymentsDone && open === '0' && undelivered === '0') break;
    if (Date.now() > deadline) {
      console.log('  gave up waiting');
      break;
    }
  }

  // --- results ----------------------------------------------------------------
  const rows = psql(
    `SELECT external_id, status, extract(epoch from created_at) * 1000, ` +
      `coalesce(extract(epoch from paid_at) * 1000, 0), extract(epoch from updated_at) * 1000 ` +
      `FROM whish_payments WHERE company_id IN (${companyList});`,
  );
  const deliveries = psql(
    `SELECT payload->>'reference', event_type, status, coalesce(extract(epoch from delivered_at) * 1000, 0), attempts ` +
      `FROM webhook_deliveries WHERE company_id IN (${companyList});`,
  );
  const delivered = new Map<string, number>();
  let retried = 0;
  for (const [ref, event, status, at, attempts] of deliveries) {
    if (Number(attempts) > 1) retried++;
    if (
      status === 'DELIVERED' &&
      (event === 'transaction.completed' || event === 'transaction.failed')
    ) {
      delivered.set(`${event}:${ref}`, Number(at));
    }
  }
  const bookLag: number[] = [];
  const paidCrmLag: number[] = [];
  const failLag: number[] = [];
  const failCrmLag: number[] = [];
  let paidNotBooked = 0;
  let wronglyFailed = 0;
  let notTold = 0;
  for (const [ext, status, createdAt, paidAtMs, updatedAt] of rows) {
    const customerPaid = paidAt.get(ext!);
    if (customerPaid) {
      if (status !== 'PAID') {
        if (status === 'FAILED') wronglyFailed++;
        else paidNotBooked++;
        continue;
      }
      bookLag.push(Number(paidAtMs) - customerPaid);
      const crm = delivered.get(`transaction.completed:whish:${ext}`);
      if (crm) paidCrmLag.push(crm - customerPaid);
      else notTold++;
    } else if (status === 'FAILED') {
      const expiredAt = Number(createdAt) + args.ttlMs;
      failLag.push(Number(updatedAt) - expiredAt);
      const crm = delivered.get(`transaction.failed:whish:${ext}`);
      if (crm) failCrmLag.push(crm - expiredAt);
      else notTold++;
    }
  }
  console.log('\nResults');
  summary('create a link (API answer time)', createMs);
  summary('paid: customer pays → deposit booked', bookLag);
  summary('paid: customer pays → company CRM told', paidCrmLag);
  summary('unpaid: Whish expires → link closed', failLag);
  summary('unpaid: Whish expires → company CRM told', failCrmLag);
  console.log(
    `  correctness: ${paidNotBooked} paid but not booked, ${wronglyFailed} paid but closed failed, ` +
      `${notTold} outcomes the company was not told, ${retried} CRM deliveries needed a retry`,
  );
  const whishStats = await call(`${args.whish}/__stats`);
  console.log('  fake Whish:', JSON.stringify(whishStats.body));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
