import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { Reflector } from '@nestjs/core';
import { ForbiddenError } from '../../../common/errors/domain.error';
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '../auth.constants';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

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
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request & { cookies?: Record<string, string> }>();

    if (!MUTATING_METHODS.has(req.method)) return true;

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;

    const cookie = req.cookies?.[CSRF_COOKIE_NAME];
    const header = req.headers[CSRF_HEADER_NAME];
    const headerValue = Array.isArray(header) ? header[0] : header;

    if (!cookie || !headerValue || cookie !== headerValue) {
      throw new ForbiddenError('CSRF token missing or invalid');
    }
    return true;
  }
}
