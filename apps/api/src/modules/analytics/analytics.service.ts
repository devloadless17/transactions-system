import { Injectable } from '@nestjs/common';
import {
  Money,
  type AnalyticsRange,
  type OverviewResponse,
  type SourceOverviewResponse,
  type VolumeMetric,
} from '@app/shared';
import { PrismaService } from '../../database/prisma.service';
import { CacheService } from '../cache/cache.service';

const DEFAULT_DAYS = 30;
const DEFAULT_CURRENCY = 'USD';
const TOP_LIMIT = 5;

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  /**
   * Drop every cached analytics rollup. Called after any financial mutation
   * (ingestion, withdrawal status change, reversal) so the next dashboard
   * read recomputes against fresh data. Cheap — analytics keys are
   * namespace-scanned by SCAN, not enumerated.
   */
  /**
   * Clear ALL cached analytics rollups (company dashboards + admin/platform
   * aggregates). Called — AWAITED — after every financial mutation and BEFORE
   * the realtime event is emitted, so each dashboard's socket-triggered refetch
   * reads fresh data instead of a still-warm cache. The TTLs remain only as a
   * backstop for quiet periods with no mutations.
   *
   * Tradeoff: at very high ingest volume the cross-tenant rollups recompute on
   * the next admin read after each mutation. If that ever becomes a hotspot,
   * move the platform aggregates to short-TTL + single-flight rather than
   * narrowing this — live, correct dashboards come first.
   */
  async invalidateAll(): Promise<void> {
    await this.cache.invalidate('analytics:');
  }

  /**
   * Compute platform-wide or company-scoped analytics for a date range.
   * Cached for 60s; admins viewing dashboards re-fetch often.
   */
  async overview(args: {
    scope: 'admin' | { companyId: string };
    range: AnalyticsRange;
  }): Promise<OverviewResponse> {
    const currency = args.range.currency ?? DEFAULT_CURRENCY;
    const to = args.range.to ? new Date(args.range.to) : new Date();
    const from = args.range.from
      ? new Date(args.range.from)
      : new Date(to.getTime() - DEFAULT_DAYS * 24 * 3600 * 1000);

    const scopeKey =
      args.scope === 'admin'
        ? `admin:${args.range.companyId ?? 'all'}`
        : `co:${args.scope.companyId}`;
    const cacheKey = `analytics:overview:${scopeKey}:${currency}:${from.toISOString()}:${to.toISOString()}`;

    return this.cache.wrap(cacheKey, 60, () => this.compute({ args, currency, from, to }));
  }

  /**
   * Per-source drilldown for admins: one source's KPIs and daily trend,
   * plus a breakdown of EVERY company that transacted through it in the
   * range. The mirror image of the per-company overview's "by source".
   * Cached for 60s like the other rollups.
   */
  async sourceOverview(args: {
    sourceId: string;
    range: AnalyticsRange;
  }): Promise<SourceOverviewResponse> {
    const currency = args.range.currency ?? DEFAULT_CURRENCY;
    const to = args.range.to ? new Date(args.range.to) : new Date();
    const from = args.range.from
      ? new Date(args.range.from)
      : new Date(to.getTime() - DEFAULT_DAYS * 24 * 3600 * 1000);

    const cacheKey = `analytics:source-overview:${args.sourceId}:${currency}:${from.toISOString()}:${to.toISOString()}`;
    return this.cache.wrap(cacheKey, 60, () =>
      this.computeSource({ sourceId: args.sourceId, currency, from, to }),
    );
  }

  private async computeSource(p: {
    sourceId: string;
    currency: string;
    from: Date;
    to: Date;
  }): Promise<SourceOverviewResponse> {
    return this.prisma.runAsAdmin(async (tx) => {
      const source = await tx.source.findUnique({ where: { id: p.sourceId } });

      const where = {
        status: 'COMPLETED' as const,
        currency: p.currency,
        sourceId: p.sourceId,
        createdAt: { gte: p.from, lte: p.to },
      };

      const agg = await tx.transaction.aggregate({
        where,
        _sum: { amount: true, commissionAmount: true },
        _count: { _all: true },
        _avg: { amount: true },
      });

      const dailyRows = await tx.$queryRawUnsafe<
        Array<{ day: Date; volume: string; fees: string; count: bigint }>
      >(
        `
        SELECT
          date_trunc('day', created_at)::date  AS day,
          SUM(amount)::text                     AS volume,
          SUM(commission_amount)::text          AS fees,
          COUNT(*)::bigint                      AS count
        FROM transactions
        WHERE status = 'COMPLETED'
          AND currency = $1
          AND source_id = $2::uuid
          AND created_at >= $3
          AND created_at <= $4
        GROUP BY 1
        ORDER BY 1 ASC
        `,
        p.currency,
        p.sourceId,
        p.from,
        p.to,
      );
      const buckets = fillDailyGaps(p.from, p.to, dailyRows);

      // Every company that used this source in the range — no cap.
      const companyRows = await tx.transaction.groupBy({
        by: ['companyId'],
        where,
        _sum: { amount: true, commissionAmount: true },
        _count: { _all: true },
        orderBy: { _sum: { amount: 'desc' } },
      });
      const companyIds = companyRows.map((r) => r.companyId);
      const companies = companyIds.length
        ? await tx.company.findMany({ where: { id: { in: companyIds } } })
        : [];
      const nameById = new Map(companies.map((c) => [c.id, c.name]));
      const byCompany = companyRows.map((r) => ({
        companyId: r.companyId,
        companyName: nameById.get(r.companyId) ?? r.companyId.slice(0, 8),
        volume: Money.of((r._sum.amount ?? 0).toString()).toString(),
        fees: Money.of((r._sum.commissionAmount ?? 0).toString()).toString(),
        count: r._count._all,
      }));

      return {
        range: { from: p.from.toISOString(), to: p.to.toISOString() },
        currency: p.currency,
        source: {
          id: p.sourceId,
          code: source?.code ?? '',
          name: source?.name ?? p.sourceId.slice(0, 8),
        },
        kpi: {
          totalVolume: Money.of((agg._sum.amount ?? 0).toString()).toString(),
          totalFees: Money.of((agg._sum.commissionAmount ?? 0).toString()).toString(),
          transactionCount: agg._count._all,
          averageAmount: Money.of((agg._avg.amount ?? 0).toString()).toString(),
          currency: p.currency,
        },
        daily: { currency: p.currency, buckets },
        byCompany,
      };
    });
  }

  private async compute(p: {
    args: { scope: 'admin' | { companyId: string }; range: AnalyticsRange };
    currency: string;
    from: Date;
    to: Date;
  }): Promise<OverviewResponse> {
    const companyFilter =
      p.args.scope === 'admin' ? p.args.range.companyId : p.args.scope.companyId;

    return this.prisma.runAsScoped(
      p.args.scope === 'admin' ? null : p.args.scope.companyId,
      async (tx) => {
        // KPI aggregate
        const agg = await tx.transaction.aggregate({
          where: {
            status: 'COMPLETED',
            currency: p.currency,
            createdAt: { gte: p.from, lte: p.to },
            ...(companyFilter ? { companyId: companyFilter } : {}),
          },
          _sum: { amount: true, commissionAmount: true },
          _count: { _all: true },
          _avg: { amount: true },
        });

        const totalVolume = Money.of((agg._sum.amount ?? 0).toString()).toString();
        const totalFees = Money.of((agg._sum.commissionAmount ?? 0).toString()).toString();
        const transactionCount = agg._count._all;
        const averageAmount = Money.of((agg._avg.amount ?? 0).toString()).toString();

        // Volume broken out by operation type: deposits (source ingestion),
        // withdrawals, loads, payouts. Each splits settled (COMPLETED) money
        // from what's still in-flight (awaiting approval / processing) so the
        // company sees both what moved and what's pending. Same currency /
        // company / date window as the KPI aggregate above.
        const baseWhere = {
          currency: p.currency,
          createdAt: { gte: p.from, lte: p.to },
          ...(companyFilter ? { companyId: companyFilter } : {}),
        };
        const sumAndCount = { _sum: { amount: true }, _count: { _all: true } } as const;
        // Deposits = transactions; settled count/total reuse the KPI aggregate.
        const depositsPending = await tx.transaction.aggregate({
          where: { ...baseWhere, status: { in: ['PENDING', 'PROCESSING'] } },
          ...sumAndCount,
        });
        const [
          withdrawalsDone,
          withdrawalsPending,
          loadsDone,
          loadsPending,
          payoutsDone,
          payoutsPending,
        ] = await Promise.all([
          tx.withdrawal.aggregate({ where: { ...baseWhere, status: 'COMPLETED' }, ...sumAndCount }),
          tx.withdrawal.aggregate({
            where: { ...baseWhere, status: { in: ['PENDING', 'APPROVED', 'PROCESSING'] } },
            ...sumAndCount,
          }),
          tx.load.aggregate({ where: { ...baseWhere, status: 'COMPLETED' }, ...sumAndCount }),
          tx.load.aggregate({
            where: { ...baseWhere, status: { in: ['PENDING', 'APPROVED', 'PROCESSING'] } },
            ...sumAndCount,
          }),
          tx.payout.aggregate({ where: { ...baseWhere, status: 'COMPLETED' }, ...sumAndCount }),
          tx.payout.aggregate({
            where: { ...baseWhere, status: { in: ['PENDING', 'APPROVED', 'PROCESSING'] } },
            ...sumAndCount,
          }),
        ]);

        const volume = {
          deposits: toVolumeMetric(agg, depositsPending),
          withdrawals: toVolumeMetric(withdrawalsDone, withdrawalsPending),
          loads: toVolumeMetric(loadsDone, loadsPending),
          payouts: toVolumeMetric(payoutsDone, payoutsPending),
        };

        // Daily buckets via raw SQL: groupBy doesn't support date_trunc directly.
        const dailyRows = await tx.$queryRawUnsafe<
          Array<{ day: Date; volume: string; fees: string; count: bigint }>
        >(
          `
        SELECT
          date_trunc('day', created_at)::date  AS day,
          SUM(amount)::text                     AS volume,
          SUM(commission_amount)::text          AS fees,
          COUNT(*)::bigint                      AS count
        FROM transactions
        WHERE status = 'COMPLETED'
          AND currency = $1
          AND created_at >= $2
          AND created_at <= $3
          ${companyFilter ? 'AND company_id = $4::uuid' : ''}
        GROUP BY 1
        ORDER BY 1 ASC
        `,
          p.currency,
          p.from,
          p.to,
          ...(companyFilter ? [companyFilter] : []),
        );

        const buckets = fillDailyGaps(p.from, p.to, dailyRows);

        // Sources by volume — include fees so dashboards can show
        // "by OMT: $X volume, $Y fees" / "by wish: ..." breakdowns. When
        // scoped to a single company (drilldown), return ALL of its sources;
        // the platform-wide view stays capped to the top few.
        const topSrcRows = await tx.transaction.groupBy({
          by: ['sourceId'],
          where: {
            status: 'COMPLETED',
            currency: p.currency,
            createdAt: { gte: p.from, lte: p.to },
            ...(companyFilter ? { companyId: companyFilter } : {}),
          },
          _sum: { amount: true, commissionAmount: true },
          _count: { _all: true },
          orderBy: { _sum: { amount: 'desc' } },
          ...(companyFilter ? {} : { take: TOP_LIMIT }),
        });
        const sourceIds = topSrcRows.map((r) => r.sourceId);
        const sources = sourceIds.length
          ? await tx.source.findMany({ where: { id: { in: sourceIds } } })
          : [];
        const sourceCode = new Map(sources.map((s) => [s.id, s.code]));
        const topSources = topSrcRows.map((r) => ({
          sourceId: r.sourceId,
          sourceCode: sourceCode.get(r.sourceId) ?? '',
          volume: Money.of((r._sum.amount ?? 0).toString()).toString(),
          fees: Money.of((r._sum.commissionAmount ?? 0).toString()).toString(),
          count: r._count._all,
        }));

        // Top companies — admin scope only.
        let topCompanies:
          | { companyId: string; companyName: string; volume: string; count: number }[]
          | undefined;
        if (p.args.scope === 'admin' && !companyFilter) {
          const rows = await tx.transaction.groupBy({
            by: ['companyId'],
            where: {
              status: 'COMPLETED',
              currency: p.currency,
              createdAt: { gte: p.from, lte: p.to },
            },
            _sum: { amount: true },
            _count: { _all: true },
            orderBy: { _sum: { amount: 'desc' } },
            take: TOP_LIMIT,
          });
          const companyIds = rows.map((r) => r.companyId);
          const companies = companyIds.length
            ? await tx.company.findMany({ where: { id: { in: companyIds } } })
            : [];
          const nameById = new Map(companies.map((c) => [c.id, c.name]));
          topCompanies = rows.map((r) => ({
            companyId: r.companyId,
            companyName: nameById.get(r.companyId) ?? r.companyId.slice(0, 8),
            volume: Money.of((r._sum.amount ?? 0).toString()).toString(),
            count: r._count._all,
          }));
        }

        return {
          range: { from: p.from.toISOString(), to: p.to.toISOString() },
          currency: p.currency,
          kpi: {
            totalVolume,
            // Company-scoped callers never receive the aggregate fee — they only
            // see per-transaction fees. Admins (scope === 'admin', incl. when
            // drilling into one company) get the total.
            ...(p.args.scope === 'admin' ? { totalFees } : {}),
            transactionCount,
            averageAmount,
            currency: p.currency,
          },
          volume,
          daily: { currency: p.currency, buckets },
          topSources,
          ...(topCompanies ? { topCompanies } : {}),
        };
      },
    );
  }
}

