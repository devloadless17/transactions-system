import { describe, expect, it, vi } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import { UserRole } from '@app/shared';
import { RolesGuard } from './roles.guard';
import { ForbiddenError } from '../../../common/errors/domain.error';

function guardWith(required: UserRole[] | undefined): RolesGuard {
  const reflector = {
    getAllAndOverride: vi.fn().mockReturnValue(required),
  } as unknown as Reflector;
  return new RolesGuard(reflector);
}

function ctxFor(principal: { role: UserRole } | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ principal }) }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  it('allows any request when no @Roles metadata is set (gating is opt-in)', () => {
    expect(guardWith(undefined).canActivate(ctxFor({ role: UserRole.COMPANY_VIEWER }))).toBe(true);
    expect(guardWith([]).canActivate(ctxFor({ role: UserRole.COMPANY_VIEWER }))).toBe(true);
  });

  it('allows when the principal role IS in the required set', () => {
    const g = guardWith([UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR]);
    expect(g.canActivate(ctxFor({ role: UserRole.ADMIN_OPERATOR }))).toBe(true);
  });

  it('rejects when the principal role is NOT in the required set', () => {
    const g = guardWith([UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR]);
    expect(() => g.canActivate(ctxFor({ role: UserRole.BACKOFFICE }))).toThrow(ForbiddenError);
  });

  it('rejects a company role on an admin-only resource', () => {
    const g = guardWith([UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR]);
    expect(() => g.canActivate(ctxFor({ role: UserRole.COMPANY_OWNER }))).toThrow(ForbiddenError);
  });

  it('rejects when there is no authenticated principal', () => {
    const g = guardWith([UserRole.SUPER_ADMIN]);
    expect(() => g.canActivate(ctxFor(undefined))).toThrow(ForbiddenError);
  });
});
