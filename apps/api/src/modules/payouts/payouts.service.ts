import { Injectable, Logger } from '@nestjs/common';
import {
  Money,
  type ApprovePayoutInput,
  type CreatePayoutInput,
  type ListPayoutsQuery,
  type PaginatedResponse,
  type PayoutDetails,
  type PayoutMethod,
  type PayoutResponse,
  type RejectPayoutInput,
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
 * Payouts: company withdraws funds to itself. Same lifecycle as a
 * withdrawal (available → reserved on request, reserved → external on
 * approval) but they belong to a separate user-facing process.
 */
@Injectable()
export class PayoutsService {
  private readonly logger = new Logger(PayoutsService.name);

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
    input: CreatePayoutInput,
  ): Promise<PayoutResponse> {
    const amount = Money.of(input.amount);
    if (!amount.isPositive()) throw new ValidationError('amount must be positive');

    const row = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.bypass_rls = 'on'`);
        const cTx = tx as unknown as PrismaClient;

        const p = await cTx.payout.create({
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

        // Reserve the amount. Ledger move: available → reserved.
        await this.ledger.writeEntries(cTx, [
          {
            companyId,
            payoutId: p.id,
            accountType: 'AVAILABLE',
            direction: 'DEBIT',
            amount,
            currency: input.currency,
          },
          {
            companyId,
            payoutId: p.id,
            accountType: 'RESERVED',
            direction: 'CREDIT',
            amount,
            currency: input.currency,
          },
        ]);
        await this.wallets.applyDelta(cTx, {
          companyId,
          currency: input.currency,
          delta: { available: amount.mul(-1), reserved: amount },
        });

        return p;
      },
      { isolationLevel: 'Serializable' },
    );

    this.invalidateAnalytics();
    return mapPayout(row);
  }

  async approve(
    id: string,
    approvedById: string,
    input: ApprovePayoutInput,
  ): Promise<PayoutResponse> {
    const row = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.bypass_rls = 'on'`);
        const cTx = tx as unknown as PrismaClient;

        const p = await cTx.payout.findUnique({ where: { id } });
        if (!p) throw new NotFoundError('Payout', id);
        if (p.status !== 'PENDING') {
          throw new ConflictError(`Payout is in status ${p.status} and cannot be approved`);
        }

        const amount = Money.of(p.amount.toString());

        // Ledger move: reserved → external.
        await this.ledger.writeEntries(cTx, [
          {
            companyId: p.companyId,
            payoutId: p.id,
            accountType: 'RESERVED',
            direction: 'DEBIT',
            amount,
            currency: p.currency,
          },
          {
            companyId: p.companyId,
            payoutId: p.id,
            accountType: 'EXTERNAL',
            direction: 'CREDIT',
            amount,
            currency: p.currency,
          },
        ]);
        await this.wallets.applyDelta(cTx, {
          companyId: p.companyId,
          currency: p.currency,
          delta: { reserved: amount.mul(-1) },
        });

        return cTx.payout.update({
          where: { id },
          data: {
            status: 'COMPLETED',
            approvedById,
            processedAt: new Date(),
            notes: input.notes ?? p.notes,
            externalReference: input.externalReference,
          },
        });
      },
      { isolationLevel: 'Serializable' },
    );

    this.invalidateAnalytics();
    return mapPayout(row);
  }

  async reject(
    id: string,
    approvedById: string,
    input: RejectPayoutInput,
  ): Promise<PayoutResponse> {
    const row = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.bypass_rls = 'on'`);
        const cTx = tx as unknown as PrismaClient;

        const p = await cTx.payout.findUnique({ where: { id } });
        if (!p) throw new NotFoundError('Payout', id);
        if (p.status !== 'PENDING') {
          throw new ConflictError(`Payout is in status ${p.status} and cannot be rejected`);
        }

        const amount = Money.of(p.amount.toString());

        // Return reserved funds to available.
        await this.ledger.writeEntries(cTx, [
          {
            companyId: p.companyId,
            payoutId: p.id,
            accountType: 'RESERVED',
            direction: 'DEBIT',
            amount,
            currency: p.currency,
          },
          {
            companyId: p.companyId,
            payoutId: p.id,
            accountType: 'AVAILABLE',
            direction: 'CREDIT',
            amount,
            currency: p.currency,
          },
        ]);
        await this.wallets.applyDelta(cTx, {
          companyId: p.companyId,
          currency: p.currency,
          delta: { reserved: amount.mul(-1), available: amount },
        });

        return cTx.payout.update({
          where: { id },
          data: {
            status: 'REJECTED',
            approvedById,
            processedAt: new Date(),
            notes: input.notes ?? p.notes,
          },
        });
      },
      { isolationLevel: 'Serializable' },
    );

    this.invalidateAnalytics();
    return mapPayout(row);
  }

  async list(args: {
    companyId?: string;
    query: ListPayoutsQuery;
  }): Promise<PaginatedResponse<PayoutResponse>> {
    return this.prisma.runAsAdmin(async (tx) => {
      const where: Prisma.PayoutWhereInput = {};
      if (args.companyId) where.companyId = args.companyId;
      else if (args.query.companyId) where.companyId = args.query.companyId;
      if (args.query.status) where.status = args.query.status;
      if (args.query.currency) where.currency = args.query.currency;
      if (args.query.payoutMethod) where.payoutMethod = args.query.payoutMethod;

      const skip = (args.query.page - 1) * args.query.pageSize;
      const [rows, total] = await Promise.all([
        tx.payout.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: args.query.pageSize,
        }),
        tx.payout.count({ where }),
      ]);

      return {
        data: rows.map(mapPayout),
        meta: {
          page: args.query.page,
          pageSize: args.query.pageSize,
          total,
          totalPages: Math.max(1, Math.ceil(total / args.query.pageSize)),
        },
      };
    });
  }

  async getById(id: string, companyId?: string): Promise<PayoutResponse> {
    const row = await this.prisma.runAsAdmin((tx) => tx.payout.findUnique({ where: { id } }));
    if (!row) throw new NotFoundError('Payout', id);
    if (companyId && row.companyId !== companyId) throw new NotFoundError('Payout', id);
    return mapPayout(row);
  }
}

function mapPayout(row: {
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
}): PayoutResponse {
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
