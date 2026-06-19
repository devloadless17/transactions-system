import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import argon2 from 'argon2';
import crypto from 'node:crypto';
import { PrismaService } from '../../database/prisma.service';
import type { Env } from '../../config/env.schema';
import { UnauthorizedError } from '../../common/errors/domain.error';
import { assertCompanyActive } from '../../common/company-status';
import type { AccessTokenPayload, RefreshTokenPayload } from './auth.types';

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  refreshTokenJti: string;
  accessTtlSec: number;
  refreshTtlSec: number;
}

interface AuthenticatedUser {
  id: string;
  email: string;
  role: AccessTokenPayload['role'];
  companyId: string | null;
  mustChangePassword: boolean;
}

// A refresh token that was revoked within this window is treated as a BENIGN
// concurrent refresh — multiple open tabs, the realtime socket's reconnect, and
// an HTTP 401 retry routinely fire the same refresh cookie within a moment of
// each other once the 15-min access token lapses. Revoking the whole session
// family on that race is what logged real users out when they returned to an idle
// tab. A token replayed AFTER this window still trips full reuse-detection (a
// genuinely stolen/old token), so the security property is preserved.
const REFRESH_REUSE_GRACE_MS = 30_000;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Verify email/password and, on success, issue access + refresh tokens.
   * The refresh token is hashed and stored as a row in `refresh_tokens`
   * so we can revoke it on logout or password reset.
   */
  async login(
    email: string,
    password: string,
    ctx: { userAgent?: string; ipAddress?: string },
  ): Promise<{ user: AuthenticatedUser; tokens: IssuedTokens }> {
    const user = await this.prisma.runAsAdmin((tx) =>
      tx.user.findUnique({ where: { email: email.toLowerCase() } }),
    );

    if (!user || user.status !== 'ACTIVE') {
      // Constant-ish timing: still hash a dummy password to avoid leaking
      // whether the user exists. Argon2 verify on a constant hash is fine.
      await argon2.verify(DUMMY_HASH, password).catch(() => false);
      throw new UnauthorizedError('Invalid credentials');
    }

    const ok = await argon2.verify(user.passwordHash, password);
    if (!ok) throw new UnauthorizedError('Invalid credentials');

    // Block sign-in for users of an inactive company (data is retained; access is not).
    await assertCompanyActive(this.prisma, user.companyId);

    const authed: AuthenticatedUser = {
      id: user.id,
      email: user.email,
      role: user.role,
      companyId: user.companyId,
      mustChangePassword: user.mustChangePassword,
    };
    const tokens = await this.issueTokens(authed, ctx);

    await this.prisma.runAsAdmin((tx) =>
      tx.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      }),
    );

    return { user: authed, tokens };
  }

  async issueTokens(
    user: AuthenticatedUser,
    ctx: { userAgent?: string; ipAddress?: string },
  ): Promise<IssuedTokens> {
    const accessTtl = this.config.get('JWT_ACCESS_TTL', { infer: true });
    const refreshTtl = this.config.get('JWT_REFRESH_TTL', { infer: true });

    const accessPayload: AccessTokenPayload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      companyId: user.companyId,
    };
    const accessToken = await this.jwt.signAsync(accessPayload, {
      secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
      expiresIn: accessTtl,
    });

    const jti = crypto.randomUUID();
    const refreshPayload: RefreshTokenPayload = { sub: user.id, jti };
    const refreshToken = await this.jwt.signAsync(refreshPayload, {
      secret: this.config.get('JWT_REFRESH_SECRET', { infer: true }),
      expiresIn: refreshTtl,
    });

    const tokenHash = hashRefreshToken(refreshToken);
    await this.prisma.runAsAdmin((tx) =>
      tx.refreshToken.create({
        data: {
          userId: user.id,
          tokenHash,
          expiresAt: new Date(Date.now() + refreshTtl * 1000),
          userAgent: ctx.userAgent ?? null,
          ipAddress: ctx.ipAddress ?? null,
        },
      }),
    );

    return {
      accessToken,
      refreshToken,
      refreshTokenJti: jti,
      accessTtlSec: accessTtl,
      refreshTtlSec: refreshTtl,
    };
  }

  async refresh(
    rawRefreshToken: string,
    ctx: { userAgent?: string; ipAddress?: string },
  ): Promise<{ user: AuthenticatedUser; tokens: IssuedTokens }> {
    let payload: RefreshTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<RefreshTokenPayload>(rawRefreshToken, {
        secret: this.config.get('JWT_REFRESH_SECRET', { infer: true }),
        algorithms: ['HS256'],
      });
    } catch {
      throw new UnauthorizedError('Invalid refresh token');
    }

    const tokenHash = hashRefreshToken(rawRefreshToken);
    const stored = await this.prisma.runAsAdmin((tx) =>
      tx.refreshToken.findUnique({ where: { tokenHash } }),
    );
    if (!stored || stored.expiresAt < new Date()) {
      throw new UnauthorizedError('Refresh token revoked or expired');
    }
    const user = await this.prisma.runAsAdmin((tx) =>
      tx.user.findUnique({ where: { id: payload.sub } }),
    );
    if (!user || user.status !== 'ACTIVE') throw new UnauthorizedError();
    await assertCompanyActive(this.prisma, user.companyId);
    const authed: AuthenticatedUser = {
      id: user.id,
      email: user.email,
      role: user.role,
      companyId: user.companyId,
      mustChangePassword: user.mustChangePassword,
    };

    // Reuse detection WITH a rotation grace window. A legitimate client (multiple
    // tabs / socket reconnect / HTTP retry) often replays the SAME cookie within a
    // second of rotating it — that must NOT log the user out. But the grace must
    // apply ONLY to benign ROTATIONS, never to tokens deliberately killed by a
    // security action (logout / password change / admin reset / reuse-detection):
    // those leave `rotatedAt` null and must stay dead, or the grace would resurrect
    // a session the user/admin just invalidated.
    //   - rotated within grace      → benign concurrent refresh: re-issue, no revoke.
    //   - rotated longer ago        → genuine reuse of an old token: revoke the family.
    //   - revoked but NOT rotated   → deliberately killed: reject, never re-issue.
    const classifyRevoked = (tok: { rotatedAt: Date | null }): 'reissue' | 'reuse' | 'reject' => {
      if (!tok.rotatedAt) return 'reject';
      return Date.now() - tok.rotatedAt.getTime() <= REFRESH_REUSE_GRACE_MS ? 'reissue' : 'reuse';
    };
    const revokeFamily = async (): Promise<void> => {
      await this.prisma.runAsAdmin((tx) =>
        tx.refreshToken.updateMany({
          where: { userId: stored.userId, revokedAt: null },
          data: { revokedAt: new Date() },
        }),
      );
      this.logger.warn(
        `refresh token reuse detected for user ${stored.userId}; revoked all active sessions`,
      );
    };
    const reissue = async () => {
      // Observability for the one window where a within-grace replay is accepted.
      this.logger.debug(`in-grace refresh re-issue for user ${stored.userId}`);
      return { user: authed, tokens: await this.issueTokens(authed, ctx) };
    };

    if (stored.revokedAt) {
      const decision = classifyRevoked(stored);
      if (decision === 'reissue') return reissue();
      if (decision === 'reuse') {
        await revokeFamily();
        throw new UnauthorizedError('Refresh token revoked or expired');
      }
      // Deliberately revoked (logout / password change / admin reset) — stays dead.
      throw new UnauthorizedError('Refresh token revoked or expired');
    }

    // Rotate: revoke the used token with a CONDITIONAL updateMany (revokedAt: null)
    // so two concurrent refreshes can't both win at the row, and STAMP rotatedAt so
    // a concurrent loser (or a within-grace replay) can tell this was a benign
    // rotation rather than a security revocation.
    const rotated = await this.prisma.runAsAdmin((tx) =>
      tx.refreshToken.updateMany({
        where: { id: stored.id, revokedAt: null },
        data: { revokedAt: new Date(), rotatedAt: new Date() },
      }),
    );
    if (rotated.count === 0) {
      // The token was revoked between our read and write. Re-read to learn WHY: a
      // concurrent rotation (benign → re-issue) or a security revoke (logout /
      // password change / admin reset → reject). Never blindly re-issue here, or a
      // logout/password-change racing a refresh would be resurrected.
      const current = await this.prisma.runAsAdmin((tx) =>
        tx.refreshToken.findUnique({ where: { id: stored.id } }),
      );
      const decision = current?.revokedAt ? classifyRevoked(current) : 'reject';
      if (decision === 'reissue') return reissue();
      if (decision === 'reuse') {
        await revokeFamily();
        throw new UnauthorizedError('Refresh token revoked or expired');
      }
      throw new UnauthorizedError('Refresh token revoked or expired');
    }

    return { user: authed, tokens: await this.issueTokens(authed, ctx) };
  }

  async logout(rawRefreshToken: string | null): Promise<void> {
    if (!rawRefreshToken) return;
    const tokenHash = hashRefreshToken(rawRefreshToken);
    await this.prisma.runAsAdmin((tx) =>
      tx.refreshToken.updateMany({
        where: { tokenHash, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    );
  }

  async me(userId: string): Promise<AuthenticatedUser> {
    const user = await this.prisma.runAsAdmin((tx) =>
      tx.user.findUnique({ where: { id: userId } }),
    );
    if (!user || user.status !== 'ACTIVE') throw new UnauthorizedError();
    await assertCompanyActive(this.prisma, user.companyId);
    return {
      id: user.id,
      email: user.email,
      role: user.role,
      companyId: user.companyId,
      mustChangePassword: user.mustChangePassword,
    };
  }

  /**
   * Change the password for the currently-authenticated user. Verifies the
   * old password before setting the new one (defense against session-hijack
   * scenarios where the attacker has the cookie but not the password).
   * Clears the mustChangePassword flag and revokes all other refresh tokens.
   */
  async changePassword(
    userId: string,
    args: { currentPassword: string; newPassword: string },
  ): Promise<void> {
    const user = await this.prisma.runAsAdmin((tx) =>
      tx.user.findUnique({ where: { id: userId } }),
    );
    if (!user) throw new UnauthorizedError();
    const ok = await argon2.verify(user.passwordHash, args.currentPassword);
    if (!ok) throw new UnauthorizedError('Current password is incorrect');

    const newHash = await argon2.hash(args.newPassword, { type: argon2.argon2id });
    await this.prisma.runAsAdmin(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: { passwordHash: newHash, mustChangePassword: false },
      });
      // Force a fresh login from every other device by revoking all refresh tokens.
      await tx.refreshToken.updateMany({
        where: { userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
    });
  }
}

// Store an unkeyed SHA-256 lookup hash of the refresh token, never the token
// itself. The token is a high-entropy signed JWT, so an unkeyed digest is an
// adequate one-way, deterministic index that we can look up and revoke by.
function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Pre-computed argon2id hash of a random string; used for constant-time
// dummy-verify when a login email is unknown.
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$ZHVtbXlzYWx0ZHVtbXlzYWx0$5J5Z3WqVfH7gWlqXJqZ8Z3WqVfH7gWlqXJqZ8Z3WqVfA';
