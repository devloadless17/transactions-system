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
import {
  createWhishPaymentSchema,
  listWhishPaymentsQuerySchema,
  UserRole,
  type CreateWhishPaymentInput,
  type ListWhishPaymentsQuery,
} from '@app/shared';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
import { CompanyAccessGuard } from '../api-keys/guards/company-access.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CsrfGuard } from '../auth/guards/csrf.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Audited } from '../audit/audit.decorator';
import type { AuthPrincipal } from '../../common/types/request.types';
import { ForbiddenError } from '../../common/errors/domain.error';
import { WhishPaymentsService } from './whish-payments.service';

/**
 * Company-facing Whish Pay. A company mints a payment link, shares the
 * returned collectUrl with its customer, and the payment settles into the
 * company's wallet once Whish confirms it (see the public callback controller).
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

  @Roles(UserRole.COMPANY_OWNER, UserRole.COMPANY_MANAGER, UserRole.COMPANY_VIEWER)
  @Get(':id')
  async get(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthPrincipal) {
    if (!user.companyId) throw new ForbiddenError('No company in session');
    return this.payments.getById(user.companyId, id);
  }

  @Roles(UserRole.COMPANY_OWNER, UserRole.COMPANY_MANAGER)
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
