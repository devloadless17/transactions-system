import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../../config/env.schema';
import type { PrismaService } from '../../../database/prisma.service';
import type { ApiKeysService } from '../api-keys.service';
import type { ApiKeyRateLimitStore, WindowCount } from '../api-key-rate-limit.store';
import { ApiKeyAuthGuard, failureBucketKey } from './api-key-auth.guard';
import { ApiKeyRateLimitGuard, IngestRateLimitGuard } from './api-key-rate-limit.guard';

/**
 * The ingest limiter policy, pinned:
 *   - AUTHENTICATED volume is UNLIMITED by default — a source pushes money that
 *     has already left the payer, so throttling it can only strand real funds.
 *   - FAILED authentication is always limited per IP — that is the surface an
 *     attacker hammers (key guessing + argon2 CPU burn on a known prefix).
 * Both fail OPEN when the counter is unreachable.
 */

const cfg = (value: number) => ({ get: () => value }) as unknown as ConfigService<Env, true>;

function ctxWith(headers: Record<string, string>, ip: string | undefined) {
  const res = { setHeader: vi.fn() };
  const req: Record<string, unknown> = { headers, ip };
  return {
    ctx: {
      switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
    } as unknown as ExecutionContext,
    req,
    res,
  };
}

function storeStub(peek: WindowCount | null = null, hit: WindowCount | null = null) {
  return {
    peek: vi.fn().mockResolvedValue(peek),
    hit: vi.fn().mockResolvedValue(hit),
    clear: vi.fn().mockResolvedValue(undefined),
  } as unknown as ApiKeyRateLimitStore & {
    peek: ReturnType<typeof vi.fn>;
    hit: ReturnType<typeof vi.fn>;
    clear: ReturnType<typeof vi.fn>;
  };
}

const prisma = {} as PrismaService;
const keysWith = (verifyResult: unknown) =>
  ({ verify: vi.fn().mockResolvedValue(verifyResult) }) as unknown as ApiKeysService & {
    verify: ReturnType<typeof vi.fn>;
  };

describe('ApiKeyAuthGuard — failed-attempt limiting (the surface attackers hammer)', () => {
  const GOOD = { companyId: null, sourceId: null, keyId: 'key-1' };

  it('rejects with 429 once the IP is over budget, WITHOUT reaching argon2 verify', async () => {
    const limits = storeStub({ count: 20, resetSeconds: 30 });
    const keys = keysWith(GOOD);
    const guard = new ApiKeyAuthGuard(keys, prisma, limits, cfg(20));
    const { ctx } = ctxWith({ authorization: 'Bearer tsk_GUESSED1_deadbeef' }, '203.0.113.9');

    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      httpStatus: 429,
    });
    // The whole point: a blocked attacker never costs us an argon2 verification.
    expect(keys.verify).not.toHaveBeenCalled();
  });

  it('counts a failure for a missing Authorization header', async () => {
    const limits = storeStub();
    const guard = new ApiKeyAuthGuard(keysWith(null), prisma, limits, cfg(20));
    const { ctx } = ctxWith({}, '203.0.113.9');

    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ httpStatus: 401 });
    expect(limits.hit).toHaveBeenCalledWith('rl:authfail:203.0.113.9:na', 60);
  });

  it('counts a failure for an invalid key', async () => {
    const limits = storeStub();
    const guard = new ApiKeyAuthGuard(keysWith(null), prisma, limits, cfg(20));
    const { ctx } = ctxWith({ authorization: 'Bearer tsk_NOPE1234_beef' }, '203.0.113.9');

    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ httpStatus: 401 });
    expect(limits.hit).toHaveBeenCalledTimes(1);
  });

  it('authenticates a valid key, records NO failure, and clears the IP budget', async () => {
    const limits = storeStub({ count: 5, resetSeconds: 30 });
    const guard = new ApiKeyAuthGuard(keysWith(GOOD), prisma, limits, cfg(20));
    const { ctx, req } = ctxWith({ authorization: 'Bearer tsk_REALKEY1_beef' }, '203.0.113.9');

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(limits.hit).not.toHaveBeenCalled();
    // Collateral protection: a partner sharing an egress IP with an attacker
    // wipes the budget every time they succeed.
    expect(limits.clear).toHaveBeenCalledWith('rl:authfail:203.0.113.9:REALKEY1', 60);
    expect((req.principal as { userId: string }).userId).toBe('key-1');
  });

  it('fails OPEN when the counter is unavailable (Redis outage must not block deposits)', async () => {
    const limits = storeStub(null, null); // peek → null
    const guard = new ApiKeyAuthGuard(keysWith(GOOD), prisma, limits, cfg(1));
    const { ctx } = ctxWith({ authorization: 'Bearer tsk_REALKEY1_beef' }, '203.0.113.9');

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });

  it('skips the limiter entirely when no client IP is available (no shared bucket)', async () => {
    const limits = storeStub();
    const guard = new ApiKeyAuthGuard(keysWith(GOOD), prisma, limits, cfg(20));
    const { ctx } = ctxWith({ authorization: 'Bearer tsk_REALKEY1_beef' }, undefined);

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(limits.peek).not.toHaveBeenCalled();
    expect(limits.hit).not.toHaveBeenCalled();
  });
});

