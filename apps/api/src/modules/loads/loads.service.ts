import { Injectable, Logger, StreamableFile } from '@nestjs/common';
import {
  Money,
  MONEY_SCALE_LABEL,
  type AdminLoadInput,
  type ApproveLoadInput,
  type CancelRequestInput,
  type CreateLoadInput,
  type FeeApplication,
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
import { netOfFee, reservedTotal } from '../ledger/flow-ledger';
import { WalletsService } from '../wallets/wallets.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { RealtimeService } from '../realtime/realtime.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CacheService } from '../cache/cache.service';
import { FeesService } from '../commissions/fees.service';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/domain.error';
import { assertListOffset } from '../../common/pagination';
import { streamFlowCsv } from '../../common/flow-csv';

const REQUESTABLE_STATUS: WithdrawalStatus = 'PENDING';

// Per-(filter) list COUNT cached briefly so paging reuses it instead of re-running
// COUNT(*) on every page — mirrors the transactions/ledger lists. Rows stay live;
// the total may lag by up to this window. TTL-only (not invalidated on write).
const LIST_COUNT_CACHE_TTL_SEC = 30;

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
    private readonly notifications: NotificationsService,
    private readonly cache: CacheService,
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
    requestedById: string | null,
    input: CreateLoadInput,
    requestedByKeyId?: string | null,
    opts?: { silent?: boolean },
  ): Promise<LoadResponse> {
    // Quantized at the boundary — the HTTP schema already does this, but internal
    // callers (e.g. the admin direct load) reach this method directly.
    const amount = Money.of(input.amount).round();
    if (!amount.isPositive())
      throw new ValidationError(`amount must be positive at up to ${MONEY_SCALE_LABEL}`);

    const row = await this.prisma.runSerializableAsTenant(companyId, async (tx) => {
      const cTx = tx as unknown as PrismaClient;

      const { fee, feeApplication } = await this.fees.resolveFlowFee(cTx, {
        companyId,
        amount,
        operationType: 'LOAD',
      });
      // Net credited to the wallet on approval.
      const net = netOfFee(amount, fee, feeApplication);
      // Mirror withdrawals/payouts: a fee that consumes the ENTIRE amount is a
      // surely-misconfigured rule, and unlike a deposit (already-collected
      // money that must book), a load REQUEST can safely be rejected up front —
      // before the company hands over real cash for a net-0 credit.
      if (!net.isPositive()) {
        throw new ValidationError(
          `The ${fee.toString()} ${input.currency} fee consumes the entire amount — nothing would be credited. Increase the amount or fix the fee rule.`,
          { amount: amount.toString(), fee: fee.toString() },
        );
      }

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
          metadata: requestedByKeyId ? { apiKeyId: requestedByKeyId } : undefined,
        },
      });
    });

    await this.invalidateAnalytics();
    this.notify(row.companyId);
    // Admin-initiated loads pass silent: the admin is doing it directly, so
    // there's no incoming request for admins to action.
    if (!opts?.silent) {
      void this.notifications.requestSubmitted({
        flow: 'LOAD',
        companyId: row.companyId,
        entityId: row.id,
        amount: row.amount.toString(),
        currency: row.currency,
      });
    }
    return mapLoad(row);
  }

  /**
   * Super-admin direct load: credit a company's wallet for funds received
   * off-platform, without the company filing a request. Implemented as
   * request → approve so the commission resolution, ledger entries, and wallet
   * credit are identical to accepting a company-requested load. The company is
   * notified (their balance changed); admins are not (we did it ourselves).
   */
  async adminLoad(
    companyId: string,
    adminId: string,
    input: AdminLoadInput,
  ): Promise<LoadResponse> {
    const pending = await this.request(
      companyId,
      adminId,
      {
        amount: input.amount,
        currency: input.currency,
        notes: input.notes,
        payout: input.payout,
      },
      null,
      { silent: true },
    );
    return this.approve(pending.id, adminId, {
      externalReference: input.externalReference ?? 'Direct admin load',
      notes: input.notes,
    });
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

      // fromDb: quantize the stored inputs once; the remaining legs derive from them.
      const amount = Money.fromDb(l.amount);
      const fee = Money.fromDb(l.feeAmount);
      const externalDebit = reservedTotal(amount, fee, l.feeApplication);
      const availableCredit = netOfFee(amount, fee, l.feeApplication);

      // Incoming funds settle any outstanding RECEIVABLE (debt the company owes
      // the platform from a prior reversal clawback) FIRST; the remainder credits
      // available. Money-out (withdrawals/payouts) is already blocked while owing,
      // but the platform otherwise has NO settlement path — so a top-up is how a
      // company clears its debt. Only fires when owed > 0; otherwise this is a
      // no-op and the common load path is unchanged.
      // `owed` is a SUM over ledger history, so it can carry a wider tail than the
      // money scale. floorToScale, never ceil: crediting MORE receivable than the
      // ledger actually records would drive that account permanently negative and
      // over-collect from the company. A sub-cent residue is left unsettled here
      // and must be written off deliberately, not invented at settlement time.
      const owed = (
        await this.ledger.outstandingReceivable(cTx, l.companyId, l.currency)
      ).floorToScale();
      const settle = owed.isPositive()
        ? owed.gt(availableCredit)
          ? availableCredit
          : owed
        : Money.zero();
      const creditToAvailable = availableCredit.sub(settle);

      // Money in: DEBIT external; CREDIT receivable(settle) + available(remainder)
      // + fee. Stays balanced: settle + remainder + fee == net + fee == external.
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
      if (settle.isPositive()) {
        entries.push({
          companyId: l.companyId,
          loadId: l.id,
          accountType: 'RECEIVABLE',
          direction: 'CREDIT',
          amount: settle,
          currency: l.currency,
          metadata: { kind: 'receivable_settlement' },
        });
      }
      if (creditToAvailable.isPositive()) {
        entries.push({
          companyId: l.companyId,
          loadId: l.id,
          accountType: 'AVAILABLE',
          direction: 'CREDIT',
          amount: creditToAvailable,
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
        delta: { available: creditToAvailable },
      });
      if (settle.isPositive()) {
        this.logger.log(
          `load ${l.id} co=${l.companyId} settled RECEIVABLE=${settle.toString()} ${l.currency.trim()} from incoming funds`,
        );
      }

      return cTx.load.update({
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
      flow: 'LOAD',
      event: 'APPROVED',
      companyId: row.companyId,
      entityId: row.id,
      amount: row.amount.toString(),
      currency: row.currency,
    });
    return mapLoad(row);
  }

  async reject(id: string, approvedById: string, input: RejectLoadInput): Promise<LoadResponse> {
    return this.close(id, input.notes, { approvedById, status: 'REJECTED' });
  }

  /** Company-initiated cancel of a PENDING load (status-only; nothing moved). */
  async cancel(
    id: string,
    companyId: string,
    cancelledById: string | null,
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
      cancelledById?: string | null;
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
    // (requestResolved handles REJECTED; clear directly for CANCELLED). A
    // silently-created (admin-direct) load has no admin notification, so this is
    // a harmless no-op there.
    if (opts.status === 'REJECTED') {
      void this.notifications.requestResolved({
        flow: 'LOAD',
        event: 'REJECTED',
        companyId: row.companyId,
        entityId: row.id,
        amount: row.amount.toString(),
        currency: row.currency,
      });
    } else {
      void this.notifications.clearAdminRequest({ flow: 'LOAD', entityId: row.id });
    }
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
      if (args.query.from || args.query.to) {
        where.createdAt = {
          ...(args.query.from ? { gte: new Date(args.query.from) } : {}),
          ...(args.query.to ? { lte: new Date(args.query.to) } : {}),
        };
      }

      const skip = (args.query.page - 1) * args.query.pageSize;
      assertListOffset(skip);
      const countKey =
        `list-count:ld:${args.companyId ?? args.query.companyId ?? 'all'}` +
        `:${args.query.status ?? ''}:${args.query.currency ?? ''}:${args.query.payoutMethod ?? ''}` +
        `:${args.query.from ?? ''}:${args.query.to ?? ''}`;
      const [rows, total] = await Promise.all([
        tx.load.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          skip,
          take: args.query.pageSize,
        }),
        // singleFlight:false — runs inside the caller's tx; compute-on-miss, never
        // block on the cross-request poll (which would pin this pooled connection).
        this.cache.wrap(countKey, LIST_COUNT_CACHE_TTL_SEC, () => tx.load.count({ where }), {
          singleFlight: false,
        }),
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

  /**
   * Stream ALL loads matching the filters as CSV (no row cap), walked in keyset
   * chunks. Mirrors the list query's filters; each chunk is its own short
   * RLS-scoped query.
   */
  streamCsv(args: { companyId?: string; query: ListLoadsQuery }): StreamableFile {
    const where = this.exportWhere(args);
    const scope = args.companyId ?? null;
    const prisma = this.prisma;
    return streamFlowCsv({
      noun: 'loads',
      now: Date.now(),
      baseWhere: where as Record<string, unknown>,
      findPage: (pageWhere, take) =>
        prisma.runAsScoped(scope, (tx) =>
          tx.load.findMany({
            where: pageWhere as Prisma.LoadWhereInput,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take,
          }),
        ),
    });
  }

  private exportWhere(args: { companyId?: string; query: ListLoadsQuery }): Prisma.LoadWhereInput {
    const where: Prisma.LoadWhereInput = {};
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

function mapLoad(row: {
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
}): LoadResponse {
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
