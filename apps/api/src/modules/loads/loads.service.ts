import { Injectable, Logger } from '@nestjs/common';
import {
  Money,
  type ApproveLoadInput,
  type CancelRequestInput,
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
import { RealtimeService } from '../realtime/realtime.service';
import { FeesService } from '../commissions/fees.service';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/domain.error';

const REQUESTABLE_STATUS: WithdrawalStatus = 'PENDING';

/**
 * Loads: company tops up its own wallet (money in, not out). An optional LOAD
 * fee is taken when the deposit is approved.
 *
 * Lifecycle:
 *   - request: persists PENDING and records the fee preview. No wallet/ledger
 *     move yet — the funds haven't arrived.
 *   - approve: operator verified receipt. Credit the net to available and the
 *     fee to the platform FEE account. (DEDUCTED: external=amount, available
 *     gets amount−fee. ON_TOP: external=amount+fee, available gets amount.)
 *   - reject / cancel: pure status change (nothing was moved at request time).
 */
@Injectable()
export class LoadsService {
  private readonly logger = new Logger(LoadsService.name);

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

  /** Refresh load lists, wallet balances, ledger and analytics live. */
  private notify(companyId: string) {
    this.realtime.company(companyId, ['loads', 'wallets', 'ledger', 'analytics']);
  }

  async request(
    companyId: string,
    requestedById: string,
    input: CreateLoadInput,
  ): Promise<LoadResponse> {
    const amount = Money.of(input.amount);
    if (!amount.round().isPositive())
      throw new ValidationError('amount must be positive at up to 8 decimal places');

    const row = await this.prisma.runSerializableAsTenant(companyId, async (tx) => {
      const cTx = tx as unknown as PrismaClient;

      const { fee, feeApplication } = await this.fees.resolveFlowFee(cTx, {
        companyId,
        amount,
        operationType: 'LOAD',
      });
      // Net credited to the wallet on approval.
      const net = feeApplication === 'ON_TOP' ? amount : amount.sub(fee);

      return cTx.load.create({
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
    });

    await this.invalidateAnalytics();
    this.notify(row.companyId);
    return mapLoad(row);
  }

  async approve(id: string, approvedById: string, input: ApproveLoadInput): Promise<LoadResponse> {
    const pre = await this.prisma.runAsAdmin((tx) =>
      tx.load.findUnique({ where: { id }, select: { companyId: true } }),
    );
    if (!pre) throw new NotFoundError('Load', id);
    const row = await this.prisma.runSerializableAsTenant(pre.companyId, async (tx) => {
      const cTx = tx as unknown as PrismaClient;

      const l = await cTx.load.findUnique({ where: { id } });
      if (!l) throw new NotFoundError('Load', id);
      if (l.status !== 'PENDING') {
        throw new ConflictError(`Load is in status ${l.status} and cannot be approved`);
      }

      const amount = Money.of(l.amount.toString());
      const fee = Money.of(l.feeAmount.toString());
      const externalDebit = l.feeApplication === 'ON_TOP' ? amount.add(fee) : amount;
      const availableCredit = l.feeApplication === 'ON_TOP' ? amount : amount.sub(fee);

      // Money in: DEBIT external, CREDIT available(net) + FEE(fee). Skip zero.
      const entries: Parameters<typeof this.ledger.writeEntries>[1] = [
        {
          companyId: l.companyId,
          loadId: l.id,
          accountType: 'EXTERNAL',
          direction: 'DEBIT',
          amount: externalDebit,
          currency: l.currency,
        },
      ];
      if (availableCredit.isPositive()) {
        entries.push({
          companyId: l.companyId,
          loadId: l.id,
          accountType: 'AVAILABLE',
          direction: 'CREDIT',
          amount: availableCredit,
          currency: l.currency,
        });
      }
      if (fee.isPositive()) {
        entries.push({
          companyId: l.companyId,
          loadId: l.id,
          accountType: 'FEE',
          direction: 'CREDIT',
          amount: fee,
          currency: l.currency,
        });
      }
      await this.ledger.writeEntries(cTx, entries);
      await this.wallets.applyDelta(cTx, {
        companyId: l.companyId,
        currency: l.currency,
        delta: { available: availableCredit },
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
    });

    await this.invalidateAnalytics();
    this.notify(row.companyId);
    return mapLoad(row);
  }

  async reject(id: string, approvedById: string, input: RejectLoadInput): Promise<LoadResponse> {
    return this.close(id, input.notes, { approvedById, status: 'REJECTED' });
  }

  /** Company-initiated cancel of a PENDING load (status-only; nothing moved). */
  async cancel(
    id: string,
    companyId: string,
    cancelledById: string,
    input: CancelRequestInput,
  ): Promise<LoadResponse> {
    return this.close(id, input.notes, { cancelledById, status: 'CANCELLED', companyId });
  }

  private async close(
    id: string,
    notes: string | undefined,
    opts: {
      status: WithdrawalStatus;
      approvedById?: string;
      cancelledById?: string;
      companyId?: string;
    },
  ): Promise<LoadResponse> {
    const targetCompanyId =
      opts.companyId ??
      (
        await this.prisma.runAsAdmin((tx) =>
          tx.load.findUnique({ where: { id }, select: { companyId: true } }),
        )
      )?.companyId;
    if (!targetCompanyId) throw new NotFoundError('Load', id);
    const row = await this.prisma.runSerializableAsTenant(targetCompanyId, async (tx) => {
      const cTx = tx as unknown as PrismaClient;

      const l = await cTx.load.findUnique({ where: { id } });
      if (!l || (opts.companyId && l.companyId !== opts.companyId)) {
        throw new NotFoundError('Load', id);
      }
      if (l.status !== 'PENDING') {
        const verb = opts.status === 'CANCELLED' ? 'cancelled' : 'rejected';
        throw new ConflictError(`Load is in status ${l.status} and cannot be ${verb}`);
      }

      // Nothing was moved at request time — closing is a pure status change.
      return cTx.load.update({
        where: { id },
        data: {
          status: opts.status,
          approvedById: opts.approvedById ?? undefined,
          cancelledById: opts.cancelledById ?? undefined,
          processedAt: new Date(),
          notes: notes ?? l.notes,
        },
      });
    });

    await this.invalidateAnalytics();
    this.notify(row.companyId);
    return mapLoad(row);
  }

  async list(args: {
    companyId?: string;
    query: ListLoadsQuery;
  }): Promise<PaginatedResponse<LoadResponse>> {
    return this.prisma.runAsScoped(args.companyId ?? null, async (tx) => {
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
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
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
    const row = await this.prisma.runAsScoped(companyId ?? null, (tx) =>
      tx.load.findUnique({ where: { id } }),
    );
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
}): LoadResponse {
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
