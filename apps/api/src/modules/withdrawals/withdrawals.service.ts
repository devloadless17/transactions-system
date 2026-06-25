import { Injectable, Logger, StreamableFile } from '@nestjs/common';
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
  type ResolveProcessingInput,
  type WithdrawalResponse,
  type WithdrawalStatus,
} from '@app/shared';
import { Prisma } from '@app/db';
import type { PrismaClient, Withdrawal } from '@app/db';
import { PrismaService } from '../../database/prisma.service';
import { LedgerService } from '../ledger/ledger.service';
import { WalletsService } from '../wallets/wallets.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { RealtimeService } from '../realtime/realtime.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CacheService } from '../cache/cache.service';
import { FeesService } from '../commissions/fees.service';
import { CrmDispatchService } from '../crm/crm-dispatch.service';
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
    private readonly crm: CrmDispatchService,
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
    const response = mapWithdrawal(row);
    // Push the new withdrawal to the company's CRM (guarded, fire-and-forget).
    this.crm.emitWithdrawal(response, 'withdrawal.pending');
    return response;
  }

  /**
   * Settle a withdrawal (manual approve or auto-approval). `approvedById` is null
   * for the automated path (system actor). Accepts `PENDING` (manual queue) or
   * `PROCESSING` (auto-approval claimed it before transferring) — both are
   * pre-settlement states; the serializable tx + status guard keep it single-shot.
   */
  async approve(
    id: string,
    approvedById: string | null,
    input: ApproveWithdrawalInput,
    // floorWhole: settle to whole dollars (auto Whish W2W path). The recipient got
    // floor(net); the sub-dollar remainder stays with the platform (rolled into the
    // realized FEE) and is recorded as rounding_remainder. Manual approvals omit it.
    opts?: { floorWhole?: boolean },
  ): Promise<WithdrawalResponse> {
    const pre = await this.prisma.runAsAdmin((tx) =>
      tx.withdrawal.findUnique({ where: { id }, select: { companyId: true } }),
    );
    if (!pre) throw new NotFoundError('Withdrawal', id);
    const row = await this.prisma.runSerializableAsTenant(pre.companyId, async (tx) => {
      const cTx = tx as unknown as PrismaClient;

      const w = await cTx.withdrawal.findUnique({ where: { id } });
      if (!w) throw new NotFoundError('Withdrawal', id);
      if (w.status !== 'PENDING' && w.status !== 'PROCESSING') {
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
      const net = netOfFee(amount, fee, w.feeApplication);
      // The money that actually leaves. floorWhole sends whole dollars and keeps
      // the cents; otherwise the recipient gets the full net.
      const external = opts?.floorWhole ? net.floorToWhole() : net;
      // What the platform realizes = original fee + any floored remainder. By
      // construction `external + feeRealized == reserved`, so debits == credits.
      const feeRealized = reserved.sub(external);
      const rounding = net.sub(external); // 0 unless floored

      // Funds leave the platform; the fee (incl. any rounding) is realized to FEE.
      // Ledger: reserved → external + FEE(feeRealized). Zero lines are skipped.
      await this.ledger.writeEntries(
        cTx,
        settleEntries(
          { withdrawalId: w.id },
          w.companyId,
          w.currency,
          reserved,
          external,
          feeRealized,
        ),
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
          approvedById: approvedById ?? null,
          processedAt: new Date(),
          // Admin's note → admin_notes; NEVER overwrite the company's request note.
          adminNotes: input.notes ?? undefined,
          externalReference: input.externalReference,
          roundingRemainder: rounding.toString(),
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
    const response = mapWithdrawal(row);
    // Approval settles in one step → the CRM sees the completed payout, now
    // carrying the fee/net breakdown and the off-platform externalReference.
    this.crm.emitWithdrawal(response, 'withdrawal.completed');
    return response;
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
          // An admin REJECT records its reason in admin_notes (shown to the
          // company); a company self-cancel leaves it untouched. The company's
          // original request note in `notes` is never overwritten.
          adminNotes: opts.status === 'REJECTED' ? (notes ?? undefined) : undefined,
        },
      });
    });

    await this.invalidateAnalytics();
    this.notify(row.companyId);
    // Only an admin reject notifies the company; a company self-cancel doesn't.
    // Either way the request is resolved, so clear the admin queue notification
    // (requestResolved does this for REJECTED; do it directly for CANCELLED).
    if (opts.status === 'REJECTED') {
      void this.notifications.requestResolved({
        flow: 'WITHDRAWAL',
        event: 'REJECTED',
        companyId: row.companyId,
        entityId: row.id,
        amount: row.amount.toString(),
        currency: row.currency,
      });
    } else {
      void this.notifications.clearAdminRequest({ flow: 'WITHDRAWAL', entityId: row.id });
    }
    const response = mapWithdrawal(row);
    // Tell the CRM the request closed without paying out — the admin's reason is
    // carried on a rejection so the company's CRM can record why.
    this.crm.emitWithdrawal(
      response,
      opts.status === 'REJECTED' ? 'withdrawal.rejected' : 'withdrawal.cancelled',
    );
    return response;
  }

  // ---------------- Auto-approval support ----------------
  // These power the background WithdrawalAutoApprovalService. The claim
  // (PENDING→PROCESSING) is the lock that makes a transfer and a company cancel
  // mutually exclusive: cancel()/reject() guard `status === 'PENDING'`, so once a
  // row is PROCESSING they're refused and money can't be paid for a cancelled
  // withdrawal.

  /**
   * Atomically claim a PENDING withdrawal for auto-processing (→ PROCESSING).
   * Returns false if it's no longer PENDING (cancelled/raced) — caller skips it.
   */
  async claimForProcessing(id: string, companyId: string): Promise<boolean> {
    const claimed = await this.prisma.runSerializableAsTenant(companyId, async (tx) => {
      const cTx = tx as unknown as PrismaClient;
      const w = await cTx.withdrawal.findUnique({ where: { id } });
      if (!w || w.companyId !== companyId || w.status !== 'PENDING') return false;
      await cTx.withdrawal.update({
        where: { id },
        data: {
          status: 'PROCESSING',
          metadata: mergeAutoMeta(w.metadata, {
            status: 'PROCESSING',
            attemptedAt: new Date().toISOString(),
          }),
        },
      });
      return true;
    });
    if (claimed) this.notify(companyId);
    return claimed;
  }

  /** Revert a claimed row back to PENDING (clean failure / session expired). */
  async revertFromProcessing(id: string, companyId: string, auto: AutoApprovalMeta): Promise<void> {
    await this.prisma.runSerializableAsTenant(companyId, async (tx) => {
      const cTx = tx as unknown as PrismaClient;
      const w = await cTx.withdrawal.findUnique({ where: { id } });
      if (!w || w.status !== 'PROCESSING') return;
      await cTx.withdrawal.update({
        where: { id },
        data: { status: 'PENDING', metadata: mergeAutoMeta(w.metadata, auto) },
      });
    });
    this.notify(companyId);
  }

  /** Merge auto-approval metadata without changing status (UNKNOWN / settle-retry flags). */
  async setAutoMeta(id: string, companyId: string, auto: AutoApprovalMeta): Promise<void> {
    await this.prisma.runSerializableAsTenant(companyId, async (tx) => {
      const cTx = tx as unknown as PrismaClient;
      const w = await cTx.withdrawal.findUnique({ where: { id } });
      if (!w) return;
      await cTx.withdrawal.update({
        where: { id },
        data: { metadata: mergeAutoMeta(w.metadata, auto) },
      });
    });
  }

  /**
   * Operator escape hatch for a row stuck in PROCESSING (an UNKNOWN transfer the
   * operator has reconciled by hand): CONFIRM the money moved and settle, or
   * REVERT to PENDING (money did NOT move) so it can be retried/rejected.
   */
  async resolveProcessing(
    id: string,
    actorId: string,
    input: ResolveProcessingInput,
  ): Promise<WithdrawalResponse> {
    if (input.action === 'complete') {
      if (!input.externalReference) {
        throw new ValidationError('externalReference is required to complete a transfer');
      }
      // A PROCESSING row is always an auto Whish transfer → settle whole-dollar.
      return this.approve(
        id,
        actorId,
        { externalReference: input.externalReference, notes: input.notes },
        { floorWhole: true },
      );
    }
    const pre = await this.prisma.runAsAdmin((tx) =>
      tx.withdrawal.findUnique({ where: { id }, select: { companyId: true, status: true } }),
    );
    if (!pre) throw new NotFoundError('Withdrawal', id);
    if (pre.status !== 'PROCESSING') {
      throw new ConflictError(`Withdrawal is in status ${pre.status}, not PROCESSING`);
    }
    await this.revertFromProcessing(id, pre.companyId, {
      status: 'FAILED',
      terminal: true,
      needsReconcile: false,
      needsAttention: false,
      errorDetail: 'operator_reverted',
    });
    return this.getById(id);
  }

  /**
   * PENDING WISH/USD withdrawals eligible for auto-approval: past the hold window,
   * created after the toggle was enabled, under the cap, and not already terminal
   * (a prior auto attempt failed → left for manual). Admin-scoped (cross-company).
   */
  async findAutoApprovalCandidates(opts: {
    holdSeconds: number;
    enabledAt: Date;
    maxAutoApproveAmount: string;
    limit: number;
  }): Promise<Withdrawal[]> {
    const cutoff = new Date(Date.now() - opts.holdSeconds * 1000);
    const rows = await this.prisma.runAsAdmin((tx) =>
      tx.withdrawal.findMany({
        where: {
          status: 'PENDING',
          payoutMethod: 'WISH',
          currency: 'USD',
          // >= 1 so flooring to whole dollars still transfers something; sub-$1
          // nets stay manual. <= the configured cap.
          netAmount: {
            gte: new Prisma.Decimal(1),
            lte: new Prisma.Decimal(opts.maxAutoApproveAmount),
          },
          createdAt: { lte: cutoff, gte: opts.enabledAt },
        },
        orderBy: { createdAt: 'asc' },
        // Over-fetch so terminal rows (filtered in JS below) can't starve fresh
        // ones, then slice to the batch.
        take: Math.max(opts.limit * 4, 100),
      }),
    );
    // Exclude rows a prior auto attempt marked terminal (failed → left for
    // manual). MUST be done in JS, not SQL: a Postgres `NOT (json_path = true)`
    // predicate is NULL for a row with NULL metadata — which is EVERY normal
    // UI-created withdrawal — so it silently drops them and nothing is processed.
    return rows.filter((r) => !autoMetaFlag(r.metadata, 'terminal')).slice(0, opts.limit);
  }

  /**
   * Rows stuck in PROCESSING that the processor should resolve (crash recovery /
   * settle-retry). Excludes UNKNOWN rows already flagged `needsReconcile` — those
   * wait for the operator escape hatch, never auto-touched again.
   */
  async findStuckProcessing(limit: number): Promise<Withdrawal[]> {
    const rows = await this.prisma.runAsAdmin((tx) =>
      tx.withdrawal.findMany({
        where: { status: 'PROCESSING' },
        orderBy: { createdAt: 'asc' },
        take: Math.max(limit * 4, 100),
      }),
    );
    // Skip UNKNOWN rows already flagged for operator reconcile; resolve the rest.
    // JS filter (not SQL) for the same NULL-metadata three-valued-logic reason.
    return rows.filter((r) => !autoMetaFlag(r.metadata, 'needsReconcile')).slice(0, limit);
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

  /**
   * Stream ALL withdrawals matching the filters as CSV (no row cap), walked in
   * keyset chunks. Mirrors the list query's filters so the export matches what
   * the user sees. Each chunk is its own short RLS-scoped query.
   */
  streamCsv(args: { companyId?: string; query: ListWithdrawalsQuery }): StreamableFile {
    const where = this.exportWhere(args);
    const scope = args.companyId ?? null;
    const prisma = this.prisma;
    return streamFlowCsv({
      noun: 'withdrawals',
      now: Date.now(),
      baseWhere: where as Record<string, unknown>,
      findPage: (pageWhere, take) =>
        prisma.runAsScoped(scope, (tx) =>
          tx.withdrawal.findMany({
            where: pageWhere as Prisma.WithdrawalWhereInput,
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            take,
          }),
        ),
    });
  }

  private exportWhere(args: {
    companyId?: string;
    query: ListWithdrawalsQuery;
  }): Prisma.WithdrawalWhereInput {
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
    return where;
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
  roundingRemainder: { toString(): string };
  status: WithdrawalStatus;
  payoutMethod: PayoutMethod;
  payoutDetails: unknown;
  externalReference: string | null;
  requestedById: string | null;
  approvedById: string | null;
  notes: string | null;
  adminNotes: string | null;
  metadata: unknown;
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
    roundingRemainder: row.roundingRemainder.toString(),
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
    adminNotes: row.adminNotes,
    processedAt: row.processedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    autoApproval: autoApprovalSummary(row.metadata),
  };
}

