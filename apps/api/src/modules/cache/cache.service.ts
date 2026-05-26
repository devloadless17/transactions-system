import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis, { type Redis } from 'ioredis';
import type { Env } from '../../config/env.schema';

/**
 * Thin Redis-backed cache. Keys are namespaced via constructor args.
 *
 * On Redis failure, falls back to bypassing the cache so the API stays up
 * (degraded but functional).
 */
@Injectable()
export class CacheService implements OnModuleDestroy {
  private readonly logger = new Logger(CacheService.name);
  private readonly redis: Redis;
  private healthy = true;

  constructor(config: ConfigService<Env, true>) {
    const url = config.get('REDIS_URL', { infer: true });
    this.redis = new IORedis(url, {
      maxRetriesPerRequest: 2,
      enableOfflineQueue: false,
      lazyConnect: false,
    });
    this.redis.on('error', (e) => {
      if (this.healthy) {
        this.logger.warn(`redis error (cache will degrade): ${e.message}`);
        this.healthy = false;
      }
    });
    this.redis.on('ready', () => {
      if (!this.healthy) this.logger.log('redis recovered');
      this.healthy = true;
    });
  }

  async onModuleDestroy() {
    try {
      await this.redis.quit();
    } catch {
      // ignore
    }
  }

  async get<T>(key: string): Promise<T | null> {
    if (!this.healthy) return null;
    try {
      const v = await this.redis.get(key);
      return v ? (JSON.parse(v) as T) : null;
    } catch (e) {
      this.logger.warn(`cache get failed for ${key}: ${(e as Error).message}`);
      return null;
    }
  }

  async set(key: string, value: unknown, ttlSeconds: number): Promise<void> {
    if (!this.healthy) return;
    try {
      await this.redis.set(key, JSON.stringify(value), 'EX', ttlSeconds);
    } catch (e) {
      this.logger.warn(`cache set failed for ${key}: ${(e as Error).message}`);
    }
  }

  async invalidate(prefix: string): Promise<void> {
    if (!this.healthy) return;
    try {
      // SCAN to avoid blocking on large datasets.
      const stream = this.redis.scanStream({ match: `${prefix}*`, count: 200 });
      const keys: string[] = [];
      for await (const batch of stream) {
        keys.push(...(batch as string[]));
      }
      if (keys.length) await this.redis.del(...keys);
    } catch (e) {
      this.logger.warn(`cache invalidate failed for ${prefix}: ${(e as Error).message}`);
    }
  }

  /**
   * Cache-aside: look up, otherwise compute and store.
   */
  async wrap<T>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;
    const fresh = await fn();
    await this.set(key, fresh, ttlSeconds);
    return fresh;
  }
}
