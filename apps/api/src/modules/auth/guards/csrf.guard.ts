import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { Reflector } from '@nestjs/core';
import { ForbiddenError } from '../../../common/errors/domain.error';
import type { Env } from '../../../config/env.schema';
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '../auth.constants';
import { verifyCsrfToken } from '../csrf.token';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import type { AuthenticatedRequest } from '../../../common/types/request.types';

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Double-submit cookie CSRF defense.
 *
 * The web app reads the `csrf-token` cookie (non-HttpOnly) and echoes it in the
 * `x-csrf-token` header on every mutating request. The server compares the two
 * and rejects if they don't match.
 *
 * Skipped for: safe methods, public routes, and API key endpoints (handled by a
 * separate guard in Phase 2).
 */
@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService<Env, true>,
  ) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request & { cookies?: Record<string, string> }>();

    if (!MUTATING_METHODS.has(req.method)) return true;

    // API-key-authenticated requests are not susceptible to CSRF — the key is
    // in the Authorization header, never in a cookie, so cross-origin pages
    // cannot silently attach it. Skip the double-submit check entirely.
    if ((req as AuthenticatedRequest).apiKeyAuth) return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const cookie = req.cookies?.[CSRF_COOKIE_NAME];
    const header = req.headers[CSRF_HEADER_NAME];
    const headerValue = Array.isArray(header) ? header[0] : header;

    // Double-submit: the cookie and the echoed header must match (proves the
    // request came from a page that can read our cookie, not a blind cross-site
    // POST). The HMAC check then proves the value was minted by us with the
    // current CSRF_SECRET — so rotating the secret invalidates every token.
    const secret = this.config.get('CSRF_SECRET', { infer: true });
    if (!cookie || !headerValue || cookie !== headerValue || !verifyCsrfToken(cookie, secret)) {
      throw new ForbiddenError('CSRF token missing or invalid');
    }
    return true;
  }
}
