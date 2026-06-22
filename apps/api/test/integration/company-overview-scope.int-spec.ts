/**
 * Tenant-isolation guard for the per-company overview KPI.
 *
 * `analytics.overview()` must NEVER hand a company-scoped caller the aggregate
 * platform fee (`kpi.totalFees`): that running total IS the platform's revenue
 * and is admin-only — a company only ever sees the fee on each individual
 * transaction. The service gates it behind `scope === 'admin'`; this test pins
 * that gate from BOTH sides so a future refactor (e.g. flipping the ternary, or
 * unconditionally spreading `{ totalFees }` into the company payload) fails CI.
 *
 * Every other overview() assertion in the suite uses `scope: 'admin'`, so the
 * company-scoped negative case below is the only thing standing between a code
 * change and silently leaking platform revenue to tenants.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Money } from '@app/shared';
import type { CacheService } from '../../src/modules/cache/cache.service';
import { AnalyticsService } from '../../src/modules/analytics/analytics.service';
import {
  addTransactionFee,
  buildHarness,
  createCompany,
  createEnabledSource,
  ingestInput,
  type Harness,
} from './harness';

const eq = (a: string, b: string) => Money.of(a).eq(Money.of(b));

// Pass-through cache so overview() recomputes against the live test DB.
const passThroughCache = {
  async wrap<T>(_key: string, _ttl: number, fn: () => Promise<T>): Promise<T> {
    return fn();
  },
} as unknown as CacheService;

let h: Harness;
let analytics: AnalyticsService;

beforeAll(async () => {
  h = buildHarness();
  await h.prisma.$connect();
  analytics = new AnalyticsService(h.prisma, passThroughCache, h.ledger);
});

afterAll(async () => {
  await h.prisma.$disconnect();
});

describe('company-scoped overview hides the aggregate platform fee', () => {
  it('omits kpi.totalFees for a company-scoped caller but includes it for admins', async () => {
    const { companyId } = await createCompany(h);
    const sourceId = await createEnabledSource(h, companyId);
    await addTransactionFee(h, companyId, '10'); // 10% platform commission

    // One settled deposit: net 90 + fee 10. The fee is booked to the FEE ledger
    // account, so the admin rollup's totalFees for this company is 10.
    await h.transactions.ingest({ kind: 'source', sourceId }, ingestInput(companyId, '100'));

    // Company scope: the tenant's own dashboard. kpi.totalFees MUST be absent —
    // this is the assertion that fails the moment totalFees is leaked into the
    // company payload.
    const companyView = await analytics.overview({
      scope: { companyId },
      range: { currency: 'USD' },
    });
    expect(companyView.kpi.totalFees).toBeUndefined();
    // The aggregate-fee surfaces (sourceFees / netRevenue) belong to the admin
    // platform rollup and the source drilldown — they must never appear on a
    // per-company overview KPI either.
    expect(companyView.kpi).not.toHaveProperty('totalFees');
    expect(companyView.kpi).not.toHaveProperty('sourceFees');
    expect(companyView.kpi).not.toHaveProperty('netRevenue');
    // The volume the company DOES see is still correct (net 90 + fee 10 = 100),
    // so this isn't just an empty response.
    expect(eq(companyView.kpi.totalVolume, '100')).toBe(true);

    // Admin scope drilling into the SAME company over the SAME range: totalFees
    // is present and equals the booked platform fee (10).
    const adminView = await analytics.overview({
      scope: 'admin',
      range: { companyId, currency: 'USD' },
    });
    expect(adminView.kpi.totalFees).toBeDefined();
    expect(eq(adminView.kpi.totalFees!, '10')).toBe(true);
  });
});
