import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { UnauthorizedError } from '../../../common/errors/domain.error';
import type { AuthenticatedRequest } from '../../../common/types/request.types';
import { ACCESS_COOKIE_NAME } from '../../auth/auth.constants';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import {
  CompanyApiKeyAuthGuard,
  MALFORMED_API_KEY_MESSAGE,
  looksLikeApiKey,
} from './company-api-key-auth.guard';

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

    // An API-key-SHAPED credential that isn't exactly `Bearer tsk_...` (lowercase
    // scheme, a different scheme, no scheme at all) would otherwise fall through to
    // the session guard and be answered with "Invalid or expired access token" —
    // sending an integrator off to debug a key that is perfectly healthy. Name the
    // real fault instead. No key lookup happens here, so this reveals nothing about
    // whether the key exists; the strict `Bearer tsk_` routing rule above is
    // untouched (it also decides the CSRF-skip flag). Skipped when a session cookie
    // is present so no dashboard request can regress on a stray Authorization header.
    const { cookies } = req as AuthenticatedRequest & { cookies?: Record<string, string> };
    const hasSessionCookie = Boolean(cookies?.[ACCESS_COOKIE_NAME]);
    if (!hasSessionCookie && looksLikeApiKey(auth)) {
      throw new UnauthorizedError(MALFORMED_API_KEY_MESSAGE);
    }

    return this.jwtGuard.canActivate(ctx);
  }
}
