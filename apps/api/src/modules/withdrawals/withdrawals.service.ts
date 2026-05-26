import { Injectable, Logger } from '@nestjs/common';
import {
  Money,
  type ApproveWithdrawalInput,
  type CreateWithdrawalInput,
  type ListWithdrawalsQuery,
  type PaginatedResponse,
  type PayoutDetails,
  type PayoutMethod,
  type RejectWithdrawalInput,
  type WithdrawalResponse,
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
 * Withdrawals: company pays an external third party. Funds move
 * available → reserved on request, reserved → external on approval.
 *
 * Sister processes (Payout, Load) live in their own modules with their
 * own services. See PayoutsService and LoadsService.
 */
@Injectable()
export class WithdrawalsService {
  private readonly logger = new Logger(WithdrawalsService.name);

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
    input: CreateWithdrawalInput,
  ): Promise<WithdrawalResponse> {
    const amount = Money.of(input.amount);
    if (!amount.isPositive()) throw new ValidationError('amount must be positive');

    const row = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.bypass_rls = 'on'`);
        const cTx = tx as unknown as PrismaClient;

        const w = await cTx.withdrawal.create({
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
            withdrawalId: w.id,
            accountType: 'AVAILABLE',
            direction: 'DEBIT',
            amount,
            currency: input.currency,
          },
          {
            companyId,
            withdrawalId: w.id,
            accountType: 'RESERVED',
            direction: 'CREDIT',
            amount,
            currency: input.currency,
          },
        ]);

        // Wallet update — fails with a not-negative CHECK if available < amount,
        // which surfaces as a ConflictError.
        await this.wallets.applyDelta(cTx, {
          companyId,
          currency: input.currency,
          delta: { available: amount.mul(-1), reserved: amount },
        });

        return w;
      },
      { isolationLevel: 'Serializable' },
    );

    this.invalidateAnalytics();
    return mapWithdrawal(row);
  }

  async approve(
    id: string,
    approvedById: string,
    input: ApproveWithdrawalInput,
  ): Promise<WithdrawalResponse> {
    const row = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.bypass_rls = 'on'`);
        const cTx = tx as unknown as PrismaClient;

        const w = await cTx.withdrawal.findUnique({ where: { id } });
        if (!w) throw new NotFoundError('Withdrawal', id);
        if (w.status !== 'PENDING') {
          throw new ConflictError(`Withdrawal is in status ${w.status} and cannot be approved`);
        }

        const amount = Money.of(w.amount.toString());

        // Funds leave the platform. Ledger move: reserved → external.
        await this.ledger.writeEntries(cTx, [
          {
            companyId: w.companyId,
            withdrawalId: w.id,
            accountType: 'RESERVED',
            direction: 'DEBIT',
            amount,
            currency: w.currency,
          },
          {
            companyId: w.companyId,
            withdrawalId: w.id,
            accountType: 'EXTERNAL',
            direction: 'CREDIT',
            amount,
            currency: w.currency,
          },
        ]);
        await this.wallets.applyDelta(cTx, {
          companyId: w.companyId,
          currency: w.currency,
          delta: { reserved: amount.mul(-1) },
        });

        return cTx.withdrawal.update({
          where: { id },
          data: {
            status: 'COMPLETED',
            approvedById,
            processedAt: new Date(),
            notes: input.notes ?? w.notes,
            externalReference: input.externalReference,
          },
        });
      },
      { isolationLevel: 'Serializable' },
    );

    this.invalidateAnalytics();
    return mapWithdrawal(row);
  }

  async reject(
    id: string,
    approvedById: string,
    input: RejectWithdrawalInput,
  ): Promise<WithdrawalResponse> {
    const row = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.bypass_rls = 'on'`);
        const cTx = tx as unknown as PrismaClient;

        const w = await cTx.withdrawal.findUnique({ where: { id } });
        if (!w) throw new NotFoundError('Withdrawal', id);
        if (w.status !== 'PENDING') {
          throw new ConflictError(`Withdrawal is in status ${w.status} and cannot be rejected`);
        }

        const amount = Money.of(w.amount.toString());

        // Return reserved funds to available.
        await this.ledger.writeEntries(cTx, [
          {
            companyId: w.companyId,
            withdrawalId: w.id,
            accountType: 'RESERVED',
            direction: 'DEBIT',
            amount,
            currency: w.currency,
          },
          {
            companyId: w.companyId,
            withdrawalId: w.id,
            accountType: 'AVAILABLE',
            direction: 'CREDIT',
            amount,
            currency: w.currency,
          },
        ]);
        await this.wallets.applyDelta(cTx, {
          companyId: w.companyId,
          currency: w.currency,
          delta: { reserved: amount.mul(-1), available: amount },
        });

        return cTx.withdrawal.update({
          where: { id },
          data: {
            status: 'REJECTED',
            approvedById,
            processedAt: new Date(),
            notes: input.notes ?? w.notes,
          },
        });
      },
      { isolationLevel: 'Serializable' },
    );

    this.invalidateAnalytics();
    return mapWithdrawal(row);
  }

  async list(args: {
    companyId?: string;
    query: ListWithdrawalsQuery;
  }): Promise<PaginatedResponse<WithdrawalResponse>> {
    return this.prisma.runAsAdmin(async (tx) => {
      const where: Prisma.WithdrawalWhereInput = {};
      if (args.companyId) where.companyId = args.companyId;
      else if (args.query.companyId) where.companyId = args.query.companyId;
      if (args.query.status) where.status = args.query.status;
      if (args.query.currency) where.currency = args.query.currency;
      if (args.query.payoutMethod) where.payoutMethod = args.query.payoutMethod;

      const skip = (args.query.page - 1) * args.query.pageSize;
      const [rows, total] = await Promise.all([
        tx.withdrawal.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take: args.query.pageSize,
        }),
        tx.withdrawal.count({ where }),
      ]);

      return {
        data: rows.map(mapWithdrawal),
        meta: {
          page: args.query.page,
          pageSize: args.query.pageSize,
          total,
          totalPages: Math.max(1, Math.ceil(total / args.query.pageSize)),
        },
      };
    });
  }

  async getById(id: string, companyId?: string): Promise<WithdrawalResponse> {
    const row = await this.prisma.runAsAdmin((tx) => tx.withdrawal.findUnique({ where: { id } }));
    if (!row) throw new NotFoundError('Withdrawal', id);
    if (companyId && row.companyId !== companyId) throw new NotFoundError('Withdrawal', id);
    return mapWithdrawal(row);
  }
}

function mapWithdrawal(row: {
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
}): WithdrawalResponse {
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
