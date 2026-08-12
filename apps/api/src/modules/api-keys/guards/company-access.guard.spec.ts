import 'reflect-metadata';
import { describe, it, expect, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { CompanyAccessGuard } from './company-access.guard';
import { MALFORMED_API_KEY_MESSAGE } from './company-api-key-auth.guard';
import type { CompanyApiKeyAuthGuard } from './company-api-key-auth.guard';
import type { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { UnauthorizedError } from '../../../common/errors/domain.error';

function build(authorization?: string, cookies?: Record<string, string>) {
  const req: Record<string, unknown> = { headers: { authorization }, cookies };
  const ctx = {
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;
  const jwtGuard = { canActivate: vi.fn(async () => true) };
  const apiKeyGuard = { canActivate: vi.fn(async () => true) };
  const guard = new CompanyAccessGuard(
    jwtGuard as unknown as JwtAuthGuard,
    apiKeyGuard as unknown as CompanyApiKeyAuthGuard,
  );
  return { guard, req, ctx, jwtGuard, apiKeyGuard };
}

describe('CompanyAccessGuard routing', () => {
  it('routes an exact `Bearer tsk_` credential to the API-key guard and flags apiKeyAuth', async () => {
    const { guard, req, ctx, jwtGuard, apiKeyGuard } = build('Bearer tsk_ABCD_secret');

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(apiKeyGuard.canActivate).toHaveBeenCalledOnce();
    expect(jwtGuard.canActivate).not.toHaveBeenCalled();
    // CsrfGuard reads this to skip the double-submit check.
    expect(req.apiKeyAuth).toBe(true);
  });

  it('routes a session token to the JWT guard unchanged', async () => {
    const { guard, ctx, jwtGuard, apiKeyGuard } = build('Bearer eyJhbGciOiJIUzI1NiJ9.x.y');

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(jwtGuard.canActivate).toHaveBeenCalledOnce();
    expect(apiKeyGuard.canActivate).not.toHaveBeenCalled();
  });

  it('routes a request with no Authorization header to the JWT guard (cookie flow)', async () => {
    const { guard, ctx, jwtGuard } = build(undefined);

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(jwtGuard.canActivate).toHaveBeenCalledOnce();
  });
});

describe('CompanyAccessGuard malformed API-key credentials', () => {
  // These all used to fall through to the session guard and answer "Invalid or
  // expired access token" / "Missing access token", which reads as "your key is
  // bad" and sends integrators to rotate a perfectly healthy key.
  it.each([
    ['lowercase scheme', 'bearer tsk_ABCD_secret'],
    ['uppercase scheme', 'BEARER tsk_ABCD_secret'],
    ['uppercase key tag', 'Bearer TSK_ABCD_secret'],
    ['wrong scheme', 'Token tsk_ABCD_secret'],
    ['no scheme', 'tsk_ABCD_secret'],
    ['extra whitespace', 'Bearer   tsk_ABCD_secret'],
  ])('rejects %s with an actionable message', async (_label, header) => {
    const { guard, ctx, jwtGuard, apiKeyGuard } = build(header);

    await expect(guard.canActivate(ctx)).rejects.toThrow(UnauthorizedError);
    await expect(guard.canActivate(ctx)).rejects.toThrow(MALFORMED_API_KEY_MESSAGE);
    // Decided on shape alone — no key lookup, no session check, so nothing leaks.
    expect(apiKeyGuard.canActivate).not.toHaveBeenCalled();
    expect(jwtGuard.canActivate).not.toHaveBeenCalled();
  });

  it('defers to the session guard when a session cookie is present', async () => {
    // A dashboard request carrying a stray Authorization header must keep its old
    // behaviour rather than being told its (irrelevant) key is malformed.
    const { guard, ctx, jwtGuard } = build('bearer tsk_ABCD_secret', { txn_access: 'jwt' });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(jwtGuard.canActivate).toHaveBeenCalledOnce();
  });

  it('leaves a non-key credential to the session guard', async () => {
    const { guard, ctx, jwtGuard } = build('Basic dXNlcjpwYXNz');

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    expect(jwtGuard.canActivate).toHaveBeenCalledOnce();
  });
});
