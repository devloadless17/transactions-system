import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { UserRole } from '@app/shared';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CsrfGuard } from '../auth/guards/csrf.guard';
import { AUDIT_METADATA_KEY } from '../audit/audit.decorator';
import { AdminDepositsController } from './admin-deposits.controller';

/**
 * A manual deposit puts money into a company's wallet, so: SUPER_ADMIN only, a
 * dashboard session only (never an API key), CSRF-guarded, and audited.
 */
describe('AdminDepositsController — who may enter a deposit by hand', () => {
  it('is SUPER_ADMIN only', () => {
    expect(Reflect.getMetadata(ROLES_KEY, AdminDepositsController)).toEqual([UserRole.SUPER_ADMIN]);
    // No method widens it.
    const c = AdminDepositsController.prototype;
    expect(Reflect.getMetadata(ROLES_KEY, c.create)).toBeUndefined();
    expect(Reflect.getMetadata(ROLES_KEY, c.preview)).toBeUndefined();
  });

  it('needs a dashboard session and a CSRF token', () => {
    const guards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, AdminDepositsController) ?? [];
    expect(guards).toEqual([JwtAuthGuard, RolesGuard, CsrfGuard]);
  });

  it('every manual deposit is audited, attributed to the company it credited', () => {
    expect(
      Reflect.getMetadata(AUDIT_METADATA_KEY, AdminDepositsController.prototype.create),
    ).toEqual({
      action: 'transaction.manual_deposit',
      entityType: 'transaction',
      idFrom: 'result.id',
      companyIdFrom: 'result.companyId',
    });
  });
});
