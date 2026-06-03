import { Injectable, Logger } from '@nestjs/common';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import type { Counter } from 'prom-client';
import {
  Money,
  type FeeApplication,
  type IngestCompanyListItem,
  type IngestTransactionInput,
  type ListTransactionsQuery,
  type PaginatedResponse,
  type TransactionResponse,
} from '@app/shared';
import type { Prisma, PrismaClient } from '@app/db';
import { PrismaService } from '../../database/prisma.service';
import { CommissionResolverService } from '../commissions/commission-resolver.service';
import { CommissionsRepository } from '../commissions/commissions.repository';
import { LedgerService } from '../ledger/ledger.service';
import { WalletsService } from '../wallets/wallets.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { RealtimeService } from '../realtime/realtime.service';
import { CacheService } from '../cache/cache.service';
import {
  ConflictError,
  ForbiddenError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain.error';

// The per-tenant list COUNT is cached briefly so paging reuses it and a whale
// tenant's COUNT(*) doesn't re-run on every page load. The total can lag by up
// to this window; the rows themselves are always live. Deliberately NOT
// invalidated on mutation — the short TTL is the tradeoff that avoids per-write
// cache churn.
const LIST_COUNT_CACHE_TTL_SEC = 30;

// CSV export walks rows in keyset chunks (no single huge query), up to a cap
// that keeps the in-memory CSV string bounded. Stream from the controller if a
// larger export is ever needed.
const CSV_EXPORT_CHUNK = 1000;
const MAX_EXPORT_ROWS = 50_000;

// Offset pagination makes Postgres scan + discard every skipped row, so a very
// deep page (e.g. page 50,000) turns into a half-million-row disk sort per
// request. No human pages that deep through the UI — they filter by date/source
// or export — so we cap the reachable offset and tell the caller to narrow the
// query instead of silently serving a slow scan. Generous enough that no real
// browsing hits it (100k rows at pageSize 100 = page 1,000).
const MAX_LIST_OFFSET = 100_000;

@Injectable()
export class TransactionsService {
  private readonly logger = new Logger(TransactionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: CommissionResolverService,
    private readonly commissionsRepo: CommissionsRepository,
    private readonly ledger: LedgerService,
    private readonly wallets: WalletsService,
    private readonly analytics: AnalyticsService,
    private readonly realtime: RealtimeService,
    @InjectMetric('txn_ingest_total') private readonly ingestCounter: Counter<string>,
    private readonly cache: CacheService,
  ) {}

  /**
   * Public list of companies for source providers to discover slugs.
   * Called by Wish/OMT/etc on startup so they can cache slugs and then
   * post transactions against them. Returns every ACTIVE + visible company —
   * the superadmin's `visible` flag is the single switch that exposes a company
   * to sources (there is no per-source opt-in). Only the fields a third-party
   * integrator needs to know are returned.
   *
   * Guarded by `ApiKeyAuthGuard` + source-key check in the controller;
   * the service itself is unauthenticated for testability.
   */
  async listVisibleCompanies(): Promise<{ data: IngestCompanyListItem[] }> {
    const rows = await this.prisma.runAsAdmin((tx) =>
      tx.company.findMany({
        where: {
          status: 'ACTIVE',
          visible: true,
        },
        orderBy: { slug: 'asc' },
        select: { id: true, slug: true, name: true, defaultCurrency: true },
      }),
    );
    return {
      data: rows.map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.name,
        defaultCurrency: r.defaultCurrency.trim(),
      })),
    };
  }

  /**
   * Ingest a transaction posted by an external source provider.
   *
   * Atomic, inside one serializable DB transaction:
   *   1. Resolve source by id (from the API key) and target company by slug (from body)
   *   2. Honour idempotency (explicit key OR natural (source, externalId) pair)
   *   3. Resolve the matching commission rule
   *   4. Insert the `transactions` row with status = COMPLETED
   *   5. Write balanced ledger entries (DEBIT EXTERNAL, CREDIT AVAILABLE, CREDIT FEE)
   *   6. Apply the wallet delta (available += netAmount)
   *   7. Invalidate analytics cache
   */
  async ingest(
    ctx: { kind: 'source'; sourceId: string },
    input: IngestTransactionInput,
  ): Promise<TransactionResponse> {
    const amount = Money.of(input.amount);
    // Reject not just non-positive but also sub-unit amounts that round to 0 at
    // the 8dp money scale (they would pass isPositive() yet violate the DB
    // amount>0 CHECK and surface as a 500).
    if (!amount.round().isPositive()) {
      throw new ValidationError('amount must be positive at up to 8 decimal places');
    }

    const [foundSource, company] = await this.prisma.runAsAdmin((tx) =>
      Promise.all([
        tx.source.findUnique({ where: { id: ctx.sourceId } }),
        tx.company.findUnique({ where: { id: input.companyId } }),
      ]),
    );
    if (!foundSource || foundSource.status !== 'ACTIVE') {
      throw new ValidationError('source not found or inactive');
    }
    if (!company || company.status !== 'ACTIVE') {
      throw new ValidationError(`company '${input.companyId}' not found or inactive`);
    }
    // Any ACTIVE source may post to any ACTIVE company the superadmin has made
    // `visible` — that flag is the single gate exposing a company to sources
    // (there is no per-source opt-in). A hidden company is off-limits to every
    // source, for both discovery and ingestion.
    if (!company.visible) {
      throw new ForbiddenError(`company '${input.companyId}' is not available to sources`);
    }
    const companyId = company.id;
    const source: { id: string; code: string; status: string } = foundSource;

    // Run the whole financial mutation scoped to the target company, so RLS
    // WITH CHECK validates that every row written (transaction, ledger, wallet)
    // belongs to `companyId` — a bug can't mis-book into another tenant.
    const { result, replayed } = await this.prisma.runSerializableAsTenant(
      companyId,
      async (tx) => {
        const cTx = tx as unknown as PrismaClient;

        // ---- idempotency: explicit key OR natural (source,external) pair ----
        if (input.idempotencyKey) {
          const existing = await cTx.transaction.findFirst({
            where: { companyId, idempotencyKey: input.idempotencyKey },
          });
          if (existing) {
            return { result: await this.mapTransaction(cTx, existing), replayed: true };
          }
        }
        // Natural idempotency: a repeat of the same (source, externalId) for this
        // company replays the existing row. The (source, externalId) unique index
        // is global, so a *different* company reusing the same pair is rejected by
        // that constraint on insert (surfaced as a 409) — it can't be observed
        // here under tenant scope, so there's nothing to second-guess.
        const dup = await cTx.transaction.findFirst({
          where: { sourceId: source.id, externalTransactionId: input.externalTransactionId },
        });
        if (dup) {
          return { result: await this.mapTransaction(cTx, dup), replayed: true };
        }

        // ---- commission ----
        const rules = await this.commissionsRepo.loadCandidates(cTx, {
          companyId,
          sourceId: source.id,
          operationType: 'TRANSACTION',
        });
        const resolution = this.resolver.resolve({
          companyId,
          sourceId: source.id,
          operationType: 'TRANSACTION',
          amount,
          rules,
        });

        // Honour the rule's fee application (mirrors loads.approve):
        //   DEDUCTED: external = amount,       company credited amount − fee
        //   ON_TOP:   external = amount + fee, company credited the full amount
        // `availableCredit` is the persisted netAmount (what the wallet receives).
        const fee = resolution.commissionAmount;
        const { externalDebit, availableCredit } = ingestSplit(
          amount,
          fee,
          resolution.feeApplication,
        );

        // ---- insert transaction row ----
        const txRow = await cTx.transaction.create({
          data: {
            companyId,
            sourceId: source.id,
            externalTransactionId: input.externalTransactionId,
            amount: amount.toString(),
            currency: input.currency,
            commissionAmount: fee.toString(),
            netAmount: availableCredit.toString(),
            status: 'COMPLETED',
            payload: (input.payload ?? {}) as Prisma.InputJsonValue,
            idempotencyKey: input.idempotencyKey ?? null,
            processedAt: new Date(),
          },
        });

        // ---- ledger: balanced double-entry ----
        // DEBIT  EXTERNAL  externalDebit   (the outside world owes us this)
        // CREDIT AVAILABLE availableCredit (company's spendable balance grows) [skip if 0]
        // CREDIT FEE       fee             (platform fee revenue)              [skip if 0]
        const ledgerLines: import('../ledger/ledger.service').LedgerEntryInput[] = [
          {
            companyId,
            transactionId: txRow.id,
            accountType: 'EXTERNAL',
            direction: 'DEBIT',
            amount: externalDebit,
            currency: input.currency,
          },
        ];
        if (availableCredit.isPositive()) {
          ledgerLines.push({
            companyId,
            transactionId: txRow.id,
            accountType: 'AVAILABLE',
            direction: 'CREDIT',
            amount: availableCredit,
            currency: input.currency,
          });
        }
        if (fee.isPositive()) {
          ledgerLines.push({
            companyId,
            transactionId: txRow.id,
            accountType: 'FEE',
            direction: 'CREDIT',
            amount: fee,
            currency: input.currency,
          });
        }
        await this.ledger.writeEntries(cTx, ledgerLines);

        // ---- wallet delta (only if the company is credited something) ----
        if (availableCredit.isPositive()) {
          await this.wallets.applyDelta(cTx, {
            companyId,
            currency: input.currency,
            delta: { available: availableCredit },
          });
        }

        this.logger.log(
          `ingest tx=${txRow.id} co=${companyId} src=${source.code} ` +
            `amount=${amount.toString()} fee=${fee.toString()} ` +
            `net=${availableCredit.toString()} app=${resolution.feeApplication} ${input.currency}`,
        );

        return { result: await this.mapTransaction(cTx, txRow), replayed: false };
      },
    );

    // An idempotent replay (explicit key or natural (source,externalId) pair)
    // books NO new money — the ledger/wallet writes were skipped above — so it
    // must not bump the ingest counter, churn the analytics cache, or push a
    // realtime refresh. Only a genuinely new transaction triggers the side effects.
    if (!replayed) {
      this.ingestCounter.inc({ source_code: source.code, currency: input.currency });

      // Refresh ALL analytics (company + admin/platform) BEFORE announcing the
      // change, so every dashboard's realtime refetch reads fresh data, not a
      // warm cache. Awaited so the emit below can't race the invalidation.
      await this.analytics
        .invalidateAll()
        .catch((e) => this.logger.warn(`analytics cache invalidate failed: ${e}`));

      this.realtime.company(companyId, ['transactions', 'wallets', 'ledger', 'analytics']);
    }

    return result;
  }

  /**
   * Reverse a COMPLETED transaction. Writes compensating ledger entries
   * (mirror of the original) and claws the credited funds back from available.
   * If the company has already spent/withdrawn some of the credit, the part
   * that available can't cover is booked to the RECEIVABLE account as a debt
   * the company owes the platform — so a reversal is ALWAYS recordable and the
   * loss can never silently sit on the books as a stuck COMPLETED row.
   *
   * Idempotent: a tx already in REVERSED state returns its current row.
   */
  async reverse(
    txId: string,
    args: { actorId: string; reason: string },
  ): Promise<TransactionResponse> {
    // Admin action: look up the owning company first, then run the mutation
    // scoped to it so RLS WITH CHECK validates every compensating write.
    const pre = await this.prisma.runAsAdmin((tx) =>
      tx.transaction.findUnique({ where: { id: txId }, select: { companyId: true } }),
    );
    if (!pre) throw new NotFoundError('Transaction', txId);
    const reversed = await this.prisma.runSerializableAsTenant(pre.companyId, async (tx) => {
      const cTx = tx as unknown as PrismaClient;

      const orig = await cTx.transaction.findUnique({
        where: { id: txId },
        include: { source: { select: { code: true } } },
      });
      if (!orig) throw new NotFoundError('Transaction', txId);
      if (orig.status === 'REVERSED') {
        return orig;
      }
      if (orig.status !== 'COMPLETED') {
        throw new ConflictError(`Transaction is in status ${orig.status} and cannot be reversed`);
      }

      const fee = Money.of(orig.commissionAmount.toString());
      const net = Money.of(orig.netAmount.toString());
      // The original EXTERNAL debit was net + fee for BOTH fee applications
      // (DEDUCTED: amount = net + fee; ON_TOP: amount + fee = net + fee), so we
      // can reconstruct it from the stored net/fee without a feeApplication
      // column and keep the reversal balanced in either case.
      const externalAmount = net.add(fee);

      // Claw `net` back from available; whatever available can't cover becomes a
      // RECEIVABLE (a debt the company owes). This keeps available >= 0 and the
      // ledger balanced whether or not the funds were already withdrawn.
      const walletRow = await cTx.wallet.findUnique({
        where: { companyId_currency: { companyId: orig.companyId, currency: orig.currency } },
      });
      const available = Money.of(walletRow?.availableBalance.toString() ?? '0');
      const { fromAvailable, receivable } = splitClawback(net, available);

      // Compensating ledger entries: mirror the original signs.
      // original was: DEBIT EXTERNAL, CREDIT AVAILABLE, CREDIT FEE
      // reversal is:  CREDIT EXTERNAL, DEBIT AVAILABLE (+ DEBIT RECEIVABLE for the
      // uncovered remainder), DEBIT FEE. debits (fromAvailable + receivable + fee)
      // == credit (net + fee), so the set stays balanced.
      const lines: import('../ledger/ledger.service').LedgerEntryInput[] = [
        {
          companyId: orig.companyId,
          transactionId: orig.id,
          accountType: 'EXTERNAL',
          direction: 'CREDIT',
          amount: externalAmount,
          currency: orig.currency,
          metadata: { kind: 'reversal', reason: args.reason },
        },
      ];
      if (fromAvailable.isPositive()) {
        lines.push({
          companyId: orig.companyId,
          transactionId: orig.id,
          accountType: 'AVAILABLE',
          direction: 'DEBIT',
          amount: fromAvailable,
          currency: orig.currency,
          metadata: { kind: 'reversal' },
        });
      }
      if (receivable.isPositive()) {
        lines.push({
          companyId: orig.companyId,
          transactionId: orig.id,
          accountType: 'RECEIVABLE',
          direction: 'DEBIT',
          amount: receivable,
          currency: orig.currency,
          metadata: { kind: 'reversal', shortfall: true },
        });
      }
      if (fee.isPositive()) {
        lines.push({
          companyId: orig.companyId,
          transactionId: orig.id,
          accountType: 'FEE',
          direction: 'DEBIT',
          amount: fee,
          currency: orig.currency,
          metadata: { kind: 'reversal' },
        });
      }
      await this.ledger.writeEntries(cTx, lines);

      // Wallet: subtract only what available could cover (stays >= 0).
      if (fromAvailable.isPositive()) {
        await this.wallets.applyDelta(cTx, {
          companyId: orig.companyId,
          currency: orig.currency,
          delta: { available: fromAvailable.mul(-1) },
        });
      }
      if (receivable.isPositive()) {
        this.logger.warn(
          `reversal of tx=${orig.id} co=${orig.companyId} created RECEIVABLE=${receivable.toString()} ${orig.currency.trim()} (available could not cover full clawback of ${net.toString()})`,
        );
      }

      const updated = await cTx.transaction.update({
        where: { id: orig.id },
        data: { status: 'REVERSED' },
        include: { source: { select: { code: true } } },
      });
      return updated;
    });

    this.logger.log(
      `reversed tx=${reversed.id} co=${reversed.companyId} amount=${reversed.amount.toString()} reason=${args.reason}`,
    );

    // Reversal flips the wallet + ledger — refresh all analytics before emit.
    await this.analytics
      .invalidateAll()
      .catch((e) => this.logger.warn(`analytics cache invalidate failed: ${e}`));

    this.realtime.company(reversed.companyId, ['transactions', 'wallets', 'ledger', 'analytics']);

    return mapTxRow(reversed, (reversed as { source?: { code: string } }).source?.code ?? '');
  }

  /**
   * Export up to MAX_EXPORT_ROWS (50k) transactions matching the filters as a
   * CSV string, walked in keyset chunks. Hard cap to bound memory; users export
   * in
   * date-range slices for larger sets.
   */
  async exportCsv(args: { companyId?: string; query: ListTransactionsQuery }): Promise<string> {
    const header = [
      'id',
      'created_at',
      'company_id',
      'source_code',
      'external_transaction_id',
      'amount',
      'currency',
      'commission_amount',
      'net_amount',
      'status',
      'customer',
      'target',
      'phone',
      'note',
    ];
    const lines = [header.join(',')];

    await this.prisma.runAsScoped(args.companyId ?? null, async (tx) => {
      const where: Prisma.TransactionWhereInput = {};
      if (args.companyId) where.companyId = args.companyId;
      else if (args.query.companyId) where.companyId = args.query.companyId;
      if (args.query.status) where.status = args.query.status;
      if (args.query.sourceId) where.sourceId = args.query.sourceId;
      if (args.query.currency) where.currency = args.query.currency;
      // Mirror the list view's search so an exported CSV contains exactly the
      // filtered rows the user is looking at. (Was previously omitted here, so an
      // export-after-search silently returned rows that didn't match the search.)
      if (args.query.search) {
        where.externalTransactionId = { contains: args.query.search };
      }
      if (args.query.from || args.query.to) {
        where.createdAt = {};
        if (args.query.from) where.createdAt.gte = new Date(args.query.from);
        if (args.query.to) where.createdAt.lte = new Date(args.query.to);
      }

      // Keyset pagination over (createdAt desc, id desc): each chunk fetches the
      // rows strictly "after" the previous chunk's last row, so we never
      // materialize the whole result set in one query and can export past the
      // old 10k cap. Bounded by MAX_EXPORT_ROWS to keep the CSV string sane.
      let cursor: { createdAt: Date; id: string } | null = null;
      while (lines.length <= MAX_EXPORT_ROWS) {
        const pageWhere: Prisma.TransactionWhereInput = cursor
          ? {
              ...where,
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : where;
        const page = await tx.transaction.findMany({
          where: pageWhere,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: CSV_EXPORT_CHUNK,
          include: { source: { select: { code: true } } },
        });
        if (page.length === 0) break;
        for (const r of page) {
          lines.push(
            [
              r.id,
              r.createdAt.toISOString(),
              r.companyId,
              r.source.code,
              csvCell(r.externalTransactionId),
              r.amount.toString(),
              r.currency.trim(),
              r.commissionAmount.toString(),
              r.netAmount.toString(),
              r.status,
              csvCell(payloadString(r.payload, 'customer') ?? ''),
              csvCell(payloadString(r.payload, 'target') ?? ''),
              csvCell(payloadString(r.payload, 'phone') ?? ''),
              csvCell(payloadString(r.payload, 'note') ?? ''),
            ].join(','),
          );
        }
        if (page.length < CSV_EXPORT_CHUNK) break;
        const last = page[page.length - 1]!;
        cursor = { createdAt: last.createdAt, id: last.id };
      }
    });

    return lines.join('\n');
  }

  async list(args: {
    companyId?: string;
    query: ListTransactionsQuery;
  }): Promise<PaginatedResponse<TransactionResponse>> {
    return this.prisma.runAsScoped(args.companyId ?? null, async (tx) => {
      const where: Prisma.TransactionWhereInput = {};
      if (args.companyId) where.companyId = args.companyId;
      else if (args.query.companyId) where.companyId = args.query.companyId;
      if (args.query.status) where.status = args.query.status;
      if (args.query.sourceId) where.sourceId = args.query.sourceId;
      if (args.query.currency) where.currency = args.query.currency;
      if (args.query.from || args.query.to) {
        where.createdAt = {};
        if (args.query.from) where.createdAt.gte = new Date(args.query.from);
        if (args.query.to) where.createdAt.lte = new Date(args.query.to);
      }
      if (args.query.search) {
        where.externalTransactionId = { contains: args.query.search };
      }

      const skip = (args.query.page - 1) * args.query.pageSize;
      if (skip > MAX_LIST_OFFSET) {
        throw new ValidationError(
          `Page too deep to scan efficiently. Narrow the results with filters (date range, status, source) or use Export CSV.`,
        );
      }
      const countKey =
        `list-count:txn:${args.companyId ?? args.query.companyId ?? 'all'}` +
        `:${args.query.status ?? ''}:${args.query.sourceId ?? ''}:${args.query.currency ?? ''}` +
        `:${args.query.from ?? ''}:${args.query.to ?? ''}:${args.query.search ?? ''}`;
      const [rows, total, sources] = await Promise.all([
        tx.transaction.findMany({
          where,
          // createdAt alone isn't a total order; add id so rows with the same
          // timestamp can't shuffle across page boundaries under high ingest.
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip,
          take: args.query.pageSize,
          include: { source: { select: { code: true } } },
        }),
        this.cache.wrap(countKey, LIST_COUNT_CACHE_TTL_SEC, () => tx.transaction.count({ where })),
        tx.source.findMany({ select: { id: true, code: true } }),
      ]);
      const codeBySource = new Map(sources.map((s) => [s.id, s.code]));

      return {
        data: rows.map((r) => mapTxRow(r, codeBySource.get(r.sourceId) ?? '')),
        meta: {
          page: args.query.page,
          pageSize: args.query.pageSize,
          total,
          totalPages: Math.max(1, Math.ceil(total / args.query.pageSize)),
        },
      };
    });
  }

  async getById(id: string, companyId?: string): Promise<TransactionResponse> {
    const row = await this.prisma.runAsScoped(companyId ?? null, (tx) =>
      tx.transaction.findUnique({
        where: { id },
        include: { source: { select: { code: true } } },
      }),
    );
    if (!row) throw new NotFoundError('Transaction', id);
    if (companyId && row.companyId !== companyId) throw new NotFoundError('Transaction', id);
    return mapTxRow(row, row.source.code);
  }

  /**
   * Fetch a transaction plus all its ledger entries. Used by the
   * transaction-detail drawer in the dashboard so users can audit the
   * full double-entry trail without leaving the row.
   */
  async getDetail(id: string, companyId?: string) {
    return this.prisma.runAsScoped(companyId ?? null, async (tx) => {
      const row = await tx.transaction.findUnique({
        where: { id },
        include: { source: { select: { code: true } } },
      });
      if (!row) throw new NotFoundError('Transaction', id);
      if (companyId && row.companyId !== companyId) throw new NotFoundError('Transaction', id);
      const entries = await tx.ledgerEntry.findMany({
        where: { transactionId: id },
        orderBy: { createdAt: 'asc' },
      });
      return {
        transaction: {
          ...mapTxRow(row, row.source.code),
          payload: (row.payload as Record<string, unknown> | null) ?? null,
          idempotencyKey: row.idempotencyKey,
        },
        ledgerEntries: entries.map((e) => ({
          id: e.id,
          accountType: e.accountType,
          direction: e.direction,
          amount: e.amount.toString(),
          currency: e.currency.trim(),
          metadata: (e.metadata as Record<string, unknown> | null) ?? null,
          createdAt: e.createdAt.toISOString(),
        })),
      };
    });
  }

  private async mapTransaction(
    tx: PrismaClient,
    row: {
      id: string;
      companyId: string;
      sourceId: string;
      externalTransactionId: string;
      amount: { toString(): string };
      currency: string;
      commissionAmount: { toString(): string };
      netAmount: { toString(): string };
      status: TransactionResponse['status'];
      payload?: unknown;
      processedAt: Date | null;
      createdAt: Date;
    },
  ): Promise<TransactionResponse> {
    const source = await tx.source.findUnique({
      where: { id: row.sourceId },
      select: { code: true },
    });
    return mapTxRow(row, source?.code ?? '');
  }
}

