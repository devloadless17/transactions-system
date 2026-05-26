import { Injectable, Logger } from '@nestjs/common';
import {
  Money,
  type ApproveLoadInput,
  type CreateLoadInput,
  type LoadResponse,
  type ListLoadsQuery,
  type PaginatedResponse,
  type PayoutDetails,
  type PayoutMethod,
  type RejectLoadInput,
  type WithdrawalStatus,
} from '@app/shared';
import type { Prisma, PrismaClient } from '@app/db';
import { PrismaService } from '../../database/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { WalletsService } from '../wallets/wallets.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/domain.error';

const REQUESTABLE_STATUS: WithdrawalStatus = 'PENDING';

/**
 * Loads: company tops up its own wallet (money in, not out).
 *
 * Lifecycle:
 *   - request: just persists PENDING. No wallet/ledger move yet — the
 *     funds haven't arrived. The company is declaring intent.
 *   - approve: operator has verified real-world receipt. Credit available
 *     (DEBIT external, CREDIT available). Wallet `available += amount`.
 *   - reject: pure status change. No money moved at request time, so
 *     there's nothing to unwind.
 */
@Injectable()
export class LoadsService {
  private readonly logger = new Logger(LoadsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly wallets: WalletsService,
    private readonly analytics: AnalyticsService,
  ) {}

  private invalidateAnalytics() {
    this.analytics
      .invalidateAll()
      .catch((e) => this.logger.warn(`analytics cache invalidate failed: ${e}`));
  }

  async request(
    companyId: string,
    requestedById: string,
    input: CreateLoadInput,
  ): Promise<LoadResponse> {
    const amount = Money.of(input.amount);
    if (!amount.isPositive()) throw new ValidationError('amount must be positive');

    const row = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.bypass_rls = 'on'`);
        const cTx = tx as unknown as PrismaClient;

        return cTx.load.create({
          data: {
            companyId,
            requestedById,
            amount: amount.toString(),
            currency: input.currency,
            status: REQUESTABLE_STATUS,
            notes: input.notes ?? null,
            payoutMethod: input.payout.method,
            payoutDetails: input.payout as unknown as Prisma.InputJsonValue,
          },
        });
      },
      { isolationLevel: 'Serializable' },
    );

    this.invalidateAnalytics();
    return mapLoad(row);
  }

  async approve(id: string, approvedById: string, input: ApproveLoadInput): Promise<LoadResponse> {
    const row = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.bypass_rls = 'on'`);
        const cTx = tx as unknown as PrismaClient;

        const l = await cTx.load.findUnique({ where: { id } });
        if (!l) throw new NotFoundError('Load', id);
        if (l.status !== 'PENDING') {
          throw new ConflictError(`Load is in status ${l.status} and cannot be approved`);
        }

        const amount = Money.of(l.amount.toString());

        // Money in: DEBIT external, CREDIT available.
        await this.ledger.writeEntries(cTx, [
          {
            companyId: l.companyId,
            loadId: l.id,
            accountType: 'EXTERNAL',
            direction: 'DEBIT',
            amount,
            currency: l.currency,
          },
          {
            companyId: l.companyId,
            loadId: l.id,
            accountType: 'AVAILABLE',
            direction: 'CREDIT',
            amount,
            currency: l.currency,
          },
        ]);
        await this.wallets.applyDelta(cTx, {
          companyId: l.companyId,
          currency: l.currency,
          delta: { available: amount },
        });

        return cTx.load.update({
          where: { id },
          data: {
            status: 'COMPLETED',
            approvedById,
            processedAt: new Date(),
            notes: input.notes ?? l.notes,
            externalReference: input.externalReference,
          },
        });
      },
      { isolationLevel: 'Serializable' },
    );

    this.invalidateAnalytics();
    return mapLoad(row);
  }

  async reject(id: string, approvedById: string, input: RejectLoadInput): Promise<LoadResponse> {
    const row = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.bypass_rls = 'on'`);
        const cTx = tx as unknown as PrismaClient;

        const l = await cTx.load.findUnique({ where: { id } });
        if (!l) throw new NotFoundError('Load', id);
        if (l.status !== 'PENDING') {
          throw new ConflictError(`Load is in status ${l.status} and cannot be rejected`);
        }

        // Nothing was reserved/moved at request time — rejection is a
        // pure status change.
        return cTx.load.update({
          where: { id },
          data: {
            status: 'REJECTED',
            approvedById,
            processedAt: new Date(),
            notes: input.notes ?? l.notes,
          },
        });
      },
      { isolationLevel: 'Serializable' },
    );

    this.invalidateAnalytics();
    return mapLoad(row);
  }

  async list(args: {
    companyId?: string;
    query: ListLoadsQuery;
  }): Promise<PaginatedResponse<LoadResponse>> {
    return this.prisma.runAsAdmin(async (tx) => {
      const where: Prisma.LoadWhereInput = {};
      if (args.companyId) where.companyId = args.companyId;
      else if (args.query.companyId) where.companyId = args.query.companyId;
      if (args.query.status) where.status = args.query.status;
      if (args.query.currency) where.currency = args.query.currency;
      if (args.query.payoutMethod) where.payoutMethod = args.query.payoutMethod;

      const skip = (args.query.page - 1) * args.query.pageSize;
      const [rows, total] = await Promise.all([
        tx.load.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: args.query.pageSize,
        }),
        tx.load.count({ where }),
      ]);

      return {
        data: rows.map(mapLoad),
        meta: {
          page: args.query.page,
          pageSize: args.query.pageSize,
          total,
          totalPages: Math.max(1, Math.ceil(total / args.query.pageSize)),
        },
      };
    });
  }

  async getById(id: string, companyId?: string): Promise<LoadResponse> {
    const row = await this.prisma.runAsAdmin((tx) => tx.load.findUnique({ where: { id } }));
    if (!row) throw new NotFoundError('Load', id);
    if (companyId && row.companyId !== companyId) throw new NotFoundError('Load', id);
    return mapLoad(row);
  }
}

function mapLoad(row: {
  id: string;
  companyId: string;
  amount: { toString(): string };
  currency: string;
  status: WithdrawalStatus;
  payoutMethod: PayoutMethod;
  payoutDetails: unknown;
  externalReference: string | null;
  requestedById: string;
  approvedById: string | null;
  notes: string | null;
  processedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): LoadResponse {
  return {
    id: row.id,
    companyId: row.companyId,
    amount: row.amount.toString(),
    currency: row.currency.trim(),
    status: row.status,
    payoutMethod: row.payoutMethod,
    payoutDetails: (row.payoutDetails as PayoutDetails | null) ?? null,
    externalReference: row.externalReference,
    requestedById: row.requestedById,
    approvedById: row.approvedById,
    notes: row.notes,
    processedAt: row.processedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
