import { Injectable } from '@nestjs/common';
import {
  bucketKey,
  eachBucketStartUtc,
  Money,
  sqlTruncUnit,
  type AdminAnalyticsRange,
  type BucketGranularity,
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
import {
  ALL_TIME_STATEMENT_TIMEOUT,
  ALL_TIME_TX_TIMEOUT_MS,
  originForPlatform,
  resolveWindow,
  type OriginDeps,
} from './range';
import { sourceFeesByCurrency, sourceFeesBreakdown } from './source-fees';

const PENDING_OPS_LIMIT = 20;
// Top sources shown on the admin overview "By source" tile.
const TOP_SOURCES_LIMIT = 5;

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

  /** The two dependencies the origin helpers need, without widening their access. */
  private get originDeps(): OriginDeps {
    return { prisma: this.prisma, cache: this.cache };
  }

  // ============================================================
  // Platform multi-currency rollup
  // ============================================================
  /**
   * Per-currency breakdown of platform activity in a range, plus the
   * total "net held" across all wallets (point-in-time, not range-bound).
   */
  async platform(range: AdminAnalyticsRange): Promise<PlatformAnalyticsResponse> {
    const origin = range.preset === 'all' ? await originForPlatform(this.originDeps) : null;
    const { from, to, isAllTime } = resolveWindow(range, origin);
    // v3: the rollup gained networkFeesEarned (and netRevenue now counts it).
    const cacheKey = `analytics:platform:v3:${from.toISOString()}:${to.toISOString()}`;

    return this.cache.wrap(cacheKey, 60, async () => {
      return this.prisma.runAsAdmin(async (tx) => {
        if (isAllTime) {
          await tx.$executeRawUnsafe(
            `SET LOCAL statement_timeout = '${ALL_TIME_STATEMENT_TIMEOUT}'`,
          );
        }
        // Money IN = transaction ingestion + load approvals. Money OUT =
        // withdrawal + payout approvals. Every figure is net + fee + network fee
        // (the money that actually moved): the raw `amount` column equals that
        // only for DEDUCTED fees — for ON_TOP it equals net, undercounting by the
        // fees. Transactions carry the fee in commissionAmount; the flows in
        // feeAmount; all four carry networkFeeAmount.
        // Settlement time: transactions settle at ingest (createdAt); loads /
        // withdrawals / payouts settle on approval (processedAt).
        const txAgg = await tx.transaction.groupBy({
          by: ['currency'],
          where: { status: 'COMPLETED', createdAt: { gte: from, lte: to } },
          _sum: { netAmount: true, commissionAmount: true, networkFeeAmount: true },
          _count: { _all: true },
        });
        const loadAgg = await tx.load.groupBy({
          by: ['currency'],
          where: { status: 'COMPLETED', processedAt: { gte: from, lte: to } },
          _sum: { netAmount: true, feeAmount: true, networkFeeAmount: true },
        });

        // Out-flows in range (withdrawals + payouts), settled on approval.
        const wdAgg = await tx.withdrawal.groupBy({
          by: ['currency'],
          where: { status: 'COMPLETED', processedAt: { gte: from, lte: to } },
          _sum: { netAmount: true, feeAmount: true, networkFeeAmount: true },
          _count: { _all: true },
        });
        const poAgg = await tx.payout.groupBy({
          by: ['currency'],
          where: { status: 'COMPLETED', processedAt: { gte: from, lte: to } },
          _sum: { netAmount: true, feeAmount: true, networkFeeAmount: true },
        });

        // Platform revenue = realized fees across EVERY flow, not just
        // transactions. Each flow books its fee to the FEE ledger account on
        // settlement (ingest for transactions; approval for withdrawals /
        // payouts / loads), and a reversal debits it back. So the net FEE
        // credit per currency is the true earned revenue and stays correct as
        // new flow types are added. (Filtered by ledger created_at = the moment
        // the fee was actually realized.)
        const feeRows = await tx.$queryRawUnsafe<Array<{ currency: string; fees: string }>>(
          `
          SELECT currency,
            SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END)::text AS fees
          FROM ledger_entries
          WHERE account_type = 'FEE'
            AND created_at >= $1 AND created_at <= $2
          GROUP BY currency
          `,
          from,
          to,
        );
        // Network-fee revenue, the same way from its own ledger account — kept
        // apart from FEE so feesEarned keeps its meaning.
        const networkFeeRows = await tx.$queryRawUnsafe<Array<{ currency: string; fees: string }>>(
          `
          SELECT currency,
            SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END)::text AS fees
          FROM ledger_entries
          WHERE account_type = 'NETWORK_FEE'
            AND created_at >= $1 AND created_at <= $2
          GROUP BY currency
          `,
          from,
          to,
        );

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
              networkFeesEarned: '0',
              sourceFees: '0',
              netRevenue: '0',
              volumeOut: '0',
              netHeld: '0',
              ingestCount: 0,
              withdrawalCount: 0,
            });
          }
          return byCurrency.get(key)!;
        };

        // Source fees = what upstream sources (e.g. Whish) charge THE PLATFORM on
        // their deposits, evaluated per-deposit from each source's fee schedule.
        // Net revenue = platform revenue (FEE + NETWORK_FEE ledgers) − source
        // fees. All system/admin-only and never leak to a company response.
        const feesBySource = await sourceFeesByCurrency(tx, from, to);
        const sourceBreakdown = await sourceFeesBreakdown(tx, from, to);

        // net + fee + network fee for a flow aggregate (feeAmount column).
        const sumOf = (v: unknown) =>
          Money.of(((v as { toString(): string } | null) ?? 0).toString());
        const netPlusFees = (m: {
          _sum: { netAmount?: unknown; feeAmount?: unknown; networkFeeAmount?: unknown };
        }) =>
          sumOf(m._sum.netAmount).add(sumOf(m._sum.feeAmount)).add(sumOf(m._sum.networkFeeAmount));
        for (const r of txAgg) {
          const s = ensure(r.currency);
          // Transactions carry the fee in commissionAmount, not feeAmount.
          s.volumeIn = Money.of(s.volumeIn)
            .add(Money.of((r._sum.netAmount ?? 0).toString()))
            .add(Money.of((r._sum.commissionAmount ?? 0).toString()))
            .add(Money.of((r._sum.networkFeeAmount ?? 0).toString()))
            .toString();
          s.ingestCount = r._count._all;
        }
        for (const r of loadAgg) {
          const s = ensure(r.currency);
          s.volumeIn = Money.of(s.volumeIn).add(netPlusFees(r)).toString();
        }
        // feesEarned comes from the FEE ledger (all flows), not just transaction
        // commission — a currency may earn fees with no ingestion (e.g. a
        // withdrawal-fee-only currency), so this loop drives `ensure` too.
        for (const r of feeRows) {
          const s = ensure(r.currency);
          s.feesEarned = Money.of(r.fees ?? '0').toString();
        }
        for (const r of networkFeeRows) {
          const s = ensure(r.currency);
          s.networkFeesEarned = Money.of(r.fees ?? '0').toString();
        }
        for (const r of wdAgg) {
          const s = ensure(r.currency);
          s.volumeOut = Money.of(s.volumeOut).add(netPlusFees(r)).toString();
          s.withdrawalCount = r._count._all;
        }
        for (const r of poAgg) {
          const s = ensure(r.currency);
          s.volumeOut = Money.of(s.volumeOut).add(netPlusFees(r)).toString();
        }
        for (const w of wallets) {
          const s = ensure(w.currency);
          const total = Money.of((w._sum.availableBalance ?? 0).toString())
            .add(Money.of((w._sum.pendingBalance ?? 0).toString()))
            .add(Money.of((w._sum.reservedBalance ?? 0).toString()));
          s.netHeld = total.toString();
        }

        // Apply per-currency source fees, then derive net revenue.
        for (const [ccy, fees] of feesBySource) {
          ensure(ccy).sourceFees = Money.of(fees || '0').toString();
        }
        for (const s of byCurrency.values()) {
          s.netRevenue = Money.of(s.feesEarned)
            .add(Money.of(s.networkFeesEarned))
            .sub(Money.of(s.sourceFees))
            .toString();
        }

        const sorted = [...byCurrency.values()].sort((a, b) =>
          a.currency.localeCompare(b.currency),
        );
        return {
          range: { from: from.toISOString(), to: to.toISOString() },
          byCurrency: sorted,
          sourceFeeBreakdown: sourceBreakdown.map((b) => ({
            sourceId: b.sourceId,
            sourceCode: b.sourceCode,
            sourceName: b.sourceName,
            currency: b.currency,
            fees: Money.of(b.fees || '0').toString(),
          })),
        };
      });
    });
  }

  // ============================================================
  // Flows: daily in vs out per currency
  // ============================================================
  async flows(range: FlowsRange): Promise<FlowsResponse> {
    const origin = range.preset === 'all' ? await originForPlatform(this.originDeps) : null;
    const { from, to, granularity, isAllTime } = resolveWindow(range, origin);
    const currency = range.currency;
    // v3: buckets gained networkFees.
    const cacheKey = `analytics:flows:v3:${currency}:${from.toISOString()}:${to.toISOString()}:${granularity}`;

    return this.cache.wrap(cacheKey, 60, async () => {
      return this.prisma.runAsAdmin(
        async (tx) => {
          if (isAllTime) {
            await tx.$executeRawUnsafe(
              `SET LOCAL statement_timeout = '${ALL_TIME_STATEMENT_TIMEOUT}'`,
            );
          }
          const truncUnit = sqlTruncUnit(granularity);
          // Daily in/out are net + fee + network fee (the money that actually
          // moved), and span every flow: in = transactions (created_at) + loads
          // (processed_at); out = withdrawals + payouts (processed_at). Plus the
          // FEE- and NETWORK_FEE-ledger overlays (all flows), so the bars and the
          // fee lines agree day-by-day.
          const txRows = await tx.$queryRawUnsafe<Array<{ day: Date; v: string }>>(
            `
          SELECT
            date_trunc($4::text, created_at AT TIME ZONE 'UTC')::date AS day,
            SUM(net_amount + commission_amount + network_fee_amount)::text AS v
          FROM transactions
          WHERE status = 'COMPLETED'
            AND currency = $1
            AND created_at >= $2 AND created_at <= $3
          GROUP BY 1 ORDER BY 1 ASC
          `,
            currency,
            from,
            to,
            truncUnit,
          );

          const loadRows = await tx.$queryRawUnsafe<Array<{ day: Date; v: string }>>(
            `
          SELECT
            date_trunc($4::text, processed_at AT TIME ZONE 'UTC')::date AS day,
            SUM(net_amount + fee_amount + network_fee_amount)::text AS v
          FROM loads
          WHERE status = 'COMPLETED'
            AND currency = $1
            AND processed_at IS NOT NULL
            AND processed_at >= $2 AND processed_at <= $3
          GROUP BY 1 ORDER BY 1 ASC
          `,
            currency,
            from,
            to,
            truncUnit,
          );

          const wdRows = await tx.$queryRawUnsafe<Array<{ day: Date; v: string }>>(
            `
          SELECT
            date_trunc($4::text, processed_at AT TIME ZONE 'UTC')::date AS day,
            SUM(net_amount + fee_amount + network_fee_amount)::text AS v
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
            truncUnit,
          );

          const poRows = await tx.$queryRawUnsafe<Array<{ day: Date; v: string }>>(
            `
          SELECT
            date_trunc($4::text, processed_at AT TIME ZONE 'UTC')::date AS day,
            SUM(net_amount + fee_amount + network_fee_amount)::text AS v
          FROM payouts
          WHERE status = 'COMPLETED'
            AND currency = $1
            AND processed_at IS NOT NULL
            AND processed_at >= $2 AND processed_at <= $3
          GROUP BY 1 ORDER BY 1 ASC
          `,
            currency,
            from,
            to,
            truncUnit,
          );

          const feeRows = await tx.$queryRawUnsafe<Array<{ day: Date; f: string }>>(
            `
          SELECT
            date_trunc($4::text, created_at AT TIME ZONE 'UTC')::date AS day,
            SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END)::text AS f
          FROM ledger_entries
          WHERE account_type = 'FEE'
            AND currency = $1
            AND created_at >= $2 AND created_at <= $3
          GROUP BY 1 ORDER BY 1 ASC
          `,
            currency,
            from,
            to,
            truncUnit,
          );

          const networkFeeRows = await tx.$queryRawUnsafe<Array<{ day: Date; f: string }>>(
            `
          SELECT
            date_trunc($4::text, created_at AT TIME ZONE 'UTC')::date AS day,
            SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END)::text AS f
          FROM ledger_entries
          WHERE account_type = 'NETWORK_FEE'
            AND currency = $1
            AND created_at >= $2 AND created_at <= $3
          GROUP BY 1 ORDER BY 1 ASC
          `,
            currency,
            from,
            to,
            truncUnit,
          );

          // Top sources by volume for this currency+window — for the admin overview
          // "By source" tile. One indexed GROUP BY source_id (backed by the partial
          // transactions_completed_source_created_idx). Lives here, on the per-currency
          // endpoint the admin overview already fetches, so the dashboard no longer
          // pays for the full overview() compute (~11 queries incl. a cross-tenant
          // GROUP BY) just to render this 5-row table.
          const topSrcRows = await tx.$queryRawUnsafe<
            Array<{ sourceId: string; volume: string; fees: string; count: bigint }>
          >(
            `
          SELECT source_id                                 AS "sourceId",
                 SUM(net_amount + commission_amount + network_fee_amount)::text AS volume,
                 SUM(commission_amount)::text              AS fees,
                 COUNT(*)::bigint                          AS count
          FROM transactions
          WHERE status = 'COMPLETED' AND currency = $1
            AND created_at >= $2 AND created_at <= $3
          GROUP BY source_id
          ORDER BY SUM(net_amount + commission_amount + network_fee_amount) DESC
          LIMIT ${TOP_SOURCES_LIMIT}
          `,
            currency,
            from,
            to,
          );
          const srcIds = topSrcRows.map((r) => r.sourceId);
          const srcRows = srcIds.length
            ? await tx.source.findMany({
                where: { id: { in: srcIds } },
                select: { id: true, code: true },
              })
            : [];
          const srcCode = new Map(srcRows.map((s) => [s.id, s.code]));
          const topSources = topSrcRows.map((r) => ({
            sourceId: r.sourceId,
            sourceCode: srcCode.get(r.sourceId) ?? '',
            volume: r.volume,
            fees: r.fees,
            count: Number(r.count),
          }));

          const buckets = mergeBuckets(
            from,
            to,
            granularity,
            [txRows, loadRows],
            [wdRows, poRows],
            feeRows,
            networkFeeRows,
          );
          return {
            currency,
            range: { from: from.toISOString(), to: to.toISOString() },
            granularity,
            buckets,
            topSources,
          };
        },
        isAllTime ? { timeout: ALL_TIME_TX_TIMEOUT_MS } : undefined,
      );
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
        // Value is net + fee + network fee — the reserved total that will
        // actually leave on approval (for ON_TOP fees that exceeds the requested
        // amount).
        const pendingByCcy = await tx.withdrawal.groupBy({
          by: ['currency'],
          where: { status: 'PENDING' },
          _sum: { netAmount: true, feeAmount: true, networkFeeAmount: true },
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

        // Pending payouts and loads also await an operator (payouts reserve funds
        // the moment they're requested), so the headline count and action queue
        // must include them — otherwise the dashboard reads "all clear" while real
        // money sits in PENDING on the separate Payouts/Loads pages.
        const [pendingPayouts, pendingLoads, pendingPayoutsCount, pendingLoadsCount] =
          await Promise.all([
            tx.payout.findMany({
              where: { status: 'PENDING' },
              orderBy: { createdAt: 'asc' },
              take: PENDING_OPS_LIMIT,
              include: { company: { select: { name: true } } },
            }),
            tx.load.findMany({
              where: { status: 'PENDING' },
              orderBy: { createdAt: 'asc' },
              take: PENDING_OPS_LIMIT,
              include: { company: { select: { name: true } } },
            }),
            tx.payout.count({ where: { status: 'PENDING' } }),
            tx.load.count({ where: { status: 'PENDING' } }),
          ]);

        const items: OpsItem[] = [];

        for (const w of pendingWithdrawals) {
          // The total that will leave on approval = net + fee + network fee (= reserved).
          const total = Money.of(w.netAmount.toString())
            .add(Money.of(w.feeAmount.toString()))
            .add(Money.of(w.networkFeeAmount.toString()))
            .toString();
          items.push({
            kind: 'withdrawal_pending',
            id: w.id,
            companyId: w.companyId,
            companyName: w.company?.name ?? w.companyId.slice(0, 8),
            summary: `Withdrawal of ${total} ${w.currency.trim()} awaiting approval`,
            amount: total,
            currency: w.currency.trim(),
            createdAt: w.createdAt.toISOString(),
          });
        }
        for (const p of pendingPayouts) {
          const total = Money.of(p.netAmount.toString())
            .add(Money.of(p.feeAmount.toString()))
            .add(Money.of(p.networkFeeAmount.toString()))
            .toString();
          items.push({
            kind: 'payout_pending',
            id: p.id,
            companyId: p.companyId,
            companyName: p.company?.name ?? p.companyId.slice(0, 8),
            summary: `Payout of ${total} ${p.currency.trim()} awaiting approval`,
            amount: total,
            currency: p.currency.trim(),
            createdAt: p.createdAt.toISOString(),
          });
        }
        for (const l of pendingLoads) {
          items.push({
            kind: 'load_pending',
            id: l.id,
            companyId: l.companyId,
            companyName: l.company?.name ?? l.companyId.slice(0, 8),
            summary: `Load of ${l.amount.toString()} ${l.currency.trim()} awaiting approval`,
            amount: l.amount.toString(),
            currency: l.currency.trim(),
            createdAt: l.createdAt.toISOString(),
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
          pendingWithdrawalsValue[p.currency.trim()] = Money.of((p._sum.netAmount ?? 0).toString())
            .add(Money.of((p._sum.feeAmount ?? 0).toString()))
            .add(Money.of((p._sum.networkFeeAmount ?? 0).toString()))
            .toString();
          pendingWithdrawalsCount += p._count._all;
        }

        return {
          pendingWithdrawalsCount,
          pendingPayoutsCount,
          pendingLoadsCount,
          pendingWithdrawalsValue,
          recentReversalsCount: recentReversals.length,
          items,
        };
      });
    });
  }
}

/**
 * Merge the per-flow row sets into one zero-filled series. Walks in UTC to match
 * the SQL, which truncates `AT TIME ZONE 'UTC'` — see fillBucketGaps in
 * analytics.service.ts for why that pairing matters.
 */
function mergeBuckets(
  from: Date,
  to: Date,
  granularity: BucketGranularity,
  inRowSets: Array<Array<{ day: Date; v: string }>>,
  outRowSets: Array<Array<{ day: Date; v: string }>>,
  feeRows: Array<{ day: Date; f: string }>,
  networkFeeRows: Array<{ day: Date; f: string }>,
): FlowsBucket[] {
  // Each direction merges several per-flow row sets, summing same-day values.
  const sumByBucket = (sets: Array<Array<{ day: Date; v: string }>>) => {
    const map = new Map<string, Money>();
    for (const rows of sets) {
      for (const r of rows) {
        const key = bucketKey(r.day);
        map.set(key, (map.get(key) ?? Money.zero()).add(Money.of(r.v ?? '0')));
      }
    }
    return map;
  };
  const inByDay = sumByBucket(inRowSets);
  const outByDay = sumByBucket(outRowSets);
  const feeByDay = new Map(feeRows.map((r) => [bucketKey(r.day), r.f ?? '0']));
  const networkFeeByDay = new Map(networkFeeRows.map((r) => [bucketKey(r.day), r.f ?? '0']));

  return eachBucketStartUtc(from, to, granularity).map((start) => {
    const key = bucketKey(start);
    return {
      date: key,
      in: (inByDay.get(key) ?? Money.zero()).toString(),
      out: (outByDay.get(key) ?? Money.zero()).toString(),
      fees: feeByDay.get(key) ?? '0',
      networkFees: networkFeeByDay.get(key) ?? '0',
    };
  });
}
