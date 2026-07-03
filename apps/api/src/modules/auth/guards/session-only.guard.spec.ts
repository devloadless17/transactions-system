import 'reflect-metadata';
import { describe, it, expect } from 'vitest';
import type { ExecutionContext, Type } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { SessionOnlyGuard } from './session-only.guard';
import { ForbiddenError } from '../../../common/errors/domain.error';
import { WhishWebhookController } from '../../whish/whish-webhook.controller';
import { CrmController } from '../../crm/crm.controller';

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

// The guard only protects what it is actually ATTACHED to. These reflection
// checks pin the invariant "outbound-webhook management is dashboard-only" to
// the concrete handlers, so silently dropping the decorator (the exact gap a
// security audit found on the Whish webhook controller) fails a test instead
// of shipping.
function methodGuards(controller: Type<unknown>, method: string): unknown[] {
  const handler = (controller.prototype as Record<string, unknown>)[method];
  return (Reflect.getMetadata(GUARDS_METADATA, handler as object) as unknown[]) ?? [];
}

describe('SessionOnlyGuard attachment (webhook management surfaces)', () => {
  it('Whish webhook set/rotate/clear are session-only (GET stays key-readable)', () => {
    for (const m of ['set', 'rotate', 'clear']) {
      expect(methodGuards(WhishWebhookController, m), `WhishWebhookController.${m}`).toContain(
        SessionOnlyGuard,
      );
    }
    expect(methodGuards(WhishWebhookController, 'get')).not.toContain(SessionOnlyGuard);
  });

  it('CRM webhook set/clear are session-only', () => {
    for (const m of ['set', 'clear']) {
      expect(methodGuards(CrmController, m), `CrmController.${m}`).toContain(SessionOnlyGuard);
    }
  });
});
