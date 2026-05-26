import { Injectable } from '@nestjs/common';
import { Money, type AnalyticsRange, type OverviewResponse } from '@app/shared';
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

  private async compute(p: {
    args: { scope: 'admin' | { companyId: string }; range: AnalyticsRange };
    currency: string;
    from: Date;
    to: Date;
  }): Promise<OverviewResponse> {
    const companyFilter =
      p.args.scope === 'admin' ? p.args.range.companyId : p.args.scope.companyId;

    return this.prisma.runAsAdmin(async (tx) => {
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

      // Top sources by volume — include fees so dashboards can show
      // "by OMT: $X volume, $Y fees" / "by wish: ..." breakdowns.
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
        take: TOP_LIMIT,
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
          totalFees,
          transactionCount,
          averageAmount,
          currency: p.currency,
        },
        daily: { currency: p.currency, buckets },
        topSources,
        ...(topCompanies ? { topCompanies } : {}),
      };
    });
  }
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
