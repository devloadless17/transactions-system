import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { analyticsRangeSchema, UserRole, type AnalyticsRange } from '@app/shared';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthPrincipal } from '../../common/types/request.types';
import { ForbiddenError } from '../../common/errors/domain.error';
import { AnalyticsService } from './analytics.service';

// Dashboards auto-refresh these endpoints. They're cookie-authed and
// Redis-cached, so they bypass the public-API IP throttler.
@SkipThrottle()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller()
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR)
  @Get('admin/analytics/overview')
  async adminOverview(@Query(new ZodPipe(analyticsRangeSchema)) range: AnalyticsRange) {
    return this.analytics.overview({ scope: 'admin', range });
  }

  @Roles(UserRole.COMPANY_OWNER, UserRole.COMPANY_MANAGER, UserRole.COMPANY_VIEWER)
  @Get('company/analytics/overview')
  async companyOverview(
    @Query(new ZodPipe(analyticsRangeSchema)) range: AnalyticsRange,
    @CurrentUser() user: AuthPrincipal,
  ) {
    if (!user.companyId) throw new ForbiddenError('No company in session');
    return this.analytics.overview({ scope: { companyId: user.companyId }, range });
  }
}
