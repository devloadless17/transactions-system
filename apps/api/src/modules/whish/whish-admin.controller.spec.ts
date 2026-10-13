import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { UserRole } from '@app/shared';
import { ROLES_KEY } from '../auth/decorators/roles.decorator';
import { CsrfGuard } from '../auth/guards/csrf.guard';
import { WhishAdminController } from './whish-admin.controller';

/**
 * Who may do what on the admin Whish page. A refund sends real money out of the
 * platform's Whish account, so it is SUPER_ADMIN only — companies ask the
 * platform, they never refund themselves (no company route exists at all).
 */
const roles = (target: object): UserRole[] | undefined => Reflect.getMetadata(ROLES_KEY, target);

describe('WhishAdminController — roles', () => {
  const c = WhishAdminController.prototype;

  it('refund is SUPER_ADMIN only', () => {
    expect(roles(c.refund)).toEqual([UserRole.SUPER_ADMIN]);
  });

  it('refresh is open to both full-admin roles (it never sends money)', () => {
    expect(roles(c.refresh)).toEqual([UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR]);
  });

  it('back office may only read', () => {
    expect(roles(WhishAdminController)).toContain(UserRole.BACKOFFICE);
    expect(roles(c.refund)).not.toContain(UserRole.BACKOFFICE);
    expect(roles(c.refresh)).not.toContain(UserRole.BACKOFFICE);
  });

  it('every mutation is CSRF-guarded (class-level guard)', () => {
    const guards: unknown[] = Reflect.getMetadata(GUARDS_METADATA, WhishAdminController) ?? [];
    expect(guards).toContain(CsrfGuard);
  });
});
