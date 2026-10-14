import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Reflector } from '@nestjs/core';
import type { Env } from '../../../config/env.schema';
import type { PrismaService } from '../../../database/prisma.service';
import type { ApiKeysService } from '../api-keys.service';
import type { ApiKeyRateLimitStore, WindowCount } from '../api-key-rate-limit.store';
import { ApiKeyAuthGuard, failureBucketKey } from './api-key-auth.guard';
import { ApiKeyRateLimitGuard, IngestRateLimitGuard } from './api-key-rate-limit.guard';
import { CompanyApiKeyAuthGuard } from './company-api-key-auth.guard';

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
      getHandler: () => undefined,
      getClass: () => undefined,
    } as unknown as ExecutionContext,
    req,
    res,
  };
}

function storeStub(
  peek: WindowCount | null = null,
  hit: WindowCount | null = null,
  opts: { trusted?: boolean; peekByKey?: Record<string, WindowCount> } = {},
) {
  return {
    peek: vi.fn((key: string) =>
      Promise.resolve(opts.peekByKey ? (opts.peekByKey[key] ?? null) : peek),
    ),
    hit: vi.fn().mockResolvedValue(hit),
    clear: vi.fn().mockResolvedValue(undefined),
    isTrusted: vi.fn().mockResolvedValue(opts.trusted ?? false),
    markTrusted: vi.fn().mockResolvedValue(undefined),
  } as unknown as ApiKeyRateLimitStore & Record<string, ReturnType<typeof vi.fn>>;
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
    expect(limits.hit).toHaveBeenCalledWith('rl:authfail:key:203.0.113.9:na', 60);
    expect(limits.hit).toHaveBeenCalledWith('rl:authfail:ip:203.0.113.9', 60);
  });

  it('counts a failure for an invalid key', async () => {
    const limits = storeStub();
    const guard = new ApiKeyAuthGuard(keysWith(null), prisma, limits, cfg(20));
    const { ctx } = ctxWith({ authorization: 'Bearer tsk_NOPE1234_beef' }, '203.0.113.9');

    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ httpStatus: 401 });
    expect(limits.hit).toHaveBeenCalledTimes(2); // per-prefix AND per-IP
  });

  it('authenticates a valid key, records NO failure, and clears the IP budget', async () => {
    const limits = storeStub({ count: 5, resetSeconds: 30 });
    const guard = new ApiKeyAuthGuard(keysWith(GOOD), prisma, limits, cfg(20));
    const { ctx, req } = ctxWith({ authorization: 'Bearer tsk_REALKEY1_beef' }, '203.0.113.9');

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(limits.hit).not.toHaveBeenCalled();
    // Collateral protection: a partner sharing an egress IP with an attacker
    // wipes the budget every time they succeed.
    expect(limits.clear).toHaveBeenCalledWith('rl:authfail:key:203.0.113.9:REALKEY1', 60);
    expect(limits.markTrusted).toHaveBeenCalled();
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

describe('ApiKeyRateLimitGuard — the company Whish Pay API, one budget per kind of call', () => {
  // INTEGRATION_CREATE_RATE_LIMIT_MAX → create + refresh; INTEGRATION_LOOKUP_RATE_LIMIT_MAX → lookup.
  // Production defaults: 60,000 and 300,000 a minute — brakes against a flood,
  // above what the platform itself serves, so never a ceiling for real customers.
  const config = {
    get: (key: string) =>
      key === 'INTEGRATION_LOOKUP_RATE_LIMIT_MAX'
        ? 300000
        : key === 'INTEGRATION_CREATE_RATE_LIMIT_MAX'
          ? 60000
          : 0,
  } as unknown as ConfigService<Env, true>;
  const reflectorFor = (budget: string | undefined) =>
    ({ getAllAndOverride: vi.fn(() => budget) }) as unknown as Reflector;
  const call = async (budget: string | undefined, count: number) => {
    const limits = storeStub(null, { count, resetSeconds: 5 });
    const guard = new ApiKeyRateLimitGuard(config, limits, reflectorFor(budget));
    const built = ctxWith({}, '203.0.113.9');
    (built.req as Record<string, unknown>).principal = { userId: 'key-1' };
    const outcome = await guard.canActivate(built.ctx).then(
      () => 'allowed',
      (e: { httpStatus?: number }) => e.httpStatus,
    );
    return { outcome, limits, res: built.res };
  };

  it('link creation: a brake at 60,000 a minute (1,000 a second) per key, above what the platform serves', async () => {
    expect((await call('create', 60000)).outcome).toBe('allowed');
    const over = await call('create', 60001);
    expect(over.outcome).toBe(429);
    expect(over.res.setHeader).toHaveBeenCalledWith('Retry-After', 5);
    expect(over.limits.hit).toHaveBeenCalledWith('rl:integration:create:key-1', 60);
  });

  it('a Whish status refresh has the same ceiling but its OWN counter', async () => {
    const { outcome, limits } = await call('refresh', 60000);
    expect(outcome).toBe('allowed');
    expect(limits.hit).toHaveBeenCalledWith('rl:integration:refresh:key-1', 60);
    expect((await call('refresh', 60001)).outcome).toBe(429);
  });

  it('status lookups (our database only) get 300,000 a minute on their own counter', async () => {
    const { outcome, limits } = await call('lookup', 300000);
    expect(outcome).toBe('allowed');
    expect(limits.hit).toHaveBeenCalledWith('rl:integration:lookup:key-1', 60);
    expect((await call('lookup', 300001)).outcome).toBe(429);
  });

  it('polling can never spend the budget link creation needs (different counters)', async () => {
    const lookup = await call('lookup', 25000);
    const create = await call('create', 1);
    const lookupKey = (lookup.limits.hit as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    const createKey = (create.limits.hit as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(lookupKey).not.toBe(createKey);
  });

  it('a handler without a declared budget spends the strictest one (create)', async () => {
    const { limits } = await call(undefined, 1);
    expect(limits.hit).toHaveBeenCalledWith('rl:integration:create:key-1', 60);
  });

  it('fails OPEN when the counter is unavailable', async () => {
    const limits = storeStub(null, null);
    const guard = new ApiKeyRateLimitGuard(config, limits, reflectorFor('create'));
    const built = ctxWith({}, '203.0.113.9');
    (built.req as Record<string, unknown>).principal = { userId: 'key-1' };
    await expect(guard.canActivate(built.ctx)).resolves.toBe(true);
  });
});

/**
 * Company keys (the Whish Pay API, and every /v1/company/* route through
 * CompanyAccessGuard) get the same failed-attempt limiting as source keys. It
 * is what makes it safe for the Whish Pay API to have no per-IP request cap.
 */
describe('CompanyApiKeyAuthGuard — failed-attempt limiting', () => {
  const COMPANY_KEY = { companyId: 'co-1', sourceId: null, keyId: 'key-9' };
  const SOURCE_KEY = { companyId: null, sourceId: 'src-1', keyId: 'key-src' };
  const activePrisma = {
    company: { findUnique: vi.fn().mockResolvedValue({ status: 'ACTIVE' }) },
    runAsAdmin: vi.fn((fn: (tx: unknown) => unknown) =>
      fn({ company: { findUnique: vi.fn().mockResolvedValue({ status: 'ACTIVE' }) } }),
    ),
  } as unknown as PrismaService;

  it('rejects with 429 once over budget, WITHOUT reaching argon2 verify', async () => {
    const limits = storeStub({ count: 20, resetSeconds: 30 });
    const keys = keysWith(COMPANY_KEY);
    const guard = new CompanyApiKeyAuthGuard(keys, activePrisma, limits, cfg(20));
    const { ctx, res } = ctxWith({ authorization: 'Bearer tsk_GUESSED1_deadbeef' }, '203.0.113.9');

    await expect(guard.canActivate(ctx)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      httpStatus: 429,
    });
    expect(keys.verify).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', 30);
  });

  it('counts an invalid key, a missing key and a malformed key as failed attempts', async () => {
    for (const authorization of ['Bearer tsk_NOPE1234_beef', undefined, 'bearer tsk_ABCD1234_x']) {
      const limits = storeStub();
      const guard = new CompanyApiKeyAuthGuard(keysWith(null), activePrisma, limits, cfg(20));
      const { ctx } = ctxWith(authorization ? { authorization } : {}, '203.0.113.9');
      await expect(guard.canActivate(ctx)).rejects.toMatchObject({ httpStatus: 401 });
      expect(limits.hit).toHaveBeenCalledTimes(2); // per-prefix AND per-IP
    }
  });

  it('a working company key records no failure, clears the budget and is trusted', async () => {
    const limits = storeStub({ count: 7, resetSeconds: 30 });
    const guard = new CompanyApiKeyAuthGuard(keysWith(COMPANY_KEY), activePrisma, limits, cfg(20));
    const { ctx, req } = ctxWith({ authorization: 'Bearer tsk_REALKEY1_beef' }, '203.0.113.9');

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(limits.hit).not.toHaveBeenCalled();
    expect(limits.clear).toHaveBeenCalledWith('rl:authfail:key:203.0.113.9:REALKEY1', 60);
    expect(limits.markTrusted).toHaveBeenCalled();
    expect(req.principal).toMatchObject({ companyId: 'co-1', apiKeyAuth: true });
  });

  it('a trusted key is never blocked, even from an IP an attacker has flooded', async () => {
    const IP = '203.0.113.9';
    const limits = storeStub(null, null, {
      trusted: true,
      peekByKey: { [`rl:authfail:ip:${IP}`]: { count: 9999, resetSeconds: 30 } },
    });
    const guard = new CompanyApiKeyAuthGuard(keysWith(COMPANY_KEY), activePrisma, limits, cfg(20));
    const { ctx } = ctxWith({ authorization: 'Bearer tsk_REALKEY1_beef' }, IP);

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(limits.peek).not.toHaveBeenCalled();
  });

  it('a real SOURCE key on a company endpoint is refused but not counted as a guess', async () => {
    const limits = storeStub();
    const guard = new CompanyApiKeyAuthGuard(keysWith(SOURCE_KEY), activePrisma, limits, cfg(20));
    const { ctx } = ctxWith({ authorization: 'Bearer tsk_SOURCEK1_beef' }, '203.0.113.9');

    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ httpStatus: 401 });
    expect(limits.hit).not.toHaveBeenCalled();
  });

  it('fails OPEN when the counter is unavailable', async () => {
    const limits = storeStub(null, null);
    const guard = new CompanyApiKeyAuthGuard(keysWith(COMPANY_KEY), activePrisma, limits, cfg(1));
    const { ctx } = ctxWith({ authorization: 'Bearer tsk_REALKEY1_beef' }, '203.0.113.9');

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });
});

describe('failureBucketKey — isolates a real partner from an attacker on the same IP', () => {
  it('gives each well-formed key prefix its own budget', () => {
    expect(failureBucketKey('1.2.3.4', 'Bearer tsk_REALKEY1_abc')).toBe(
      'rl:authfail:key:1.2.3.4:REALKEY1',
    );
    expect(failureBucketKey('1.2.3.4', 'Bearer tsk_GUESSED1_abc')).toBe(
      'rl:authfail:key:1.2.3.4:GUESSED1',
    );
  });

  it('pools every malformed/missing credential into ONE bucket (no unbounded Redis keys)', () => {
    for (const junk of [undefined, '', 'Bearer nonsense', 'Bearer tsk_short_x', 'Basic abc']) {
      expect(failureBucketKey('1.2.3.4', junk)).toBe('rl:authfail:key:1.2.3.4:na');
    }
  });

  it("a partner's bucket is untouched while an attacker burns their own", () => {
    const partner = failureBucketKey('1.2.3.4', 'Bearer tsk_REALKEY1_good');
    const attacker = failureBucketKey('1.2.3.4', 'Bearer tsk_GUESSED1_bad');
    expect(partner).not.toBe(attacker);
  });
});

describe('closing the bypasses the review found', () => {
  const GOOD = { companyId: null, sourceId: null, keyId: 'key-1' };
  const IP = '203.0.113.9';

  it('an attacker ROTATING the key prefix is still caught by the per-IP budget', async () => {
    // Each fresh prefix has an empty per-prefix bucket, so only the IP-wide
    // budget (max * 5) can stop prefix rotation.
    const limits = storeStub(null, null, {
      peekByKey: { [`rl:authfail:ip:${IP}`]: { count: 100, resetSeconds: 30 } },
    });
    const guard = new ApiKeyAuthGuard(keysWith(null), prisma, limits, cfg(20));
    const { ctx } = ctxWith({ authorization: 'Bearer tsk_NEWGUESS_abc' }, IP);

    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ httpStatus: 429 });
  });

  it('a TRUSTED credential skips the budgets, so a flooded IP cannot block a real partner', async () => {
    const limits = storeStub(null, null, {
      trusted: true,
      peekByKey: {
        [`rl:authfail:ip:${IP}`]: { count: 9999, resetSeconds: 30 },
        [`rl:authfail:key:${IP}:REALKEY1`]: { count: 9999, resetSeconds: 30 },
      },
    });
    const guard = new ApiKeyAuthGuard(keysWith(GOOD), prisma, limits, cfg(20));
    const { ctx } = ctxWith({ authorization: 'Bearer tsk_REALKEY1_good' }, IP);

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(limits.peek).not.toHaveBeenCalled();
  });

  it('the auth 429 advertises Retry-After like every other 429 on this API', async () => {
    const limits = storeStub(null, null, {
      peekByKey: { [`rl:authfail:key:${IP}:GUESSED1`]: { count: 20, resetSeconds: 17 } },
    });
    const guard = new ApiKeyAuthGuard(keysWith(null), prisma, limits, cfg(20));
    const { ctx, res } = ctxWith({ authorization: 'Bearer tsk_GUESSED1_abc' }, IP);

    await expect(guard.canActivate(ctx)).rejects.toMatchObject({ httpStatus: 429 });
    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', 17);
  });
});
