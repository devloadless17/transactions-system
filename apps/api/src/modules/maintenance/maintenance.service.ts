import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

// Hourly sweep. These tables have an expiresAt index but no retention, so they
// would otherwise grow unbounded.
const CLEANUP_INTERVAL_MS = 60 * 60_000;

/**
 * Periodic cleanup of expired auth / idempotency rows. Only deletes rows whose
 * expiresAt is in the past — an expired refresh token is already unusable
 * (refresh() rejects it), and reuse detection relies only on revoked-but-not-yet-
 * expired tokens, which are preserved until they expire.
 */
@Injectable()
export class MaintenanceService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MaintenanceService.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(private readonly prisma: PrismaService) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.tick(), CLEANUP_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async cleanup(): Promise<{ refreshTokens: number; idempotencyKeys: number }> {
    const now = new Date();
    return this.prisma.runAsAdmin(async (tx) => {
      const rt = await tx.refreshToken.deleteMany({ where: { expiresAt: { lt: now } } });
      const ik = await tx.idempotencyKey.deleteMany({ where: { expiresAt: { lt: now } } });
      return { refreshTokens: rt.count, idempotencyKeys: ik.count };
    });
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const r = await this.cleanup();
      if (r.refreshTokens || r.idempotencyKeys) {
        this.logger.log(
          `Cleanup: removed ${r.refreshTokens} expired refresh tokens, ${r.idempotencyKeys} idempotency keys`,
        );
      }
    } catch (err) {
      this.logger.warn(`Cleanup tick failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
