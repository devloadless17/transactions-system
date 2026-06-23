import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis, { type Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import type { Env } from '../../config/env.schema';

// Returned by tryLock when Redis is unavailable: the caller still proceeds
// (fail-open), and unlock treats it as a no-op. Never collides with a real token.
const LOCK_DEGRADED = 'degraded';

// Single-flight tuning for `wrap`. When a read misses and another caller already
// holds the compute lock, we poll for its result up to SINGLE_FLIGHT_MAX_WAIT_MS
// (in SINGLE_FLIGHT_POLL_MS steps) before giving up and computing ourselves — so
// a crashed/slow lock holder can never block or deadlock other readers.
const SINGLE_FLIGHT_LOCK_TTL_MS = 5_000;
const SINGLE_FLIGHT_POLL_MS = 50;
const SINGLE_FLIGHT_MAX_WAIT_MS = 3_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
  async wrap<T>(
    key: string,
    ttlSeconds: number,
    fn: () => Promise<T>,
    opts?: { singleFlight?: boolean },
  ): Promise<T> {
    const gen = await this.generation(namespaceOf(key));
    const genKey = `${key}::g${gen}`;
    const cached = await this.get<T>(genKey);
    if (cached !== null) return cached;

    // Opt out of single-flight for callers that run INSIDE a transaction (e.g. the
    // commission-rule lookup on the money path): blocking up to
    // SINGLE_FLIGHT_MAX_WAIT_MS while holding a SERIALIZABLE tx (and its wallet row
    // locks) open is far worse than a brief stampede of a small, indexed read.
    // Compute directly on a miss and cache the result.
    if (opts?.singleFlight === false) {
      const fresh = await fn();
      await this.set(genKey, fresh, ttlSeconds);
      return fresh;
    }

    // Single-flight: on a miss, only one caller should run `fn` while the others
    // wait for its result, to avoid a stampede when many reads miss at once
    // (e.g. right after an invalidation bumps the generation). The lock is keyed
    // on `genKey`, so it is scoped to this exact generation — we can never wait
    // for or serve a value from a stale generation.
    //
    // When Redis is unavailable `tryLock` returns the LOCK_DEGRADED sentinel, so
    // every caller "wins" and computes directly — behavior identical to today's
    // uncached/degraded path. `unlock` is a no-op for that sentinel.
    const token = await this.tryLock(genKey, SINGLE_FLIGHT_LOCK_TTL_MS);
    if (token === null) {
      // Another caller is computing. Poll for its result, bounded so a crashed or
      // slow holder can never block us indefinitely; on timeout we compute too.
      const deadline = Date.now() + SINGLE_FLIGHT_MAX_WAIT_MS;
      while (Date.now() < deadline) {
        await sleep(SINGLE_FLIGHT_POLL_MS);
        const value = await this.get<T>(genKey);
        if (value !== null) return value;
      }
      // Holder never published in time — fall back to computing ourselves.
      return fn();
    }

    try {
      const fresh = await fn();
      await this.set(genKey, fresh, ttlSeconds);
      return fresh;
    } finally {
      await this.unlock(genKey, token);
    }
  }

  /**
   * Best-effort distributed lock (SET key token NX PX ttl). Returns a unique
   * token if acquired, else null. FAILS OPEN: if Redis is unavailable it returns
   * a sentinel token so the caller still runs — single-instance behavior is never
   * worse than today (the caller's own in-process guard still applies). The token
   * MUST be passed back to `unlock` so a slow job can't release a lock that
   * another instance has since acquired. Used to stop multiple API replicas from
   * running the same background sweep at once.
   */
  async tryLock(key: string, ttlMs: number): Promise<string | null> {
    if (!this.healthy) return LOCK_DEGRADED;
    try {
      const token = randomUUID();
      const res = await this.redis.set(`lock:${key}`, token, 'PX', ttlMs, 'NX');
      return res === 'OK' ? token : null;
    } catch (e) {
      this.logger.warn(`cache tryLock failed for ${key}: ${(e as Error).message}`);
      return LOCK_DEGRADED; // fail open
    }
  }

  /** Release a lock ONLY if this caller still holds it (token match), so we never
   * delete a lock another instance acquired after ours expired. No-op for the
   * fail-open sentinel. */
  async unlock(key: string, token: string): Promise<void> {
    if (!this.healthy || token === LOCK_DEGRADED) return;
    try {
      await this.redis.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1,
        `lock:${key}`,
        token,
      );
    } catch {
      // The lock will fall off on its own via the PX TTL; nothing to do.
    }
  }
}

/** First `:`-delimited segment of a key/prefix — the unit of invalidation. */
function namespaceOf(key: string): string {
  const i = key.indexOf(':');
  return i === -1 ? key : key.slice(0, i);
}
