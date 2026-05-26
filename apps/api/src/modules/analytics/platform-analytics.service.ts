import { Injectable } from '@nestjs/common';
import {
  Money,
  type AdminAnalyticsRange,
  type CurrencyRollup,
  type FlowsBucket,
  type FlowsRange,
  type FlowsResponse,
  type OpsItem,
  type OperationsResponse,
  type PlatformAnalyticsResponse,
} from '@app/shared';
import { PrismaService } from '../../database/prisma.service';
import { CacheService } from '../cache/cache.service';

const DEFAULT_DAYS = 30;
const PENDING_OPS_LIMIT = 20;

/**
 * System-admin oriented analytics that span all companies and currencies.
 * Separate from AnalyticsService because the shape and aggregation strategy
 * are different — admin wants platform-wide rollups, not per-tenant.
 */
@Injectable()
export class PlatformAnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
  ) {}

  // ============================================================
  // Platform multi-currency rollup
  // ============================================================
  /**
   * Per-currency breakdown of platform activity in a range, plus the
   * total "net held" across all wallets (point-in-time, not range-bound).
   */
  async platform(range: AdminAnalyticsRange): Promise<PlatformAnalyticsResponse> {
    const { from, to } = resolveRange(range);
    const cacheKey = `analytics:platform:${from.toISOString()}:${to.toISOString()}`;

    return this.cache.wrap(cacheKey, 60, async () => {
      return this.prisma.runAsAdmin(async (tx) => {
        // Transactions in range (ingestion + fees).
        const txAgg = await tx.transaction.groupBy({
          by: ['currency'],
          where: { status: 'COMPLETED', createdAt: { gte: from, lte: to } },
          _sum: { amount: true, commissionAmount: true },
          _count: { _all: true },
        });

        // Withdrawals in range (payout outflow).
        const wdAgg = await tx.withdrawal.groupBy({
          by: ['currency'],
          where: { status: 'COMPLETED', processedAt: { gte: from, lte: to } },
          _sum: { amount: true },
          _count: { _all: true },
        });

        // Wallets are a point-in-time view — sum what's currently parked
        // across all companies, per currency.
        const wallets = await tx.wallet.groupBy({
          by: ['currency'],
          _sum: {
            availableBalance: true,
            pendingBalance: true,
            reservedBalance: true,
          },
        });

        // Merge into a single per-currency map.
        const byCurrency = new Map<string, CurrencyRollup>();
        const ensure = (c: string): CurrencyRollup => {
          const key = c.trim();
          if (!byCurrency.has(key)) {
            byCurrency.set(key, {
              currency: key,
              volumeIn: '0',
              feesEarned: '0',
              volumeOut: '0',
              netHeld: '0',
              ingestCount: 0,
              withdrawalCount: 0,
            });
          }
          return byCurrency.get(key)!;
        };

        for (const r of txAgg) {
          const s = ensure(r.currency);
          s.volumeIn = Money.of((r._sum.amount ?? 0).toString()).toString();
          s.feesEarned = Money.of((r._sum.commissionAmount ?? 0).toString()).toString();
          s.ingestCount = r._count._all;
        }
        for (const r of wdAgg) {
          const s = ensure(r.currency);
          s.volumeOut = Money.of((r._sum.amount ?? 0).toString()).toString();
          s.withdrawalCount = r._count._all;
        }
        for (const w of wallets) {
          const s = ensure(w.currency);
          const total = Money.of((w._sum.availableBalance ?? 0).toString())
            .add(Money.of((w._sum.pendingBalance ?? 0).toString()))
            .add(Money.of((w._sum.reservedBalance ?? 0).toString()));
          s.netHeld = total.toString();
        }

        const sorted = [...byCurrency.values()].sort((a, b) =>
          a.currency.localeCompare(b.currency),
        );
        return {
          range: { from: from.toISOString(), to: to.toISOString() },
          byCurrency: sorted,
        };
      });
    });
  }

  // ============================================================
  // Flows: daily in vs out per currency
  // ============================================================
  async flows(range: FlowsRange): Promise<FlowsResponse> {
    const { from, to } = resolveRange(range);
    const currency = range.currency;
    const cacheKey = `analytics:flows:${currency}:${from.toISOString()}:${to.toISOString()}`;

    return this.cache.wrap(cacheKey, 60, async () => {
      return this.prisma.runAsAdmin(async (tx) => {
        // Two queries: transactions in (date_trunc), withdrawals out (date_trunc).
        const txRows = await tx.$queryRawUnsafe<Array<{ day: Date; v: string; f: string }>>(
          `
          SELECT
            date_trunc('day', created_at)::date AS day,
            SUM(amount)::text                    AS v,
            SUM(commission_amount)::text         AS f
          FROM transactions
          WHERE status = 'COMPLETED'
            AND currency = $1
            AND created_at >= $2 AND created_at <= $3
          GROUP BY 1 ORDER BY 1 ASC
          `,
          currency,
          from,
          to,
        );

        const wdRows = await tx.$queryRawUnsafe<Array<{ day: Date; v: string }>>(
          `
          SELECT
            date_trunc('day', processed_at)::date AS day,
            SUM(amount)::text                      AS v
          FROM withdrawals
          WHERE status = 'COMPLETED'
            AND currency = $1
            AND processed_at IS NOT NULL
            AND processed_at >= $2 AND processed_at <= $3
          GROUP BY 1 ORDER BY 1 ASC
          `,
          currency,
          from,
          to,
        );

        const buckets = mergeDailyBuckets(from, to, txRows, wdRows);
        return {
          currency,
          range: { from: from.toISOString(), to: to.toISOString() },
          buckets,
        };
      });
    });
  }

  // ============================================================
  // Operations queue: what needs admin attention right now
  // ============================================================
  async operations(): Promise<OperationsResponse> {
    return this.cache.wrap('analytics:operations', 15, async () => {
      return this.prisma.runAsAdmin(async (tx) => {
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);

        // Pending withdrawals: count + value-by-currency + a sample for the action queue.
        const pendingByCcy = await tx.withdrawal.groupBy({
          by: ['currency'],
          where: { status: 'PENDING' },
          _sum: { amount: true },
          _count: { _all: true },
        });
        const pendingWithdrawals = await tx.withdrawal.findMany({
          where: { status: 'PENDING' },
          orderBy: { createdAt: 'asc' },
          take: PENDING_OPS_LIMIT,
          include: { company: { select: { name: true } } },
        });

        const recentReversals = await tx.transaction.findMany({
          where: { status: 'REVERSED', updatedAt: { gte: sevenDaysAgo } },
          orderBy: { updatedAt: 'desc' },
          take: 10,
          include: { company: { select: { name: true } } },
        });

        const items: OpsItem[] = [];

        for (const w of pendingWithdrawals) {
          items.push({
            kind: 'withdrawal_pending',
            id: w.id,
            companyId: w.companyId,
            companyName: w.company?.name ?? w.companyId.slice(0, 8),
            summary: `Withdrawal of ${w.amount.toString()} ${w.currency.trim()} awaiting approval`,
            amount: w.amount.toString(),
            currency: w.currency.trim(),
            createdAt: w.createdAt.toISOString(),
          });
        }
        for (const r of recentReversals) {
          items.push({
            kind: 'transaction_reversed',
            id: r.id,
            companyId: r.companyId,
            companyName: r.company?.name ?? r.companyId.slice(0, 8),
            summary: `Reversed: ${r.externalTransactionId} (${r.amount.toString()} ${r.currency.trim()})`,
            amount: r.amount.toString(),
            currency: r.currency.trim(),
            createdAt: r.updatedAt.toISOString(),
          });
        }

        // Sort items newest first so the action queue is genuinely current.
        items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

        const pendingWithdrawalsValue: Record<string, string> = {};
        let pendingWithdrawalsCount = 0;
        for (const p of pendingByCcy) {
          pendingWithdrawalsValue[p.currency.trim()] = Money.of(
            (p._sum.amount ?? 0).toString(),
          ).toString();
          pendingWithdrawalsCount += p._count._all;
        }

        return {
          pendingWithdrawalsCount,
          pendingWithdrawalsValue,
          recentReversalsCount: recentReversals.length,
          items,
        };
      });
    });
  }
}

