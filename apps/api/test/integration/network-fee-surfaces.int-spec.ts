/**
 * Every company-facing and admin read surface carries the network fee
 * consistently: the activity feed (normal + running-balance mode), the three
 * CSV exports, the wallet-summary reconciliation cards, the company and admin
 * overviews, and the platform revenue / flows / operations rollups.
 *
 * Also pins the one byte-level hazard of adding a column: a company with the
 * switch OFF must see the SAME activity amount text as before (the new column
 * is DECIMAL(20,2), so it never widens a 2-dp sum's scale).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActivityKind, ActivityDirection, Money } from '@app/shared';
import type { CacheService } from '../../src/modules/cache/cache.service';
import { ActivityService } from '../../src/modules/activity/activity.service';
import { AnalyticsService } from '../../src/modules/analytics/analytics.service';
import { PlatformAnalyticsService } from '../../src/modules/analytics/platform-analytics.service';
import {
  addFixedFlowFee,
  addFlowFee,
  buildHarness,
  cashWithdrawalInput,
  createCompany,
  createEnabledSource,
  ingestInput,
  loadInput,
  payoutInput,
  setNetworkFee,
  snapshot,
  type Harness,
} from './harness';

const eq = (a: string | undefined, b: string) => a !== undefined && Money.of(a).eq(Money.of(b));

const passThroughCache = {
  async wrap<T>(_key: string, _ttl: number, fn: () => Promise<T>): Promise<T> {
    return fn();
  },
} as unknown as CacheService;

async function readCsv(file: { getStream(): AsyncIterable<unknown> }): Promise<string[][]> {
  let csv = '';
  for await (const chunk of file.getStream()) csv += String(chunk);
  return csv
    .replace(/^\uFEFF/, '')
    .trim()
    .split('\n')
    .map((l) => l.split(','));
}

let h: Harness;
let activity: ActivityService;
let analytics: AnalyticsService;
let platform: PlatformAnalyticsService;

// The ON company and the ids of what it booked.
let co: { companyId: string; userId: string };
let depositId: string;
let withdrawalId: string;
let payoutId: string;
let loadId: string;
let pendingWithdrawalId: string;
// Platform-wide figures before this file booked anything (the test DB is shared).
let networkBefore = '0';
let flowsNetworkBefore = Money.zero();
let pendingValueBefore = Money.zero();

beforeAll(async () => {
  h = buildHarness();
  await h.prisma.$connect();
  activity = new ActivityService(h.prisma, passThroughCache);
  analytics = new AnalyticsService(h.prisma, passThroughCache, h.ledger);
  platform = new PlatformAnalyticsService(h.prisma, passThroughCache);

  const usd = (await platform.platform({})).byCurrency.find((c) => c.currency === 'USD');
  networkBefore = usd?.networkFeesEarned ?? '0';
  flowsNetworkBefore = (await platform.flows({ currency: 'USD' })).buckets.reduce(
    (s, b) => s.add(Money.of(b.networkFees)),
    Money.zero(),
  );

  co = await createCompany(h);
  const sourceId = await createEnabledSource(h, co.companyId);
  await addFixedFlowFee(h, co.companyId, 'TRANSACTION', '2');
  await addFixedFlowFee(h, co.companyId, 'WITHDRAWAL', '2', 'ON_TOP');
  await addFixedFlowFee(h, co.companyId, 'PAYOUT', '1');
  await setNetworkFee(h, co.companyId, {
    enabled: true,
    rates: [
      { operationType: 'TRANSACTION', feeType: 'PERCENTAGE', feeValue: '1' },
      { operationType: 'WITHDRAWAL', feeType: 'FIXED', feeValue: '1' },
      { operationType: 'PAYOUT', feeType: 'FIXED', feeValue: '0.50' },
      { operationType: 'LOAD', feeType: 'PERCENTAGE', feeValue: '1' },
    ],
  });

  // Deposit 100 → commission 2, network 1, credited 97.
  depositId = (
    await h.transactions.ingest({ kind: 'source', sourceId }, ingestInput(co.companyId, '100'))
  ).id;
  // Withdrawal 50 ON_TOP → wallet charged 53 (fee 2 + network 1), recipient 50.
  const w = await h.withdrawals.request(co.companyId, co.userId, cashWithdrawalInput('50'));
  withdrawalId = w.id;
  await h.withdrawals.approve(w.id, co.userId, { externalReference: 'paid-w' });
  // Payout 10 DEDUCTED → fee 1, network 0.50, recipient 8.50.
  const p = await h.payouts.request(co.companyId, co.userId, payoutInput('10'));
  payoutId = p.id;
  await h.payouts.approve(p.id, co.userId, { externalReference: 'paid-p' });
  // Load 100 (no commission rule) → network 1, credited 99.
  const l = await h.loads.request(co.companyId, co.userId, loadInput('100'));
  loadId = l.id;
  await h.loads.approve(l.id, co.userId, { externalReference: 'cash-l' });
  // One withdrawal left PENDING for the operations queue: 10 ON_TOP → 13.
  pendingValueBefore = Money.of((await platform.operations()).pendingWithdrawalsValue.USD ?? '0');
  pendingWithdrawalId = (
    await h.withdrawals.request(co.companyId, co.userId, cashWithdrawalInput('10'))
  ).id;
});

afterAll(async () => {
  await h.prisma.$disconnect();
});

describe('activity feed', () => {
  it('normal mode: amount = fee + networkFee + net on every row', async () => {
    const r = await activity.list({
      companyId: co.companyId,
      query: { page: 1, pageSize: 20, direction: ActivityDirection.OUT },
    });
    expect(r.meta.balanceMode).toBe(false);
    const w = r.data.find((x) => x.id === withdrawalId)!;
    expect(eq(w.amount, '53')).toBe(true);
    expect(eq(w.fee, '2')).toBe(true);
    expect(eq(w.networkFee, '1')).toBe(true);
    expect(eq(w.net, '50')).toBe(true);
    const p = r.data.find((x) => x.id === payoutId)!;
    expect(eq(p.networkFee, '0.50')).toBe(true);
    expect(eq(p.net, '8.50')).toBe(true);
  });

  it('balance mode: same breakdown, and the running balance still reconciles to the wallet', async () => {
    const r = await activity.list({ companyId: co.companyId, query: { page: 1, pageSize: 20 } });
    expect(r.meta.balanceMode).toBe(true);
    for (const row of r.data) {
      expect(
        Money.of(row.amount).eq(
          Money.of(row.fee).add(Money.of(row.networkFee)).add(Money.of(row.net)),
        ),
        `${row.kind} ${row.id}`,
      ).toBe(true);
    }
    const dep = r.data.find((x) => x.id === depositId)!;
    expect(eq(dep.amount, '100')).toBe(true);
    expect(eq(dep.networkFee, '1')).toBe(true);
    const load = r.data.find((x) => x.id === loadId)!;
    expect(eq(load.networkFee, '1')).toBe(true);
    // Newest row's running balance == the live wallet (97 − 53 − 10 + 99 = 133;
    // the pending withdrawal's 13 is reserved, not in the completed feed).
    const s = await snapshot(h, co.companyId);
    expect(eq(r.data[0]!.balanceAfter ?? undefined, '133')).toBe(true);
    expect(eq(s.wallet!.available, '120')).toBe(true); // 133 − 13 reserved by the pending one
  });
});

describe('CSV exports — network_fee_amount is the LAST column', () => {
  it('transactions export', async () => {
    const rows = await readCsv(
      await h.transactions.streamCsv({
        companyId: co.companyId,
        query: { page: 1, pageSize: 20 } as never,
      }),
    );
    const header = rows[0]!;
    expect(header[header.length - 1]).toBe('network_fee_amount');
    expect(header.slice(0, -1)).toContain('processed_at'); // existing columns kept their positions
    const row = rows.find((r) => r[0] === depositId)!;
    expect(row[header.indexOf('network_fee_amount')]).toBe('1.00');
    expect(row[header.indexOf('commission_amount')]).toBe('2.00');
    expect(row[header.indexOf('net_amount')]).toBe('97.00');
  });

  it('withdrawals export: gross includes the network fee', async () => {
    const rows = await readCsv(
      await h.withdrawals.streamCsv({
        companyId: co.companyId,
        query: { page: 1, pageSize: 20 } as never,
      }),
    );
    const header = rows[0]!;
    expect(header[header.length - 1]).toBe('network_fee_amount');
    const row = rows.find((r) => r[0] === withdrawalId)!;
    expect(row[header.indexOf('gross_amount')]).toBe('53.00');
    expect(row[header.indexOf('fee_amount')]).toBe('2.00');
    expect(row[header.indexOf('network_fee_amount')]).toBe('1.00');
    expect(row[header.indexOf('net_amount')]).toBe('50.00');
  });

  it('activity export', async () => {
    const rows = await readCsv(
      activity.streamCsv({ companyId: co.companyId, query: { page: 1, pageSize: 20 } }),
    );
    const header = rows[0]!;
    expect(header[header.length - 1]).toBe('network_fee_amount');
    const row = rows.find((r) => r[0] === payoutId)!;
    expect(eq(row[header.indexOf('gross_amount')], '10')).toBe(true);
    expect(eq(row[header.indexOf('network_fee_amount')], '0.50')).toBe(true);
  });
});

describe('analytics', () => {
  it('wallet summary still reconciles to the wallet with both fees', async () => {
    const ws = await analytics.walletSummary(co.companyId, 'USD');
    expect(eq(ws.deposits.gross, '100')).toBe(true);
    expect(eq(ws.deposits.net, '97')).toBe(true);
    expect(eq(ws.loads.gross, '100')).toBe(true);
    expect(eq(ws.loads.net, '99')).toBe(true);
    // Out-flows count completed + in-flight: 53 + 13 (pending) and 10.
    expect(eq(ws.withdrawals.total, '66')).toBe(true);
    expect(eq(ws.payouts.total, '10')).toBe(true);
    const available = Money.of(ws.deposits.net)
      .add(Money.of(ws.loads.net))
      .sub(Money.of(ws.withdrawals.total))
      .sub(Money.of(ws.payouts.total))
      .add(Money.of(ws.receivable));
    const s = await snapshot(h, co.companyId);
    expect(available.eq(Money.of(s.wallet!.available))).toBe(true);
  });

  it('company overview: volumes include the network fee; the aggregate stays admin-only', async () => {
    const view = await analytics.overview({
      scope: { companyId: co.companyId },
      range: { currency: 'USD' },
    });
    expect(eq(view.kpi.totalVolume, '100')).toBe(true);
    expect(view.kpi.totalNetworkFees).toBeUndefined();
    expect(view.kpi.totalFees).toBeUndefined();
    expect(eq(view.volume.deposits.completedNetworkFees, '1')).toBe(true);
    expect(eq(view.volume.deposits.completedTotal, '100')).toBe(true);
    expect(eq(view.volume.withdrawals.completedTotal, '53')).toBe(true);
    expect(eq(view.volume.withdrawals.completedNetworkFees, '1')).toBe(true);
    expect(eq(view.volume.withdrawals.pendingTotal, '13')).toBe(true);
    expect(eq(view.volume.loads.completedNetworkFees, '1')).toBe(true);
    expect(eq(view.volume.payouts.completedNetworkFees, '0.50')).toBe(true);
  });

  it('admin drill-down: totalNetworkFees from the NETWORK_FEE ledger; totalFees unchanged', async () => {
    const view = await analytics.overview({
      scope: 'admin',
      range: { currency: 'USD', companyId: co.companyId },
    });
    expect(eq(view.kpi.totalFees, '5')).toBe(true); // 2 + 2 + 1 — commission only
    expect(eq(view.kpi.totalNetworkFees, '3.50')).toBe(true); // 1 + 1 + 0.50 + 1
  });

  it('platform rollup: network fees are their own revenue line, added to net revenue', async () => {
    const usd = (await platform.platform({})).byCurrency.find((c) => c.currency === 'USD')!;
    expect(Money.of(usd.networkFeesEarned).sub(Money.of(networkBefore)).eq(Money.of('3.50'))).toBe(
      true,
    );
    expect(
      Money.of(usd.netRevenue).eq(
        Money.of(usd.feesEarned).add(Money.of(usd.networkFeesEarned)).sub(Money.of(usd.sourceFees)),
      ),
    ).toBe(true);
  });

  it('flows: the daily network-fee series adds up', async () => {
    const total = (await platform.flows({ currency: 'USD' })).buckets.reduce(
      (s, b) => s.add(Money.of(b.networkFees)),
      Money.zero(),
    );
    expect(total.sub(flowsNetworkBefore).eq(Money.of('3.50'))).toBe(true);
  });

  it('operations queue: a pending withdrawal counts the full amount that will leave', async () => {
    const ops = await platform.operations();
    // The pending value grew by exactly 13 = 10 + fee 2 + network fee 1.
    const after = Money.of(ops.pendingWithdrawalsValue.USD ?? '0');
    expect(after.sub(pendingValueBefore).eq(Money.of('13'))).toBe(true);
    // And its queue item (when inside the sample) says the same.
    const item = ops.items.find((i) => i.id === pendingWithdrawalId);
    if (item) expect(eq(item.amount ?? undefined, '13')).toBe(true);
  });
});

describe('a company with the switch OFF', () => {
  it('sees byte-identical activity amount text (no widened scale)', async () => {
    const off = await createCompany(h);
    const sourceId = await createEnabledSource(h, off.companyId);
    await addFlowFee(h, off.companyId, 'TRANSACTION', '0');
    await h.transactions.ingest({ kind: 'source', sourceId }, ingestInput(off.companyId, '200'));
    const p = await h.payouts.request(off.companyId, off.userId, payoutInput('100'));
    await h.payouts.approve(p.id, off.userId, { externalReference: 'paid' });

    const r = await activity.list({
      companyId: off.companyId,
      query: { page: 1, pageSize: 20, kind: ActivityKind.PAYOUT },
    });
    const row = r.data.find((x) => x.id === p.id)!;
    // payouts are DECIMAL(20,2): the gross text must stay exactly "100.00".
    expect(row.amount).toBe('100.00');
    expect(row.networkFee).toBe('0.00');
    expect((await h.payouts.getById(p.id, off.companyId)).networkFeeAmount).toBe('0');
  });
});