/**
 * Split an ingest amount into the EXTERNAL debit and the AVAILABLE credit
 * according to how the fee is applied:
 *   - DEDUCTED: the fee comes out of the amount → external = amount, the
 *     company is credited amount − fee.
 *   - ON_TOP:   the fee is charged on top → external = amount + fee, the
 *     company is credited the full amount.
 * In both cases external = credit + fee, so the ledger set stays balanced.
 */
export function ingestSplit(
  amount: Money,
  fee: Money,
  feeApplication: FeeApplication,
): { externalDebit: Money; availableCredit: Money } {
  const isOnTop = feeApplication === 'ON_TOP';
  return {
    externalDebit: isOnTop ? amount.add(fee) : amount,
    availableCredit: isOnTop ? amount : amount.sub(fee),
  };
}

/**
 * Split a clawback of `net` against the current available balance: take what
 * the wallet can cover (capped, so available never goes below zero) and record
 * the rest as a receivable (a debt the company owes). `fromAvailable + receivable`
 * always equals `net`, so the reversal ledger set stays balanced.
 */
export function splitClawback(
  net: Money,
  available: Money,
): { fromAvailable: Money; receivable: Money } {
  const fromAvailable = available.gte(net) ? net : available;
  return { fromAvailable, receivable: net.sub(fromAvailable) };
}

