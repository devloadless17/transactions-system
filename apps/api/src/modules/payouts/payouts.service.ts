import { Injectable, Logger } from '@nestjs/common';
import {
  Money,
  type ApprovePayoutInput,
  type CancelRequestInput,
  type CreatePayoutInput,
  type FeeApplication,
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
import { RealtimeService } from '../realtime/realtime.service';
import { FeesService } from '../commissions/fees.service';
import {
  assertSufficient,
  releaseEntries,
  reserveEntries,
  reservedTotal,
  settleEntries,
} from '../ledger/flow-ledger';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/domain.error';

const REQUESTABLE_STATUS: WithdrawalStatus = 'PENDING';

/**
 * Payouts: company withdraws funds to itself. Same lifecycle as a
 * withdrawal (available → reserved on request, reserved → external on
 * approval) with an optional PAYOUT fee realized to the FEE account on
 * approval.
 */
@Injectable()
export class PayoutsService {
  private readonly logger = new Logger(PayoutsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ledger: LedgerService,
    private readonly wallets: WalletsService,
    private readonly analytics: AnalyticsService,
    private readonly realtime: RealtimeService,
    private readonly fees: FeesService,
  ) {}

  private async invalidateAnalytics(): Promise<void> {
    await this.analytics
      .invalidateAll()
      .catch((e) => this.logger.warn(`analytics cache invalidate failed: ${e}`));
  }

  /** Refresh payout lists, wallet balances, ledger and analytics live. */
  private notify(companyId: string) {
    this.realtime.company(companyId, ['payouts', 'wallets', 'ledger', 'analytics']);
  }

  async request(
    companyId: string,
    requestedById: string,
    input: CreatePayoutInput,
  ): Promise<PayoutResponse> {
    const amount = Money.of(input.amount);
    if (!amount.round().isPositive())
      throw new ValidationError('amount must be positive at up to 8 decimal places');

    const row = await this.prisma.runSerializableAsTenant(companyId, async (tx) => {
      const cTx = tx as unknown as PrismaClient;

      // Block money-out while the company owes the platform (reversal clawback
      // shortfall). It must settle the debt before paying out again.
      const owed = await this.ledger.outstandingReceivable(cTx, companyId, input.currency);
      if (owed.isPositive()) {
        throw new ConflictError(
          `Outstanding balance of ${owed.toString()} ${input.currency} owed to the platform must be settled before a payout`,
          { currency: input.currency, outstanding: owed.toString() },
        );
      }

      const { fee, feeApplication } = await this.fees.resolveFlowFee(cTx, {
        companyId,
        amount,
        operationType: 'PAYOUT',
      });
      const reserved = reservedTotal(amount, fee, feeApplication);
      const net = feeApplication === 'ON_TOP' ? amount : amount.sub(fee);

      await assertSufficient(cTx, companyId, input.currency, reserved);

      const p = await cTx.payout.create({
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

      await this.ledger.writeEntries(
        cTx,
        reserveEntries({ payoutId: p.id }, companyId, input.currency, reserved),
      );
      await this.wallets.applyDelta(cTx, {
        companyId,
        currency: input.currency,
        delta: { available: reserved.mul(-1), reserved },
      });

      return p;
    });

    await this.invalidateAnalytics();
    this.notify(row.companyId);
    return mapPayout(row);
  }

  async approve(
    id: string,
    approvedById: string,
    input: ApprovePayoutInput,
  ): Promise<PayoutResponse> {
    const pre = await this.prisma.runAsAdmin((tx) =>
      tx.payout.findUnique({ where: { id }, select: { companyId: true } }),
    );
    if (!pre) throw new NotFoundError('Payout', id);
    const row = await this.prisma.runSerializableAsTenant(pre.companyId, async (tx) => {
      const cTx = tx as unknown as PrismaClient;

      const p = await cTx.payout.findUnique({ where: { id } });
      if (!p) throw new NotFoundError('Payout', id);
      if (p.status !== 'PENDING') {
        throw new ConflictError(`Payout is in status ${p.status} and cannot be approved`);
      }

      // A reversal may have booked a RECEIVABLE for this company AFTER this
      // payout reserved its funds (clawback claims `available`, not the reserved
      // bucket). Re-assert the money-out block at approval so reserved funds
      // can't leave while the company owes the platform — mirrors request().
      const owed = await this.ledger.outstandingReceivable(cTx, p.companyId, p.currency);
      if (owed.isPositive()) {
        throw new ConflictError(
          `Outstanding balance of ${owed.toString()} ${p.currency} owed to the platform must be settled before this payout can be approved`,
          { currency: p.currency, outstanding: owed.toString() },
        );
      }

      const amount = Money.of(p.amount.toString());
      const fee = Money.of(p.feeAmount.toString());
      const reserved = reservedTotal(amount, fee, p.feeApplication);
      const external = p.feeApplication === 'ON_TOP' ? amount : amount.sub(fee);

      // Funds leave the platform; the fee is realized to the FEE account.
      // Ledger: reserved → external(net) + FEE(fee). Zero lines are skipped.
      await this.ledger.writeEntries(
        cTx,
        settleEntries({ payoutId: p.id }, p.companyId, p.currency, reserved, external, fee),
      );
      await this.wallets.applyDelta(cTx, {
        companyId: p.companyId,
        currency: p.currency,
        delta: { reserved: reserved.mul(-1) },
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
    });

    await this.invalidateAnalytics();
    this.notify(row.companyId);
    return mapPayout(row);
  }

  async reject(
    id: string,
    approvedById: string,
    input: RejectPayoutInput,
  ): Promise<PayoutResponse> {
    return this.release(id, input.notes, { approvedById, status: 'REJECTED' });
  }

  /**
   * Company-initiated cancel of a PENDING payout. Releases the full reserved
   * total back to available so it can be re-requested. PENDING only.
   */
  async cancel(
    id: string,
    companyId: string,
    cancelledById: string,
    input: CancelRequestInput,
  ): Promise<PayoutResponse> {
    return this.release(id, input.notes, { cancelledById, status: 'CANCELLED', companyId });
  }

  /** Shared reserved-release used by reject (admin) and cancel (company). */
  private async release(
    id: string,
    notes: string | undefined,
    opts: {
      status: WithdrawalStatus;
      approvedById?: string;
      cancelledById?: string;
      companyId?: string;
    },
  ): Promise<PayoutResponse> {
    // cancel passes the company; reject (admin) doesn't — resolve it so the
    // mutation runs scoped and RLS WITH CHECK validates the writes.
    const targetCompanyId =
      opts.companyId ??
      (
        await this.prisma.runAsAdmin((tx) =>
          tx.payout.findUnique({ where: { id }, select: { companyId: true } }),
        )
      )?.companyId;
    if (!targetCompanyId) throw new NotFoundError('Payout', id);
    const row = await this.prisma.runSerializableAsTenant(targetCompanyId, async (tx) => {
      const cTx = tx as unknown as PrismaClient;

      const p = await cTx.payout.findUnique({ where: { id } });
      if (!p || (opts.companyId && p.companyId !== opts.companyId)) {
        throw new NotFoundError('Payout', id);
      }
      if (p.status !== 'PENDING') {
        const verb = opts.status === 'CANCELLED' ? 'cancelled' : 'rejected';
        throw new ConflictError(`Payout is in status ${p.status} and cannot be ${verb}`);
      }

      const reserved = reservedTotal(
        Money.of(p.amount.toString()),
        Money.of(p.feeAmount.toString()),
        p.feeApplication,
      );

      await this.ledger.writeEntries(
        cTx,
        releaseEntries({ payoutId: p.id }, p.companyId, p.currency, reserved),
      );
      await this.wallets.applyDelta(cTx, {
        companyId: p.companyId,
        currency: p.currency,
        delta: { reserved: reserved.mul(-1), available: reserved },
      });

      return cTx.payout.update({
        where: { id },
        data: {
          status: opts.status,
          approvedById: opts.approvedById ?? undefined,
          cancelledById: opts.cancelledById ?? undefined,
          processedAt: new Date(),
          notes: notes ?? p.notes,
        },
      });
    });

    await this.invalidateAnalytics();
    this.notify(row.companyId);
    return mapPayout(row);
  }

  async list(args: {
    companyId?: string;
    query: ListPayoutsQuery;
  }): Promise<PaginatedResponse<PayoutResponse>> {
    return this.prisma.runAsScoped(args.companyId ?? null, async (tx) => {
      const where: Prisma.PayoutWhereInput = {};
      if (args.companyId) where.companyId = args.companyId;
      else if (args.query.companyId) where.companyId = args.query.companyId;
      if (args.query.status) where.status = args.query.status;
      if (args.query.currency) where.currency = args.query.currency;
      if (args.query.payoutMethod) where.payoutMethod = args.query.payoutMethod;
      if (args.query.from || args.query.to) {
        where.createdAt = {
          ...(args.query.from ? { gte: new Date(args.query.from) } : {}),
          ...(args.query.to ? { lte: new Date(args.query.to) } : {}),
        };
      }

      const skip = (args.query.page - 1) * args.query.pageSize;
      const [rows, total] = await Promise.all([
        tx.payout.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
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
    const row = await this.prisma.runAsScoped(companyId ?? null, (tx) =>
      tx.payout.findUnique({ where: { id } }),
    );
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
  feeAmount: { toString(): string };
  feeApplication: FeeApplication;
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
}): PayoutResponse {
  return {
    id: row.id,
    companyId: row.companyId,
    amount: row.amount.toString(),
    currency: row.currency.trim(),
    feeAmount: row.feeAmount.toString(),
    feeApplication: row.feeApplication,
    netAmount: row.netAmount.toString(),
    totalAmount: Money.of(row.netAmount.toString())
      .add(Money.of(row.feeAmount.toString()))
      .toString(),
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
