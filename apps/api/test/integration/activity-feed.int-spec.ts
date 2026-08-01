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
  addFlowFee,
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

// --- money semantics with non-zero fees ---
// The flow tables' stored `amount` is the REQUESTED figure: gross for a
// DEDUCTED fee but net for ON_TOP. The feed must always report the gross that
// actually moved (net + fee) — this block locks that with real fees in both
// modes, where the earlier fee-0 fixtures could not tell the difference.
describe('activity feed — gross amounts with non-zero fees', () => {
  let companyC: string;
  let userC: string;
  let idDepositC: string; //    DEPOSIT 1000, 10% commission → fee 100, net 900
  let idWithdrawalC: string; // WITHDRAWAL 150, 10% ON_TOP   → fee 15, net 150, gross 165
  let idPayoutC: string; //     PAYOUT 100, 10% DEDUCTED     → fee 10, net 90, gross 100
  // Company C's rows are created at "now", so they never leak into the pinned
  // BEFORE_OTHERS admin-scope expectations above; C's own queries are RLS-scoped.
  const queryC = { page: 1, pageSize: 20 };

  beforeAll(async () => {
    const c = await createCompany(h);
    companyC = c.companyId;
    userC = c.userId;
    const sourceC = await createEnabledSource(h, companyC);
    await addTransactionFee(h, companyC, '10');
    await addFlowFee(h, companyC, 'WITHDRAWAL', '10', 'ON_TOP');
    await addFlowFee(h, companyC, 'PAYOUT', '10', 'DEDUCTED');

    const dep = await h.transactions.ingest(
      { kind: 'source', sourceId: sourceC },
      ingestInput(companyC, '1000'),
    );
    idDepositC = dep.id; // available: 900

    const wd = await h.withdrawals.request(companyC, userC, cashWithdrawalInput('150'));
    await h.withdrawals.approve(wd.id, userC, { externalReference: 'wd-ontop-1' });
    idWithdrawalC = wd.id; // gross 165 leaves → available: 735

    const po = await h.payouts.request(companyC, userC, payoutInput('100'));
    await h.payouts.approve(po.id, userC, { externalReference: 'pay-ded-1' });
    idPayoutC = po.id; // gross 100 leaves → available: 635
  });

  it('lists gross (net + fee) for every row, in both fee modes', async () => {
    const r = await activity.list({ companyId: companyC, query: queryC });
    const byId = new Map(r.data.map((x) => [x.id, x]));

    const wd = byId.get(idWithdrawalC)!;
    expect(moneyEq(wd.amount, '165')).toBe(true); // NOT the requested 150
    expect(moneyEq(wd.fee, '15')).toBe(true);
    expect(moneyEq(wd.net, '150')).toBe(true);

    const po = byId.get(idPayoutC)!;
    expect(moneyEq(po.amount, '100')).toBe(true);
    expect(moneyEq(po.fee, '10')).toBe(true);
    expect(moneyEq(po.net, '90')).toBe(true);

    const dep = byId.get(idDepositC)!;
    expect(moneyEq(dep.amount, '1000')).toBe(true);
    expect(moneyEq(dep.fee, '100')).toBe(true);
    expect(moneyEq(dep.net, '900')).toBe(true);

    // The invariant the export/UI rely on: amount is always fee + net.
    for (const row of r.data) {
      expect(Money.of(row.amount).eq(Money.of(row.fee).add(Money.of(row.net)))).toBe(true);
    }

    // Balance mode still reconciles — proves the gross change didn't leak into
    // the (ledger-driven) running-balance math. 900 − 165 − 100 = 635.
    expect(r.meta.balanceMode).toBe(true);
    expect(moneyEq(r.data[0].balanceAfter, '635')).toBe(true);
    const wallet = await h.prisma.runAsScoped(companyC, (tx) =>
      tx.wallet.findUnique({
        where: { companyId_currency: { companyId: companyC, currency: 'USD' } },
      }),
    );
    expect(moneyEq(r.data[0].balanceAfter, wallet!.availableBalance.toString())).toBe(true);
  });

  it('exports gross_amount/fee_amount/net_amount/fee_application columns in the CSV', async () => {
    const file = activity.streamCsv({ companyId: companyC, query: queryC });
    let csv = '';
    for await (const chunk of file.getStream()) csv += chunk;
    const lines = csv.trim().split('\n');
    expect(lines).toHaveLength(4); // header + 3 rows

    const header = lines[0].split(',').map((c) => c.trim());
    expect(header).toContain('gross_amount');
    expect(header).toContain('fee_amount');
    expect(header).toContain('net_amount');
    expect(header).toContain('fee_application');
    // The ambiguous bare columns must be gone.
    expect(header).not.toContain('amount');
    expect(header).not.toContain('fee');
    expect(header).not.toContain('net');

    // Money columns are the CSV's last four cells (currency, gross, fee, net,
    // fee_application) — index from the end so free-text cells can't shift them.
    const moneyTail = (line: string) => {
      const cells = line.split(',');
      return {
        gross: cells[cells.length - 4],
        fee: cells[cells.length - 3],
        net: cells[cells.length - 2],
        feeApplication: cells[cells.length - 1],
      };
    };

    const wdLine = lines.find((l) => l.startsWith(idWithdrawalC))!;
    const wd = moneyTail(wdLine);
    expect(moneyEq(wd.gross, '165')).toBe(true);
    expect(moneyEq(wd.fee, '15')).toBe(true);
    expect(moneyEq(wd.net, '150')).toBe(true);
    expect(wd.feeApplication).toBe('ON_TOP');

    const poLine = lines.find((l) => l.startsWith(idPayoutC))!;
    const po = moneyTail(poLine);
    expect(moneyEq(po.gross, '100')).toBe(true);
    expect(po.feeApplication).toBe('DEDUCTED');

    const depLine = lines.find((l) => l.startsWith(idDepositC))!;
    const dep = moneyTail(depLine);
    expect(moneyEq(dep.gross, '1000')).toBe(true);
    expect(moneyEq(dep.fee, '100')).toBe(true);
    expect(moneyEq(dep.net, '900')).toBe(true);
    expect(dep.feeApplication).toBe(''); // deposits have no fee mode
  });
});

