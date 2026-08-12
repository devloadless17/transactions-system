import { Injectable, Logger, StreamableFile } from '@nestjs/common';
import {
  Money,
  MONEY_SCALE_LABEL,
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
import { streamFlowCsv } from '../../common/flow-csv';

const REQUESTABLE_STATUS: WithdrawalStatus = 'PENDING';

// Per-(filter) list COUNT cached briefly so paging reuses it instead of re-running
// COUNT(*) on every page — mirrors the transactions/ledger lists. Rows stay live;
// the total may lag by up to this window. TTL-only (not invalidated on write).
const LIST_COUNT_CACHE_TTL_SEC = 30;

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
    private readonly notifications: NotificationsService,
    private readonly cache: CacheService,
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
    requestedById: string | null,
    input: CreatePayoutInput,
    requestedByKeyId?: string | null,
  ): Promise<PayoutResponse> {
    // Quantized at the boundary, DOWNWARD: the HTTP schema already does this, but
    // internal callers reach this method directly. Rounding down (never up) means
    // we can never reserve or pay out more than was actually requested.
    const amount = Money.of(input.amount).floorToScale();
    if (!amount.isPositive())
      throw new ValidationError(`amount must be positive at up to ${MONEY_SCALE_LABEL}`);

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
      const net = netOfFee(amount, fee, feeApplication);

      // A DEDUCTED fee >= amount would make the recipient receive 0 while the
      // full amount still leaves the wallet to the platform FEE account. Reject
      // clearly at request time (mirrors withdrawals; deposits are untouched).
      if (!net.isPositive()) {
        throw new ValidationError(
          `The ${fee.toString()} ${input.currency} fee consumes the entire amount — the recipient would receive 0. Increase the amount or fix the fee rule.`,
          { amount: amount.toString(), fee: fee.toString() },
        );
      }

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
          metadata: requestedByKeyId ? { apiKeyId: requestedByKeyId } : undefined,
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
    void this.notifications.requestSubmitted({
      flow: 'PAYOUT',
      companyId: row.companyId,
      entityId: row.id,
      amount: row.amount.toString(),
      currency: row.currency,
    });
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

      // fromDb: quantize the stored inputs once; the remaining legs derive from them.
      const amount = Money.fromDb(p.amount);
      const fee = Money.fromDb(p.feeAmount);
      const reserved = reservedTotal(amount, fee, p.feeApplication);
      const external = netOfFee(amount, fee, p.feeApplication);

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
          // Admin's note → admin_notes; NEVER overwrite the company's request note.
          adminNotes: input.notes ?? undefined,
          externalReference: input.externalReference,
        },
      });
    });

    await this.invalidateAnalytics();
    this.notify(row.companyId);
    void this.notifications.requestResolved({
      flow: 'PAYOUT',
      event: 'APPROVED',
      companyId: row.companyId,
      entityId: row.id,
      amount: row.amount.toString(),
      currency: row.currency,
    });
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
    cancelledById: string | null,
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
      cancelledById?: string | null;
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
        Money.fromDb(p.amount),
        Money.fromDb(p.feeAmount),
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
          // An admin REJECT records its reason in admin_notes (shown to the
          // company); a company self-cancel leaves it untouched. The company's
          // original request note in `notes` is never overwritten.
          adminNotes: opts.status === 'REJECTED' ? (notes ?? undefined) : undefined,
        },
      });
    });

    await this.invalidateAnalytics();
    this.notify(row.companyId);
    // Admin reject notifies the company; a company self-cancel doesn't. Either
    // way the request is resolved, so clear the admin queue notification
    // (requestResolved handles REJECTED; clear directly for CANCELLED).
    if (opts.status === 'REJECTED') {
      void this.notifications.requestResolved({
        flow: 'PAYOUT',
        event: 'REJECTED',
        companyId: row.companyId,
        entityId: row.id,
        amount: row.amount.toString(),
        currency: row.currency,
      });
    } else {
      void this.notifications.clearAdminRequest({ flow: 'PAYOUT', entityId: row.id });
    }
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
      assertListOffset(skip);
      const countKey =
        `list-count:po:${args.companyId ?? args.query.companyId ?? 'all'}` +
        `:${args.query.status ?? ''}:${args.query.currency ?? ''}:${args.query.payoutMethod ?? ''}` +
        `:${args.query.from ?? ''}:${args.query.to ?? ''}`;
      const [rows, total] = await Promise.all([
        tx.payout.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip,
          take: args.query.pageSize,
        }),
        // singleFlight:false — runs inside the caller's tx; compute-on-miss, never
        // block on the cross-request poll (which would pin this pooled connection).
        this.cache.wrap(countKey, LIST_COUNT_CACHE_TTL_SEC, () => tx.payout.count({ where }), {
          singleFlight: false,
        }),
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

  /**
   * Stream ALL payouts matching the filters as CSV (no row cap), walked in
   * keyset chunks. Mirrors the list query's filters; each chunk is its own
   * short RLS-scoped query.
   */
  streamCsv(args: { companyId?: string; query: ListPayoutsQuery }): StreamableFile {
    const where = this.exportWhere(args);
    const scope = args.companyId ?? null;
    const prisma = this.prisma;
    return streamFlowCsv({
      noun: 'payouts',
      now: Date.now(),
      baseWhere: where as Record<string, unknown>,
      findPage: (pageWhere, take) =>
        prisma.runAsScoped(scope, (tx) =>
          tx.payout.findMany({
            where: pageWhere as Prisma.PayoutWhereInput,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take,
          }),
        ),
    });
  }

  private exportWhere(args: {
    companyId?: string;
    query: ListPayoutsQuery;
  }): Prisma.PayoutWhereInput {
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
    return where;
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
  requestedById: string | null;
  approvedById: string | null;
  notes: string | null;
  adminNotes: string | null;
  processedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): PayoutResponse {
  return {
    id: row.id,
    companyId: row.companyId,
    // Quantized on the way out so the API, the CSV export and the CRM webhook
    // all report the same figure — and the same figure the ledger books. Deriving
    // totalAmount from these (not from the raw columns) keeps net + fee == total
    // exact, because a sum of two at-scale values is itself at scale.
    amount: Money.fromDb(row.amount).toString(),
    currency: row.currency.trim(),
    feeAmount: Money.fromDb(row.feeAmount).toString(),
    feeApplication: row.feeApplication,
    netAmount: Money.fromDb(row.netAmount).toString(),
    totalAmount: Money.fromDb(row.netAmount).add(Money.fromDb(row.feeAmount)).toString(),
    status: row.status,
    payoutMethod: row.payoutMethod,
    payoutDetails: (row.payoutDetails as PayoutDetails | null) ?? null,
    externalReference: row.externalReference,
    requestedById: row.requestedById,
    approvedById: row.approvedById,
    notes: row.notes,
    adminNotes: row.adminNotes,
    processedAt: row.processedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
