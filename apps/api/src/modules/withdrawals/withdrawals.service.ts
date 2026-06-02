import { Injectable, Logger } from '@nestjs/common';
import {
  Money,
  type ApproveWithdrawalInput,
  type CancelRequestInput,
  type CreateWithdrawalInput,
  type FeeApplication,
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
import { RealtimeService } from '../realtime/realtime.service';
import { FeesService } from '../commissions/fees.service';
import {
  ConflictError,
  InsufficientBalanceError,
  NotFoundError,
  ValidationError,
} from '../../common/errors/domain.error';

const REQUESTABLE_STATUS: WithdrawalStatus = 'PENDING';

/** Reserved total for a row = amount, or amount+fee when the fee is ON_TOP. */
function reservedTotal(amount: Money, fee: Money, feeApplication: FeeApplication): Money {
  return feeApplication === 'ON_TOP' ? amount.add(fee) : amount;
}

/**
 * Read the available balance inside the current tx and throw a clear
 * "top up" error if it can't cover `required`.
 */
async function assertSufficient(
  tx: PrismaClient,
  companyId: string,
  currency: string,
  required: Money,
): Promise<void> {
  const wallet = await tx.wallet.findUnique({
    where: { companyId_currency: { companyId, currency } },
  });
  const available = Money.of(wallet?.availableBalance.toString() ?? '0');
  if (available.lt(required)) {
    throw new InsufficientBalanceError({
      currency,
      required: required.toString(),
      available: available.toString(),
      shortfall: required.sub(available).toString(),
    });
  }
}

/**
 * Withdrawals: company pays an external third party. Funds move
 * available → reserved on request, reserved → external on approval. An
 * optional WITHDRAWAL fee (DEDUCTED or ON_TOP) is realized to the platform
 * FEE account on approval.
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
    private readonly realtime: RealtimeService,
    private readonly fees: FeesService,
  ) {}

  private invalidateAnalytics() {
    this.analytics
      .invalidateAll()
      .catch((e) => this.logger.warn(`analytics cache invalidate failed: ${e}`));
  }

  /** Refresh withdrawal lists, wallet balances, ledger and analytics live. */
  private notify(companyId: string) {
    this.realtime.company(companyId, ['withdrawals', 'wallets', 'ledger', 'analytics']);
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

        // Resolve the WITHDRAWAL fee (free if no rule). ON_TOP reserves
        // amount+fee; DEDUCTED reserves amount and the recipient gets amount−fee.
        const { fee, feeApplication } = await this.fees.resolveFlowFee(cTx, {
          companyId,
          amount,
          operationType: 'WITHDRAWAL',
        });
        const reserved = reservedTotal(amount, fee, feeApplication);
        const net = feeApplication === 'ON_TOP' ? amount : amount.sub(fee);

        // Clear "top up" error if available can't cover the reserved total.
        await assertSufficient(cTx, companyId, input.currency, reserved);

        const w = await cTx.withdrawal.create({
          data: {
            companyId,
            requestedById,
            amount: amount.toString(),
            currency: input.currency,
            feeAmount: fee.toString(),
            netAmount: net.toString(),
            feeApplication,
            status: REQUESTABLE_STATUS,
            notes: input.notes ?? null,
            payoutMethod: input.payout.method,
            payoutDetails: input.payout as unknown as Prisma.InputJsonValue,
          },
        });

        // Reserve the full reserved total. Ledger move: available → reserved.
        await this.ledger.writeEntries(cTx, [
          {
            companyId,
            withdrawalId: w.id,
            accountType: 'AVAILABLE',
            direction: 'DEBIT',
            amount: reserved,
            currency: input.currency,
          },
          {
            companyId,
            withdrawalId: w.id,
            accountType: 'RESERVED',
            direction: 'CREDIT',
            amount: reserved,
            currency: input.currency,
          },
        ]);

        await this.wallets.applyDelta(cTx, {
          companyId,
          currency: input.currency,
          delta: { available: reserved.mul(-1), reserved },
        });

        return w;
      },
      { isolationLevel: 'Serializable' },
    );

    this.invalidateAnalytics();
    this.notify(row.companyId);
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
        const fee = Money.of(w.feeAmount.toString());
        const reserved = reservedTotal(amount, fee, w.feeApplication);
        const external = w.feeApplication === 'ON_TOP' ? amount : amount.sub(fee);

        // Funds leave the platform; the fee is realized to the FEE account.
        // Ledger: reserved → external(net) + FEE(fee). Skip any zero line.
        const entries: Parameters<typeof this.ledger.writeEntries>[1] = [
          {
            companyId: w.companyId,
            withdrawalId: w.id,
            accountType: 'RESERVED',
            direction: 'DEBIT',
            amount: reserved,
            currency: w.currency,
          },
        ];
        if (external.isPositive()) {
          entries.push({
            companyId: w.companyId,
            withdrawalId: w.id,
            accountType: 'EXTERNAL',
            direction: 'CREDIT',
            amount: external,
            currency: w.currency,
          });
        }
        if (fee.isPositive()) {
          entries.push({
            companyId: w.companyId,
            withdrawalId: w.id,
            accountType: 'FEE',
            direction: 'CREDIT',
            amount: fee,
            currency: w.currency,
          });
        }
        await this.ledger.writeEntries(cTx, entries);
        await this.wallets.applyDelta(cTx, {
          companyId: w.companyId,
          currency: w.currency,
          delta: { reserved: reserved.mul(-1) },
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
    this.notify(row.companyId);
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

        const reserved = reservedTotal(
          Money.of(w.amount.toString()),
          Money.of(w.feeAmount.toString()),
          w.feeApplication,
        );

        // Return the full reserved total to available (no fee realized).
        await this.ledger.writeEntries(cTx, [
          {
            companyId: w.companyId,
            withdrawalId: w.id,
            accountType: 'RESERVED',
            direction: 'DEBIT',
            amount: reserved,
            currency: w.currency,
          },
          {
            companyId: w.companyId,
            withdrawalId: w.id,
            accountType: 'AVAILABLE',
            direction: 'CREDIT',
            amount: reserved,
            currency: w.currency,
          },
        ]);
        await this.wallets.applyDelta(cTx, {
          companyId: w.companyId,
          currency: w.currency,
          delta: { reserved: reserved.mul(-1), available: reserved },
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
    this.notify(row.companyId);
    return mapWithdrawal(row);
  }

  /**
   * Company-initiated cancel of a PENDING withdrawal. Releases the full
   * reserved total back to available (no fee realized) so the company can
   * re-request. Only PENDING can be cancelled — once approved, no.
   */
  async cancel(
    id: string,
    companyId: string,
    cancelledById: string,
    input: CancelRequestInput,
  ): Promise<WithdrawalResponse> {
    const row = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL app.bypass_rls = 'on'`);
        const cTx = tx as unknown as PrismaClient;

        const w = await cTx.withdrawal.findUnique({ where: { id } });
        if (!w || w.companyId !== companyId) throw new NotFoundError('Withdrawal', id);
        if (w.status !== 'PENDING') {
          throw new ConflictError(`Withdrawal is in status ${w.status} and cannot be cancelled`);
        }

        const reserved = reservedTotal(
          Money.of(w.amount.toString()),
          Money.of(w.feeAmount.toString()),
          w.feeApplication,
        );

        await this.ledger.writeEntries(cTx, [
          {
            companyId: w.companyId,
            withdrawalId: w.id,
            accountType: 'RESERVED',
            direction: 'DEBIT',
            amount: reserved,
            currency: w.currency,
          },
          {
            companyId: w.companyId,
            withdrawalId: w.id,
            accountType: 'AVAILABLE',
            direction: 'CREDIT',
            amount: reserved,
            currency: w.currency,
          },
        ]);
        await this.wallets.applyDelta(cTx, {
          companyId: w.companyId,
          currency: w.currency,
          delta: { reserved: reserved.mul(-1), available: reserved },
        });

        return cTx.withdrawal.update({
          where: { id },
          data: {
            status: 'CANCELLED',
            cancelledById,
            processedAt: new Date(),
            notes: input.notes ?? w.notes,
          },
        });
      },
      { isolationLevel: 'Serializable' },
    );

    this.invalidateAnalytics();
    this.notify(row.companyId);
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
  feeAmount: { toString(): string };
  netAmount: { toString(): string };
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
    feeAmount: row.feeAmount.toString(),
    netAmount: row.netAmount.toString(),
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
