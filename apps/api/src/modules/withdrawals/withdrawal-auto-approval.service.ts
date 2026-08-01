import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Injectable, Logger } from '@nestjs/common';
import { Money } from '@app/shared';
import type { Withdrawal } from '@app/db';
import { WithdrawalsService } from './withdrawals.service';
import { AutoApprovalConfigStore } from './auto-approval-config.store';
import { classifyW2WFailure } from './auto-approval-rules';
import { WhishTransfersService } from '../whish/whish-transfers.service';
import { WhishSessionExpiredError } from '../whish/whish-w2w.client';
import { AuditService } from '../audit/audit.service';
import { ValidationError } from '../../common/errors/domain.error';

const INTERVAL_MS = 15_000;
// Cap rows touched per tick so a backlog can't make one tick run unbounded.
const BATCH = 25;

/**
 * Background processor that auto-approves Whish (WISH) withdrawals: claim
 * (PENDING→PROCESSING, which blocks cancel), transfer via W2W, and settle only on
 * a confirmed SUCCESS. Every other outcome leaves the withdrawal where a human can
 * take over (PENDING for clean failures, PROCESSING+flagged for ambiguous ones).
 *
 * Ships inert: it no-ops unless a SUPER_ADMIN has enabled the config AND the W2W
 * session is healthy. Dependency-free interval (mirrors WhishReconciliationService),
 * self-guards against overlapping ticks.
 */
