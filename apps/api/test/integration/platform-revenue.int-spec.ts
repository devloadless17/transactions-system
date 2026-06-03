/**
 * Guards the platform revenue rollup: "fees earned" must include the realized
 * fee from EVERY money flow (transactions, loads, withdrawals, payouts), not
 * just transaction commission. Each flow books its fee to the FEE ledger
 * account on settlement, and PlatformAnalyticsService now sums that account —
 * so this test fails if revenue ever silently regresses to transaction-only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money } from '@app/shared';
import type { CacheService } from '../../src/modules/cache/cache.service';
import { PlatformAnalyticsService } from '../../src/modules/analytics/platform-analytics.service';
import { AnalyticsService } from '../../src/modules/analytics/analytics.service';
import {
  addFlowFee,
  addTransactionFee,
  buildHarness,
  cashWithdrawalInput,
  createCompany,
  createEnabledSource,
  ingestInput,
  loadInput,
  payoutInput,
  type Harness,
} from './harness';

const eq = (a: string, b: string) => Money.of(a).eq(Money.of(b));

// Pass-through cache so platform() recomputes against the live test DB.
const passThroughCache = {
  async wrap<T>(_key: string, _ttl: number, fn: () => Promise<T>): Promise<T> {
    return fn();
  },
} as unknown as CacheService;

let h: Harness;
let platformAnalytics: PlatformAnalyticsService;
let analytics: AnalyticsService;

beforeAll(async () => {
  h = buildHarness();
  await h.prisma.$connect();
  platformAnalytics = new PlatformAnalyticsService(h.prisma, passThroughCache);
  analytics = new AnalyticsService(h.prisma, passThroughCache, h.ledger);
});

afterAll(async () => {
  await h.prisma.$disconnect();
});

describe('platform revenue (feesEarned) spans every flow type', () => {
  it('sums transaction + load + withdrawal + payout fees', async () => {
    const { companyId, userId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);

    // 10% fee on every flow type.
    await addTransactionFee(h, companyId, '10');
    await addFlowFee(h, companyId, 'LOAD', '10');
    await addFlowFee(h, companyId, 'WITHDRAWAL', '10');
    await addFlowFee(h, companyId, 'PAYOUT', '10');

    // Baseline: platform rollup for this currency before anything settles.
    const usdBefore = (await platformAnalytics.platform({})).byCurrency.find(
      (c) => c.currency.trim() === 'USD',
    );
    const feesBefore = usdBefore ? usdBefore.feesEarned : '0';
    const volumeInBefore = usdBefore ? usdBefore.volumeIn : '0';
    const volumeOutBefore = usdBefore ? usdBefore.volumeOut : '0';

    // 1) Transaction: ingest 100 → fee 10 (booked to FEE at ingest).
    await h.transactions.ingest({ kind: 'source', sourceId }, ingestInput(companyId, '100'));

    // 2) Load (money in): 100 → fee 10, realized on approval. Wallet +90.
    const load = await h.loads.request(companyId, userId, loadInput('100'));
    expect(eq(load.feeAmount, '10')).toBe(true);
    await h.loads.approve(load.id, userId, { externalReference: 'recv-1' });

    // Wallet now holds 90 (ingest) + 90 (load) = 180 available.
    // 3) Withdrawal (money out): 50 → fee 5, realized on approval.
    const wd = await h.withdrawals.request(companyId, userId, cashWithdrawalInput('50'));
    expect(eq(wd.feeAmount, '5')).toBe(true);
    await h.withdrawals.approve(wd.id, userId, { externalReference: 'wd-ref-1' });

    // 4) Payout (money out): 50 → fee 5, realized on approval.
    const po = await h.payouts.request(companyId, userId, payoutInput('50'));
    expect(eq(po.feeAmount, '5')).toBe(true);
    expect(eq(po.totalAmount, '50')).toBe(true); // DEDUCTED: total = net 45 + fee 5 = amount
    await h.payouts.approve(po.id, userId, { externalReference: 'po-ref-1' });

    // Revenue must have grown by 10 + 10 + 5 + 5 = 30 (NOT just the 10 from
    // the transaction — that was the bug).
    const usdAfter = (await platformAnalytics.platform({})).byCurrency.find(
      (c) => c.currency.trim() === 'USD',
    );
    expect(usdAfter).toBeDefined();
    const delta = Money.of(usdAfter!.feesEarned).sub(Money.of(feesBefore));
    expect(eq(delta.toString(), '30')).toBe(true);

    // Volume in spans transactions AND loads, at net + fee:
    //   transaction 100 (net 90 + fee 10) + load 100 (net 90 + fee 10) = 200.
    const inDelta = Money.of(usdAfter!.volumeIn).sub(Money.of(volumeInBefore));
    expect(eq(inDelta.toString(), '200')).toBe(true);
    // Volume out spans withdrawals AND payouts, at net + fee:
    //   withdrawal 50 (net 45 + fee 5) + payout 50 (net 45 + fee 5) = 100.
    //   (The old rollup excluded payouts and summed `amount`, giving 50.)
    const outDelta = Money.of(usdAfter!.volumeOut).sub(Money.of(volumeOutBefore));
    expect(eq(outDelta.toString(), '100')).toBe(true);

    // The daily Flows series must reconcile with the rollup totals (same data,
    // same window) — guards mergeDailyBuckets summing all flow types per day.
    const flows = await platformAnalytics.flows({ currency: 'USD' });
    const sumBucket = (k: 'in' | 'out' | 'fees') =>
      flows.buckets.reduce((acc, b) => acc.add(Money.of(b[k])), Money.zero());
    expect(eq(sumBucket('in').toString(), usdAfter!.volumeIn)).toBe(true);
    expect(eq(sumBucket('out').toString(), usdAfter!.volumeOut)).toBe(true);
    expect(eq(sumBucket('fees').toString(), usdAfter!.feesEarned)).toBe(true);

    // The admin per-company drilldown ("Platform fees" card) must show the
    // SAME all-flow total for this company — not just its transaction fee (10).
    const drill = await analytics.overview({
      scope: 'admin',
      range: { companyId, currency: 'USD' },
    });
    expect(drill.kpi.totalFees).toBeDefined();
    expect(eq(drill.kpi.totalFees!, '30')).toBe(true);

    // Per-flow cards expose the net vs. fee split, and gross = net + fee
    // (DEDUCTED). Payout: 50 gross = 45 net + 5 fee.
    const p = drill.volume.payouts;
    expect(eq(p.completedTotal, '50')).toBe(true);
    expect(eq(p.completedNet, '45')).toBe(true);
    expect(eq(p.completedFees, '5')).toBe(true);
    expect(
      eq(Money.of(p.completedNet).add(Money.of(p.completedFees)).toString(), p.completedTotal),
    ).toBe(true);
    // Deposits (transactions): 100 gross = 90 net + 10 fee.
    const d = drill.volume.deposits;
    expect(eq(d.completedNet, '90')).toBe(true);
    expect(eq(d.completedFees, '10')).toBe(true);
  });

  it('ON_TOP fee: card total counts net + fee, not just the requested amount', async () => {
    const { companyId, userId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    await addTransactionFee(h, companyId, '0'); // fund with no transaction fee

    // ON_TOP withdrawal fee of 10%: the fee is charged ON TOP of the amount, so
    // the recipient gets the full amount and the company pays amount + fee.
    await h.prisma.runAsAdmin((tx) =>
      tx.commissionRule.create({
        data: {
          companyId,
          sourceId: null,
          operationType: 'WITHDRAWAL',
          feeApplication: 'ON_TOP',
          minAmount: '0.00000001',
          maxAmount: '100000000',
          commissionType: 'PERCENTAGE',
          commissionValue: '10',
          priority: 100,
          active: true,
        },
      }),
    );

    // Platform rollup baseline BEFORE any flow settles (deltas isolate this
    // test's contribution from other tests' data already in the window).
    const before = (await platformAnalytics.platform({})).byCurrency.find(
      (c) => c.currency.trim() === 'USD',
    );
    const inBefore = before ? before.volumeIn : '0';
    const outBefore = before ? before.volumeOut : '0';

    await h.transactions.ingest({ kind: 'source', sourceId }, ingestInput(companyId, '100'));

    const wd = await h.withdrawals.request(companyId, userId, cashWithdrawalInput('50'));
    expect(wd.feeApplication).toBe('ON_TOP'); // surfaced on the response for the UI
    expect(eq(wd.feeAmount, '5')).toBe(true); // 10% of 50
    expect(eq(wd.netAmount, '50')).toBe(true); // ON_TOP → recipient gets the full 50
    expect(eq(wd.totalAmount, '55')).toBe(true); // total = net 50 + fee 5 (exceeds requested 50)
    await h.withdrawals.approve(wd.id, userId, { externalReference: 'ontop-1' });

    const w = (await analytics.overview({ scope: 'admin', range: { companyId, currency: 'USD' } }))
      .volume.withdrawals;
    expect(eq(w.completedNet, '50')).toBe(true);
    expect(eq(w.completedFees, '5')).toBe(true);
    // The fix: total = net + fee = 55 (money actually paid), NOT the requested
    // amount 50. This guards the ON_TOP undercount.
    expect(eq(w.completedTotal, '55')).toBe(true);

    // Same guard on the super-admin PLATFORM rollup (the surface that was the
    // bug): volumeOut must grow by net+fee = 55, not the requested 50; volumeIn
    // by the zero-fee ingest of 100.
    const after = (await platformAnalytics.platform({})).byCurrency.find(
      (c) => c.currency.trim() === 'USD',
    );
    expect(eq(Money.of(after!.volumeOut).sub(Money.of(outBefore)).toString(), '55')).toBe(true);
    expect(eq(Money.of(after!.volumeIn).sub(Money.of(inBefore)).toString(), '100')).toBe(true);
  });

  it('source-overview totalVolume counts net + fee for an ON_TOP deposit (not SUM(amount))', async () => {
    const { companyId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);

    // ON_TOP transaction fee of 10%: the stored `amount` is the net (fee is on
    // top), so a SUM(amount) headline would drop the fee and disagree with the
    // page's own daily + by-company figures. Guards computeSource().
    await h.prisma.runAsAdmin((tx) =>
      tx.commissionRule.create({
        data: {
          companyId,
          sourceId: null,
          operationType: 'TRANSACTION',
          feeApplication: 'ON_TOP',
          minAmount: '0.00000001',
          maxAmount: '100000000',
          commissionType: 'PERCENTAGE',
          commissionValue: '10',
          priority: 100,
          active: true,
        },
      }),
    );

    await h.transactions.ingest({ kind: 'source', sourceId }, ingestInput(companyId, '100'));

    const src = await analytics.sourceOverview({ sourceId, range: { currency: 'USD' } });
    // Headline KPI = net 100 + fee 10 = 110 (money moved), NOT SUM(amount) = 100.
    expect(eq(src.kpi.totalVolume, '110')).toBe(true);
    expect(src.kpi.totalFees).toBeDefined();
    expect(eq(src.kpi.totalFees!, '10')).toBe(true);
    // …and it must match the page's own per-company row (which was already 110).
    const row = src.byCompany.find((c) => c.companyId === companyId);
    expect(row).toBeDefined();
    expect(eq(row!.volume, '110')).toBe(true);
  });
});
