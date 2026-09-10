/* eslint-disable @typescript-eslint/consistent-type-imports --
 * NestJS DI: the classes below are constructor-injected, so they must be VALUE
 * imports. `import type` elides them and `emitDecoratorMetadata` then writes
 * `Object` into design:paramtypes, which makes Nest fail to resolve the
 * provider at runtime. The lint rule cannot see that distinction.
 */
import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis, { type Redis } from 'ioredis';
import type { Env } from '../../config/env.schema';

/** A fixed-window counter reading. `null` means "counter unavailable — fail open". */
export interface WindowCount {
  count: number;
  /** Seconds until the current window rolls over (for Retry-After / RateLimit-Reset). */
  resetSeconds: number;
}

/**
 * Shared Redis fixed-window counter for the API-key surfaces. One connection
 * serves BOTH limiters so a second guard doesn't open a second socket:
 *
 *   - authenticated ingest volume (opt-in, off by default — a paying source
 *     must never be throttled; see ApiKeyRateLimitGuard), and
 *   - FAILED authentication attempts per IP (always on — this is the surface
 *     an attacker actually hammers; see ApiKeyAuthGuard).
 *
 * Every method FAILS OPEN (returns null) when Redis is unreachable: a cache
 * outage must never stop a deposit, and must never lock out a real partner.
 */
@Injectable()
export class ApiKeyRateLimitStore implements OnModuleDestroy {
  private readonly logger = new Logger(ApiKeyRateLimitStore.name);
  private readonly redis: Redis;
  private healthy = true;

  constructor(config: ConfigService<Env, true>) {
    this.redis = new IORedis(config.get('REDIS_URL', { infer: true }), {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    this.redis.on('error', () => {
      this.healthy = false;
    });
    this.redis.on('ready', () => {
      this.healthy = true;
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }

  /** Current count WITHOUT incrementing — used to gate before doing costly work. */
  async peek(key: string, windowSeconds: number): Promise<WindowCount | null> {
    return this.run(
      windowSeconds,
      async (bucketKey) => {
        const raw = await this.redis.get(bucketKey);
        return raw === null ? 0 : Number(raw);
      },
      key,
    );
  }

  /** Increment the current window and return the new count. */
  async hit(key: string, windowSeconds: number): Promise<WindowCount | null> {
    return this.run(
      windowSeconds,
      async (bucketKey) => {
        const count = await this.redis.incr(bucketKey);
        // Only the window opener sets the TTL, so the window can't be extended
        // indefinitely by a steady stream of hits.
        if (count === 1) await this.redis.expire(bucketKey, windowSeconds + 5);
        return count;
      },
      key,
    );
  }

  /**
   * Drop the counter for a key. Called on a SUCCESSFUL authentication so a real
   * partner can never be locked out as collateral: if they share an egress IP
   * with an attacker (NAT, shared cloud range), every successful call of theirs
   * wipes the failure budget the attacker was filling.
   */
  async clear(key: string, windowSeconds: number): Promise<void> {
    if (!this.healthy) return;
    const bucket = Math.floor(Math.floor(Date.now() / 1000) / windowSeconds);
    await this.redis.del(`${key}:${bucket}`).catch(() => undefined);
  }

  private async run(
    windowSeconds: number,
    op: (bucketKey: string) => Promise<number>,
    key: string,
  ): Promise<WindowCount | null> {
    if (!this.healthy) return null;
    const nowSec = Math.floor(Date.now() / 1000);
    const bucket = Math.floor(nowSec / windowSeconds);
    try {
      const count = await op(`${key}:${bucket}`);
      return { count, resetSeconds: (bucket + 1) * windowSeconds - nowSec };
    } catch (err) {
      this.logger.warn(`rate-limit Redis error, failing open: ${(err as Error).message}`);
      return null;
    }
  }
}
