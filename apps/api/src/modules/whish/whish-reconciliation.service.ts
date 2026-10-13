/* eslint-disable @typescript-eslint/consistent-type-imports --
 * NestJS DI: the classes below are constructor-injected, so they must be VALUE
 * imports. `import type` elides them and `emitDecoratorMetadata` then writes
 * `Object` into design:paramtypes, which makes Nest fail to resolve the
 * provider at runtime. The lint rule cannot see that distinction.
 */
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Injectable, Logger } from '@nestjs/common';
import { WhishPaymentsService } from './whish-payments.service';
import { registerBackgroundJob } from '../../common/lifecycle/background-jobs';
import { JobLeaseService } from '../../database/job-lease.service';

// The heartbeat: a pass every minute whether or not anything is due. It is the
// safety net (a wake-up lost to a restart, a link another instance created) and
// the proof the poller is alive; the checks themselves are timed by wake-ups.
const INTERVAL_MS = 60_000;
// A wake-up fires this long after the moment a link is due, so the pass's own
// clock reading is past that moment.
const WAKE_AFTER_DUE_MS = 200;
// ...and never sooner than this after a pass, whatever the schedule says: a due
// link a pass could not move on is retried, not spun on.
const MIN_WAKE_MS = 1_000;
// One poller at a time across instances: a blue/green deploy runs two API
// versions side by side, and two pollers would check every due link twice
// (Whish calls that share the per-key budget with link creation). Renewed
// while a run goes on — a run can take minutes.
const LEASE = 'whish-reconciliation';
const LEASE_TTL_MS = 60_000;

/**
 * Runs the Whish reconciliation poller: asks Whish about each PENDING link when
 * its check is due (WhishPaymentsService owns the schedule), in case the link
 * expired unpaid or a callback was missed.
 *
 * Two timers, no @nestjs/schedule:
 *  - a heartbeat pass every minute;
 *  - after each pass, one wake-up for the moment the next link is due, when
 *    that comes before the next heartbeat. So a check lands on its second, and
 *    the poller still does nothing between heartbeats while no link is due.
 * A pass that took a full batch is followed by the next at once, so a backlog
 * is worked through continuously, never at one batch a minute — unless Whish
 * answers "too many requests", which sends the poller back to the heartbeat.
 *
 * Self-guards against overlapping passes. No-op until Whish is configured (the
 * service checks that internally).
 */
@Injectable()
export class WhishReconciliationService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(WhishReconciliationService.name);
  private timer?: NodeJS.Timeout;
  private wake?: NodeJS.Timeout;
  private running = false;
  private stopping = false;

  constructor(
    private readonly payments: WhishPaymentsService,
    private readonly leases: JobLeaseService,
  ) {}

  onApplicationBootstrap(): void {
    this.logger.log(
      `Whish reconciliation poller STARTED (heartbeat every ${INTERVAL_MS / 1000}s, each link checked when due)`,
    );
    this.timer = setInterval(() => void this.tick(true), INTERVAL_MS);
    // A shutdown stops new runs and waits for one in progress (main.ts).
    registerBackgroundJob({
      name: 'whish-reconciliation',
      stop: () => {
        this.stopping = true; // the run in progress stops between links
        this.onModuleDestroy();
      },
      isRunning: () => this.running,
    });
    // Don't keep the event loop alive just for this ticker.
    this.timer.unref?.();
    // Run once promptly at boot so a just-deployed instance doesn't wait a full
    // interval before its first reconcile.
    void this.tick(true);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.wake) clearTimeout(this.wake);
  }

  /**
   * One poller pass. `heartbeat` = the every-minute pass, always logged;
   * otherwise a wake-up set for the moment a link became due.
   */
  private async tick(heartbeat = false): Promise<void> {
    // The pass in progress ends by setting the next wake-up itself. After a
    // shutdown began nothing starts: the database is on its way out.
    if (this.running || this.stopping) return;
    this.running = true;
    try {
      for (let first = true; ; first = false) {
        const run = await this.leases.runExclusive(LEASE, LEASE_TTL_MS, (lease) =>
          // A lost lease stops the run between links, like a shutdown does.
          this.payments.reconcileStalePayments({ shouldStop: () => this.stopping || !lease.held }),
        );
        if (!run.ran) {
          // Another instance is the poller right now and times its own
          // wake-ups; ours would only collide with it. The heartbeat asks again.
          if (heartbeat) {
            this.logger.log('Reconciliation tick skipped: another instance holds the lease.');
          }
          return;
        }
        const r = run.value;
        // Heartbeat: log EVERY one (even when it finds nothing) so we can confirm
        // the poller is actually running in each environment — a silent poller
        // was indistinguishable from a missing one. A wake-up logs what it did.
        if ((heartbeat && first) || r.checked > 0) {
          this.logger.log(
            `Reconciliation tick: checked ${r.checked}, timed-out→failed ${r.timedOut}`,
          );
        }
        if (r.throttled) {
          // Whish said "too many requests": do not come back early. Only the
          // next every-minute pass asks again, so link creation — which uses
          // the same Whish account — keeps the room.
          if (this.wake) clearTimeout(this.wake);
          this.wake = undefined;
          return;
        }
        // A full batch: more links are already due. Take them now.
        if (!r.more || this.stopping) break;
      }
      await this.armWake();
    } catch (err) {
      this.logger.warn(`Reconciliation tick failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /**
   * Come back at the moment the next link is due, when that is before the next
   * heartbeat. A later one needs no timer: the heartbeat arrives first and
   * looks again.
   */
  private async armWake(): Promise<void> {
    if (this.wake) clearTimeout(this.wake);
    this.wake = undefined;
    if (this.stopping) return;
    const dueAt = await this.payments.nextPollDueAt();
    // Checked again: the shutdown may have begun while we were asking.
    if (dueAt === null || this.stopping) return;
    const inMs = dueAt - Date.now() + WAKE_AFTER_DUE_MS;
    if (inMs >= INTERVAL_MS) return;
    this.wake = setTimeout(() => void this.tick(), Math.max(MIN_WAKE_MS, inMs));
    // Like the heartbeat: never keeps the event loop alive on its own.
    this.wake.unref?.();
  }
}
