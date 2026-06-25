import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@app/db';
import type {
  UpdateWithdrawalAutoApprovalInput,
  WithdrawalAutoApprovalConfig,
  WhishSessionStatus,
} from '@app/shared';
import { PrismaService } from '../../database/prisma.service';

const ROW_ID = 'default';

/** Defaults when the row was never written — mirror the Prisma model defaults. */
const DEFAULTS = {
  enabled: false,
  enabledAt: null as Date | null,
  holdSeconds: 30,
  maxAutoApproveAmount: '500',
  circuitBreakerTrippedAt: null as Date | null,
  consecutiveFailures: 0,
  failureThreshold: 3,
  updatedAt: null as Date | null,
};

export interface AutoApprovalState {
  enabled: boolean;
  enabledAt: Date | null;
  holdSeconds: number;
  maxAutoApproveAmount: string;
  circuitBreakerTrippedAt: Date | null;
  consecutiveFailures: number;
  failureThreshold: number;
  updatedAt: Date | null;
}

/**
 * Single-row store for the withdrawal auto-approval config + circuit-breaker
 * state. Admin-only RLS (all access via `runAsAdmin`). Mirrors the single-row
 * pattern of WhishSessionStore. The feature ships disabled; only `update()` with
 * `enabled:true` ever begins auto-processing, and it stamps `enabledAt` so the
 * processor only picks up requests created after that moment.
 */
@Injectable()
export class AutoApprovalConfigStore {
  private readonly logger = new Logger(AutoApprovalConfigStore.name);

  constructor(private readonly prisma: PrismaService) {}

  async getState(): Promise<AutoApprovalState> {
    const row = await this.prisma.runAsAdmin((tx) =>
      tx.withdrawalAutoApprovalConfig.findUnique({ where: { id: ROW_ID } }),
    );
    if (!row) return { ...DEFAULTS };
    return {
      enabled: row.enabled,
      enabledAt: row.enabledAt,
      holdSeconds: row.holdSeconds,
      maxAutoApproveAmount: row.maxAutoApproveAmount.toString(),
      circuitBreakerTrippedAt: row.circuitBreakerTrippedAt,
      consecutiveFailures: row.consecutiveFailures,
      failureThreshold: row.failureThreshold,
      updatedAt: row.updatedAt,
    };
  }

  async getConfig(): Promise<WithdrawalAutoApprovalConfig> {
    return this.toResponse(await this.getState());
  }

  async update(input: UpdateWithdrawalAutoApprovalInput): Promise<WithdrawalAutoApprovalConfig> {
    const current = await this.getState();
    const data: Prisma.WithdrawalAutoApprovalConfigUncheckedUpdateInput = {};

    if (input.enabled !== undefined) {
      data.enabled = input.enabled;
      // Stamp enabledAt on every OFF→ON transition so "only new requests" is
      // measured from the latest enable. Leave it untouched when disabling.
      if (input.enabled && !current.enabled) data.enabledAt = new Date();
    }
    if (input.holdSeconds !== undefined) data.holdSeconds = input.holdSeconds;
    if (input.maxAutoApproveAmount !== undefined) {
      data.maxAutoApproveAmount = new Prisma.Decimal(input.maxAutoApproveAmount);
    }
    if (input.failureThreshold !== undefined) data.failureThreshold = input.failureThreshold;
    if (input.clearBreaker) {
      data.circuitBreakerTrippedAt = null;
      data.consecutiveFailures = 0;
    }

    const row = await this.prisma.runAsAdmin((tx) =>
      tx.withdrawalAutoApprovalConfig.upsert({
        where: { id: ROW_ID },
        // create starts from defaults, then applies the same patch as update.
        create: {
          id: ROW_ID,
          enabled: input.enabled ?? false,
          enabledAt: input.enabled ? new Date() : null,
          holdSeconds: input.holdSeconds ?? DEFAULTS.holdSeconds,
          maxAutoApproveAmount: new Prisma.Decimal(
            input.maxAutoApproveAmount ?? DEFAULTS.maxAutoApproveAmount,
          ),
          failureThreshold: input.failureThreshold ?? DEFAULTS.failureThreshold,
        },
        update: data,
      }),
    );
    this.logger.log(
      `Auto-approval config updated (enabled=${row.enabled}, hold=${row.holdSeconds}s, max=${row.maxAutoApproveAmount})`,
    );
    return this.toResponse({
      enabled: row.enabled,
      enabledAt: row.enabledAt,
      holdSeconds: row.holdSeconds,
      maxAutoApproveAmount: row.maxAutoApproveAmount.toString(),
      circuitBreakerTrippedAt: row.circuitBreakerTrippedAt,
      consecutiveFailures: row.consecutiveFailures,
      failureThreshold: row.failureThreshold,
      updatedAt: row.updatedAt,
    });
  }