function mapTxRow(
  row: {
    id: string;
    companyId: string;
    sourceId: string;
    externalTransactionId: string;
    amount: { toString(): string };
    currency: string;
    commissionAmount: { toString(): string };
    netAmount: { toString(): string };
    status: TransactionResponse['status'];
    payload?: unknown;
    processedAt: Date | null;
    createdAt: Date;
  },
  sourceCode: string,
): TransactionResponse {
  return {
    id: row.id,
    companyId: row.companyId,
    sourceId: row.sourceId,
    sourceCode,
    externalTransactionId: row.externalTransactionId,
    amount: row.amount.toString(),
    currency: row.currency.trim(),
    commissionAmount: row.commissionAmount.toString(),
    netAmount: row.netAmount.toString(),
    status: row.status,
    customer: payloadString(row.payload, 'customer'),
    target: payloadString(row.payload, 'target'),
    phone: payloadString(row.payload, 'phone'),
    note: payloadString(row.payload, 'note'),
    processedAt: row.processedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Lift a known descriptive field out of the JSONB payload. Returns the string
 * value, or null when absent — or when a legacy row still has it as an object
 * (pre-flattening), so old data degrades gracefully instead of leaking `[object
 * Object]` into the response.
 */
function payloadString(payload: unknown, key: string): string | null {
  if (payload && typeof payload === 'object') {
    const v = (payload as Record<string, unknown>)[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

function csvCell(s: string): string {
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
