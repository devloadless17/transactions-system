import crypto from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { JwtService } from '@nestjs/jwt';
import type { ConfigService } from '@nestjs/config';
import { UserRole } from '@app/shared';
import { PrismaService } from '../../src/database/prisma.service';
import { AuthService } from '../../src/modules/auth/auth.service';
import type { Env } from '../../src/config/env.schema';

/**
 * Integration cover for refresh-token rotation + reuse-detection against the
 * REAL _test DB. This is NOT the money harness — AuthService is constructed
 * directly with a real PrismaService, a real JwtService, and a stub
 * ConfigService that returns the JWT secrets/TTLs the service reads.
 *
 * The product behaviour pinned here (do NOT change auth.service.ts to make a
 * test pass — these ARE the correct semantics):
 *   (1) happy rotation: refresh(t1) -> t2; t1 is now revoked AND rotated.
 *   (2) in-grace replay of t1 (rotatedAt within REFRESH_REUSE_GRACE_MS) RE-ISSUES
 *       and does NOT revoke the family.
 *   (3) out-of-grace replay of an already-rotated t1 trips reuse-detection:
 *       the whole family is revoked and the refresh is rejected.
 *   (4) a logout-revoked token (revokedAt set, rotatedAt NULL) is rejected and a
 *       sibling token still works (no family revoke).
 *   (5) concurrent double-refresh of the same token never over-revokes: at least
 *       one call succeeds and the family is left intact (no reuse revoke).
 *
 * REFRESH_REUSE_GRACE_MS is a hardcoded 30_000ms constant in the service (not
 * configurable), so the grace-window scenarios manipulate the stored token's
 * `rotatedAt` directly in the DB rather than waiting real time.
 */

// REFRESH_REUSE_GRACE_MS in auth.service.ts. Mirrored here for the DB-time math.
const GRACE_MS = 30_000;

// Secrets only need to satisfy the service's verify/sign calls (min length is
// enforced at boot, not here); they just have to differ from each other.
const ACCESS_SECRET = 'test-access-secret-test-access-secret-0001';
const REFRESH_SECRET = 'test-refresh-secret-test-refresh-secret-002';
const ACCESS_TTL = 900;
const REFRESH_TTL = 7 * 24 * 3600;

// Minimal stub of the typed ConfigService<Env, true> — only the four keys
// issueTokens()/refresh() read. The `{ infer: true }` second arg is ignored.
const configStub = {
  get(key: keyof Env) {
    switch (key) {
      case 'JWT_ACCESS_SECRET':
        return ACCESS_SECRET;
      case 'JWT_REFRESH_SECRET':
        return REFRESH_SECRET;
      case 'JWT_ACCESS_TTL':
        return ACCESS_TTL;
      case 'JWT_REFRESH_TTL':
        return REFRESH_TTL;
      default:
        return undefined;
    }
  },
} as unknown as ConfigService<Env, true>;

const CTX = { userAgent: 'vitest', ipAddress: '127.0.0.1' };

let seq = 0;
const uniqEmail = () => `auth-refresh-${Date.now().toString(36)}-${seq++}@example.test`;

/** Seed an ACTIVE, company-less user directly (null company ⇒ assertCompanyActive is a no-op). */
async function seedUser(prisma: PrismaService): Promise<string> {
  const user = await prisma.runAsAdmin((tx) =>
    tx.user.create({
      data: {
        email: uniqEmail(),
        passwordHash: 'x', // never authenticated via password in these tests
        role: UserRole.SUPER_ADMIN,
        status: 'ACTIVE',
        companyId: null,
      },
      select: { id: true },
    }),
  );
  return user.id;
}

function hashRefreshToken(token: string): string {
  // Must match auth.service.ts's private hashRefreshToken (unkeyed sha256 hex).
  // Re-implemented (it is not exported) so we can locate the stored row by raw token.
  return crypto.createHash('sha256').update(token).digest('hex');
}

