/**
 * Integration tests for the unified activity feed (ActivityService) — the
 * cross-table UNION ALL of COMPLETED deposits/loads/withdrawals/payouts. These
 * lock the feed's observable contract (chronological ordering, COMPLETED-only,
 * each filter, pagination, totals, tenant isolation, and the running-balance
 * reconciliation to the wallet) so the query-shape optimizations cannot silently
 * change any result. Behaviour is asserted against correct expected values, not
 * against the prior implementation, so it is a true contract — equally valid
 * before and after the rewrite.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money, ActivityKind, ActivityDirection } from '@app/shared';
import type { ActivityListResponse, ListActivityQuery } from '@app/shared';
import { ActivityService } from '../../src/modules/activity/activity.service';
import type { CacheService } from '../../src/modules/cache/cache.service';
import {
  addTransactionFee,
  buildHarness,
  createCompany,
  createEnabledSource,
  ingestInput,
  cashWithdrawalInput,
  payoutInput,
  loadInput,
  type Harness,
} from './harness';

const moneyEq = (a: string | null, b: string) => a != null && Money.of(a).eq(Money.of(b));
const D = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

// Pass-through cache so the COUNT query is always recomputed (no Redis needed).
const passThroughCache = {
  async wrap<T>(_key: string, _ttl: number, fn: () => Promise<T>): Promise<T> {
    return fn();
  },
} as unknown as CacheService;

// The integration DB is shared across spec files (recreated once per run), and
// sibling specs create COMPLETED rows at "now". Our fixtures use controlled past
// dates (2026-06-01..06), so bounding admin cross-company queries to this instant
// isolates them to OUR rows. (Company-scoped/balance tests are already isolated by
// RLS to their own company, so they don't need it.)
const BEFORE_OTHERS = '2026-06-10T00:00:00.000Z';

// A baseline query; individual tests override page/pageSize/filters.
const baseQuery: ListActivityQuery = { page: 1, pageSize: 20, to: BEFORE_OTHERS };

let h: Harness;
let activity: ActivityService;

// Company A — four COMPLETED operations (one of each kind) plus one PENDING load
// that must never appear. Company B — one COMPLETED deposit, for cross-company
// and companyId-narrowing assertions.
let companyA: string;
let companyB: string;
let idDepositA: string; // DEPOSIT 100, 2026-06-01
let idLoadA: string; //    LOAD    50, 2026-06-02  (ref recv-load-001)
let idDepositB: string; // DEPOSIT 200, 2026-06-03  (company B)
let idWithdrawalA: string; // WITHDRAWAL 20, 2026-06-04
let idPayoutA: string; //  PAYOUT  30, 2026-06-05
let idPendingLoadA: string; // PENDING LOAD, 2026-06-06 (excluded)

beforeAll(async () => {
  h = buildHarness();
  await h.prisma.$connect();
  activity = new ActivityService(h.prisma, passThroughCache);

  // --- Company A: fund, then one COMPLETED op of each kind (fees 0) ---
  const a = await createCompany(h);
  companyA = a.companyId;
  const sourceA = await createEnabledSource(h, companyA);
  await addTransactionFee(h, companyA, '0'); // ingest needs a pricing rule; 0% → net == amount

  const depA = await h.transactions.ingest(
    { kind: 'source', sourceId: sourceA },
    ingestInput(companyA, '100'),
  );
  idDepositA = depA.id; // available: 100

  const loadA = await h.loads.request(companyA, a.userId, loadInput('50'));
  await h.loads.approve(loadA.id, a.userId, { externalReference: 'recv-load-001' });
  idLoadA = loadA.id; // available: 150

  const wdA = await h.withdrawals.request(companyA, a.userId, cashWithdrawalInput('20'));
  await h.withdrawals.approve(wdA.id, a.userId, { externalReference: 'wd-001' });
  idWithdrawalA = wdA.id; // available: 130

  const poA = await h.payouts.request(companyA, a.userId, payoutInput('30'));
  await h.payouts.approve(poA.id, a.userId, { externalReference: 'pay-001' });
  idPayoutA = poA.id; // available: 100

  const pendingLoadA = await h.loads.request(companyA, a.userId, loadInput('999'));
  idPendingLoadA = pendingLoadA.id; // stays PENDING — must be excluded

  // --- Company B: one COMPLETED deposit ---
  const b = await createCompany(h);
  companyB = b.companyId;
  const sourceB = await createEnabledSource(h, companyB);
  await addTransactionFee(h, companyB, '0');
  const depB = await h.transactions.ingest(
    { kind: 'source', sourceId: sourceB },
    ingestInput(companyB, '200'),
  );
  idDepositB = depB.id;

  // Pin created_at to deterministic, well-separated days so ordering, date
  // filters, and the running-balance window are all exactly reproducible. (admin
  // scope bypasses RLS; created_at is a plain settable column here.)
  await h.prisma.runAsAdmin(async (tx) => {
    await tx.transaction.update({
      where: { id: idDepositA },
      data: { createdAt: D('2026-06-01') },
    });
    await tx.load.update({ where: { id: idLoadA }, data: { createdAt: D('2026-06-02') } });
    await tx.transaction.update({
      where: { id: idDepositB },
      data: { createdAt: D('2026-06-03') },
    });
    await tx.withdrawal.update({
      where: { id: idWithdrawalA },
      data: { createdAt: D('2026-06-04') },
    });
    await tx.payout.update({ where: { id: idPayoutA }, data: { createdAt: D('2026-06-05') } });
    await tx.load.update({ where: { id: idPendingLoadA }, data: { createdAt: D('2026-06-06') } });
  });
});

afterAll(async () => {
  await h.prisma.$disconnect();
});

// --- standard list (no running balance) ---
describe('activity feed — normal list', () => {
  const ids = (r: ActivityListResponse) => r.data.map((x) => x.id);

  it('admin sees all COMPLETED across companies, newest first; PENDING excluded', async () => {
    const r = await activity.list({ query: baseQuery });
    expect(r.meta.balanceMode).toBe(false);
    expect(r.meta.total).toBe(5);
    expect(ids(r)).toEqual([idPayoutA, idWithdrawalA, idDepositB, idLoadA, idDepositA]);
    expect(r.data.map((x) => x.id)).not.toContain(idPendingLoadA);
    // Admin scope carries company attribution.
    expect(r.data[0].companyId).toBe(companyA);
    expect(r.data[2].companyId).toBe(companyB);
  });

  it('filters by kind', async () => {
    const r = await activity.list({ query: { ...baseQuery, kind: ActivityKind.LOAD } });
    expect(r.meta.total).toBe(1);
    expect(ids(r)).toEqual([idLoadA]);
  });

  it('filters by direction (IN = deposits + loads, OUT = withdrawals + payouts)', async () => {
    const out = await activity.list({ query: { ...baseQuery, direction: ActivityDirection.OUT } });
    expect(ids(out)).toEqual([idPayoutA, idWithdrawalA]);
    expect(out.meta.total).toBe(2);

    const inc = await activity.list({ query: { ...baseQuery, direction: ActivityDirection.IN } });
    expect(ids(inc)).toEqual([idDepositB, idLoadA, idDepositA]);
    expect(inc.meta.total).toBe(3);
  });

  it('filters by inclusive date range', async () => {
    const r = await activity.list({
      query: {
        ...baseQuery,
        from: '2026-06-02T00:00:00.000Z',
        to: '2026-06-04T00:00:00.000Z',
      },
    });
    expect(ids(r)).toEqual([idWithdrawalA, idDepositB, idLoadA]);
    expect(r.meta.total).toBe(3);
  });

  it('filters by search across reference / description / details', async () => {
    const r = await activity.list({ query: { ...baseQuery, search: 'recv-load' } });
    expect(ids(r)).toEqual([idLoadA]);
    expect(r.meta.total).toBe(1);
  });

  it('narrows to one company (admin companyId filter)', async () => {
    // direction keeps this on the normal-list path even for a single company.
    const r = await activity.list({
      query: { ...baseQuery, companyId: companyA, direction: ActivityDirection.IN },
    });
    expect(ids(r)).toEqual([idLoadA, idDepositA]);
    expect(r.meta.total).toBe(2);
  });

  it('paginates with a stable total', async () => {
    const p1 = await activity.list({ query: { page: 1, pageSize: 2, to: BEFORE_OTHERS } });
    expect(ids(p1)).toEqual([idPayoutA, idWithdrawalA]);
    expect(p1.meta.total).toBe(5);
    expect(p1.meta.totalPages).toBe(3);

    const p2 = await activity.list({ query: { page: 2, pageSize: 2, to: BEFORE_OTHERS } });
    expect(ids(p2)).toEqual([idDepositB, idLoadA]);

    const p3 = await activity.list({ query: { page: 3, pageSize: 2, to: BEFORE_OTHERS } });
    expect(ids(p3)).toEqual([idDepositA]);
  });

  it('isolates a company scope to its own rows', async () => {
    // Company scope WITH a filter stays on the normal-list path; only A's rows.
    const r = await activity.list({
      companyId: companyA,
      query: { ...baseQuery, direction: ActivityDirection.IN },
    });
    expect(ids(r)).toEqual([idLoadA, idDepositA]);
    // Company feed hides its own attribution (it's single-tenant).
    expect(r.data.every((x) => x.companyId === null && x.companyName === null)).toBe(true);
  });

  it('rejects a too-deep page instead of scanning forever', async () => {
    await expect(activity.list({ query: { page: 5000, pageSize: 20 } })).rejects.toThrow();
  });
});

// --- running-balance mode (single company + currency, no kind/direction/search) ---
describe('activity feed — balance mode', () => {
  it('reports an absolute running AVAILABLE balance that reconciles to the wallet', async () => {
    const r = await activity.list({
      companyId: companyA,
      query: { ...baseQuery, currency: 'USD' },
    });
    expect(r.meta.balanceMode).toBe(true);
    expect(r.meta.total).toBe(4); // company A's four COMPLETED ops; PENDING excluded
    expect(r.data.map((x) => x.id)).toEqual([idPayoutA, idWithdrawalA, idLoadA, idDepositA]);

    // Cumulative AVAILABLE in chronological order: +100, +50, -20, -30.
    // Shown newest-first, so balanceAfter reads 100, 130, 150, 100.
    expect(moneyEq(r.data[0].balanceAfter, '100')).toBe(true); // payout  (latest)
    expect(moneyEq(r.data[1].balanceAfter, '130')).toBe(true); // withdrawal
    expect(moneyEq(r.data[2].balanceAfter, '150')).toBe(true); // load
    expect(moneyEq(r.data[3].balanceAfter, '100')).toBe(true); // deposit (earliest)

    // The newest row's running balance equals the wallet's actual available.
    const wallet = await h.prisma.runAsScoped(companyA, (tx) =>
      tx.wallet.findUnique({
        where: { companyId_currency: { companyId: companyA, currency: 'USD' } },
      }),
    );
    expect(wallet).not.toBeNull();
    expect(moneyEq(r.data[0].balanceAfter, wallet!.availableBalance.toString())).toBe(true);
  });

  it('keeps balances absolute when a date filter trims the visible rows', async () => {
    const r = await activity.list({
      companyId: companyA,
      query: { ...baseQuery, currency: 'USD', from: '2026-06-05T00:00:00.000Z' },
    });
    expect(r.meta.balanceMode).toBe(true);
    expect(r.data.map((x) => x.id)).toEqual([idPayoutA]);
    // Still the absolute balance after the payout, not a page-relative subtotal.
    expect(moneyEq(r.data[0].balanceAfter, '100')).toBe(true);
  });
});
