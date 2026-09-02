/**
 * Pins the "All time" analytics window and its adaptive bucketing.
 *
 * The dashboards cap an explicit range at 366 days and otherwise default to the
 * last 30, so "everything since day one" is a distinct request (`preset: 'all'`)
 * whose lower bound the server resolves and whose bucket width it widens with
 * the span. Two things can silently go wrong there, and both are money bugs:
 *
 *   1. rows older than the default window are simply missing, and
 *   2. a week/month bucket misaligns against the SQL `date_trunc`, so volume
 *      lands in the wrong bucket (or in none at all).
 *
 * The Σ(bucket volumes) === kpi.totalVolume identity catches (2) at every
 * granularity — the KPI is a plain aggregate over the same window, so the two
 * can only agree if every row was bucketed exactly once.
 *
 * Assertions are scoped to this spec's own company/source so they are immune to
 * other specs sharing the run's DB.
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

const passThroughCache = {
  async wrap<T>(_key: string, _ttl: number, fn: () => Promise<T>): Promise<T> {
    return fn();
  },
} as unknown as CacheService;

const DAY_MS = 24 * 3600 * 1000;
const sum = (values: string[]) =>
  values.reduce((acc, v) => acc.add(Money.of(v)), Money.zero()).toString();

let h: Harness;
let analytics: AnalyticsService;
let companyId: string;
let sourceId: string;

/** Backdate a settled transaction so it falls outside the 30-day default. */
async function backdate(externalId: string, daysAgo: number): Promise<void> {
  const at = new Date(Date.now() - daysAgo * DAY_MS);
  await h.prisma.runAsAdmin(async (tx) => {
    await tx.transaction.updateMany({
      where: { externalTransactionId: externalId },
      data: { createdAt: at },
    });
  });
}

beforeAll(async () => {
  h = buildHarness();
  await h.prisma.$connect();
  analytics = new AnalyticsService(h.prisma, passThroughCache, h.ledger);

  const co = await createCompany(h);
  companyId = co.companyId;
  sourceId = await createEnabledSource(h, companyId);
  await addTransactionFee(h, companyId, '10');

  // Backdate the company AND the source: their creation dates are the all-time
  // origins, so leaving them at "now" would clip the history seeded below. This
  // mirrors reality (a company/source always predates its own rows) — and the
  // clipping is the documented limitation of using creation dates as the bound.
  const origin = new Date(Date.now() - 1200 * DAY_MS);
  await h.prisma.runAsAdmin(async (tx) => {
    await tx.company.update({ where: { id: companyId }, data: { createdAt: origin } });
    await tx.source.update({ where: { id: sourceId }, data: { createdAt: origin } });
  });

  // Three deposits: ~3 years ago, ~6 months ago, and today.
  for (const daysAgo of [1100, 180, 0]) {
    const input = ingestInput(companyId, '100');
    await h.transactions.ingest({ kind: 'source', sourceId }, input);
    if (daysAgo > 0) await backdate(input.externalTransactionId, daysAgo);
  }
});

afterAll(async () => {
  await h.prisma.$disconnect();
});