function resolveRange(range: AdminAnalyticsRange): { from: Date; to: Date } {
  const to = range.to ? new Date(range.to) : new Date();
  const from = range.from
    ? new Date(range.from)
    : new Date(to.getTime() - DEFAULT_DAYS * 24 * 3600 * 1000);
  return { from, to };
}

function mergeDailyBuckets(
  from: Date,
  to: Date,
  txRows: Array<{ day: Date; v: string; f: string }>,
  wdRows: Array<{ day: Date; v: string }>,
): FlowsBucket[] {
  const txByDay = new Map(txRows.map((r) => [toDateKey(r.day), { v: r.v ?? '0', f: r.f ?? '0' }]));
  const wdByDay = new Map(wdRows.map((r) => [toDateKey(r.day), r.v ?? '0']));

  const out: FlowsBucket[] = [];
  const cursor = new Date(from);
  cursor.setUTCHours(0, 0, 0, 0);
  const end = new Date(to);
  end.setUTCHours(0, 0, 0, 0);
  while (cursor.getTime() <= end.getTime()) {
    const key = toDateKey(cursor);
    out.push({
      date: key,
      in: txByDay.get(key)?.v ?? '0',
      out: wdByDay.get(key) ?? '0',
      fees: txByDay.get(key)?.f ?? '0',
    });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

function toDateKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}