// Shape a (completed, pending) pair of Prisma aggregate results into the
// VolumeMetric the dashboard consumes. Amounts become Decimal strings.
function toVolumeMetric(
  completed: { _sum: { amount: { toString(): string } | null }; _count: { _all: number } },
  pending: { _sum: { amount: { toString(): string } | null }; _count: { _all: number } },
): VolumeMetric {
  return {
    completedTotal: Money.of((completed._sum.amount ?? 0).toString()).toString(),
    completedCount: completed._count._all,
    pendingTotal: Money.of((pending._sum.amount ?? 0).toString()).toString(),
    pendingCount: pending._count._all,
  };
}

function fillDailyGaps(
  from: Date,
  to: Date,
  rows: Array<{ day: Date; volume: string; fees: string; count: bigint }>,
): Array<{ date: string; volume: string; fees: string; count: number }> {
  const byDay = new Map<string, { volume: string; fees: string; count: number }>();
  for (const r of rows) {
    byDay.set(toDateKey(r.day), {
      volume: r.volume ?? '0',
      fees: r.fees ?? '0',
      count: Number(r.count),
    });
  }
  const out: Array<{ date: string; volume: string; fees: string; count: number }> = [];
  const cursor = new Date(from);
  cursor.setUTCHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setUTCHours(0, 0, 0, 0);
  while (cursor.getTime() <= end.getTime()) {
    const key = toDateKey(cursor);
    out.push({
      date: key,
      volume: byDay.get(key)?.volume ?? '0',
      fees: byDay.get(key)?.fees ?? '0',
      count: byDay.get(key)?.count ?? 0,
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

function toDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}
