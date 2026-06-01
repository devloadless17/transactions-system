import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Injectable, Logger } from '@nestjs/common';
import { WhishPaymentsService } from './whish-payments.service';

const INTERVAL_MS = 60_000;

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

  constructor(private readonly payments: WhishPaymentsService) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), INTERVAL_MS);
    // Don't keep the event loop alive just for this ticker.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const r = await this.payments.reconcileStalePayments();
      if (r.checked || r.expired) {
        this.logger.log(`Reconciliation: checked ${r.checked}, expired ${r.expired}`);
      }
    } catch (err) {
      this.logger.warn(`Reconciliation tick failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
