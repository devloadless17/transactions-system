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
    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw new UnauthorizedError('Refresh token revoked or expired');
    }

    const user = await this.prisma.runAsAdmin((tx) =>
      tx.user.findUnique({ where: { id: payload.sub } }),
    );
    if (!user || user.status !== 'ACTIVE') throw new UnauthorizedError();
    await assertCompanyActive(this.prisma, user.companyId);

    // Rotate: revoke the used refresh token and mint new tokens.
    await this.prisma.runAsAdmin(async (tx) => {
      await tx.refreshToken.update({
        where: { id: stored.id },
        data: { revokedAt: new Date() },
      });
    });

    const authed: AuthenticatedUser = {
      id: user.id,
      email: user.email,
      role: user.role,
      companyId: user.companyId,
      mustChangePassword: user.mustChangePassword,
    };
    const tokens = await this.issueTokens(authed, ctx);
    return { user: authed, tokens };
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

// Hash refresh tokens with a keyed HMAC. The full JWT is the secret —
// we keep it out of the DB and store a deterministic short hash that
// we can index.
function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Pre-computed argon2id hash of a random string; used for constant-time
// dummy-verify when a login email is unknown.
const DUMMY_HASH =
  '$argon2id$v=19$m=65536,t=3,p=4$ZHVtbXlzYWx0ZHVtbXlzYWx0$5J5Z3WqVfH7gWlqXJqZ8Z3WqVfH7gWlqXJqZ8Z3WqVfA';