// A deposit priced ON_TOP is the one case where the transactions table's stored
// `amount` is the NET, not the gross (ingest credits the full amount and debits
// amount + fee externally). The fixtures above only ever priced deposits
// DEDUCTED, where amount happens to equal net + fee, so they could not tell the
// two apart. Deposits carry no fee_application column, so the feed must derive
// the gross as net + commission — the identity that holds under BOTH modes.
describe('activity feed — ON_TOP deposit reports the gross that actually moved', () => {
  let companyD: string;
  let idDepositD: string; // DEPOSIT 1000, 10% ON_TOP → fee 100, net 1000, gross 1100
  const queryD = { page: 1, pageSize: 20 };

  beforeAll(async () => {
    const d = await createCompany(h);
    companyD = d.companyId;
    const sourceD = await createEnabledSource(h, companyD);
    await addFlowFee(h, companyD, 'TRANSACTION', '10', 'ON_TOP');

    const dep = await h.transactions.ingest(
      { kind: 'source', sourceId: sourceD },
      ingestInput(companyD, '1000'),
    );
    idDepositD = dep.id;
    // ON_TOP credits the full requested amount; the fee is charged on top of it.
    expect(moneyEq(dep.netAmount, '1000')).toBe(true);
  });

  it('lists gross 1100 (net 1000 + fee 100), not the stored amount 1000', async () => {
    const r = await activity.list({ companyId: companyD, query: queryD });
    const dep = r.data.find((x) => x.id === idDepositD)!;
    expect(moneyEq(dep.amount, '1100')).toBe(true);
    expect(moneyEq(dep.fee, '100')).toBe(true);
    expect(moneyEq(dep.net, '1000')).toBe(true);
    // The invariant the export/UI rely on must hold for deposits too.
    expect(Money.of(dep.amount).eq(Money.of(dep.fee).add(Money.of(dep.net)))).toBe(true);

    // The gross fix must not leak into the ledger-driven running balance: the
    // wallet was credited the net (1000), not the gross.
    expect(r.meta.balanceMode).toBe(true);
    expect(moneyEq(dep.balanceAfter, '1000')).toBe(true);
  });

  it('exports the same gross in the CSV', async () => {
    const file = activity.streamCsv({ companyId: companyD, query: queryD });
    let csv = '';
    for await (const chunk of file.getStream()) csv += chunk;
    const line = csv
      .trim()
      .split('\n')
      .find((l) => l.startsWith(idDepositD))!;
    const cells = line.split(',');
    expect(moneyEq(cells[cells.length - 4], '1100')).toBe(true); // gross_amount
    expect(moneyEq(cells[cells.length - 3], '100')).toBe(true); // fee_amount
    expect(moneyEq(cells[cells.length - 2], '1000')).toBe(true); // net_amount
  });
});
