import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { listActivityQuerySchema, UserRole, type ListActivityQuery } from '@app/shared';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
import { CompanyAccessGuard } from '../api-keys/guards/company-access.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthPrincipal } from '../../common/types/request.types';
import { ForbiddenError } from '../../common/errors/domain.error';
import { ActivityService } from './activity.service';

@UseGuards(CompanyAccessGuard, RolesGuard)
@Controller()
export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  // ---------- Admin: unified activity across all (or one) company ----------
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR, UserRole.BACKOFFICE)
  @Get('admin/activity')
  async adminList(@Query(new ZodPipe(listActivityQuerySchema)) query: ListActivityQuery) {
    return this.activity.list({ query });
  }

  // Platform-wide PENDING request counts for the admin sidebar badges.
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR, UserRole.BACKOFFICE)
  @Get('admin/operations/counts')
  async adminCounts() {
    return this.activity.adminPendingCounts();
  }

  // ---------- Company: own unified activity ----------
  @Roles(UserRole.COMPANY_OWNER, UserRole.COMPANY_MANAGER, UserRole.COMPANY_VIEWER)
  @Get('company/activity')
  async companyList(
    @Query(new ZodPipe(listActivityQuerySchema)) query: ListActivityQuery,
    @CurrentUser() user: AuthPrincipal,
  ) {
    if (!user.companyId) throw new ForbiddenError('No company in session');
    return this.activity.list({ companyId: user.companyId, query });
  }

  // ---------- Company: PENDING request counts for the sidebar badges ----------
  @Roles(UserRole.COMPANY_OWNER, UserRole.COMPANY_MANAGER, UserRole.COMPANY_VIEWER)
  @Get('company/operations/counts')
  async companyCounts(@CurrentUser() user: AuthPrincipal) {
    if (!user.companyId) throw new ForbiddenError('No company in session');
    return this.activity.companyPendingCounts(user.companyId);
  }
}
