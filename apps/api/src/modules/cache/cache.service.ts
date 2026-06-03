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

  /**
   * Invalidate a whole namespace by bumping its generation counter — O(1), no
   * SCAN. Every cached key carries the generation it was written under (see
   * `wrap`), so bumping makes all current entries unreachable at once and the
   * next read recomputes.
   *
   * Crucially this is race-safe: a read already in flight when invalidation
   * runs writes its (now-stale) result under the OLD generation, which nothing
   * reads anymore — so a slow read can't re-poison the cache after a mutation
   * (the bug that made dashboards show stale "old data" until a reload).
   * Orphaned old-generation keys simply expire via their TTL.
   *
   * The namespace is the first `:`-delimited segment of `prefix`, matching how
   * keys are namespaced (`analytics:…`, `commission:rules:…`).
   */
  async invalidate(prefix: string): Promise<void> {
    if (!this.healthy) return;
    try {
      await this.redis.incr(`cachegen:${namespaceOf(prefix)}`);
    } catch (e) {
      this.logger.warn(`cache invalidate failed for ${prefix}: ${(e as Error).message}`);
    }
  }

  /** Current generation for a namespace (0 if unset or Redis is unavailable). */
  private async generation(namespace: string): Promise<number> {
    if (!this.healthy) return 0;
    try {
      const v = await this.redis.get(`cachegen:${namespace}`);
      return v ? Number(v) || 0 : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Cache-aside, generation-aware: look up under the namespace's current
   * generation, otherwise compute and store under it. If an invalidation bumps
   * the generation while `fn` runs, the store lands on the old (orphaned)
   * generation and future reads — using the new generation — recompute fresh.
   */
  async wrap<T>(key: string, ttlSeconds: number, fn: () => Promise<T>): Promise<T> {
    const gen = await this.generation(namespaceOf(key));
    const genKey = `${key}::g${gen}`;
    const cached = await this.get<T>(genKey);
    if (cached !== null) return cached;
    const fresh = await fn();
    await this.set(genKey, fresh, ttlSeconds);
    return fresh;
  }
}

/** First `:`-delimited segment of a key/prefix — the unit of invalidation. */
function namespaceOf(key: string): string {
  const i = key.indexOf(':');
  return i === -1 ? key : key.slice(0, i);
}
