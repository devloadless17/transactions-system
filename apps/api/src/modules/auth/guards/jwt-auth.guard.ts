import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Env } from '../../../config/env.schema';
import { ForbiddenError, UnauthorizedError } from '../../../common/errors/domain.error';
import type { AuthenticatedRequest, AuthPrincipal } from '../../../common/types/request.types';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ACCESS_COOKIE_NAME } from '../auth.constants';
import type { AccessTokenPayload } from '../auth.types';
import { PrismaService } from '../../../database/prisma.service';
import { assertCompanyActive } from '../../../common/company-status';

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtService,
    private readonly config: ConfigService<Env, true>,
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const req = ctx.switchToHttp().getRequest<Request & { cookies?: Record<string, string> }>();
    const token = this.extractToken(req);
    if (!token) throw new UnauthorizedError('Missing access token');

    let payload: AccessTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<AccessTokenPayload>(token, {
        secret: this.config.get('JWT_ACCESS_SECRET', { infer: true }),
        algorithms: ['HS256'],
      });
    } catch {
      throw new UnauthorizedError('Invalid or expired access token');
    }

    // Re-validate the USER live (not just the JWT): a disabled or role-changed
    // user must lose / update access promptly, exactly like the company-status
    // gate below — a still-valid 15-min access token must not retain revoked
    // privileges. (This guard covers human dashboard/admin requests; ingest uses
    // ApiKeyAuthGuard, so there's no hot-path cost here.)
    const user = await this.prisma.runAsAdmin((tx) =>
      tx.user.findUnique({
        where: { id: payload.sub },
        select: { status: true, role: true, companyId: true, mustChangePassword: true },
      }),
    );
    if (!user || user.status !== 'ACTIVE') {
      throw new UnauthorizedError('User account is inactive');
    }
    if (user.role !== payload.role) {
      throw new UnauthorizedError('Session is stale (role changed); please sign in again');
    }
    // Enforce forced password rotation server-side, not just in the web client:
    // a user provisioned with a temp password (mustChangePassword=true) may only
    // reach the auth self-service routes until they rotate it. Without this, the
    // admin-issued temp credential is a fully-privileged, long-lived API key.
    if (user.mustChangePassword && !isPasswordChangePending(req.path)) {
      throw new ForbiddenError('Password change required before using the API');
    }

    const principal: AuthPrincipal = {
      userId: payload.sub,
      email: payload.email,
      // Use the live role/company, not the (possibly stale) token claims.
      role: user.role,
      companyId: user.companyId,
    };
    // Freeze access for inactive tenants immediately — even with a still-valid
    // token. Platform admins (no companyId) are never gated.
    await assertCompanyActive(this.prisma, principal.companyId);
    (req as AuthenticatedRequest).principal = principal;
    return true;
  }

  private extractToken(req: Request & { cookies?: Record<string, string> }): string | null {
    const cookieToken = req.cookies?.[ACCESS_COOKIE_NAME];
    if (cookieToken) return cookieToken;
    const auth = req.headers.authorization;
    if (auth && auth.startsWith('Bearer ')) return auth.slice('Bearer '.length);
    return null;
  }
}

// Routes a user with a pending forced password change may still reach (to read
// their session, rotate the password, or sign out). `endsWith` tolerates the
// global route prefix. Everything else is blocked until the flag clears.
const PASSWORD_CHANGE_ALLOWLIST = ['/auth/me', '/auth/change-password', '/auth/logout'];
function isPasswordChangePending(path: string): boolean {
  return PASSWORD_CHANGE_ALLOWLIST.some((p) => path === p || path.endsWith(p));
}
