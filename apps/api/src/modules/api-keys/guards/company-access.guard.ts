import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import type { AuthenticatedRequest } from '../../../common/types/request.types';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { CompanyApiKeyAuthGuard } from './company-api-key-auth.guard';

/**
 * Accepts either a company API key (Authorization: Bearer tsk_...) or a JWT
 * session cookie. This lets companies call company/* endpoints both from the
 * dashboard (cookie + CSRF) and programmatically (Bearer API key, no CSRF).
 *
 * When the API key path is taken, req.apiKeyAuth is set to true so CsrfGuard
 * knows to skip the double-submit check (API keys are not susceptible to CSRF).
 */
@Injectable()
export class CompanyAccessGuard implements CanActivate {
  constructor(
    private readonly jwtGuard: JwtAuthGuard,
    private readonly apiKeyGuard: CompanyApiKeyAuthGuard,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const auth = req.headers.authorization as string | undefined;

    if (auth?.startsWith('Bearer tsk_')) {
      const ok = await this.apiKeyGuard.canActivate(ctx);
      if (ok) req.apiKeyAuth = true;
      return ok;
    }

    return this.jwtGuard.canActivate(ctx);
  }
}
