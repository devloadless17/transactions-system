import { beforeEach, describe, expect, it, vi } from 'vitest';

// A minimal fake of the three Redis calls the storage makes.
const redis = {
  incr: vi.fn<(key: string) => Promise<number>>(),
  pttl: vi.fn<(key: string) => Promise<number>>(),
  pexpire: vi.fn<(key: string, ms: number) => Promise<number>>(),
  on: vi.fn(),
};
vi.mock('ioredis', () => ({ default: vi.fn(() => redis) }));

import { RedisThrottlerStorage } from './redis-throttler-storage';

/**
 * The throttler guard writes the storage record straight into response headers:
 * `timeToBlockExpire` → `Retry-After`, `timeToExpire` → `X-RateLimit-Reset`.
 * Both headers are SECONDS. Redis speaks milliseconds, so the storage must
 * convert — returning the raw PTTL told a throttled client to wait 60000 s.
 */
describe('RedisThrottlerStorage', () => {
  const TTL_MS = 60_000;
  const LIMIT = 100;
  let storage: RedisThrottlerStorage;

  beforeEach(() => {
    vi.clearAllMocks();
    redis.pexpire.mockResolvedValue(1);
    storage = new RedisThrottlerStorage('redis://unused');
  });

  it('first hit of a window: sets the TTL and reports the window in seconds', async () => {
    redis.incr.mockResolvedValue(1);
    redis.pttl.mockResolvedValue(-1);
    const rec = await storage.increment('ip', TTL_MS, LIMIT, 0, 'default');
    expect(redis.pexpire).toHaveBeenCalledWith('throttle:default:ip', TTL_MS);
    expect(rec).toEqual({ totalHits: 1, timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 });
  });

  it('over the limit: Retry-After is the seconds left in the window, never milliseconds', async () => {
    redis.incr.mockResolvedValue(LIMIT + 1);
    redis.pttl.mockResolvedValue(41_250);
    const rec = await storage.increment('ip', TTL_MS, LIMIT, 0, 'default');
    expect(redis.pexpire).not.toHaveBeenCalled();
    expect(rec.isBlocked).toBe(true);
    // Rounded UP: a client that waits exactly this long is always let through.
    expect(rec.timeToBlockExpire).toBe(42);
    expect(rec.timeToExpire).toBe(42);
  });

  it('a configured block duration is reported in seconds too', async () => {
    redis.incr.mockResolvedValue(LIMIT + 1);
    redis.pttl.mockResolvedValue(10_000);
    const rec = await storage.increment('ip', TTL_MS, LIMIT, 300_000, 'default');
    expect(rec.timeToBlockExpire).toBe(300);
    expect(rec.timeToExpire).toBe(10);
  });

  it('under the limit: not blocked, reset time in seconds', async () => {
    redis.incr.mockResolvedValue(7);
    redis.pttl.mockResolvedValue(999);
    const rec = await storage.increment('ip', TTL_MS, LIMIT, 0, 'default');
    expect(rec).toEqual({ totalHits: 7, timeToExpire: 1, isBlocked: false, timeToBlockExpire: 0 });
  });

  it('fails OPEN when Redis errors — and still reports seconds', async () => {
    redis.incr.mockRejectedValue(new Error('down'));
    const rec = await storage.increment('ip', TTL_MS, LIMIT, 0, 'default');
    expect(rec).toEqual({ totalHits: 1, timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 });
  });
});
