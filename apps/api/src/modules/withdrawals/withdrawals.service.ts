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
import { NotificationsService } from '../notifications/notifications.service';
import { CacheService } from '../cache/cache.service';
import { FeesService } from '../commissions/fees.service';
import {
  assertSufficient,
  netOfFee,
  releaseEntries,
  reserveEntries,
  reservedTotal,
  settleEntries,
} from '../ledger/flow-ledger';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/domain.error';
import { assertListOffset } from '../../common/pagination';

const REQUESTABLE_STATUS: WithdrawalStatus = 'PENDING';

// Per-(filter) list COUNT cached briefly so paging reuses it instead of re-running
// COUNT(*) on every page — mirrors the transactions/ledger lists. Rows stay live;
// the total may lag by up to this window. TTL-only (not invalidated on write).
const LIST_COUNT_CACHE_TTL_SEC = 30;

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
    private readonly notifications: NotificationsService,
    private readonly cache: CacheService,
    private readonly fees: FeesService,
  ) {}

  private async invalidateAnalytics(): Promise<void> {
    await this.analytics
      .invalidateAll()
      .catch((e) => this.logger.warn(`analytics cache invalidate failed: ${e}`));
  }

  /** Refresh withdrawal lists, wallet balances, ledger and analytics live. */
  private notify(companyId: string) {
    this.realtime.company(companyId, ['withdrawals', 'wallets', 'ledger', 'analytics']);
  }

  async request(
    companyId: string,
    requestedById: string | null,
    input: CreateWithdrawalInput,
    requestedByKeyId?: string | null,
  ): Promise<WithdrawalResponse> {
    const amount = Money.of(input.amount);
    if (!amount.round().isPositive())
      throw new ValidationError('amount must be positive at up to 8 decimal places');

    const row = await this.prisma.runSerializableAsTenant(companyId, async (tx) => {
      const cTx = tx as unknown as PrismaClient;

      // Block money-out while the company owes the platform (e.g. from a
      // reversal clawback that exceeded its balance). It must settle first.
      const owed = await this.ledger.outstandingReceivable(cTx, companyId, input.currency);
      if (owed.isPositive()) {
        throw new ConflictError(
          `Outstanding balance of ${owed.toString()} ${input.currency} owed to the platform must be settled before withdrawing`,
          { currency: input.currency, outstanding: owed.toString() },
        );
      }

      // Resolve the WITHDRAWAL fee (free if no rule). ON_TOP reserves
      // amount+fee; DEDUCTED reserves amount and the recipient gets amount−fee.
      const { fee, feeApplication } = await this.fees.resolveFlowFee(cTx, {
        companyId,
        amount,
        operationType: 'WITHDRAWAL',
      });
      const reserved = reservedTotal(amount, fee, feeApplication);
      const net = netOfFee(amount, fee, feeApplication);

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
          metadata: requestedByKeyId ? { apiKeyId: requestedByKeyId } : undefined,
        },
      });

      // Reserve the full reserved total. Ledger move: available → reserved.
      await this.ledger.writeEntries(
        cTx,
        reserveEntries({ withdrawalId: w.id }, companyId, input.currency, reserved),
      );

      await this.wallets.applyDelta(cTx, {
        companyId,
        currency: input.currency,
        delta: { available: reserved.mul(-1), reserved },
      });

      return w;
    });

    await this.invalidateAnalytics();
    this.notify(row.companyId);
    void this.notifications.requestSubmitted({
      flow: 'WITHDRAWAL',
      companyId: row.companyId,
      entityId: row.id,
      amount: row.amount.toString(),
      currency: row.currency,
    });
    return mapWithdrawal(row);
  }

  async approve(
    id: string,
    approvedById: string,
    input: ApproveWithdrawalInput,
  ): Promise<WithdrawalResponse> {
    const pre = await this.prisma.runAsAdmin((tx) =>
      tx.withdrawal.findUnique({ where: { id }, select: { companyId: true } }),
    );
    if (!pre) throw new NotFoundError('Withdrawal', id);
    const row = await this.prisma.runSerializableAsTenant(pre.companyId, async (tx) => {
      const cTx = tx as unknown as PrismaClient;

      const w = await cTx.withdrawal.findUnique({ where: { id } });
      if (!w) throw new NotFoundError('Withdrawal', id);
      if (w.status !== 'PENDING') {
        throw new ConflictError(`Withdrawal is in status ${w.status} and cannot be approved`);
      }

      // A reversal may have booked a RECEIVABLE for this company AFTER this
      // withdrawal reserved its funds (clawback claims `available`, not the
      // reserved bucket). Re-assert the money-out block at approval so reserved
      // funds can't leave while the company owes the platform — mirrors request().
      const owed = await this.ledger.outstandingReceivable(cTx, w.companyId, w.currency);
      if (owed.isPositive()) {
        throw new ConflictError(
          `Outstanding balance of ${owed.toString()} ${w.currency} owed to the platform must be settled before this withdrawal can be approved`,
          { currency: w.currency, outstanding: owed.toString() },
        );
      }

      const amount = Money.of(w.amount.toString());
      const fee = Money.of(w.feeAmount.toString());
      const reserved = reservedTotal(amount, fee, w.feeApplication);
      const external = netOfFee(amount, fee, w.feeApplication);

      // Funds leave the platform; the fee is realized to the FEE account.
      // Ledger: reserved → external(net) + FEE(fee). Zero lines are skipped.
      await this.ledger.writeEntries(
        cTx,
        settleEntries({ withdrawalId: w.id }, w.companyId, w.currency, reserved, external, fee),
      );
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
    });

    await this.invalidateAnalytics();
    this.notify(row.companyId);
    void this.notifications.requestResolved({
      flow: 'WITHDRAWAL',
      event: 'APPROVED',
      companyId: row.companyId,
      entityId: row.id,
      amount: row.amount.toString(),
      currency: row.currency,
    });
    return mapWithdrawal(row);
  }

  async reject(
    id: string,
    approvedById: string,
    input: RejectWithdrawalInput,
  ): Promise<WithdrawalResponse> {
    return this.release(id, input.notes, { approvedById, status: 'REJECTED' });
  }

  /**
   * Company-initiated cancel of a PENDING withdrawal. Releases the full
   * reserved total back to available (no fee realized) so the company can
   * re-request. Only PENDING can be cancelled — once approved, no.
   */
  async cancel(
    id: string,
    companyId: string,
    cancelledById: string | null,
    input: CancelRequestInput,
  ): Promise<WithdrawalResponse> {
    return this.release(id, input.notes, { cancelledById, status: 'CANCELLED', companyId });
  }

  /** Shared reserved-release used by reject (admin) and cancel (company). */
  private async release(
    id: string,
    notes: string | undefined,
    opts: {
      status: WithdrawalStatus;
      approvedById?: string;
      cancelledById?: string | null;
      companyId?: string;
    },
  ): Promise<WithdrawalResponse> {
    // cancel passes the company; reject (admin) doesn't — resolve it so the
    // mutation runs scoped and RLS WITH CHECK validates the writes.
    const targetCompanyId =
      opts.companyId ??
      (
        await this.prisma.runAsAdmin((tx) =>
          tx.withdrawal.findUnique({ where: { id }, select: { companyId: true } }),
        )
      )?.companyId;
    if (!targetCompanyId) throw new NotFoundError('Withdrawal', id);
    const row = await this.prisma.runSerializableAsTenant(targetCompanyId, async (tx) => {
      const cTx = tx as unknown as PrismaClient;

      const w = await cTx.withdrawal.findUnique({ where: { id } });
      if (!w || (opts.companyId && w.companyId !== opts.companyId)) {
        throw new NotFoundError('Withdrawal', id);
      }
      if (w.status !== 'PENDING') {
        const verb = opts.status === 'CANCELLED' ? 'cancelled' : 'rejected';
        throw new ConflictError(`Withdrawal is in status ${w.status} and cannot be ${verb}`);
      }

      const reserved = reservedTotal(
        Money.of(w.amount.toString()),
        Money.of(w.feeAmount.toString()),
        w.feeApplication,
      );

      // Return the full reserved total to available (no fee realized).
      await this.ledger.writeEntries(
        cTx,
        releaseEntries({ withdrawalId: w.id }, w.companyId, w.currency, reserved),
      );
      await this.wallets.applyDelta(cTx, {
        companyId: w.companyId,
        currency: w.currency,
        delta: { reserved: reserved.mul(-1), available: reserved },
      });

      return cTx.withdrawal.update({
        where: { id },
        data: {
          status: opts.status,
          approvedById: opts.approvedById ?? undefined,
          cancelledById: opts.cancelledById ?? undefined,
          processedAt: new Date(),
          notes: notes ?? w.notes,
        },
      });
    });

    await this.invalidateAnalytics();
    this.notify(row.companyId);
    // Only an admin reject notifies the company; a company self-cancel doesn't.
    if (opts.status === 'REJECTED') {
      void this.notifications.requestResolved({
        flow: 'WITHDRAWAL',
        event: 'REJECTED',
        companyId: row.companyId,
        entityId: row.id,
        amount: row.amount.toString(),
        currency: row.currency,
      });
    }
    return mapWithdrawal(row);
  }

  async list(args: {
    companyId?: string;
    query: ListWithdrawalsQuery;
  }): Promise<PaginatedResponse<WithdrawalResponse>> {
    return this.prisma.runAsScoped(args.companyId ?? null, async (tx) => {
      const where: Prisma.WithdrawalWhereInput = {};
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
      assertListOffset(skip);
      const countKey =
        `list-count:wd:${args.companyId ?? args.query.companyId ?? 'all'}` +
        `:${args.query.status ?? ''}:${args.query.currency ?? ''}:${args.query.payoutMethod ?? ''}` +
        `:${args.query.from ?? ''}:${args.query.to ?? ''}`;
      const [rows, total] = await Promise.all([
        tx.withdrawal.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip,
          take: args.query.pageSize,
        }),
        this.cache.wrap(countKey, LIST_COUNT_CACHE_TTL_SEC, () => tx.withdrawal.count({ where })),
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
    const row = await this.prisma.runAsScoped(companyId ?? null, (tx) =>
      tx.withdrawal.findUnique({ where: { id } }),
    );
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
  feeApplication: FeeApplication;
  netAmount: { toString(): string };
  status: WithdrawalStatus;
  payoutMethod: PayoutMethod;
  payoutDetails: unknown;
  externalReference: string | null;
  requestedById: string | null;
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