describe('all-time analytics window', () => {
  it('reaches history the default 30-day window misses', async () => {
    const scope = { companyId } as const;
    const recent = await analytics.overview({ scope, range: { currency: 'USD' } });
    const allTime = await analytics.overview({ scope, range: { currency: 'USD', preset: 'all' } });

    // Today's deposit only: 100 (net 90 + fee 10).
    expect(Money.of(recent.kpi.totalVolume).eq(Money.of('100'))).toBe(true);
    // All three.
    expect(Money.of(allTime.kpi.totalVolume).eq(Money.of('300'))).toBe(true);
    expect(allTime.kpi.transactionCount).toBe(3);
  });

  it('widens the bucket to months for a multi-year span', async () => {
    const allTime = await analytics.overview({
      scope: { companyId },
      range: { currency: 'USD', preset: 'all' },
    });
    expect(allTime.daily.granularity).toBe('month');
    // Every bucket must be a month start, and they must be unique + ordered.
    const dates = allTime.daily.buckets.map((b) => b.date);
    expect(dates.every((d) => d.endsWith('-01'))).toBe(true);
    expect(new Set(dates).size).toBe(dates.length);
    expect([...dates].sort()).toEqual(dates);
  });

  it('keeps day buckets for the default window', async () => {
    const recent = await analytics.overview({
      scope: { companyId },
      range: { currency: 'USD' },
    });
    expect(recent.daily.granularity).toBe('day');
  });

  it('picks week buckets for a mid-length explicit window', async () => {
    const to = new Date();
    const from = new Date(to.getTime() - 200 * DAY_MS);
    const mid = await analytics.overview({
      scope: { companyId },
      range: { currency: 'USD', from: from.toISOString(), to: to.toISOString() },
    });
    expect(mid.daily.granularity).toBe('week');
    // Postgres date_trunc('week') is ISO — every bucket starts on a Monday.
    for (const b of mid.daily.buckets) {
      expect(new Date(`${b.date}T00:00:00Z`).getUTCDay()).toBe(1);
    }
  });

  // THE money assertion: buckets and the KPI aggregate must describe the same
  // rows. Any truncation or alignment bug shows up here as a mismatch.
  it.each(['day', 'week', 'month'] as const)(
    'sums bucket volumes to kpi.totalVolume at %s granularity',
    async (expected) => {
      // Span chosen to land in the target tier: 30d → day, 200d → week, all → month.
      const range =
        expected === 'month'
          ? ({ currency: 'USD', preset: 'all' } as const)
          : ({
              currency: 'USD',
              from: new Date(Date.now() - (expected === 'day' ? 30 : 200) * DAY_MS).toISOString(),
              to: new Date().toISOString(),
            } as const);

      const res = await analytics.overview({ scope: { companyId }, range });
      expect(res.daily.granularity).toBe(expected);
      expect(
        Money.of(sum(res.daily.buckets.map((b) => b.volume))).eq(Money.of(res.kpi.totalVolume)),
      ).toBe(true);
    },
  );

  it('holds the same identity for an admin-scoped source drilldown', async () => {
    const res = await analytics.sourceOverview({
      sourceId,
      range: { currency: 'USD', preset: 'all' },
    });
    expect(res.daily.granularity).toBe('month');
    expect(
      Money.of(sum(res.daily.buckets.map((b) => b.volume))).eq(Money.of(res.kpi.totalVolume)),
    ).toBe(true);
    expect(res.kpi.transactionCount).toBe(3);
  });

  // All time must not become an all-tenants back door: the window widens, the
  // RLS scope does not.
  it('still scopes a company to its own rows', async () => {
    const other = await createCompany(h);
    const otherSource = await createEnabledSource(h, other.companyId);
    await addTransactionFee(h, other.companyId, '10');
    await h.transactions.ingest(
      { kind: 'source', sourceId: otherSource },
      ingestInput(other.companyId, '4200'),
    );

    const mine = await analytics.overview({
      scope: { companyId },
      range: { currency: 'USD', preset: 'all' },
    });
    expect(Money.of(mine.kpi.totalVolume).eq(Money.of('300'))).toBe(true);
    expect(mine.kpi.transactionCount).toBe(3);
  });

  // Company scope never receives the aggregate platform fee, at any window.
  it('keeps the company/admin fee split under all-time', async () => {
    const asCompany = await analytics.overview({
      scope: { companyId },
      range: { currency: 'USD', preset: 'all' },
    });
    const asAdmin = await analytics.overview({
      scope: 'admin',
      range: { currency: 'USD', companyId, preset: 'all' },
    });
    expect(asCompany.kpi.totalFees).toBeUndefined();
    expect(asAdmin.kpi.totalFees).toBeDefined();
  });
});