/** Read the stored refresh_tokens row for a raw token (admin scope, by hash). */
function storedFor(prisma: PrismaService, rawToken: string) {
  return prisma.runAsAdmin((tx) =>
    tx.refreshToken.findUnique({ where: { tokenHash: hashRefreshToken(rawToken) } }),
  );
}

/** Count the user's still-active (not-yet-revoked) refresh tokens. */
function activeCount(prisma: PrismaService, userId: string): Promise<number> {
  return prisma.runAsAdmin((tx) => tx.refreshToken.count({ where: { userId, revokedAt: null } }));
}

describe('refresh-token rotation / reuse-detection', () => {
  let prisma: PrismaService;
  let auth: AuthService;

  beforeAll(async () => {
    // Guardrail: never let this suite touch a non-test database.
    if (!process.env.DATABASE_URL?.includes('_test')) {
      throw new Error(
        `refusing to run auth integration tests against non-test DATABASE_URL=${process.env.DATABASE_URL}`,
      );
    }
    prisma = new PrismaService();
    const jwt = new JwtService({}); // per-call secret/expiry are passed explicitly
    auth = new AuthService(prisma, jwt, configStub);
  });

  it('(1) happy rotation: refresh(t1) -> t2; t1 is now revoked AND rotated', async () => {
    const userId = await seedUser(prisma);
    const t1 = await auth.issueTokens(
      {
        id: userId,
        email: 'a',
        role: UserRole.SUPER_ADMIN,
        companyId: null,
        mustChangePassword: false,
      },
      CTX,
    );

    const res = await auth.refresh(t1.refreshToken, CTX);

    // A fresh, distinct token was issued.
    expect(res.tokens.refreshToken).toBeTruthy();
    expect(res.tokens.refreshToken).not.toBe(t1.refreshToken);
    expect(res.user.id).toBe(userId);

    // t1 is now a benign ROTATION: revokedAt set, rotatedAt set.
    const oldRow = await storedFor(prisma, t1.refreshToken);
    expect(oldRow?.revokedAt).not.toBeNull();
    expect(oldRow?.rotatedAt).not.toBeNull();

    // t2 is live; the family has exactly one active token.
    const newRow = await storedFor(prisma, res.tokens.refreshToken);
    expect(newRow?.revokedAt).toBeNull();
    expect(await activeCount(prisma, userId)).toBe(1);
  });

  it('(2) in-grace replay of t1 RE-ISSUES and does NOT revoke the family', async () => {
    const userId = await seedUser(prisma);
    const t1 = await auth.issueTokens(
      {
        id: userId,
        email: 'a',
        role: UserRole.SUPER_ADMIN,
        companyId: null,
        mustChangePassword: false,
      },
      CTX,
    );

    // First refresh rotates t1 -> t2 (rotatedAt = now, within grace).
    const first = await auth.refresh(t1.refreshToken, CTX);
    expect(await activeCount(prisma, userId)).toBe(1); // only t2

    // Replay the SAME t1 while it is still within the grace window: must re-issue
    // a NEW token without revoking the family (benign concurrent refresh).
    const replay = await auth.refresh(t1.refreshToken, CTX);
    expect(replay.tokens.refreshToken).toBeTruthy();
    expect(replay.tokens.refreshToken).not.toBe(t1.refreshToken);
    expect(replay.tokens.refreshToken).not.toBe(first.tokens.refreshToken);

    // t2 must still be alive — the replay did NOT trip a family revoke.
    const t2Row = await storedFor(prisma, first.tokens.refreshToken);
    expect(t2Row?.revokedAt).toBeNull();
    // Two live successors now (t2 + the in-grace re-issue), zero family revoke.
    expect(await activeCount(prisma, userId)).toBe(2);
  });

  it('(3) out-of-grace replay of an already-rotated t1 revokes the family and is rejected', async () => {
    const userId = await seedUser(prisma);
    const t1 = await auth.issueTokens(
      {
        id: userId,
        email: 'a',
        role: UserRole.SUPER_ADMIN,
        companyId: null,
        mustChangePassword: false,
      },
      CTX,
    );

    const first = await auth.refresh(t1.refreshToken, CTX); // t1 -> t2, rotatedAt = now

    // Age t1's rotation past the grace window (deterministic: rewrite rotatedAt
    // in the DB rather than sleeping). Now a replay reads as genuine reuse.
    const staleRotatedAt = new Date(Date.now() - GRACE_MS - 60_000);
    await prisma.runAsAdmin((tx) =>
      tx.refreshToken.update({
        where: { tokenHash: hashRefreshToken(t1.refreshToken) },
        data: { rotatedAt: staleRotatedAt },
      }),
    );

    await expect(auth.refresh(t1.refreshToken, CTX)).rejects.toThrow();

    // Reuse detection revoked the WHOLE family, including the otherwise-valid t2.
    expect(await activeCount(prisma, userId)).toBe(0);
    const t2Row = await storedFor(prisma, first.tokens.refreshToken);
    expect(t2Row?.revokedAt).not.toBeNull();

    // And t2 itself can no longer refresh — the session family is dead.
    await expect(auth.refresh(first.tokens.refreshToken, CTX)).rejects.toThrow();
  });

  it('(4) a logout-revoked token is rejected and a sibling token still works', async () => {
    const userId = await seedUser(prisma);
    const authed = {
      id: userId,
      email: 'a',
      role: UserRole.SUPER_ADMIN,
      companyId: null,
      mustChangePassword: false,
    };
    // Two independent sessions for the same user (e.g. two devices).
    const sessionA = await auth.issueTokens(authed, CTX);
    const sessionB = await auth.issueTokens(authed, CTX);

    // Log out session A only. logout() sets revokedAt but leaves rotatedAt NULL,
    // marking it a deliberate security revoke (not a benign rotation).
    await auth.logout(sessionA.refreshToken);

    const aRow = await storedFor(prisma, sessionA.refreshToken);
    expect(aRow?.revokedAt).not.toBeNull();
    expect(aRow?.rotatedAt).toBeNull(); // deliberate kill, not a rotation

    // A: rejected even within any grace window — classifyRevoked => 'reject'
    // because rotatedAt is null. It must NOT trigger a family revoke.
    await expect(auth.refresh(sessionA.refreshToken, CTX)).rejects.toThrow();

    // B: untouched, still refreshable; logout of A did not cascade to B.
    const bRefreshed = await auth.refresh(sessionB.refreshToken, CTX);
    expect(bRefreshed.tokens.refreshToken).toBeTruthy();
    expect(bRefreshed.user.id).toBe(userId);
  });

  it('(5) concurrent double-refresh of the same token never over-revokes', async () => {
    const userId = await seedUser(prisma);
    const t1 = await auth.issueTokens(
      {
        id: userId,
        email: 'a',
        role: UserRole.SUPER_ADMIN,
        companyId: null,
        mustChangePassword: false,
      },
      CTX,
    );

    // Fire two refreshes of the SAME token at once. The conditional rotate
    // (updateMany where revokedAt: null) lets exactly one win the row; the loser
    // re-reads, sees a within-grace rotation, and re-issues. Neither should trip
    // the reuse path (which would revoke the whole family).
    const results = await Promise.allSettled([
      auth.refresh(t1.refreshToken, CTX),
      auth.refresh(t1.refreshToken, CTX),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    // At least one must succeed; the in-grace branch means both typically do.
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);

    // No over-revoke: the family was NOT killed. There is at least one live
    // successor token, and t1's own row carries a rotatedAt (benign rotation),
    // never the null-rotatedAt signature of a security revoke.
    expect(await activeCount(prisma, userId)).toBeGreaterThanOrEqual(1);
    const t1Row = await storedFor(prisma, t1.refreshToken);
    expect(t1Row?.revokedAt).not.toBeNull();
    expect(t1Row?.rotatedAt).not.toBeNull();

    // Each successful refresh issued a usable, distinct successor token.
    for (const r of fulfilled) {
      if (r.status === 'fulfilled') {
        expect(r.value.tokens.refreshToken).toBeTruthy();
        expect(r.value.tokens.refreshToken).not.toBe(t1.refreshToken);
      }
    }
  });
});
