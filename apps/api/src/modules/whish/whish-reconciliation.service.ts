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

const INTERVAL_MS = 60_000;
// One poller at a time across instances: a blue/green deploy runs two API
// versions side by side, and two pollers would check every due link twice
// (Whish calls that share the per-key budget with link creation). Renewed
// while a run goes on — a run can take minutes.
const LEASE = 'whish-reconciliation';
const LEASE_TTL_MS = 60_000;

/**
 * Periodically reconciles stale PENDING Whish payments in case a callback was
 * missed, and expires very old ones. Dependency-free interval (no
 * @nestjs/schedule); self-guards against overlapping runs. No-op until Whish is
 * configured (the service checks that internally).
 */
@Injectable()
export class WhishReconciliationService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(WhishReconciliationService.name);
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopping = false;

  constructor(
    private readonly payments: WhishPaymentsService,
    private readonly leases: JobLeaseService,
  ) {}

  onApplicationBootstrap(): void {
    this.logger.log(`Whish reconciliation poller STARTED (every ${INTERVAL_MS / 1000}s)`);
    this.timer = setInterval(() => void this.tick(), INTERVAL_MS);
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
    void this.tick();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const run = await this.leases.runExclusive(LEASE, LEASE_TTL_MS, (lease) =>
        // A lost lease stops the run between links, like a shutdown does.
        this.payments.reconcileStalePayments({ shouldStop: () => this.stopping || !lease.held }),
      );
      if (!run.ran) {
        this.logger.log('Reconciliation tick skipped: another instance holds the lease.');
        return;
      }
      const r = run.value;
      // Heartbeat: log EVERY tick (even when it finds nothing) so we can confirm
      // the poller is actually running in each environment — a silent poller was
      // indistinguishable from a missing one.
      this.logger.log(`Reconciliation tick: checked ${r.checked}, timed-out→failed ${r.timedOut}`);
    } catch (err) {
      this.logger.warn(`Reconciliation tick failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
