import { Injectable } from '@nestjs/common';
import {
  bucketKey,
  eachBucketStartUtc,
  Money,
  sqlTruncUnit,
  type AnalyticsRange,
  type BucketGranularity,
  type OverviewResponse,
  type SourceOverviewResponse,
  type VolumeMetric,
  type WalletSummaryResponse,
} from '@app/shared';
import { PrismaService } from '../../database/prisma.service';
import { CacheService } from '../cache/cache.service';
import { LedgerService } from '../ledger/ledger.service';
import {
  ALL_TIME_STATEMENT_TIMEOUT,
  ALL_TIME_TX_TIMEOUT_MS,
  originForOverviewScope,
  originForSource,
  resolveWindow,
  type OriginDeps,
  type AnalyticsWindow,
} from './range';
import { REVENUE_ACCOUNTS, revenueTotals, type RevenueAccount } from './ledger-revenue';
import { sourceFeeForSource } from './source-fees';

const DEFAULT_CURRENCY = 'USD';
const TOP_LIMIT = 5;

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: CacheService,
    private readonly ledger: LedgerService,
  ) {}

  /** The two dependencies the origin helpers need, without widening their access. */
  private get originDeps(): OriginDeps {
    return { prisma: this.prisma, cache: this.cache };
  }

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
    const origin =
      args.range.preset === 'all'
        ? await originForOverviewScope(this.originDeps, args.scope, args.range.companyId)
        : null;
    const window = resolveWindow(args.range, origin);

    const scopeKey =
      args.scope === 'admin'
        ? `admin:${args.range.companyId ?? 'all'}`
        : `co:${args.scope.companyId}`;
    // Versioned because the payload shape changes between releases: `v2` added
    // `daily.granularity`, `v3` the network-fee figures (completedNetworkFees,
    // kpi.totalNetworkFees), `v4` networkFees on the daily buckets and the
    // by-source rows. Without a bump a post-deploy read could serve a
    // pre-deploy entry missing them for a whole TTL.
    // The granularity is in the key too — it is derivable from the window today,
    // but that stops being true the moment the thresholds are ever retuned.
    const cacheKey = `analytics:overview:v4:${scopeKey}:${currency}:${window.from.toISOString()}:${window.to.toISOString()}:${window.granularity}`;

    return this.cache.wrap(cacheKey, 60, () => this.compute({ args, currency, window }));
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
          _sum: { netAmount: true, commissionAmount: true, networkFeeAmount: true },
        }),
        tx.load.aggregate({
          where: { ...base, status: 'COMPLETED' },
          _sum: { netAmount: true, feeAmount: true, networkFeeAmount: true },
        }),
        tx.withdrawal.aggregate({
          where: { ...base, status: { in: [...ACTIVE] } },
          _sum: { netAmount: true, feeAmount: true, networkFeeAmount: true },
        }),
        tx.payout.aggregate({
          where: { ...base, status: { in: [...ACTIVE] } },
          _sum: { netAmount: true, feeAmount: true, networkFeeAmount: true },
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
      // Deposits gross = net + fee + network fee, matching loads.gross — so
      // gross - net is the (unshown) fees on both in-flow rows. Transactions
      // carry the fee in commissionAmount. (Summing `amount` would be net for an
      // ON_TOP deposit.)
      const depGross = depNet
        .add(m(deposits._sum.commissionAmount))
        .add(m(deposits._sum.networkFeeAmount));
      const loadNet = m(loads._sum.netAmount);
      const loadGross = loadNet.add(m(loads._sum.feeAmount)).add(m(loads._sum.networkFeeAmount));
      // What left the wallet: net + both fees (the reserved total, either fee
      // application) — so the identity above still holds with a network fee.
      const wdTotal = m(withdrawals._sum.netAmount)
        .add(m(withdrawals._sum.feeAmount))
        .add(m(withdrawals._sum.networkFeeAmount));
      const poTotal = m(payouts._sum.netAmount)
        .add(m(payouts._sum.feeAmount))
        .add(m(payouts._sum.networkFeeAmount));
      return {
        currency,
        deposits: { gross: depGross.toString(), net: depNet.toString() },
        loads: { gross: loadGross.toString(), net: loadNet.toString() },
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
    const origin =
      args.range.preset === 'all' ? await originForSource(this.originDeps, args.sourceId) : null;
    const window = resolveWindow(args.range, origin);

    // v4: daily buckets and by-company rows gained networkFees (v3: the KPI
    // gained totalNetworkFees).
    const cacheKey = `analytics:source-overview:v4:${args.sourceId}:${currency}:${window.from.toISOString()}:${window.to.toISOString()}:${window.granularity}`;
    return this.cache.wrap(cacheKey, 60, () =>
      this.computeSource({ sourceId: args.sourceId, currency, window }),
    );
  }

  private async computeSource(p: {
    sourceId: string;
    currency: string;
    window: AnalyticsWindow;
  }): Promise<SourceOverviewResponse> {
    const { from, to, granularity } = p.window;
    return this.prisma.runAsAdmin(
      async (tx) => {
        if (p.window.isAllTime) {
          await tx.$executeRawUnsafe(
            `SET LOCAL statement_timeout = '${ALL_TIME_STATEMENT_TIMEOUT}'`,
          );
        }
        const source = await tx.source.findUnique({ where: { id: p.sourceId } });

        const where = {
          status: 'COMPLETED' as const,
          currency: p.currency,
          sourceId: p.sourceId,
          createdAt: { gte: from, lte: to },
        };

        const agg = await tx.transaction.aggregate({
          where,
          _sum: { amount: true, netAmount: true, commissionAmount: true, networkFeeAmount: true },
          _count: { _all: true },
        });

        const dailyRows = await tx.$queryRawUnsafe<
          Array<{ day: Date; volume: string; fees: string; networkFees: string; count: bigint }>
        >(
          `
        SELECT
          date_trunc($5::text, created_at AT TIME ZONE 'UTC')::date AS day,
          SUM(net_amount + commission_amount + network_fee_amount)::text AS volume,
          SUM(commission_amount)::text                 AS fees,
          SUM(network_fee_amount)::text                AS "networkFees",
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
          from,
          to,
          sqlTruncUnit(granularity),
        );
        const buckets = fillBucketGaps(from, to, granularity, dailyRows);

        // Top companies by volume for this source. Capped so the payload can't grow
        // unbounded with tenant count on a high-fan-out source (a source used by tens
        // of thousands of companies would otherwise return one row each). 500 is far
        // beyond what the drilldown table meaningfully shows; raise if ever needed.
        const SOURCE_COMPANY_CAP = 500;
        const companyRows = await tx.transaction.groupBy({
          by: ['companyId'],
          where,
          _sum: { amount: true, netAmount: true, commissionAmount: true, networkFeeAmount: true },
          _count: { _all: true },
          orderBy: { _sum: { amount: 'desc' } },
          take: SOURCE_COMPANY_CAP,
        });
        const companyIds = companyRows.map((r) => r.companyId);
        const companies = companyIds.length
          ? await tx.company.findMany({ where: { id: { in: companyIds } } })
          : [];
        const nameById = new Map(companies.map((c) => [c.id, c.name]));
        const byCompany = companyRows.map((r) => ({
          companyId: r.companyId,
          companyName: nameById.get(r.companyId) ?? r.companyId.slice(0, 8),
          // net + fee + network fee (money moved), consistent with the
          // platform/volume surfaces.
          volume: Money.of((r._sum.netAmount ?? 0).toString())
            .add(Money.of((r._sum.commissionAmount ?? 0).toString()))
            .add(Money.of((r._sum.networkFeeAmount ?? 0).toString()))
            .toString(),
          fees: Money.of((r._sum.commissionAmount ?? 0).toString()).toString(),
          networkFees: Money.of((r._sum.networkFeeAmount ?? 0).toString()).toString(),
          count: r._count._all,
        }));

        // What this source charged THE PLATFORM on its deposits (cost of funds).
        // Admin-only endpoint — never surfaced to companies.
        const sourceFees = await sourceFeeForSource(tx, p.sourceId, p.currency, from, to);
        // Volume = net + fee + network fee (money moved), shared by the KPI total
        // and the average below so the two can never disagree.
        const sourceVolume = Money.of((agg._sum.netAmount ?? 0).toString())
          .add(Money.of((agg._sum.commissionAmount ?? 0).toString()))
          .add(Money.of((agg._sum.networkFeeAmount ?? 0).toString()));

        return {
          range: { from: from.toISOString(), to: to.toISOString() },
          currency: p.currency,
          source: {
            id: p.sourceId,
            code: source?.code ?? '',
            name: source?.name ?? p.sourceId.slice(0, 8),
          },
          sourceFees,
          kpi: {
            // Volume = net + fee + network fee (money moved), consistent with the
            // daily series, the by-company rows, and every other volume surface.
            // NOT SUM(amount) — for an ON_TOP deposit `amount` is the net, so it
            // would drop the fees and disagree with the rest of this very page.
            totalVolume: sourceVolume.toString(),
            totalFees: Money.of((agg._sum.commissionAmount ?? 0).toString()).toString(),
            totalNetworkFees: Money.of((agg._sum.networkFeeAmount ?? 0).toString()).toString(),
            transactionCount: agg._count._all,
            // Average = volume ÷ count (the volume shown on this same card), not
            // avg(amount): for an ON_TOP fee `amount` is the net, so avg(amount)
            // wouldn't tie out with the volume beside it.
            averageAmount: agg._count._all > 0 ? sourceVolume.div(agg._count._all).toString() : '0',
            currency: p.currency,
          },
          daily: { currency: p.currency, granularity, buckets },
          byCompany,
        };
      },
      p.window.isAllTime ? { timeout: ALL_TIME_TX_TIMEOUT_MS } : undefined,
    );
  }

  private async compute(p: {
    args: { scope: 'admin' | { companyId: string }; range: AnalyticsRange };
    currency: string;
    window: AnalyticsWindow;
  }): Promise<OverviewResponse> {
    const companyFilter =
      p.args.scope === 'admin' ? p.args.range.companyId : p.args.scope.companyId;
    const { from, to, granularity } = p.window;

    return this.prisma.runAsScoped(
      p.args.scope === 'admin' ? null : p.args.scope.companyId,
      async (tx) => {
        if (p.window.isAllTime) {
          await tx.$executeRawUnsafe(
            `SET LOCAL statement_timeout = '${ALL_TIME_STATEMENT_TIMEOUT}'`,
          );
        }
        // KPI aggregate
        const agg = await tx.transaction.aggregate({
          where: {
            status: 'COMPLETED',
            currency: p.currency,
            createdAt: { gte: from, lte: to },
            ...(companyFilter ? { companyId: companyFilter } : {}),
          },
          _sum: { amount: true, netAmount: true, commissionAmount: true, networkFeeAmount: true },
          _count: { _all: true },
        });

        // Volume = net + fee + network fee (the money that moved). Equals
        // `amount` for DEDUCTED fees; for ON_TOP the fees are on top, so this sum
        // is the figure that matches the Deposits card, the daily chart, and
        // platform volumeIn.
        const totalVolume = Money.of((agg._sum.netAmount ?? 0).toString())
          .add(Money.of((agg._sum.commissionAmount ?? 0).toString()))
          .add(Money.of((agg._sum.networkFeeAmount ?? 0).toString()))
          .toString();
        // Total platform fees = realized fees from EVERY flow (transactions,
        // loads, withdrawals, payouts), read from the FEE ledger account — not
        // just transaction commission. Scoped to the same company/currency/
        // window as the KPI aggregate. (Per-source fees below stay
        // transaction-based, since sources only ever carry transactions.)
        //
        // Network-fee revenue comes from its own ledger account (NETWORK_FEE), so
        // the FEE figure keeps its meaning. It is admin-only like totalFees, so a
        // company-scoped caller's query does not read that account at all. One
        // statement for both accounts — see ledger-revenue.ts.
        const isAdminScope = p.args.scope === 'admin';
        const revenue = await revenueTotals<RevenueAccount>(tx, {
          currency: p.currency,
          from,
          to,
          companyId: companyFilter,
          accounts: isAdminScope ? REVENUE_ACCOUNTS : ['FEE'],
        });
        const totalFees = revenue.FEE;
        const totalNetworkFees: string | undefined = isAdminScope ? revenue.NETWORK_FEE : undefined;
        const transactionCount = agg._count._all;
        // Average ties to the volume on the same card (volume ÷ count), not
        // avg(amount): for an ON_TOP fee `amount` is the net, so avg(amount)
        // would disagree with the net+fee volume headline.
        const averageAmount =
          transactionCount > 0 ? Money.of(totalVolume).div(transactionCount).toString() : '0';

        // Volume broken out by operation type: deposits (source ingestion),
        // withdrawals, loads, payouts. Each splits settled (COMPLETED) money
        // from what's still in-flight (awaiting approval / processing) so the
        // company sees both what moved and what's pending. Same currency /
        // company / date window as the KPI aggregate above.
        const baseWhere = {
          currency: p.currency,
          createdAt: { gte: from, lte: to },
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
          processedAt: { gte: from, lte: to },
          ...(companyFilter ? { companyId: companyFilter } : {}),
        };
        // Sum net + fee + network fee (not `amount`) for every group. The card
        // TOTAL is the money that actually moved: for DEDUCTED fees that equals
        // `amount`, but for ON_TOP fees they are charged on top, so `amount`
        // alone (= net) understates the real total. Withdrawals/payouts/loads
        // carry feeAmount; transactions carry commissionAmount; all four carry
        // networkFeeAmount.
        const flowSums = {
          _sum: { netAmount: true, feeAmount: true, networkFeeAmount: true },
          _count: { _all: true },
        } as const;
        const txSums = {
          _sum: { netAmount: true, commissionAmount: true, networkFeeAmount: true },
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

        // Fees summed per group: transactions = commissionAmount, the money
        // in/out flows = feeAmount; every group carries networkFeeAmount.
        const sumOf = (v: { toString(): string } | null | undefined) =>
          Money.of((v ?? 0).toString()).toString();
        // Every summed key is REQUIRED on purpose: an aggregate that forgets to
        // select one fails to compile instead of silently counting it as 0.
        const flowFees = (m: {
          _sum: {
            feeAmount: { toString(): string } | null;
            networkFeeAmount: { toString(): string } | null;
          };
        }) => ({ fee: sumOf(m._sum.feeAmount), network: sumOf(m._sum.networkFeeAmount) });
        const txFees = (m: {
          _sum: {
            commissionAmount: { toString(): string } | null;
            networkFeeAmount: { toString(): string } | null;
          };
        }) => ({ fee: sumOf(m._sum.commissionAmount), network: sumOf(m._sum.networkFeeAmount) });
        const volume = {
          deposits: toVolumeMetric(agg, txFees(agg), depositsPending, txFees(depositsPending)),
          withdrawals: toVolumeMetric(
            withdrawalsDone,
            flowFees(withdrawalsDone),
            withdrawalsPending,
            flowFees(withdrawalsPending),
          ),
          loads: toVolumeMetric(
            loadsDone,
            flowFees(loadsDone),
            loadsPending,
            flowFees(loadsPending),
          ),
          payouts: toVolumeMetric(
            payoutsDone,
            flowFees(payoutsDone),
            payoutsPending,
            flowFees(payoutsPending),
          ),
        };

        // Time buckets via raw SQL: groupBy doesn't support date_trunc directly.
        // The trunc unit is BOUND, not interpolated (see the fillBucketGaps
        // docblock for why the UTC cast matters). Its position shifts with the
        // optional company filter, so the index is computed rather than fixed.
        const truncParam = companyFilter ? 5 : 4;
        const dailyRows = await tx.$queryRawUnsafe<
          Array<{ day: Date; volume: string; fees: string; networkFees: string; count: bigint }>
        >(
          `
        SELECT
          date_trunc($${truncParam}::text, created_at AT TIME ZONE 'UTC')::date AS day,
          SUM(net_amount + commission_amount + network_fee_amount)::text AS volume,
          SUM(commission_amount)::text                 AS fees,
          SUM(network_fee_amount)::text                AS "networkFees",
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
          from,
          to,
          ...(companyFilter ? [companyFilter] : []),
          sqlTruncUnit(granularity),
        );

        const buckets = fillBucketGaps(from, to, granularity, dailyRows);

        // Sources by volume — include fees so dashboards can show
        // "by OMT: $X volume, $Y fees" / "by wish: ..." breakdowns. When
        // scoped to a single company (drilldown), return ALL of its sources;
        // the platform-wide view stays capped to the top few.
        // Sources ranked by DISPLAYED volume (net + fee), which Prisma groupBy
        // can't ORDER BY (it sorts a single aggregated field, not net+fee), so we
        // do it in raw SQL and LIMIT at the DB. The platform-wide view caps to the
        // top few; a single-company drilldown (companyFilter set) returns ALL of
        // its sources, so no LIMIT there. Bounding the LIMIT also keeps the
        // source.findMany IN-list small on the platform path.
        const topSrcRows = await tx.$queryRawUnsafe<
          Array<{
            sourceId: string;
            volume: string;
            fees: string;
            networkFees: string;
            count: bigint;
          }>
        >(
          `
          SELECT
            source_id                                    AS "sourceId",
            SUM(net_amount + commission_amount + network_fee_amount)::text AS volume,
            SUM(commission_amount)::text                 AS fees,
            SUM(network_fee_amount)::text                AS "networkFees",
            COUNT(*)::bigint                             AS count
          FROM transactions
          WHERE status = 'COMPLETED'
            AND currency = $1
            AND created_at >= $2
            AND created_at <= $3
            ${companyFilter ? 'AND company_id = $4::uuid' : ''}
          GROUP BY source_id
          ORDER BY SUM(net_amount + commission_amount + network_fee_amount) DESC
          ${companyFilter ? '' : `LIMIT ${TOP_LIMIT}`}
          `,
          p.currency,
          from,
          to,
          ...(companyFilter ? [companyFilter] : []),
        );
        const sourceIds = topSrcRows.map((r) => r.sourceId);
        const sources = sourceIds.length
          ? await tx.source.findMany({ where: { id: { in: sourceIds } } })
          : [];
        const sourceCode = new Map(sources.map((s) => [s.id, s.code]));
        const topSources = topSrcRows.map((r) => ({
          sourceId: r.sourceId,
          sourceCode: sourceCode.get(r.sourceId) ?? '',
          // net + fee + network fee (money moved), matching totalVolume and the
          // deposit card.
          volume: Money.of(r.volume ?? '0').toString(),
          fees: Money.of(r.fees ?? '0').toString(),
          // The network fee on those same deposits — `volume` already includes it.
          networkFees: Money.of(r.networkFees ?? '0').toString(),
          count: Number(r.count),
        }));

        // Top companies — admin scope only.
        let topCompanies:
          | { companyId: string; companyName: string; volume: string; count: number }[]
          | undefined;
        if (p.args.scope === 'admin' && !companyFilter) {
          // Rank by DISPLAYED volume (net + fee), which Prisma groupBy can't
          // ORDER BY, and LIMIT at the DB so the company.findMany IN-list stays
          // bounded (this branch has no companyFilter — without a LIMIT the group
          // count grows with the whole tenant table). A fee-heavy company isn't
          // dropped because we order by net+fee, not net alone.
          const rows = await tx.$queryRawUnsafe<
            Array<{ companyId: string; volume: string; count: bigint }>
          >(
            `
            SELECT
              company_id                                   AS "companyId",
              SUM(net_amount + commission_amount + network_fee_amount)::text AS volume,
              COUNT(*)::bigint                             AS count
            FROM transactions
            WHERE status = 'COMPLETED'
              AND currency = $1
              AND created_at >= $2
              AND created_at <= $3
            GROUP BY company_id
            ORDER BY SUM(net_amount + commission_amount + network_fee_amount) DESC
            LIMIT ${TOP_LIMIT}
            `,
            p.currency,
            from,
            to,
          );
          const companyIds = rows.map((r) => r.companyId);
          const companies = companyIds.length
            ? await tx.company.findMany({ where: { id: { in: companyIds } } })
            : [];
          const nameById = new Map(companies.map((c) => [c.id, c.name]));
          topCompanies = rows.map((r) => ({
            companyId: r.companyId,
            companyName: nameById.get(r.companyId) ?? r.companyId.slice(0, 8),
            // net + fee (money moved), consistent with totalVolume.
            volume: Money.of(r.volume ?? '0').toString(),
            count: Number(r.count),
          }));
        }

        return {
          range: { from: from.toISOString(), to: to.toISOString() },
          currency: p.currency,
          kpi: {
            totalVolume,
            // Company-scoped callers never receive the aggregate fee — they only
            // see per-transaction fees. Admins (scope === 'admin', incl. when
            // drilling into one company) get the total.
            ...(p.args.scope === 'admin' ? { totalFees, totalNetworkFees } : {}),
            transactionCount,
            averageAmount,
            currency: p.currency,
          },
          volume,
          daily: { currency: p.currency, granularity, buckets },
          topSources,
          ...(topCompanies ? { topCompanies } : {}),
        };
      },
      p.window.isAllTime ? { timeout: ALL_TIME_TX_TIMEOUT_MS } : undefined,
    );
  }
}

// Shape a (completed, pending) pair of Prisma aggregate results into the
// VolumeMetric the dashboard consumes. Amounts become Decimal strings.
function toVolumeMetric(
  completed: { _sum: { netAmount: { toString(): string } | null }; _count: { _all: number } },
  completedFees: { fee: string; network: string },
  pending: { _sum: { netAmount: { toString(): string } | null }; _count: { _all: number } },
  pendingFees: { fee: string; network: string },
): VolumeMetric {
  // Total = net + fee + network fee (the money that actually moved). Equals
  // `amount` for DEDUCTED fees; for ON_TOP the fees are on top, so summing the
  // parts is the only figure that's correct for both — and it keeps
  // gross = net + fee + network fee.
  const cNet = Money.of((completed._sum.netAmount ?? 0).toString());
  const cFee = Money.of(completedFees.fee);
  const cNetwork = Money.of(completedFees.network);
  const pNet = Money.of((pending._sum.netAmount ?? 0).toString());
  const pFee = Money.of(pendingFees.fee);
  const pNetwork = Money.of(pendingFees.network);
  return {
    completedTotal: cNet.add(cFee).add(cNetwork).toString(),
    completedNet: cNet.toString(),
    completedFees: cFee.toString(),
    completedNetworkFees: cNetwork.toString(),
    completedCount: completed._count._all,
    pendingTotal: pNet.add(pFee).add(pNetwork).toString(),
    pendingCount: pending._count._all,
  };
}

/**
 * Emit one row per bucket across the whole window, zero-filling the buckets the
 * query returned nothing for, so a chart never has to reason about gaps.
 *
 * Both this walker and the SQL must agree on where a bucket starts. The SQL
 * truncates `created_at AT TIME ZONE 'UTC'` and this walks in UTC, so they line
 * up regardless of the Postgres session TimeZone (which this repo never pins).
 * Without that cast a non-UTC server would shift every week/month bucket
 * against these keys and each one would come back empty.
 */
function fillBucketGaps(
  from: Date,
  to: Date,
  granularity: BucketGranularity,
  rows: Array<{ day: Date; volume: string; fees: string; networkFees: string; count: bigint }>,
): Array<{ date: string; volume: string; fees: string; networkFees: string; count: number }> {
  const byBucket = new Map<
    string,
    { volume: string; fees: string; networkFees: string; count: number }
  >();
  for (const r of rows) {
    byBucket.set(bucketKey(r.day), {
      volume: r.volume ?? '0',
      fees: r.fees ?? '0',
      networkFees: r.networkFees ?? '0',
      count: Number(r.count),
    });
  }
  return eachBucketStartUtc(from, to, granularity).map((start) => {
    const key = bucketKey(start);
    return {
      date: key,
      volume: byBucket.get(key)?.volume ?? '0',
      fees: byBucket.get(key)?.fees ?? '0',
      networkFees: byBucket.get(key)?.networkFees ?? '0',
      count: byBucket.get(key)?.count ?? 0,
    };
  });
}
