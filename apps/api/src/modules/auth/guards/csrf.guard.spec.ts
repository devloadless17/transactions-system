import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { ConfigService } from '@nestjs/config';
import { CsrfGuard } from './csrf.guard';
import { ForbiddenError } from '../../../common/errors/domain.error';
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from '../auth.constants';
import { issueCsrfToken } from '../csrf.token';

const SECRET = 'test-csrf-secret-0123456789';

function makeGuard(isPublic = false): CsrfGuard {
  const reflector = {
    getAllAndOverride: vi.fn().mockReturnValue(isPublic),
  } as unknown as Reflector;
  const config = { get: vi.fn().mockReturnValue(SECRET) } as unknown as ConfigService<never, true>;
  return new CsrfGuard(reflector, config);
}

function ctxFor(req: Record<string, unknown>): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

describe('CsrfGuard', () => {
  it('allows safe methods (GET) without any token', () => {
    expect(makeGuard().canActivate(ctxFor({ method: 'GET', headers: {}, cookies: {} }))).toBe(true);
  });

  it('allows API-key-authenticated requests (no cookie, not CSRF-susceptible)', () => {
    const req = { method: 'POST', headers: {}, cookies: {}, apiKeyAuth: true };
    expect(makeGuard().canActivate(ctxFor(req))).toBe(true);
  });

  it('allows @Public routes', () => {
    const req = { method: 'POST', headers: {}, cookies: {} };
    expect(makeGuard(true).canActivate(ctxFor(req))).toBe(true);
  });

  it('rejects a mutating request with NO token', () => {
    const req = { method: 'POST', headers: {}, cookies: {} };
    expect(() => makeGuard().canActivate(ctxFor(req))).toThrow(ForbiddenError);
  });

  it('rejects when the header is present but the cookie is missing', () => {
    const token = issueCsrfToken(SECRET);
    const req = { method: 'POST', headers: { [CSRF_HEADER_NAME]: token }, cookies: {} };
    expect(() => makeGuard().canActivate(ctxFor(req))).toThrow(ForbiddenError);
  });

  it('rejects when cookie and header do NOT match (double-submit fails)', () => {
    const req = {
      method: 'POST',
      headers: { [CSRF_HEADER_NAME]: issueCsrfToken(SECRET) },
      cookies: { [CSRF_COOKIE_NAME]: issueCsrfToken(SECRET) },
    };
    expect(() => makeGuard().canActivate(ctxFor(req))).toThrow(ForbiddenError);
  });

  it('rejects a matching but HMAC-INVALID token (not minted by us)', () => {
    const forged = 'deadbeef.deadbeef';
    const req = {
      method: 'POST',
      headers: { [CSRF_HEADER_NAME]: forged },
      cookies: { [CSRF_COOKIE_NAME]: forged },
    };
    expect(() => makeGuard().canActivate(ctxFor(req))).toThrow(ForbiddenError);
  });

  it('allows a matching, HMAC-valid double-submit token', () => {
    const token = issueCsrfToken(SECRET);
    const req = {
      method: 'POST',
      headers: { [CSRF_HEADER_NAME]: token },
      cookies: { [CSRF_COOKIE_NAME]: token },
    };
    expect(makeGuard().canActivate(ctxFor(req))).toBe(true);
  });
});
