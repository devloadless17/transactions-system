/**
 * Pins the source-fee → net-revenue money math (the newest analytics surface).
 *
 * Source fees = what an upstream source charges THE PLATFORM per deposit. They are
 * computed + frozen on the transaction at settlement (transactions.source_fee_amount)
 * and net revenue = Σ platform commission (FEE ledger) − Σ source_fee_amount. This
 * test seeds a tiered FIXED+PERCENTAGE schedule across BOTH channels (INGEST +
 * WHISH_PAY), ingests deposits that hit each tier (incl. the exact touching
 * boundary), and asserts the persisted per-deposit fee, the per-source rollup, the
 * platform breakdown, the net-revenue identity, and that a source with no schedule
 * accrues zero. Assertions are scoped to this spec's own source so they're immune to
 * other specs sharing the run's DB.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money, SourceFeeChannel } from '@app/shared';
import type { CacheService } from '../../src/modules/cache/cache.service';
import { PlatformAnalyticsService } from '../../src/modules/analytics/platform-analytics.service';
import { AnalyticsService } from '../../src/modules/analytics/analytics.service';
import { SourcesService } from '../../src/modules/sources/sources.service';
import {
  addTransactionFee,
  buildHarness,
  createCompany,
  createEnabledSource,
  ingestInput,
  type Harness,
} from './harness';

const eq = (a: string, b: string) => Money.of(a).eq(Money.of(b));

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

async function setSourceFeeRules(
  sourceId: string,
  rules: Array<{
    channel: SourceFeeChannel;
    minAmount: string;
    maxAmount: string | null;
    feeType: 'FIXED' | 'PERCENTAGE';
    feeValue: string;
  }>,
): Promise<void> {
  await h.prisma.runAsAdmin((tx) =>
    tx.sourceFeeRule.createMany({ data: rules.map((r) => ({ sourceId, ...r })) }),
  );
}

describe('source fees & net revenue', () => {
  it('prices each deposit by tier + channel, freezes it on the row, and nets it off revenue', async () => {
    const { companyId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    await addTransactionFee(h, companyId, '10'); // platform earns 10% commission (revenue)

    // What the SOURCE charges the platform:
    //   INGEST    : ≤ $10 → flat $1 ; > $10 → 1%
    //   WHISH_PAY : 2% on everything
    await setSourceFeeRules(sourceId, [
      {
        channel: SourceFeeChannel.INGEST,
        minAmount: '0',
        maxAmount: '10',
        feeType: 'FIXED',
        feeValue: '1',
      },
      {
        channel: SourceFeeChannel.INGEST,
        minAmount: '10',
        maxAmount: null,
        feeType: 'PERCENTAGE',
        feeValue: '1',
      },
      {
        channel: SourceFeeChannel.WHISH_PAY,
        minAmount: '0',
        maxAmount: null,
        feeType: 'PERCENTAGE',
        feeValue: '2',
      },
    ]);

    // amount → expected source fee
    //   $8   INGEST    → $1.00  (flat, ≤10)
    //   $10  INGEST    → $1.00  (touching boundary → LOWER/flat tier wins)
    //   $200 INGEST    → $2.00  (1%)
    //   $50  WHISH_PAY → $1.00  (2%)
    const t8 = await h.transactions.ingest(
      { kind: 'source', sourceId },
      ingestInput(companyId, '8'),
    );
    const t10 = await h.transactions.ingest(
      { kind: 'source', sourceId },
      ingestInput(companyId, '10'),
    );
    const t200 = await h.transactions.ingest(
      { kind: 'source', sourceId },
      ingestInput(companyId, '200'),
    );
    const t50 = await h.transactions.ingest(
      { kind: 'source', sourceId, channel: SourceFeeChannel.WHISH_PAY },
      ingestInput(companyId, '50'),
    );

    // (1) per-deposit fee is frozen on the transaction row
    const rows = await h.prisma.runAsAdmin((tx) =>
      tx.transaction.findMany({
        where: { sourceId },
        select: { id: true, amount: true, sourceFeeAmount: true },
      }),
    );
    const feeOf = (id: string) => rows.find((r) => r.id === id)!.sourceFeeAmount.toString();
    expect(eq(feeOf(t8.id), '1')).toBe(true);
    expect(eq(feeOf(t10.id), '1')).toBe(true); // boundary → flat tier
    expect(eq(feeOf(t200.id), '2')).toBe(true);
    expect(eq(feeOf(t50.id), '1')).toBe(true); // WHISH_PAY channel

    // (2) per-source rollup (sourceOverview) sums the column to $5
    const overview = await analytics.sourceOverview({ sourceId, range: { currency: 'USD' } });
    expect(eq(overview.sourceFees, '5')).toBe(true);

    // (3) platform breakdown attributes $5 to this source, and the net-revenue
    //     identity holds for the USD rollup (netRevenue == feesEarned +
    //     networkFeesEarned − sourceFees; the network-fee term is 0 unless some
    //     company in the shared test DB is charged one).
    const platform = await platformAnalytics.platform({});
    const mine = platform.sourceFeeBreakdown.find((b) => b.sourceId === sourceId);
    expect(mine).toBeTruthy();
    expect(eq(mine!.fees, '5')).toBe(true);
    const usd = platform.byCurrency.find((c) => c.currency === 'USD')!;
    expect(
      eq(
        usd.netRevenue,
        Money.of(usd.feesEarned)
          .add(Money.of(usd.networkFeesEarned))
          .sub(Money.of(usd.sourceFees))
          .toString(),
      ),
    ).toBe(true);
  });

  it('a source with no fee schedule accrues zero source fee', async () => {
    const { companyId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    await addTransactionFee(h, companyId, '10');
    await h.transactions.ingest({ kind: 'source', sourceId }, ingestInput(companyId, '100'));

    const overview = await analytics.sourceOverview({ sourceId, range: { currency: 'USD' } });
    expect(eq(overview.sourceFees, '0')).toBe(true);
  });

  it('configuring a schedule reprices deposits that already settled (retroactive)', async () => {
    const { companyId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    await addTransactionFee(h, companyId, '10');

    // Deposit settles BEFORE any source-fee rule exists → frozen at 0 (the bug:
    // a schedule configured afterwards used to leave this at 0 forever).
    const t = await h.transactions.ingest(
      { kind: 'source', sourceId },
      ingestInput(companyId, '100'),
    );
    const before = await h.prisma.runAsAdmin((tx) =>
      tx.transaction.findUnique({ where: { id: t.id }, select: { sourceFeeAmount: true } }),
    );
    expect(eq(before!.sourceFeeAmount.toString(), '0')).toBe(true);

    // Configure the schedule through the real service path (which now recomputes
    // existing deposits). Bare realtime + cache stubs are enough for this unit of
    // work (setFeeRules busts the source-fee rule cache after recompute).
    const sources = new SourcesService(
      h.prisma,
      { admin() {} } as never,
      { async invalidate() {} } as never,
    );
    await sources.setFeeRules(sourceId, {
      rules: [
        {
          channel: SourceFeeChannel.INGEST,
          minAmount: '0',
          maxAmount: null,
          feeType: 'PERCENTAGE',
          feeValue: '1',
          active: true,
        },
      ],
    });

    // The already-settled deposit is repriced: 1% of $100 = $1.
    const after = await h.prisma.runAsAdmin((tx) =>
      tx.transaction.findUnique({ where: { id: t.id }, select: { sourceFeeAmount: true } }),
    );
    expect(eq(after!.sourceFeeAmount.toString(), '1')).toBe(true);
    const overview = await analytics.sourceOverview({ sourceId, range: { currency: 'USD' } });
    expect(eq(overview.sourceFees, '1')).toBe(true);
  });

  it("keeps a REVERSED deposit's source-fee cost counted (reversal symmetry)", async () => {
    const { companyId, userId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    await addTransactionFee(h, companyId, '10'); // 10% platform commission
    await setSourceFeeRules(sourceId, [
      {
        channel: SourceFeeChannel.INGEST,
        minAmount: '0',
        maxAmount: null,
        feeType: 'PERCENTAGE',
        feeValue: '2', // source charges the platform 2% per deposit
      },
    ]);
    const t = await h.transactions.ingest(
      { kind: 'source', sourceId },
      ingestInput(companyId, '100'),
    );
    // 2% of $100 = $2 source-fee cost, frozen on the deposit.
    const before = await analytics.sourceOverview({ sourceId, range: { currency: 'USD' } });
    expect(eq(before.sourceFees, '2')).toBe(true);

    // Reverse (claw back) the deposit. The upstream source already charged the
    // platform its $2 and does NOT refund it on OUR clawback, so the cost must
    // stay counted (status IN COMPLETED|REVERSED), symmetric with the realized-
    // time FEE-revenue side. Counting only COMPLETED would silently erase a real
    // cost and overstate net revenue.
    await h.transactions.reverse(t.id, { actorId: userId, reason: 'chargeback' });

    const after = await analytics.sourceOverview({ sourceId, range: { currency: 'USD' } });
    expect(eq(after.sourceFees, '2')).toBe(true); // unchanged across the reversal
  });
});
