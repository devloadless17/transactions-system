import { describe, it, expect } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { SessionOnlyGuard } from './session-only.guard';
import { ForbiddenError } from '../../../common/errors/domain.error';

function ctx(principal: unknown): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ principal }) }),
  } as unknown as ExecutionContext;
}

describe('SessionOnlyGuard', () => {
  const guard = new SessionOnlyGuard();

  it('allows a dashboard session principal (apiKeyAuth falsy / absent)', () => {
    expect(guard.canActivate(ctx({ apiKeyAuth: false, companyId: 'c1' }))).toBe(true);
    expect(guard.canActivate(ctx({ companyId: 'c1' }))).toBe(true);
  });

  it('rejects an API-key principal (apiKeyAuth true) — leaked tsk_ key cannot manage keys/team/webhook', () => {
    expect(() => guard.canActivate(ctx({ apiKeyAuth: true, companyId: 'c1' }))).toThrow(
      ForbiddenError,
    );
  });
});
