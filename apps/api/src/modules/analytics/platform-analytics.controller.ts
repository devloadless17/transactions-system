import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import {
  adminAnalyticsRangeSchema,
  analyticsRangeSchema,
  flowsRangeSchema,
  UserRole,
  type AdminAnalyticsRange,
  type AnalyticsRange,
  type FlowsRange,
} from '@app/shared';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { PlatformAnalyticsService } from './platform-analytics.service';
import { AnalyticsService } from './analytics.service';

/**
 * Analytics endpoints are auto-refreshed by the admin dashboard every
 * 15–30s. They're cookie-authenticated to SUPER_ADMIN / ADMIN_OPERATOR
 * and hit Redis cache by default, so the global per-IP throttler (meant
 * to defend the public API surface) doesn't make sense here — it would
 * starve the dashboard during normal operator use.
 */
@SkipThrottle()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR)
@Controller('admin/analytics')
export class PlatformAnalyticsController {
  constructor(
    private readonly platformSvc: PlatformAnalyticsService,
    private readonly analytics: AnalyticsService,
  ) {}

  @Get('platform')
  async platform(@Query(new ZodPipe(adminAnalyticsRangeSchema)) range: AdminAnalyticsRange) {
    return this.platformSvc.platform(range);
  }

  @Get('flows')
  async flows(@Query(new ZodPipe(flowsRangeSchema)) range: FlowsRange) {
    return this.platformSvc.flows(range);
  }

  @Get('operations')
  async operations() {
    return this.platformSvc.operations();
  }

  /**
   * Per-company drilldown. Reuses the existing AnalyticsService logic
   * (the same one used by the company itself) but invoked under admin
   * scope so we can plot a specific company's activity on the admin's
   * company-detail page.
   */
  @Get('companies/:companyId/overview')
  async companyOverview(
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Query(new ZodPipe(analyticsRangeSchema)) range: AnalyticsRange,
  ) {
    return this.analytics.overview({
      scope: 'admin',
      range: { ...range, companyId },
    });
  }

  /**
   * Per-source drilldown: one source's KPIs/trend plus every company that
   * transacted through it. The "by source, each company" admin view.
   */
  @Get('sources/:sourceId/overview')
  async sourceOverview(
    @Param('sourceId', new ParseUUIDPipe()) sourceId: string,
    @Query(new ZodPipe(analyticsRangeSchema)) range: AnalyticsRange,
  ) {
    return this.analytics.sourceOverview({ sourceId, range });
  }
}
