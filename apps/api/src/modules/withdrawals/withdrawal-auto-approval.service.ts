/* eslint-disable @typescript-eslint/consistent-type-imports --
 * NestJS DI: the classes below are constructor-injected, so they must be VALUE
 * imports. `import type` elides them and `emitDecoratorMetadata` then writes
 * `Object` into design:paramtypes, which makes Nest fail to resolve the
 * provider at runtime. The lint rule cannot see that distinction.
 */
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Injectable, Logger } from '@nestjs/common';
import { Money } from '@app/shared';
import type { Withdrawal } from '@app/db';
import { WithdrawalsService } from './withdrawals.service';
import { AutoApprovalConfigStore } from './auto-approval-config.store';
import { classifyW2WFailure } from './auto-approval-rules';
import { TransferInProgressError, WhishTransfersService } from '../whish/whish-transfers.service';
import { WhishSessionExpiredError } from '../whish/whish-w2w.client';
import { AuditService } from '../audit/audit.service';
import { ValidationError } from '../../common/errors/domain.error';
import { registerBackgroundJob } from '../../common/lifecycle/background-jobs';
import { JobLeaseService, type HeldLease } from '../../database/job-lease.service';
import type { AutoApprovalState } from './auto-approval-config.store';

const INTERVAL_MS = 15_000;
// Cap rows touched per tick so a backlog can't make one tick run unbounded.
const BATCH = 25;
// Only one instance auto-approves at a time: a blue/green deploy runs two API
// versions side by side. The lease is renewed in the background while a run
// goes on and re-confirmed before every withdrawal; it outlives any one
// withdrawal's work (a Whish call times out at 15s).
const LEASE = 'withdrawal-auto-approval';
const LEASE_TTL_MS = 60_000;

/**
 * Background processor that auto-approves Whish (WISH) withdrawals: claim
 * (PENDING→PROCESSING, which blocks cancel), transfer via W2W, and settle only on
 * a confirmed SUCCESS. Every other outcome leaves the withdrawal where a human can
 * take over (PENDING for clean failures, PROCESSING+flagged for ambiguous ones).
 *
 * Ships inert: it no-ops unless a SUPER_ADMIN has enabled the config AND the W2W
 * session is healthy. Dependency-free interval (mirrors WhishReconciliationService),
 * self-guards against overlapping ticks.
 *
 * SIMULATION MODE (WITHDRAWAL_AUTO_APPROVAL_SIMULATE, staging only): identical
 * pipeline — same admin toggle, hold window, and eligibility rules — but the W2W
 * send is replaced with a fabricated SUCCESS (`SIMULATED-` reference), so the
 * flow can be exercised where real transfers are forbidden. Env validation
 * refuses to boot with both simulate and WHISH_W2W_ENABLED on.
 */
