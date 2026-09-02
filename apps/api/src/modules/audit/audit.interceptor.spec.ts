import { describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { Reflector } from '@nestjs/core';
import type { AuthenticatedRequest } from '../../common/types/request.types';
import { AuditInterceptor } from './audit.interceptor';
import type { AuditService } from './audit.service';

/**
 * The interceptor owns the audit row for every `@Audited()` route, so the
 * field-diff merge must be additive: routes that publish nothing have to keep
 * producing byte-identical metadata, and the error path — the one that exists
 * for fraud/incident forensics — must be unaffected.
 */
function harness(opts: { auditChanges?: AuthenticatedRequest['auditChanges']; fail?: unknown }) {
  const record = vi.fn(() => Promise.resolve());
  const audit = { record } as unknown as AuditService;
  const reflector = {
    getAllAndOverride: () => ({
      action: 'company.updated',
      entityType: 'company',
      idFrom: 'params.id',
    }),
  } as unknown as Reflector;

  const req = {
    method: 'PATCH',
    originalUrl: '/v1/admin/companies/c1',
    params: { id: 'c1' },
    headers: {},
    ip: '10.0.0.1',
    principal: { userId: 'u1', email: 'a@b.c', role: 'SUPER_ADMIN', companyId: null },
    auditChanges: opts.auditChanges,
  } as unknown as AuthenticatedRequest;

  const ctx = {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => req }),
  } as unknown as ExecutionContext;

  const next = {
    handle: () => (opts.fail ? throwError(() => opts.fail) : of({ id: 'c1' })),
  } as CallHandler;

  return { interceptor: new AuditInterceptor(audit, reflector), ctx, next, record };
}

const metadataOf = (record: ReturnType<typeof vi.fn>) =>
  (record.mock.calls[0][0] as { metadata: Record<string, unknown> }).metadata;

describe('AuditInterceptor — field diffs', () => {
  it('merges a published diff into metadata.changes', async () => {
    const { interceptor, ctx, next, record } = harness({
      auditChanges: { name: { from: 'Alpha', to: 'Beta' } },
    });
    await new Promise<void>((resolve) =>
      interceptor.intercept(ctx, next).subscribe(() => resolve()),
    );

    expect(metadataOf(record).changes).toEqual({ name: { from: 'Alpha', to: 'Beta' } });
  });

  // Routes that haven't adopted the mechanism must be untouched — no empty
  // `changes: {}` key appearing on every audit row in the system.
  it('writes NO changes key when the handler published nothing', async () => {
    const { interceptor, ctx, next, record } = harness({});
    await new Promise<void>((resolve) =>
      interceptor.intercept(ctx, next).subscribe(() => resolve()),
    );

    const metadata = metadataOf(record);
    expect('changes' in metadata).toBe(false);
    expect(metadata).toEqual({
      method: 'PATCH',
      path: '/v1/admin/companies/c1',
      outcome: 'success',
    });
  });

  it('omits an empty diff', async () => {
    const { interceptor, ctx, next, record } = harness({ auditChanges: {} });
    await new Promise<void>((resolve) =>
      interceptor.intercept(ctx, next).subscribe(() => resolve()),
    );
    expect('changes' in metadataOf(record)).toBe(false);
  });

  it('still records the error outcome, with no diff, when the handler throws', async () => {
    const err = Object.assign(new Error('only a SUPER_ADMIN can rename a company'), {
      status: 403,
    });
    const { interceptor, ctx, next, record } = harness({ fail: err });
    // The interceptor re-throws, so settle on either terminal signal.
    await new Promise<void>((resolve) =>
      interceptor.intercept(ctx, next).subscribe({
        error: () => resolve(),
        complete: () => resolve(),
      }),
    );

    const metadata = metadataOf(record);
    expect(metadata.outcome).toBe('error');
    expect(metadata.status).toBe(403);
    expect(metadata.error).toMatch(/SUPER_ADMIN/);
    expect('changes' in metadata).toBe(false);
  });
});