/** Project the stored autoApproval metadata into the (admin-visible) summary. */
function autoApprovalSummary(metadata: unknown): WithdrawalResponse['autoApproval'] {
  if (!metadata || typeof metadata !== 'object') return null;
  const a = (metadata as Record<string, unknown>).autoApproval;
  if (!a || typeof a !== 'object') return null;
  const m = a as Record<string, unknown>;
  return {
    status: String(m.status ?? 'UNKNOWN'),
    needsReconcile: m.needsReconcile === true ? true : undefined,
    needsAttention: m.needsAttention === true ? true : undefined,
    terminal: m.terminal === true ? true : undefined,
    errorDetail: typeof m.errorDetail === 'string' ? m.errorDetail : undefined,
  };
}

/** Auto-approval bookkeeping stored under `withdrawal.metadata.autoApproval`. */
export interface AutoApprovalMeta {
  status: 'PROCESSING' | 'SUCCESS' | 'FAILED' | 'UNKNOWN' | 'SESSION_EXPIRED';
  reference?: string;
  traceId?: string | null;
  errorDetail?: string;
  needsReconcile?: boolean;
  needsAttention?: boolean;
  terminal?: boolean;
  attemptedAt?: string;
}

/** Read a boolean flag off `metadata.autoApproval` (null/absent → false). */
function autoMetaFlag(
  metadata: unknown,
  flag: 'terminal' | 'needsReconcile' | 'needsAttention',
): boolean {
  if (!metadata || typeof metadata !== 'object') return false;
  const a = (metadata as Record<string, unknown>).autoApproval;
  if (!a || typeof a !== 'object') return false;
  return (a as Record<string, unknown>)[flag] === true;
}

/** Merge an autoApproval patch into existing metadata (never drops apiKeyId etc.). */
function mergeAutoMeta(existing: unknown, auto: AutoApprovalMeta): Prisma.InputJsonValue {
  const base =
    existing && typeof existing === 'object' ? (existing as Record<string, unknown>) : {};
  const prevAuto =
    base.autoApproval && typeof base.autoApproval === 'object'
      ? (base.autoApproval as Record<string, unknown>)
      : {};
  return { ...base, autoApproval: { ...prevAuto, ...auto } } as Prisma.InputJsonValue;
}
