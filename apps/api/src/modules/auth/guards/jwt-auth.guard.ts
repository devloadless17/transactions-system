import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import type { Env } from '../../../config/env.schema';
import { UnauthorizedError } from '../../../common/errors/domain.error';
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
      });
    } catch {
      throw new UnauthorizedError('Invalid or expired access token');
    }

    const principal: AuthPrincipal = {
      userId: payload.sub,
      email: payload.email,
      role: payload.role,
      companyId: payload.companyId,
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
