import { Injectable } from '@nestjs/common';
import {
  Money,
  type AnalyticsRange,
  type OverviewResponse,
  type SourceOverviewResponse,
  type VolumeMetric,
  type WalletSummaryResponse,
} from '@app/shared';
import { PrismaService } from '../../database/prisma.service';
import { CacheService } from '../cache/cache.service';
import { LedgerService } from '../ledger/ledger.service';

const DEFAULT_DAYS = 30;
const DEFAULT_CURRENCY = 'USD';
const TOP_LIMIT = 5;

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly ledger: LedgerService,
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
   * Lifetime wallet reconciliation for one company + currency. Deliberately
   * NOT cached and NOT date-ranged: the cards are meant to reconcile against
   * the live wallet balance (in-flows.net - out-flows.total = available), so a
   * stale rollup would make the math appear off. The aggregates are a handful
   * of indexed SUMs — cheap to run on each dashboard poll.
   */
  async walletSummary(
    companyId: string,
    currencyArg?: string,
    range?: { from?: string; to?: string },
  ): Promise<WalletSummaryResponse> {
    const currency = currencyArg ?? DEFAULT_CURRENCY;
    // Optional date window (by request time) so the dashboard's range picker
    // drives these cards. When omitted the cards stay all-time and reconcile to
    // the live wallet balance.
    const createdAt =
      range?.from || range?.to
        ? {
            ...(range.from ? { gte: new Date(range.from) } : {}),
            ...(range.to ? { lte: new Date(range.to) } : {}),
          }
        : undefined;
    return this.prisma.runAsScoped(companyId, async (tx) => {
      const base = { companyId, currency, ...(createdAt ? { createdAt } : {}) };
      // Out-flows reserve `available` the moment they're requested, so count
      // everything that isn't cancelled/rejected (i.e. completed + in-flight).
      const ACTIVE = ['PENDING', 'APPROVED', 'PROCESSING', 'COMPLETED'] as const;
      const [deposits, loads, withdrawals, payouts] = await Promise.all([
        tx.transaction.aggregate({
          where: { ...base, status: 'COMPLETED' },
          _sum: { netAmount: true, commissionAmount: true },
        }),
        tx.load.aggregate({
          where: { ...base, status: 'COMPLETED' },
          _sum: { netAmount: true, feeAmount: true },
        }),
        tx.withdrawal.aggregate({
          where: { ...base, status: { in: [...ACTIVE] } },
          _sum: { netAmount: true, feeAmount: true },
        }),
        tx.payout.aggregate({
          where: { ...base, status: { in: [...ACTIVE] } },
          _sum: { netAmount: true, feeAmount: true },
        }),
      ]);
      // Outstanding RECEIVABLE (debt owed by the company to the platform from a
      // reversal clawback shortfall) = Σ(DEBIT) − Σ(CREDIT) on the RECEIVABLE
      // account. ALWAYS all-time (not date-windowed) so it matches the live
      // wallet: with it, net deposit + net load − withdrawals − payouts +
      // receivable == available, even after a reversal. Uses the single canonical
      // implementation on LedgerService so this can't drift from the withdrawal/
      // payout debt block that reads the same method.
      const receivable = await this.ledger.outstandingReceivable(tx, companyId, currency);
      const m = (v: { toString(): string } | null | undefined) => Money.of((v ?? 0).toString());
      const depNet = m(deposits._sum.netAmount);
      // Deposits gross = net + fee, matching loads.gross — so gross - net is the
      // (unshown) fee on both in-flow rows. Transactions carry the fee in
      // commissionAmount. (Summing `amount` would be net for an ON_TOP deposit.)
      const depGross = depNet.add(m(deposits._sum.commissionAmount));
      const loadNet = m(loads._sum.netAmount);
      const wdTotal = m(withdrawals._sum.netAmount).add(m(withdrawals._sum.feeAmount));
      const poTotal = m(payouts._sum.netAmount).add(m(payouts._sum.feeAmount));
      return {
        currency,
        deposits: { gross: depGross.toString(), net: depNet.toString() },
        loads: { gross: loadNet.add(m(loads._sum.feeAmount)).toString(), net: loadNet.toString() },
        withdrawals: { total: wdTotal.toString() },
        payouts: { total: poTotal.toString() },
        receivable: receivable.toString(),
      };
    });
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
        _sum: { amount: true, netAmount: true, commissionAmount: true },
        _count: { _all: true },
        _avg: { amount: true },
      });

      const dailyRows = await tx.$queryRawUnsafe<
        Array<{ day: Date; volume: string; fees: string; count: bigint }>
      >(
        `
        SELECT
          date_trunc('day', created_at)::date          AS day,
          SUM(net_amount + commission_amount)::text    AS volume,
          SUM(commission_amount)::text                 AS fees,
          COUNT(*)::bigint                             AS count
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
        _sum: { amount: true, netAmount: true, commissionAmount: true },
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
        // net + fee (money moved), consistent with the platform/volume surfaces.
        volume: Money.of((r._sum.netAmount ?? 0).toString())
          .add(Money.of((r._sum.commissionAmount ?? 0).toString()))
          .toString(),
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
          // Volume = net + fee (money moved), consistent with the daily series,
          // the by-company rows, and every other volume surface. NOT SUM(amount)
          // — for an ON_TOP deposit `amount` is the net, so it would drop the fee
          // and disagree with the rest of this very page.
          totalVolume: Money.of((agg._sum.netAmount ?? 0).toString())
            .add(Money.of((agg._sum.commissionAmount ?? 0).toString()))
            .toString(),
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
          _sum: { amount: true, netAmount: true, commissionAmount: true },
          _count: { _all: true },
          _avg: { amount: true },
        });

        // Volume = net + fee (the money that moved). Equals `amount` for a
        // DEDUCTED fee; for ON_TOP the fee is on top, so net+fee is the figure
        // that matches the Deposits card, the daily chart, and platform volumeIn.
        const totalVolume = Money.of((agg._sum.netAmount ?? 0).toString())
          .add(Money.of((agg._sum.commissionAmount ?? 0).toString()))
          .toString();
        // Total platform fees = realized fees from EVERY flow (transactions,
        // loads, withdrawals, payouts), read from the FEE ledger account — not
        // just transaction commission. Scoped to the same company/currency/
        // window as the KPI aggregate. (Per-source fees below stay
        // transaction-based, since sources only ever carry transactions.)
        const feeRow = await tx.$queryRawUnsafe<Array<{ fees: string }>>(
          `
          SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)::text AS fees
          FROM ledger_entries
          WHERE account_type = 'FEE'
            AND currency = $1
            AND created_at >= $2 AND created_at <= $3
            ${companyFilter ? 'AND company_id = $4::uuid' : ''}
          `,
          p.currency,
          p.from,
          p.to,
          ...(companyFilter ? [companyFilter] : []),
        );
        const totalFees = Money.of(feeRow[0]?.fees ?? '0').toString();
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
        // COMPLETED withdrawals/payouts/loads settle (and book their FEE ledger
        // credit) on approval, so window them by processedAt — matching the
        // platform rollup (platform-analytics.service.ts) and the FEE-ledger
        // totalFees query. This keeps the per-company cards reconciling with the
        // platform "Volume out"/"Platform fees" surfaces for any date range.
        // (Transactions settle at ingest, so deposits stay on createdAt; pending
        // flows have no processedAt yet, so they stay on baseWhere/createdAt.)
        const settledWhere = {
          currency: p.currency,
          processedAt: { gte: p.from, lte: p.to },
          ...(companyFilter ? { companyId: companyFilter } : {}),
        };
        // Sum net + fee (not `amount`) for every group. The card TOTAL is the
        // money that actually moved = net + fee: for a DEDUCTED fee that equals
        // `amount`, but for an ON_TOP fee the fee is charged on top, so `amount`
        // alone (= net) understates the real total. Withdrawals/payouts/loads
        // carry feeAmount; transactions carry commissionAmount.
        const flowSums = {
          _sum: { netAmount: true, feeAmount: true },
          _count: { _all: true },
        } as const;
        const txSums = {
          _sum: { netAmount: true, commissionAmount: true },
          _count: { _all: true },
        } as const;
        const PENDING_STATUSES = ['PENDING', 'APPROVED', 'PROCESSING'] as const;
        // Deposits = transactions; the completed side reuses the KPI aggregate.
        const depositsPending = await tx.transaction.aggregate({
          where: { ...baseWhere, status: { in: ['PENDING', 'PROCESSING'] } },
          ...txSums,
        });
        const [
          withdrawalsDone,
          withdrawalsPending,
          loadsDone,
          loadsPending,
          payoutsDone,
          payoutsPending,
        ] = await Promise.all([
          tx.withdrawal.aggregate({ where: { ...settledWhere, status: 'COMPLETED' }, ...flowSums }),
          tx.withdrawal.aggregate({
            where: { ...baseWhere, status: { in: [...PENDING_STATUSES] } },
            ...flowSums,
          }),
          tx.load.aggregate({ where: { ...settledWhere, status: 'COMPLETED' }, ...flowSums }),
          tx.load.aggregate({
            where: { ...baseWhere, status: { in: [...PENDING_STATUSES] } },
            ...flowSums,
          }),
          tx.payout.aggregate({ where: { ...settledWhere, status: 'COMPLETED' }, ...flowSums }),
          tx.payout.aggregate({
            where: { ...baseWhere, status: { in: [...PENDING_STATUSES] } },
            ...flowSums,
          }),
        ]);

        // Fee summed per group: transactions = commissionAmount, the money
        // in/out flows = feeAmount.
        const feeOf = (m: { _sum: { feeAmount?: { toString(): string } | null } }) =>
          Money.of((m._sum.feeAmount ?? 0).toString()).toString();
        const commissionOf = (m: { _sum: { commissionAmount?: { toString(): string } | null } }) =>
          Money.of((m._sum.commissionAmount ?? 0).toString()).toString();
        const volume = {
          deposits: toVolumeMetric(
            agg,
            commissionOf(agg),
            depositsPending,
            commissionOf(depositsPending),
          ),
          withdrawals: toVolumeMetric(
            withdrawalsDone,
            feeOf(withdrawalsDone),
            withdrawalsPending,
            feeOf(withdrawalsPending),
          ),
          loads: toVolumeMetric(loadsDone, feeOf(loadsDone), loadsPending, feeOf(loadsPending)),
          payouts: toVolumeMetric(
            payoutsDone,
            feeOf(payoutsDone),
            payoutsPending,
            feeOf(payoutsPending),
          ),
        };

        // Daily buckets via raw SQL: groupBy doesn't support date_trunc directly.
        const dailyRows = await tx.$queryRawUnsafe<
          Array<{ day: Date; volume: string; fees: string; count: bigint }>
        >(
          `
        SELECT
          date_trunc('day', created_at)::date          AS day,
          SUM(net_amount + commission_amount)::text    AS volume,
          SUM(commission_amount)::text                 AS fees,
          COUNT(*)::bigint                             AS count
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
          _sum: { amount: true, netAmount: true, commissionAmount: true },
          _count: { _all: true },
          // No DB `take`: we rank by the DISPLAYED volume (net + fee), which Prisma
          // groupBy can't ORDER BY, so fetch all in-window source groups (a small
          // set) and sort + slice below. A net-only top-N could otherwise exclude a
          // fee-heavy source that belongs in the top-5 by volume.
          orderBy: { _sum: { netAmount: 'desc' } },
        });
        const sourceIds = topSrcRows.map((r) => r.sourceId);
        const sources = sourceIds.length
          ? await tx.source.findMany({ where: { id: { in: sourceIds } } })
          : [];
        const sourceCode = new Map(sources.map((s) => [s.id, s.code]));
        const topSourcesAll = topSrcRows.map((r) => ({
          sourceId: r.sourceId,
          sourceCode: sourceCode.get(r.sourceId) ?? '',
          // net + fee (money moved), matching totalVolume and the deposit card.
          volume: Money.of((r._sum.netAmount ?? 0).toString())
            .add(Money.of((r._sum.commissionAmount ?? 0).toString()))
            .toString(),
          fees: Money.of((r._sum.commissionAmount ?? 0).toString()).toString(),
          count: r._count._all,
        }));
        // Order by the displayed volume; the platform view shows the top few, a
        // single-company drilldown returns all of its sources.
        topSourcesAll.sort((a, b) => Money.of(b.volume).cmp(Money.of(a.volume)));
        const topSources = companyFilter ? topSourcesAll : topSourcesAll.slice(0, TOP_LIMIT);

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
            _sum: { amount: true, netAmount: true, commissionAmount: true },
            _count: { _all: true },
            // No DB `take`: rank by the displayed volume (net + fee), which groupBy
            // can't ORDER BY. Fetch all in-window company groups and sort + slice
            // below, so a fee-heavy company isn't dropped by a net-only top-N.
            orderBy: { _sum: { netAmount: 'desc' } },
          });
          const companyIds = rows.map((r) => r.companyId);
          const companies = companyIds.length
            ? await tx.company.findMany({ where: { id: { in: companyIds } } })
            : [];
          const nameById = new Map(companies.map((c) => [c.id, c.name]));
          const mappedCompanies = rows.map((r) => ({
            companyId: r.companyId,
            companyName: nameById.get(r.companyId) ?? r.companyId.slice(0, 8),
            // net + fee (money moved), consistent with totalVolume.
            volume: Money.of((r._sum.netAmount ?? 0).toString())
              .add(Money.of((r._sum.commissionAmount ?? 0).toString()))
              .toString(),
            count: r._count._all,
          }));
          mappedCompanies.sort((a, b) => Money.of(b.volume).cmp(Money.of(a.volume)));
          topCompanies = mappedCompanies.slice(0, TOP_LIMIT);
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
  completed: { _sum: { netAmount?: { toString(): string } | null }; _count: { _all: number } },
  completedFees: string,
  pending: { _sum: { netAmount?: { toString(): string } | null }; _count: { _all: number } },
  pendingFees: string,
): VolumeMetric {
  // Total = net + fee (the money that actually moved). Equals `amount` for
  // DEDUCTED fees; for ON_TOP the fee is on top, so summing net + fee is the
  // only figure that's correct for both — and it keeps gross = net + fee.
  const cNet = Money.of((completed._sum.netAmount ?? 0).toString());
  const cFee = Money.of(completedFees);
  const pNet = Money.of((pending._sum.netAmount ?? 0).toString());
  const pFee = Money.of(pendingFees);
  return {
    completedTotal: cNet.add(cFee).toString(),
    completedNet: cNet.toString(),
    completedFees: cFee.toString(),
    completedCount: completed._count._all,
    pendingTotal: pNet.add(pFee).toString(),
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
