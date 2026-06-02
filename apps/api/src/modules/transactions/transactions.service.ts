import { Injectable, Logger } from '@nestjs/common';
import { InjectMetric } from '@willsoto/nestjs-prometheus';
import type { Counter } from 'prom-client';
import {
  Money,
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
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/domain.error';

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
  ) {}

  /**
   * Public list of companies for source providers to discover slugs.
   * Called by Wish/OMT/etc on startup so they can cache slugs and then
   * post transactions against them. Returns only ACTIVE companies and only
   * the fields a third-party integrator needs to know.
   *
   * Guarded by `ApiKeyAuthGuard` + source-key check in the controller;
   * the service itself is unauthenticated for testability.
   */
  async listCompaniesForSource(): Promise<{ data: IngestCompanyListItem[] }> {
    const rows = await this.prisma.runAsAdmin((tx) =>
      tx.company.findMany({
        where: { status: 'ACTIVE', visible: true },
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
    if (!amount.isPositive()) {
      throw new ValidationError('amount must be positive');
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
    const companyId = company.id;
    const source: { id: string; code: string; status: string } = foundSource;

    // Run the whole financial mutation as admin (we already validated the
    // caller via API key) inside a serializable transaction.
    const result = await this.prisma.runSerializable(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.bypass_rls = 'on'`);
      const cTx = tx as unknown as PrismaClient;

      // ---- idempotency: explicit key OR natural (source,external) pair ----
      if (input.idempotencyKey) {
        const existing = await cTx.transaction.findFirst({
          where: { companyId, idempotencyKey: input.idempotencyKey },
        });
        if (existing) {
          return this.mapTransaction(cTx, existing);
        }
      }
      const dup = await cTx.transaction.findFirst({
        where: { sourceId: source.id, externalTransactionId: input.externalTransactionId },
      });
      if (dup) {
        if (dup.companyId !== companyId) {
          throw new ConflictError(
            'externalTransactionId already used by a different company for this source',
            { sourceId: source.id, externalTransactionId: input.externalTransactionId },
          );
        }
        return this.mapTransaction(cTx, dup);
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

      // ---- insert transaction row ----
      const txRow = await cTx.transaction.create({
        data: {
          companyId,
          sourceId: source.id,
          externalTransactionId: input.externalTransactionId,
          amount: amount.toString(),
          currency: input.currency,
          commissionAmount: resolution.commissionAmount.toString(),
          netAmount: resolution.netAmount.toString(),
          status: 'COMPLETED',
          payload: (input.payload ?? {}) as Prisma.InputJsonValue,
          idempotencyKey: input.idempotencyKey ?? null,
          processedAt: new Date(),
        },
      });

      // ---- ledger: balanced double-entry ----
      // DEBIT  EXTERNAL  amount       (the outside world owes us this)
      // CREDIT AVAILABLE netAmount    (company's spendable balance grows)  [skip if 0]
      // CREDIT FEE       commission   (platform fee revenue)               [skip if 0]
      const ledgerLines: import('../ledger/ledger.service').LedgerEntryInput[] = [
        {
          companyId,
          transactionId: txRow.id,
          accountType: 'EXTERNAL',
          direction: 'DEBIT',
          amount,
          currency: input.currency,
        },
      ];
      if (resolution.netAmount.isPositive()) {
        ledgerLines.push({
          companyId,
          transactionId: txRow.id,
          accountType: 'AVAILABLE',
          direction: 'CREDIT',
          amount: resolution.netAmount,
          currency: input.currency,
        });
      }
      if (resolution.commissionAmount.isPositive()) {
        ledgerLines.push({
          companyId,
          transactionId: txRow.id,
          accountType: 'FEE',
          direction: 'CREDIT',
          amount: resolution.commissionAmount,
          currency: input.currency,
        });
      }
      await this.ledger.writeEntries(cTx, ledgerLines);

      // ---- wallet delta (only if net > 0) ----
      if (resolution.netAmount.isPositive()) {
        await this.wallets.applyDelta(cTx, {
          companyId,
          currency: input.currency,
          delta: { available: resolution.netAmount },
        });
      }

      this.logger.log(
        `ingest tx=${txRow.id} co=${companyId} src=${source.code} ` +
          `amount=${amount.toString()} fee=${resolution.commissionAmount.toString()} ` +
          `net=${resolution.netAmount.toString()} ${input.currency}`,
      );

      return this.mapTransaction(cTx, txRow);
    });

    this.ingestCounter.inc({ source_code: source.code, currency: input.currency });

    // Drop the analytics cache so the next dashboard read reflects this
    // transaction immediately instead of waiting for the 60s TTL.
    this.analytics
      .invalidateAll()
      .catch((e) => this.logger.warn(`analytics cache invalidate failed: ${e}`));

    this.realtime.company(companyId, ['transactions', 'wallets', 'ledger', 'analytics']);

    return result;
  }

  /**
   * Reverse a COMPLETED transaction. Writes compensating ledger entries
   * (mirror of the original) and decrements the available balance.
   * Fails if reversing would push available negative — operator must
   * resolve manually in that case.
   *
   * Idempotent: a tx already in REVERSED state returns its current row.
   */
  async reverse(
    txId: string,
    args: { actorId: string; reason: string },
  ): Promise<TransactionResponse> {
    const reversed = await this.prisma.runSerializable(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL app.bypass_rls = 'on'`);
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

      const amount = Money.of(orig.amount.toString());
      const fee = Money.of(orig.commissionAmount.toString());
      const net = Money.of(orig.netAmount.toString());

      // Compensating ledger entries: mirror the original signs.
      // original was: DEBIT EXTERNAL, CREDIT AVAILABLE, CREDIT FEE
      // reversal is:  CREDIT EXTERNAL, DEBIT AVAILABLE, DEBIT FEE
      const lines: import('../ledger/ledger.service').LedgerEntryInput[] = [
        {
          companyId: orig.companyId,
          transactionId: orig.id,
          accountType: 'EXTERNAL',
          direction: 'CREDIT',
          amount,
          currency: orig.currency,
          metadata: { kind: 'reversal', reason: args.reason },
        },
      ];
      if (net.isPositive()) {
        lines.push({
          companyId: orig.companyId,
          transactionId: orig.id,
          accountType: 'AVAILABLE',
          direction: 'DEBIT',
          amount: net,
          currency: orig.currency,
          metadata: { kind: 'reversal' },
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

      // Wallet: subtract the net (which we previously credited).
      if (net.isPositive()) {
        await this.wallets.applyDelta(cTx, {
          companyId: orig.companyId,
          currency: orig.currency,
          delta: { available: net.mul(-1) },
        });
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

    // Reversal flips the wallet + ledger — analytics need to recompute.
    this.analytics
      .invalidateAll()
      .catch((e) => this.logger.warn(`analytics cache invalidate failed: ${e}`));

    this.realtime.company(reversed.companyId, ['transactions', 'wallets', 'ledger', 'analytics']);

    return mapTxRow(reversed, (reversed as { source?: { code: string } }).source?.code ?? '');
  }

  /**
   * Export up to 10k transactions matching the filters as a CSV string.
   * Hard cap on row count to avoid pathological exports; users export in
   * date-range slices for larger sets.
   */
  async exportCsv(args: { companyId?: string; query: ListTransactionsQuery }): Promise<string> {
    const rows = await this.prisma.runAsAdmin(async (tx) => {
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
      return tx.transaction.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 10_000,
        include: { source: { select: { code: true } } },
      });
    });

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
    ];
    const lines = [header.join(',')];
    for (const r of rows) {
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
        ].join(','),
      );
    }
    return lines.join('\n');
  }

  async list(args: {
    companyId?: string;
    query: ListTransactionsQuery;
  }): Promise<PaginatedResponse<TransactionResponse>> {
    return this.prisma.runAsAdmin(async (tx) => {
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
      const [rows, total, sources] = await Promise.all([
        tx.transaction.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: args.query.pageSize,
          include: { source: { select: { code: true } } },
        }),
        tx.transaction.count({ where }),
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
    const row = await this.prisma.runAsAdmin((tx) =>
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
    return this.prisma.runAsAdmin(async (tx) => {
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
    processedAt: row.processedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function csvCell(s: string): string {
  if (s.includes(',') || s.includes('"') || s.includes('\n')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}