describe('IngestRateLimitGuard — authenticated ingest volume', () => {
  const authed = (ip = '203.0.113.9') => {
    const built = ctxWith({}, ip);
    (built.req as Record<string, unknown>).principal = { userId: 'key-1' };
    return built;
  };

  it('is UNLIMITED by default (max 0) and never even touches the counter', async () => {
    const limits = storeStub();
    const guard = new IngestRateLimitGuard(cfg(0), limits);
    const { ctx } = authed();

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(limits.hit).not.toHaveBeenCalled();
  });

  it('enforces the ceiling when one is configured', async () => {
    const limits = storeStub(null, { count: 6, resetSeconds: 12 });
    const guard = new IngestRateLimitGuard(cfg(5), limits);
    const { ctx, res } = authed();

    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      httpStatus: 429,
    });
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', 12);
  });

  it('allows and advertises headroom below the ceiling', async () => {
    const limits = storeStub(null, { count: 3, resetSeconds: 40 });
    const guard = new IngestRateLimitGuard(cfg(5), limits);
    const { ctx, res } = authed();

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(res.setHeader).toHaveBeenCalledWith('RateLimit-Remaining', 2);
  });

  it('fails OPEN when the counter is unavailable', async () => {
    const limits = storeStub(null, null); // hit → null
    const guard = new IngestRateLimitGuard(cfg(5), limits);
    const { ctx } = authed();

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });
});

describe('ApiKeyRateLimitGuard — company Whish Pay stays capped', () => {
  it('still enforces its configured ceiling (unlimited ingest must not leak here)', async () => {
    const limits = storeStub(null, { count: 301, resetSeconds: 5 });
    const guard = new ApiKeyRateLimitGuard(cfg(300), limits);
    const built = ctxWith({}, '203.0.113.9');
    (built.req as Record<string, unknown>).principal = { userId: 'key-1' };

    await expect(guard.canActivate(built.ctx)).rejects.toMatchObject({ httpStatus: 429 });
  });
});

describe('failureBucketKey — isolates a real partner from an attacker on the same IP', () => {
  it('gives each well-formed key prefix its own budget', () => {
    expect(failureBucketKey('1.2.3.4', 'Bearer tsk_REALKEY1_abc')).toBe(
      'rl:authfail:1.2.3.4:REALKEY1',
    );
    expect(failureBucketKey('1.2.3.4', 'Bearer tsk_GUESSED1_abc')).toBe(
      'rl:authfail:1.2.3.4:GUESSED1',
    );
  });

  it('pools every malformed/missing credential into ONE bucket (no unbounded Redis keys)', () => {
    for (const junk of [undefined, '', 'Bearer nonsense', 'Bearer tsk_short_x', 'Basic abc']) {
      expect(failureBucketKey('1.2.3.4', junk)).toBe('rl:authfail:1.2.3.4:na');
    }
  });

  it("a partner's bucket is untouched while an attacker burns their own", () => {
    const partner = failureBucketKey('1.2.3.4', 'Bearer tsk_REALKEY1_good');
    const attacker = failureBucketKey('1.2.3.4', 'Bearer tsk_GUESSED1_bad');
    expect(partner).not.toBe(attacker);
  });
});
