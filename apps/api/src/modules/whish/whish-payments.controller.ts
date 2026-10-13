import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { StreamableFile } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import {
  createWhishPaymentSchema,
  listWhishPaymentsQuerySchema,
  UserRole,
  type CreateWhishPaymentInput,
  type ListWhishPaymentsQuery,
} from '@app/shared';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
import { CompanyAccessGuard } from '../api-keys/guards/company-access.guard';
import {
  ApiKeyRateLimitGuard,
  IntegrationBudget,
} from '../api-keys/guards/api-key-rate-limit.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CsrfGuard } from '../auth/guards/csrf.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Audited } from '../audit/audit.decorator';
import { SkipResponseEnvelope } from '../../common/decorators/skip-response-envelope.decorator';
import type { AuthPrincipal } from '../../common/types/request.types';
import { ForbiddenError } from '../../common/errors/domain.error';
import { WhishPaymentsService } from './whish-payments.service';

/**
 * Company-facing Whish Pay. A company mints a payment link, shares the
 * returned collectUrl with its customer, and the payment settles into the
 * company's wallet once Whish confirms it (see the public callback controller).
 *
 * A link's own calls — create, look up, refresh — carry the same per-key brakes
 * as the Whish Pay API (/v1/integrations/whish; per user on a dashboard session)
 * instead of the per-IP cap: a company creating links for many customers at
 * once must never be refused (see ApiKeyRateLimitGuard). Only the list and the
 * CSV keep the per-IP cap.
 */
@UseGuards(CompanyAccessGuard, RolesGuard, CsrfGuard)
@Controller('company/whish/payments')
export class WhishPaymentsController {
  constructor(private readonly payments: WhishPaymentsService) {}

  @Roles(UserRole.COMPANY_OWNER, UserRole.COMPANY_MANAGER, UserRole.COMPANY_VIEWER)
  @Get()
  async list(
    @Query(new ZodPipe(listWhishPaymentsQuerySchema)) query: ListWhishPaymentsQuery,
    @CurrentUser() user: AuthPrincipal,
  ) {
    if (!user.companyId) throw new ForbiddenError('No company in session');
    return this.payments.list(user.companyId, query);
  }

  // Declared BEFORE the `:id` route so the literal `export.csv` segment isn't
  // captured by the UUID param route.
  @Roles(UserRole.COMPANY_OWNER, UserRole.COMPANY_MANAGER, UserRole.COMPANY_VIEWER)
  @Get('export.csv')
  @SkipResponseEnvelope()
  export(
    @Query(new ZodPipe(listWhishPaymentsQuerySchema)) query: ListWhishPaymentsQuery,
    @CurrentUser() user: AuthPrincipal,
  ): StreamableFile {
    if (!user.companyId) throw new ForbiddenError('No company in session');
    return this.payments.streamCsv({ companyId: user.companyId, query });
  }

  @Roles(UserRole.COMPANY_OWNER, UserRole.COMPANY_MANAGER, UserRole.COMPANY_VIEWER)
  @SkipThrottle()
  @UseGuards(ApiKeyRateLimitGuard)
  @IntegrationBudget('lookup')
  @Get(':id')
  async get(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthPrincipal) {
    if (!user.companyId) throw new ForbiddenError('No company in session');
    return this.payments.getById(user.companyId, id);
  }

  @Roles(UserRole.COMPANY_OWNER, UserRole.COMPANY_MANAGER)
  @SkipThrottle()
  @UseGuards(ApiKeyRateLimitGuard)
  @IntegrationBudget('create')
  @Post()
  @Audited({
    action: 'whish.payment_created',
    entityType: 'whish_payment',
    idFrom: 'result.id',
  })
  async create(
    @Body(new ZodPipe(createWhishPaymentSchema)) body: CreateWhishPaymentInput,
    @CurrentUser() user: AuthPrincipal,
  ) {
    if (!user.companyId) throw new ForbiddenError('No company in session');
    return this.payments.createPayment(user.companyId, body);
  }

  @Roles(UserRole.COMPANY_OWNER, UserRole.COMPANY_MANAGER)
  @SkipThrottle()
  @UseGuards(ApiKeyRateLimitGuard)
  @IntegrationBudget('refresh')
  @Post(':id/refresh-status')
  @Audited({
    action: 'whish.payment_refreshed',
    entityType: 'whish_payment',
    idFrom: 'params.id',
  })
  async refresh(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthPrincipal) {
    if (!user.companyId) throw new ForbiddenError('No company in session');
    return this.payments.refreshStatus(user.companyId, id);
  }
}