@Injectable()
export class WithdrawalAutoApprovalService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(WithdrawalAutoApprovalService.name);
  private timer?: NodeJS.Timeout;
  private nudgeTimer?: NodeJS.Timeout;
  private running = false;
  private stopping = false;

  constructor(
    private readonly withdrawals: WithdrawalsService,
    private readonly config: AutoApprovalConfigStore,
    private readonly transfers: WhishTransfersService,
    private readonly audit: AuditService,
    private readonly leases: JobLeaseService,
  ) {}

  /** WITHDRAWAL_AUTO_APPROVAL_SIMULATE — single authority is the config store. */
  private get simulate(): boolean {
    return this.config.simulationMode;
  }

  onApplicationBootstrap(): void {
    this.logger.log(
      `Withdrawal auto-approval poller STARTED (every ${INTERVAL_MS / 1000}s)` +
        (this.simulate ? ' — SIMULATION MODE (no real transfers)' : ''),
    );
    this.timer = setInterval(() => void this.tick(), INTERVAL_MS);
    // A shutdown stops new runs and waits for one in progress (main.ts).
    registerBackgroundJob({
      name: 'withdrawal-auto-approval',
      stop: () => this.requestStop(),
      isRunning: () => this.running,
    });
    this.timer.unref?.();
    void this.tick();
  }

  /**
   * Shutdown: no new run, and the run in progress stops BETWEEN withdrawals — a
   * transfer that has started always runs to its end; the next instance takes
   * the rest.
   */
  requestStop(): void {
    this.stopping = true;
    this.onModuleDestroy();
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

      if (this.simulate) {
        // Defense in depth on top of the boot-time mutual exclusion: never
        // simulate while the real W2W side is armed.
        if (this.transfers.isW2WEnabled()) {
          this.logger.error(
            'SIMULATION mode is on but WHISH_W2W_ENABLED is true — refusing to run.',
          );
          return;
        }
      } else if (state.circuitBreakerTrippedAt) {
        // Circuit breaker: if tripped, only continue once the Whish session has been
        // refreshed (auto-resume); otherwise skip — everything stays manual.
        const session = await this.transfers.sessionStatus();
        const resumed = await this.config.maybeAutoResume(state, session);
        if (!resumed) return;
      }

      if (!state.enabled || !state.enabledAt) return; // OFF → silent (the default)
      // Simulation never touches Whish, so the W2W env/session gates only apply
      // to the real pipeline.
      if (!this.simulate) {
        if (!this.transfers.isW2WEnabled()) {
          this.logger.warn('Auto-approval is ON but WHISH_W2W_ENABLED is false — skipping.');
          return;
        }
        const session = await this.transfers.sessionStatus();
        if (!session.configured) {
          this.logger.warn('Auto-approval is ON but no Whish session is configured — skipping.');
          return;
        }
      }

      // Never on two instances at once (see LEASE). If the other one holds it,
      // skip: its run covers the work, and this instance's next tick follows.
      const { enabledAt } = state; // narrowed to a Date by the gate above
      const run = await this.leases.runExclusive(LEASE, LEASE_TTL_MS, (lease) =>
        this.processBatch(state, enabledAt, lease),
      );
      if (!run.ran) {
        this.logger.log('Auto-approval tick skipped: another instance holds the lease.');
      }
    } catch (err) {
      this.logger.warn(`Auto-approval tick failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** One run, holding the lease: resolve PROCESSING rows, then claim fresh ones. */
  private async processBatch(
    state: AutoApprovalState,
    enabledAt: Date,
    lease: HeldLease,
  ): Promise<void> {
    // 1. Resolve rows already in PROCESSING (crash recovery / settle retries).
    const stuck = await this.withdrawals.findStuckProcessing(BATCH);
    for (const w of stuck) {
      // Re-check the master switch every iteration: flipping it OFF stops the
      // run immediately, so a disable can never let one more transfer through.
      if (this.stopping) return; // shutdown: before the next withdrawal, never mid-transfer
      // Still ours, confirmed by the database, before touching each withdrawal:
      // a run that lost its lease stops rather than overlap another instance.
      if (!(await lease.confirm())) return;
      if (!(await this.config.isEnabled())) return;
      const stop = await this.processClaimed(w);
      if (stop) return;
    }

    // 2. Claim & process fresh PENDING candidates past the hold window.
    const candidates = await this.withdrawals.findAutoApprovalCandidates({
      holdSeconds: state.holdSeconds,
      enabledAt,
      maxAutoApproveAmount: state.maxAutoApproveAmount,
      limit: BATCH,
    });
    let processed = 0;
    for (const w of candidates) {
      if (this.stopping) break; // shutdown → stop, before claiming
      if (!(await lease.confirm())) break; // lease lost → stop, before claiming
      if (!(await this.config.isEnabled())) break; // disabled mid-run → stop, before claiming
      const claimed = await this.withdrawals.claimForProcessing(w.id, w.companyId);
      if (!claimed) continue; // cancelled / raced away — skip
      processed++;
      const stop = await this.processClaimed(w);
      if (stop) return;
    }
    // Heartbeat so the processor's decisions are visible in the logs.
    this.logger.log(
      `${this.simulate ? '[SIMULATED] ' : ''}Auto-approval tick: ${candidates.length} candidate(s), ${stuck.length} stuck, ${processed} processed ` +
        `(hold=${state.holdSeconds}s, cap=${state.maxAutoApproveAmount}).`,
    );
  }

  /**
   * Drive one PROCESSING withdrawal through transfer → settle. Returns true if the
   * tick should STOP (session expired — the whole W2W side is down — or another
   * instance's transfer is holding the Whish session).
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

    // SIMULATION: fabricate a success at the exact point the real send would
    // fire — settle flows through the same approve/ledger/webhook path. This
    // branch is structurally incapable of reaching WhishTransfersService.
    if (this.simulate) {
      await this.settleSuccess(w, `SIMULATED-${w.id}`, null);
      return false;
    }

    // Transfer the full net "to pay", cents included (e.g. 18.67 → 18.67). The
    // settle (approve) books exactly the amount recorded on the transfer row, so
    // what is sent here and what is booked to EXTERNAL always match.
    const transferAmount = Money.fromDb(w.netAmount);

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
      if (err instanceof TransferInProgressError) {
        // Another instance's transfer kept the Whish session past our wait.
        // NOTHING was recorded or sent, so the row stays PROCESSING untouched:
        // the next tick takes it up again (findStuckProcessing). Stop this one.
        this.logger.warn(
          `Withdrawal ${w.id}: the Whish session is busy with another transfer — retrying next tick.`,
        );
        return true;
      }
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
    const net = Money.fromDb(w.netAmount);
    try {
      // approve() books EXTERNAL = the amount actually sent (the full net; only a
      // legacy whole-dollar transfer leaves a rounding remainder).
      // skipReceivableBlock: the transfer already SUCCEEDED (money left), so settle
      // must NOT be blocked by a receivable that appeared after the transfer —
      // otherwise the row would wedge in PROCESSING forever. The debt still stands.
      const settled = await this.withdrawals.approve(
        w.id,
        null,
        {
          externalReference: reference,
          notes: this.simulate
            ? `Auto-approved (SIMULATED — no transfer) (${reference})`
            : `Auto-approved via Whish W2W (${reference})`,
        },
        { skipReceivableBlock: true },
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
          transferred: net.sub(Money.fromDb(settled.roundingRemainder)).toString(),
          rounding: settled.roundingRemainder,
          currency: w.currency.trim(),
          ...(this.simulate ? { simulated: true } : {}),
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