@Injectable()
export class WithdrawalAutoApprovalService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(WithdrawalAutoApprovalService.name);
  private timer?: NodeJS.Timeout;
  private nudgeTimer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly withdrawals: WithdrawalsService,
    private readonly config: AutoApprovalConfigStore,
    private readonly transfers: WhishTransfersService,
    private readonly audit: AuditService,
  ) {}

  onApplicationBootstrap(): void {
    this.logger.log(`Withdrawal auto-approval poller STARTED (every ${INTERVAL_MS / 1000}s)`);
    this.timer = setInterval(() => void this.tick(), INTERVAL_MS);
    this.timer.unref?.();
    void this.tick();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
  }

  /**
   * Fast lane: a WISH withdrawal was just requested. The 15s interval poller is a
   * safety net — on its own it adds up to ~15s of latency on top of the hold
   * window, so a 3s hold can take ~18s to transfer. This schedules a one-shot tick
   * just after the hold window (≈ holdSeconds + 1s) so the transfer fires promptly.
   *
   * Debounced: a burst of requests collapses to ONE run at the latest request's
   * hold expiry (each call resets the timer). Best-effort and self-correcting — the
   * tick re-reads the master switch + hold window, so this can never transfer when
   * auto-approval is OFF or before a row is actually eligible. The interval poller
   * still covers anything this misses (e.g. a request created during a restart).
   */
  nudge(): void {
    void this.config
      .getState()
      .then((state) => {
        if (!state.enabled || !state.enabledAt) return; // OFF → no fast lane
        if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
        this.nudgeTimer = setTimeout(
          () => {
            this.nudgeTimer = undefined;
            void this.tick();
          },
          state.holdSeconds * 1000 + 1000,
        );
        this.nudgeTimer.unref?.();
      })
      .catch(() => undefined); // never let a nudge failure surface; the poller covers it
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const state = await this.config.getState();

      // Circuit breaker: if tripped, only continue once the Whish session has been
      // refreshed (auto-resume); otherwise skip — everything stays manual.
      if (state.circuitBreakerTrippedAt) {
        const session = await this.transfers.sessionStatus();
        const resumed = await this.config.maybeAutoResume(state, session);
        if (!resumed) return;
      }

      if (!state.enabled || !state.enabledAt) return; // OFF → silent (the default)
      if (!this.transfers.isW2WEnabled()) {
        this.logger.warn('Auto-approval is ON but WHISH_W2W_ENABLED is false — skipping.');
        return;
      }
      const session = await this.transfers.sessionStatus();
      if (!session.configured) {
        this.logger.warn('Auto-approval is ON but no Whish session is configured — skipping.');
        return;
      }

      // 1. Resolve rows already in PROCESSING (crash recovery / settle retries).
      const stuck = await this.withdrawals.findStuckProcessing(BATCH);
      for (const w of stuck) {
        // Re-check the master switch every iteration: flipping it OFF stops the
        // run immediately, so a disable can never let one more transfer through.
        if (!(await this.config.isEnabled())) return;
        const stop = await this.processClaimed(w);
        if (stop) return;
      }

      // 2. Claim & process fresh PENDING candidates past the hold window.
      const candidates = await this.withdrawals.findAutoApprovalCandidates({
        holdSeconds: state.holdSeconds,
        enabledAt: state.enabledAt,
        maxAutoApproveAmount: state.maxAutoApproveAmount,
        limit: BATCH,
      });
      let processed = 0;
      for (const w of candidates) {
        if (!(await this.config.isEnabled())) break; // disabled mid-run → stop, before claiming
        const claimed = await this.withdrawals.claimForProcessing(w.id, w.companyId);
        if (!claimed) continue; // cancelled / raced away — skip
        processed++;
        const stop = await this.processClaimed(w);
        if (stop) return;
      }
      // Heartbeat so the processor's decisions are visible in the logs.
      this.logger.log(
        `Auto-approval tick: ${candidates.length} candidate(s), ${stuck.length} stuck, ${processed} processed ` +
          `(hold=${state.holdSeconds}s, cap=${state.maxAutoApproveAmount}).`,
      );
    } catch (err) {
      this.logger.warn(`Auto-approval tick failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * Drive one PROCESSING withdrawal through transfer → settle. Returns true if the
   * tick should STOP (session expired — the whole W2W side is down).
   */
  private async processClaimed(w: Withdrawal): Promise<boolean> {
    const phone = (w.payoutDetails as { recipientPhone?: string } | null)?.recipientPhone;
    if (!phone) {
      // Can't transfer without a phone — drop back to manual, marked terminal.
      await this.withdrawals.revertFromProcessing(w.id, w.companyId, {
        status: 'FAILED',
        terminal: true,
        errorDetail: 'missing_recipient_phone',
        failureCategory: 'INVALID_RECIPIENT',
      });
      return false;
    }

    // Transfer whole dollars only: floor the net "to pay" (e.g. 18.67 → 18). The
    // settle (approve floorWhole) keeps the cents as the rounding remainder, so the
    // amount sent here and the amount booked to EXTERNAL match exactly.
    const transferAmount = Money.of(w.netAmount.toString()).floorToWhole();

    let result;
    try {
      // Idempotent on withdrawalId: a row already attempted returns its existing
      // status WITHOUT re-sending — so crash-recovery never double-transfers.
      result = await this.transfers.sendTransfer(
        // Candidates are filtered to USD (>= $1); W2W is USD-only.
        { amount: transferAmount.toString(), recipientPhone: phone, currency: 'USD' },
        { source: 'WITHDRAWAL', actorId: null, companyId: w.companyId, withdrawalId: w.id },
      );
    } catch (err) {
      if (err instanceof WhishSessionExpiredError) {
        // Money did NOT move — revert to manual and pause the whole feature.
        await this.withdrawals.revertFromProcessing(w.id, w.companyId, {
          status: 'SESSION_EXPIRED',
          errorDetail: 'session_expired',
        });
        await this.config.trip('session_expired');
        return true; // stop the tick — nothing else can transfer until re-seeded
      }
      if (err instanceof ValidationError) {
        // Thrown BEFORE the upstream call (bad amount / not configured) — money
        // definitively did NOT move, so it's safe to drop back to manual.
        await this.withdrawals.revertFromProcessing(w.id, w.companyId, {
          status: 'FAILED',
          terminal: true,
          errorDetail: err.message,
        });
        // A credential-decrypt failure is FLEET-WIDE (a rotated/invalid
        // WHISH_W2W_ENC_KEY fails every row identically) — trip the breaker and
        // stop the tick like session_expired, so the operator gets ONE loud
        // paused-feature signal instead of the whole queue silently failing
        // row-by-row to manual.
        if ((err.details as { code?: string } | undefined)?.code === 'session_decrypt_failed') {
          await this.config.trip('session_decrypt_failed');
          return true; // stop the tick — nothing else can transfer until the key is fixed
        }
        return false;
      }
      // Any other unexpected error could have fired AFTER the Whish call (e.g. a DB
      // hiccup persisting the result) — money MAY have moved. Never auto-revert (a
      // later manual reject would then double-pay); hold PROCESSING + flag for the
      // operator to reconcile, exactly like an UNKNOWN.
      await this.withdrawals.setAutoMeta(w.id, w.companyId, {
        status: 'UNKNOWN',
        needsReconcile: true,
        errorDetail: `unexpected: ${(err as Error).message}`,
      });
      await this.config.recordFailure();
      this.logger.error(
        `Withdrawal ${w.id} auto-transfer errored unexpectedly — held for reconcile: ${(err as Error).message}`,
      );
      return false;
    }

    switch (result.status) {
      case 'SUCCESS':
        await this.settleSuccess(w, result.reference, result.traceId);
        break;
      case 'FAILED':
        // Clean business failure (money did NOT move) — back to manual, terminal.
        // Categorise so the queue can tell the operator whose problem it is (a bad
        // recipient number vs a receiver limit vs a transient Whish outage) rather
        // than a bare "Auto: failed". This is a business failure, so the breaker is
        // NOT tripped (recordSuccess below) — a single transient 'off' or a
        // receiver-limit rejection never pauses the whole queue.
        await this.withdrawals.revertFromProcessing(w.id, w.companyId, {
          status: 'FAILED',
          terminal: true,
          reference: result.reference,
          errorDetail: result.upstreamMessage ?? 'transfer_failed',
          failureCategory: classifyW2WFailure(result.upstreamCode, result.upstreamMessage),
        });
        await this.config.recordSuccess(); // system is healthy, just this one failed
        await this.audit.record({
          actorId: null,
          companyId: w.companyId,
          action: 'withdrawal.auto_transfer_failed',
          entityType: 'withdrawal',
          entityId: w.id,
          metadata: { reference: result.reference, message: result.upstreamMessage },
        });
        break;
      case 'UNKNOWN':
      case 'PENDING':
        // Money MAY have moved — keep PROCESSING, flag for operator reconcile,
        // and never auto-touch it again (findStuckProcessing excludes it).
        await this.withdrawals.setAutoMeta(w.id, w.companyId, {
          status: 'UNKNOWN',
          reference: result.reference,
          traceId: result.traceId,
          needsReconcile: true,
        });
        await this.config.recordFailure();
        this.logger.warn(
          `Withdrawal ${w.id} auto-transfer UNKNOWN (ref ${result.reference}) — needs reconcile`,
        );
        break;
    }
    return false;
  }

  private async settleSuccess(
    w: Withdrawal,
    reference: string,
    traceId: string | null,
  ): Promise<void> {
    const net = Money.of(w.netAmount.toString());
    const transferred = net.floorToWhole();
    try {
      // floorWhole: EXTERNAL = floor(net), the cents become the rounding remainder.
      // skipReceivableBlock: the transfer already SUCCEEDED (money left), so settle
      // must NOT be blocked by a receivable that appeared after the transfer —
      // otherwise the row would wedge in PROCESSING forever. The debt still stands.
      await this.withdrawals.approve(
        w.id,
        null,
        { externalReference: reference, notes: `Auto-approved via Whish W2W (${reference})` },
        { floorWhole: true, skipReceivableBlock: true },
      );
      await this.config.recordSuccess();
      await this.audit.record({
        actorId: null,
        companyId: w.companyId,
        action: 'withdrawal.auto_approved',
        entityType: 'withdrawal',
        entityId: w.id,
        metadata: {
          reference,
          traceId,
          net: net.toString(),
          transferred: transferred.toString(),
          rounding: net.sub(transferred).toString(),
          currency: w.currency.trim(),
        },
      });
    } catch (err) {
      // The transfer SUCCEEDED (money moved) but settling the ledger failed (e.g. a
      // RECEIVABLE block appeared). Keep PROCESSING + flag; the next tick retries
      // approve() (transfer already SUCCESS → just settles). Never reverts.
      await this.withdrawals.setAutoMeta(w.id, w.companyId, {
        status: 'SUCCESS',
        reference,
        needsAttention: true,
        errorDetail: `settle_failed: ${(err as Error).message}`,
      });
      this.logger.error(
        `Withdrawal ${w.id} transfer SUCCEEDED but settle failed: ${(err as Error).message}`,
      );
    }
  }
}
