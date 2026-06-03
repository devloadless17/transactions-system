import { Logger } from '@nestjs/common';
import IORedis, { type Redis } from 'ioredis';
import type { ThrottlerStorage } from '@nestjs/throttler';

// `@nestjs/throttler` exports the record only as a symbol, not a named type, so
// we mirror its shape locally — structural typing satisfies `ThrottlerStorage`.
interface ThrottlerStorageRecord {
  totalHits: number;
  timeToExpire: number;
  isBlocked: boolean;
  timeToBlockExpire: number;
}

/**
 * Redis-backed fixed-window storage for `@nestjs/throttler`, so the global rate
 * limits (login, refresh, default) are SHARED across API instances and survive
 * restarts. The default in-memory storage makes the effective login limit
 * `limit × instanceCount` and resets on every deploy — a real weakening of
 * brute-force protection once the API runs more than one process.
 *
 * Fixed-window via INCR + PEXPIRE — the same simple, proven pattern as the
 * ingest limiter (`ApiKeyRateLimitGuard`). Fails OPEN on Redis errors so a
 * cache outage degrades to "no global limit" rather than locking everyone out.
 */
export class RedisThrottlerStorage implements ThrottlerStorage {
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  private readonly redis: Redis;
  private healthy = true;

  constructor(redisUrl: string) {
    this.redis = new IORedis(redisUrl, {
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

  async increment(
    key: string,
    ttl: number,
    limit: number,
    blockDuration: number,
    throttlerName: string,
  ): Promise<ThrottlerStorageRecord> {
    // ttl / blockDuration are MILLISECONDS in throttler v6.
    const failOpen: ThrottlerStorageRecord = {
      totalHits: 1,
      timeToExpire: ttl,
      isBlocked: false,
      timeToBlockExpire: 0,
    };
    if (!this.healthy) return failOpen;

    const redisKey = `throttle:${throttlerName}:${key}`;
    try {
      const totalHits = await this.redis.incr(redisKey);
      let timeToExpire = await this.redis.pttl(redisKey);
      // First hit in this window (or a key that somehow lost its TTL): set it.
      if (timeToExpire < 0) {
        await this.redis.pexpire(redisKey, ttl);
        timeToExpire = ttl;
      }
      const isBlocked = totalHits > limit;
      return {
        totalHits,
        timeToExpire,
        isBlocked,
        timeToBlockExpire: isBlocked ? (blockDuration > 0 ? blockDuration : timeToExpire) : 0,
      };
    } catch (e) {
      this.logger.warn(`throttler redis error, allowing request: ${(e as Error).message}`);
      return failOpen;
    }
  }
}