  /** A transfer outcome that proves Whish is working → clear the failure run. */
  async recordSuccess(): Promise<void> {
    await this.prisma
      .runAsAdmin((tx) =>
        tx.withdrawalAutoApprovalConfig.updateMany({
          where: { id: ROW_ID, consecutiveFailures: { gt: 0 } },
          data: { consecutiveFailures: 0 },
        }),
      )
      .catch((e) => this.logger.warn(`recordSuccess failed: ${(e as Error).message}`));
  }

  /** Count a W2W failure; trip the breaker once it crosses the threshold. */
  async recordFailure(): Promise<void> {
    await this.prisma
      .runAsAdmin(async (tx) => {
        const row = await tx.withdrawalAutoApprovalConfig.update({
          where: { id: ROW_ID },
          data: { consecutiveFailures: { increment: 1 } },
        });
        if (row.consecutiveFailures >= row.failureThreshold && !row.circuitBreakerTrippedAt) {
          await tx.withdrawalAutoApprovalConfig.update({
            where: { id: ROW_ID },
            data: { circuitBreakerTrippedAt: new Date() },
          });
          this.logger.warn(
            `Auto-approval circuit breaker TRIPPED after ${row.consecutiveFailures} consecutive failures`,
          );
        }
      })
      .catch((e) => this.logger.warn(`recordFailure failed: ${(e as Error).message}`));
  }

  /** Immediate trip (e.g. session expired) — the whole W2W side is down. */
  async trip(reason: string): Promise<void> {
    await this.prisma
      .runAsAdmin((tx) =>
        tx.withdrawalAutoApprovalConfig.updateMany({
          where: { id: ROW_ID, circuitBreakerTrippedAt: null },
          data: { circuitBreakerTrippedAt: new Date() },
        }),
      )
      .then(() => this.logger.warn(`Auto-approval circuit breaker TRIPPED (${reason})`))
      .catch((e) => this.logger.warn(`trip failed: ${(e as Error).message}`));
  }

  async clearBreaker(): Promise<void> {
    await this.prisma
      .runAsAdmin((tx) =>
        tx.withdrawalAutoApprovalConfig.updateMany({
          where: { id: ROW_ID },
          data: { circuitBreakerTrippedAt: null, consecutiveFailures: 0 },
        }),
      )
      .catch((e) => this.logger.warn(`clearBreaker failed: ${(e as Error).message}`));
  }

  /**
   * Auto-resume: if the breaker is tripped but the Whish session has since been
   * refreshed (rotated after the trip, no recent auth failure), clear it so
   * auto-approval resumes — honoring the operator's `enabled` preference.
   * Returns true if the breaker is now clear.
   */
  async maybeAutoResume(state: AutoApprovalState, session: WhishSessionStatus): Promise<boolean> {
    if (!state.circuitBreakerTrippedAt) return true;
    const rotated = session.lastRotatedAt ? new Date(session.lastRotatedAt) : null;
    const healthy =
      session.configured &&
      session.lastAuthFailureAt === null &&
      rotated !== null &&
      rotated > state.circuitBreakerTrippedAt;
    if (healthy) {
      await this.clearBreaker();
      this.logger.log('Auto-approval circuit breaker auto-resumed (session refreshed)');
      return true;
    }
    return false;
  }

  private toResponse(s: AutoApprovalState): WithdrawalAutoApprovalConfig {
    return {
      enabled: s.enabled,
      enabledAt: s.enabledAt?.toISOString() ?? null,
      holdSeconds: s.holdSeconds,
      maxAutoApproveAmount: s.maxAutoApproveAmount,
      circuitBreakerTrippedAt: s.circuitBreakerTrippedAt?.toISOString() ?? null,
      consecutiveFailures: s.consecutiveFailures,
      failureThreshold: s.failureThreshold,
      updatedAt: s.updatedAt?.toISOString() ?? null,
    };
  }
}
