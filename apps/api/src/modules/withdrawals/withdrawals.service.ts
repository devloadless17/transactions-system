import { Injectable, Logger } from '@nestjs/common';
import type { StreamableFile } from '@nestjs/common';
import {
  Money,
  MONEY_SCALE_LABEL,
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
import { WhishTransfersService } from '../whish/whish-transfers.service';
import { AutoApprovalConfigStore } from './auto-approval-config.store';
import {
  AUTO_APPROVE_CURRENCY,
  AUTO_APPROVE_METHOD,
  AUTO_APPROVE_MIN_NET,
  autoApprovalSkipReason,
  describeSkipReason,
  type W2WFailureCategory,
} from './auto-approval-rules';
import {
  assertSufficient,
  type FeeParts,
  feesConsumeAmountError,
  grossOf,
  netOfFee,
  releaseEntries,
  reservedTotal,
  reserveEntries,
  settleEntries,
  storedFees,
} from '../ledger/flow-ledger';
import { ConflictError, NotFoundError, ValidationError } from '../../common/errors/domain.error';
import { assertListOffset } from '../../common/pagination';
import { streamFlowCsv } from '../../common/flow-csv';
import {
  searchCount,
  searchKeysetIds,
  searchPageIds,
  type SearchListFilters,
} from '../../common/search';

const REQUESTABLE_STATUS: WithdrawalStatus = 'PENDING';

/** Cap the (uncached) config + Whish-session reads behind the Telegram alert. */
const ELIGIBILITY_TIMEOUT_MS = 5_000;

/** Reject if `p` hasn't settled within `ms`. Clears its timer either way. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([p, expiry]).finally(() => clearTimeout(timer));
}

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
    // Read-only, used post-commit to predict whether auto-approval will pick a
    // withdrawal up. `AutoApprovalConfigStore` is a leaf (Prisma only) and
    // `WhishTransfersService` never injects us back, so neither creates a cycle.
    private readonly autoApprovalConfig: AutoApprovalConfigStore,
    private readonly transfers: WhishTransfersService,
  ) {}

  /**
   * Outstanding debt, quantized to the platform money scale.
   *
   * MUST match how loads SETTLE that debt (loads.service floors it too). If the
   * block and the settlement disagree, a sub-cent residue becomes unclearable:
   * every withdrawal 409s "outstanding balance owed" forever, while no load can
   * ever bring it to zero. Flooring on both sides means a residue below one cent
   * neither blocks money-out nor needs clearing.
   */
  private async quantizedOwed(
    tx: PrismaClient,
    companyId: string,
    currency: string,
  ): Promise<Money> {
    return (await this.ledger.outstandingReceivable(tx, companyId, currency)).floorToScale();
  }

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
    // Quantized at the boundary, DOWNWARD: the HTTP schema already does this, but
    // internal callers reach this method directly. Rounding down (never up) means
    // we can never reserve or pay out more than was actually requested.
    const amount = Money.of(input.amount).floorToScale();
    if (!amount.isPositive())
      throw new ValidationError(`amount must be positive at up to ${MONEY_SCALE_LABEL}`);

    const row = await this.prisma.runSerializableAsTenant(companyId, async (tx) => {
      const cTx = tx as unknown as PrismaClient;

      // Block money-out while the company owes the platform (e.g. from a
      // reversal clawback that exceeded its balance). It must settle first.
      const owed = await this.quantizedOwed(cTx, companyId, input.currency);
      if (owed.isPositive()) {
        throw new ConflictError(
          `Outstanding balance of ${owed.toString()} ${input.currency} owed to the platform must be settled before withdrawing`,
          { currency: input.currency, outstanding: owed.toString() },
        );
      }

      // Resolve the WITHDRAWAL fees (commission free if no rule; network fee 0
      // unless the company's switch is on). ON_TOP reserves amount + fees;
      // DEDUCTED reserves amount and the recipient gets amount − fees.
      const { fees, feeApplication } = await this.fees.resolveFlowFee(cTx, {
        companyId,
        amount,
        operationType: 'WITHDRAWAL',
      });
      const reserved = reservedTotal(amount, fees, feeApplication);
      const net = netOfFee(amount, fees, feeApplication);

      // DEDUCTED fees >= amount would make the recipient receive 0 while the
      // full amount still leaves the wallet to the platform fee accounts — a
      // balanced but surely-misconfigured money-out. Reject clearly at request
      // time, before anything is reserved. (ON_TOP nets = amount, so this can
      // only trip on DEDUCTED fees; deposits are untouched.)
      if (!net.isPositive()) {
        throw feesConsumeAmountError(amount, fees, input.currency, 'the recipient would receive 0');
      }

      // Clear "top up" error if available can't cover the reserved total.
      await assertSufficient(cTx, companyId, input.currency, reserved);

      const w = await cTx.withdrawal.create({
        data: {
          companyId,
          requestedById,
          amount: amount.toString(),
          currency: input.currency,
          feeAmount: fees.commission.toString(),
          networkFeeAmount: fees.network.toString(),
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
    // Unlike loads/payouts, a withdrawal only pages a human when auto-approval
    // will NOT pick it up (over the cap, cash/crypto, non-USD, sub-$1 net, or the
    // feature is off/paused). The reason is resolved lazily — AFTER the in-app
    // notification is created, and only if Telegram is configured — so its DB
    // reads can never delay or lose the admin's queue entry.
    void this.notifications.requestSubmitted({
      flow: 'WITHDRAWAL',
      companyId: row.companyId,
      entityId: row.id,
      // What the operator pays the recipient — the one figure admins (incl.
      // back office) act on; never a figure a fee could be derived from.
      amount: Money.fromDb(row.netAmount).toString(),
      currency: row.currency,
      resolveManualActionReason: () => this.resolveManualReason(row),
    });
    const response = mapWithdrawal(row);
    // Push the new withdrawal to the company's CRM (guarded, fire-and-forget).
    this.crm.emitWithdrawal(response, 'withdrawal.pending');
    return response;
  }

  /**
   * Why a human must action this withdrawal, or `null` if auto-approval will
   * settle it (in which case no one is alerted). Predicts the poller's decision
   * using the shared rules, against the NET amount — the cap is applied after the
   * fee, so a gross over the cap can still auto-approve.
   *
   * Fails LOUD: if the config or Whish session can't be read we return a reason
   * anyway, so a lookup blip produces a spurious ping rather than a withdrawal
   * that silently waits for someone who was never told.
   */
  private async resolveManualReason(row: Withdrawal): Promise<string | null> {
    const netAmount = row.netAmount.toString();
    try {
      // Bounded: these are uncached admin transactions, and a stalled Postgres
      // must degrade to "alert anyway", never to a promise that never settles.
      const [state, session] = await withTimeout(
        Promise.all([this.autoApprovalConfig.getState(), this.transfers.sessionStatus()]),
        ELIGIBILITY_TIMEOUT_MS,
        'auto-approval eligibility lookup',
      );
      const reason = autoApprovalSkipReason(
        { payoutMethod: row.payoutMethod, currency: row.currency, netAmount },
        {
          enabled: state.enabled,
          enabledAt: state.enabledAt,
          circuitBreakerTrippedAt: state.circuitBreakerTrippedAt,
          maxAutoApproveAmount: state.maxAutoApproveAmount,
          w2wEnabled: this.transfers.isW2WEnabled(),
          session,
          simulate: this.autoApprovalConfig.simulationMode,
        },
      );
      if (!reason) return null;
      return describeSkipReason(reason, {
        payoutMethod: row.payoutMethod,
        currency: row.currency,
        netAmount,
        maxAutoApproveAmount: state.maxAutoApproveAmount,
      });
    } catch (e) {
      this.logger.warn(
        `could not determine auto-approval eligibility for withdrawal ${row.id}; alerting anyway: ${(e as Error).message}`,
      );
      return 'eligibility unknown — check manually';
    }
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
    // skipReceivableBlock: settle even if the company now owes a RECEIVABLE — used
    // ONLY when the W2W transfer already SUCCEEDED (money physically left, so the
    // ledger MUST record it; the debt stays outstanding and still blocks NEW money-out).
    // requireProcessing: refuse anything but a PROCESSING row — for the operator's
    // "the transfer did go through" confirmation, which must never settle a PENDING
    // row (no transfer was ever attempted for it) with the two options above.
    opts?: { skipReceivableBlock?: boolean; requireProcessing?: boolean },
  ): Promise<WithdrawalResponse> {
    const pre = await this.prisma.runAsAdmin((tx) =>
      tx.withdrawal.findUnique({ where: { id }, select: { companyId: true } }),
    );
    if (!pre) throw new NotFoundError('Withdrawal', id);
    // The Whish W2W transfer made for this withdrawal, if any (admin-only RLS, so
    // read here, outside the tenant transaction). Its amount is what actually left.
    const sent = await this.prisma.runAsAdmin((tx) =>
      tx.whishTransfer.findUnique({ where: { withdrawalId: id }, select: { amount: true } }),
    );
    const row = await this.prisma.runSerializableAsTenant(pre.companyId, async (tx) => {
      const cTx = tx as unknown as PrismaClient;

      const w = await cTx.withdrawal.findUnique({ where: { id } });
      if (!w) throw new NotFoundError('Withdrawal', id);
      if (w.status !== 'PENDING' && w.status !== 'PROCESSING') {
        throw new ConflictError(`Withdrawal is in status ${w.status} and cannot be approved`);
      }
      // Checked HERE, inside the serializable transaction, so a concurrent revert
      // of the same row can't slip between the check and the settlement.
      if (opts?.requireProcessing && w.status !== 'PROCESSING') {
        throw new ConflictError(`Withdrawal is in status ${w.status}, not PROCESSING`);
      }

      // A reversal may have booked a RECEIVABLE for this company AFTER this
      // withdrawal reserved its funds (clawback claims `available`, not the
      // reserved bucket). Re-assert the money-out block at approval so reserved
      // funds can't leave while the company owes the platform — mirrors request().
      // Skipped only when settling a transfer that ALREADY left (skipReceivableBlock):
      // the money is gone, so the ledger MUST book it; the debt remains outstanding.
      if (!opts?.skipReceivableBlock) {
        const owed = await this.quantizedOwed(cTx, w.companyId, w.currency);
        if (owed.isPositive()) {
          throw new ConflictError(
            `Outstanding balance of ${owed.toString()} ${w.currency} owed to the platform must be settled before this withdrawal can be approved`,
            { currency: w.currency, outstanding: owed.toString() },
          );
        }
      }

      // fromDb: a legacy row can carry a wider tail than the money scale; quantize
      // the INPUTS once here and derive reserved/net/fees by exact subtraction.
      // Both fees were frozen on the row at request time.
      const amount = Money.fromDb(w.amount);
      const fees = storedFees(w.feeAmount, w.networkFeeAmount);
      const reserved = reservedTotal(amount, fees, w.feeApplication);
      const net = netOfFee(amount, fees, w.feeApplication);
      // The money that actually leaves = the full net. A PROCESSING row is an auto
      // Whish transfer, so book exactly what was SENT: the full net to the cent
      // today, but a transfer fired before 2dp sending was whole dollars (floor of
      // the net) — those cents stay with the platform as the rounding remainder.
      let external = net;
      if (w.status === 'PROCESSING' && sent) {
        external = Money.fromDb(sent.amount);
        if (external.gt(net) || !external.isPositive()) {
          throw new ConflictError(
            `Whish transfer amount ${external.toString()} does not fit net ${net.toString()} ${w.currency}`,
          );
        }
      }
      // What the platform realizes = both original fees + any legacy remainder,
      // which stays on FEE (so true commission = FEE − Σ rounding_remainder still
      // holds). By construction external + commission + network == reserved,
      // so debits == credits.
      const realized: FeeParts = {
        commission: reserved.sub(external).sub(fees.network),
        network: fees.network,
      };
      const rounding = net.sub(external); // 0 unless a legacy whole-dollar transfer

      // Funds leave the platform; the fees (incl. any rounding) are realized to
      // FEE and NETWORK_FEE. Ledger: reserved → external + FEE + NETWORK_FEE.
      // Zero lines are skipped.
      await this.ledger.writeEntries(
        cTx,
        settleEntries(
          { withdrawalId: w.id },
          w.companyId,
          w.currency,
          reserved,
          external,
          realized,
        ),
      );
      await this.wallets.applyDelta(cTx, {
        companyId: w.companyId,
        currency: w.currency,
        delta: { reserved: reserved.mul(-1) },
      });

      // If this row went through auto-approval (it carries autoApproval metadata),
      // clear the transient stuck flags now that it has settled to COMPLETED — else a
      // settle-fail-then-retry-succeed leaves a permanent stale "needs attention"
      // badge on a fully-settled withdrawal. No-op for manual approvals.
      const settledAutoMeta =
        autoMetaStatus(w.metadata) !== null
          ? mergeAutoMeta(w.metadata, {
              status: 'SUCCESS',
              needsAttention: false,
              needsReconcile: false,
            })
          : undefined;

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
          ...(settledAutoMeta ? { metadata: settledAutoMeta } : {}),
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
        Money.fromDb(w.amount),
        storedFees(w.feeAmount, w.networkFeeAmount),
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
      // Never auto-pay a company that owes the platform (e.g. a reversal clawback
      // booked a RECEIVABLE after the request). Leave it PENDING for manual review
      // — approve() enforces the same block, but the auto transfer fires BEFORE
      // approve(), so we must re-assert it here or money could leave despite the debt.
      const owed = await this.quantizedOwed(cTx, w.companyId, w.currency);
      if (owed.isPositive()) return false;
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
    const flagged = await this.prisma.runSerializableAsTenant(companyId, async (tx) => {
      const cTx = tx as unknown as PrismaClient;
      const w = await cTx.withdrawal.findUnique({ where: { id } });
      if (!w) return null;
      await cTx.withdrawal.update({
        where: { id },
        data: { metadata: mergeAutoMeta(w.metadata, auto) },
      });
      // Newly handed to a person: the transfer's outcome is unknown.
      return auto.needsReconcile === true && !autoMetaFlag(w.metadata, 'needsReconcile') ? w : null;
    });
    // These flags (needsReconcile / needsAttention / UNKNOWN) are the operator-
    // actionable stuck-money signals; emit so the admin queue + Resolve-processing
    // escape hatch update live, mirroring every other mutator (revertFromProcessing).
    this.notify(companyId);
    // Post-commit and best-effort (it never throws): the money stays held until
    // someone resolves it, so ring every admin's bell once, when it happens.
    if (flagged) {
      void this.notifications.withdrawalNeedsDecision({
        companyId,
        entityId: flagged.id,
        amount: Money.fromDb(flagged.netAmount).toString(),
        currency: flagged.currency,
      });
    }
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
      // Operator confirms the money moved → settle what was sent, and past any
      // receivable that appeared after the transfer (the cash already left).
      // Only a PROCESSING row has a transfer to confirm: a PENDING one settled
      // this way would pay out past a debt for a transfer that never happened.
      return this.approve(
        id,
        actorId,
        { externalReference: input.externalReference, notes: input.notes },
        { skipReceivableBlock: true, requireProcessing: true },
      );
    }
    const pre = await this.prisma.runAsAdmin((tx) =>
      tx.withdrawal.findUnique({
        where: { id },
        select: { companyId: true, status: true, metadata: true },
      }),
    );
    if (!pre) throw new NotFoundError('Withdrawal', id);
    if (pre.status !== 'PROCESSING') {
      throw new ConflictError(`Withdrawal is in status ${pre.status}, not PROCESSING`);
    }
    // Refuse to revert a row whose transfer already SUCCEEDED (settle failed but the
    // money LEFT). Reverting → PENDING would let a later reject/cancel release the
    // reserved funds back to the company on top of the cash it already received —
    // a double-pay. Such a row can only be COMPLETEd.
    if (
      autoMetaFlag(pre.metadata, 'needsAttention') ||
      autoMetaStatus(pre.metadata) === 'SUCCESS'
    ) {
      throw new ConflictError(
        'This withdrawal’s transfer already succeeded (money left the platform). It can only be completed, not reverted — reverting would double-pay the company.',
      );
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
          // Scoping constants are shared with `autoApprovalSkipReason()` so the
          // poller and anything predicting its behaviour cannot drift apart.
          payoutMethod: AUTO_APPROVE_METHOD,
          currency: AUTO_APPROVE_CURRENCY,
          // >= the minimum (sub-$1 nets stay manual). <= the configured cap.
          netAmount: {
            gte: new Prisma.Decimal(AUTO_APPROVE_MIN_NET),
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
        `:${args.query.from ?? ''}:${args.query.to ?? ''}:${args.query.search ?? ''}`;
      // A search (phone, name, reference, id, note — common/search.ts) picks the
      // page and the total in SQL, index-backed; the rows still load through
      // Prisma, so the response is the same either way.
      const search = args.query.search;
      const searchFilters: SearchListFilters = {
        companyId: args.companyId ?? args.query.companyId,
        status: args.query.status,
        currency: args.query.currency,
        payoutMethod: args.query.payoutMethod,
        from: args.query.from,
        to: args.query.to,
      };
      const orderBy: Prisma.WithdrawalOrderByWithRelationInput[] = [
        { createdAt: 'desc' },
        { id: 'desc' },
      ];
      const [rows, total] = await Promise.all([
        search
          ? searchPageIds(tx, 'withdrawals', searchFilters, search, skip, args.query.pageSize).then(
              (ids) =>
                ids.length ? tx.withdrawal.findMany({ where: { id: { in: ids } }, orderBy }) : [],
            )
          : tx.withdrawal.findMany({ where, orderBy, skip, take: args.query.pageSize }),
        // singleFlight:false — runs inside the caller's tx; compute-on-miss, never
        // block on the cross-request poll (which would pin this pooled connection).
        this.cache.wrap(
          countKey,
          LIST_COUNT_CACHE_TTL_SEC,
          () =>
            search
              ? searchCount(tx, 'withdrawals', searchFilters, search)
              : tx.withdrawal.count({ where }),
          { singleFlight: false },
        ),
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
  async streamCsv(args: {
    companyId?: string;
    query: ListWithdrawalsQuery;
    /** Back office gets one money figure per row — see common/backoffice-view.ts. */
    backoffice?: boolean;
  }): Promise<StreamableFile> {
    const where = this.exportWhere(args);
    const scope = args.companyId ?? null;
    const prisma = this.prisma;
    return streamFlowCsv({
      noun: 'withdrawals',
      now: Date.now(),
      backoffice: args.backoffice ? 'pay' : undefined,
      baseWhere: where as Record<string, unknown>,
      // A searched export walks the search's ids (common/search.ts), chunk by
      // chunk, exactly like the list page — same rows, same order.
      fetchPage: args.query.search
        ? (cursor, take) => {
            const search = args.query.search!;
            const filters: SearchListFilters = {
              companyId: args.companyId ?? args.query.companyId,
              status: args.query.status,
              currency: args.query.currency,
              payoutMethod: args.query.payoutMethod,
              from: args.query.from,
              to: args.query.to,
            };
            return prisma.runAsScoped(scope, async (tx) => {
              const ids = await searchKeysetIds(tx, 'withdrawals', filters, search, cursor, take);
              return ids.length
                ? tx.withdrawal.findMany({
                    where: { id: { in: ids } },
                    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
                  })
                : [];
            });
          }
        : undefined,
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
  networkFeeAmount: { toString(): string };
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
    // Quantized on the way out so the API, the CSV export and the CRM webhook
    // all report the same figure — and the same figure the ledger books. Deriving
    // totalAmount from these (not from the raw columns) keeps
    // net + fee + networkFee == total exact, because a sum of at-scale values is
    // itself at scale.
    amount: Money.fromDb(row.amount).toString(),
    currency: row.currency.trim(),
    feeAmount: Money.fromDb(row.feeAmount).toString(),
    networkFeeAmount: Money.fromDb(row.networkFeeAmount).toString(),
    feeApplication: row.feeApplication,
    netAmount: Money.fromDb(row.netAmount).toString(),
    roundingRemainder: Money.fromDb(row.roundingRemainder).toString(),
    totalAmount: grossOf(
      Money.fromDb(row.netAmount),
      storedFees(row.feeAmount, row.networkFeeAmount),
    ).toString(),
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
    failureCategory: isW2WFailureCategory(m.failureCategory) ? m.failureCategory : undefined,
  };
}

const W2W_FAILURE_CATEGORIES: readonly W2WFailureCategory[] = [
  'INVALID_RECIPIENT',
  'RECEIVER',
  'TEMPORARY',
  'GENERIC',
];
function isW2WFailureCategory(v: unknown): v is W2WFailureCategory {
  return typeof v === 'string' && (W2W_FAILURE_CATEGORIES as readonly string[]).includes(v);
}

/** Auto-approval bookkeeping stored under `withdrawal.metadata.autoApproval`. */
export interface AutoApprovalMeta {
  status: 'PROCESSING' | 'SUCCESS' | 'FAILED' | 'UNKNOWN' | 'SESSION_EXPIRED';
  reference?: string;
  traceId?: string | null;
  errorDetail?: string;
  // Set on a terminal FAILED to tell the operator whose problem it is (bad recipient
  // number vs receiver limit vs Whish outage). Derived via `classifyW2WFailure`.
  failureCategory?: W2WFailureCategory;
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

/** Read `metadata.autoApproval.status` (null/absent → null). */
function autoMetaStatus(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const a = (metadata as Record<string, unknown>).autoApproval;
  if (!a || typeof a !== 'object') return null;
  const s = (a as Record<string, unknown>).status;
  return typeof s === 'string' ? s : null;
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
