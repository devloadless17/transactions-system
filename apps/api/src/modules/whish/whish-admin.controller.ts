import { Controller, Get, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import {
  WHISH_CURRENCIES,
  listWhishPaymentsQuerySchema,
  UserRole,
  type ListWhishPaymentsQuery,
  type WhishCurrency,
} from '@app/shared';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CsrfGuard } from '../auth/guards/csrf.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { Audited } from '../audit/audit.decorator';
import { ValidationError } from '../../common/errors/domain.error';
import { WhishPaymentsService } from './whish-payments.service';

/** Admin view of Whish: platform balance + all payments across companies. */
@UseGuards(JwtAuthGuard, RolesGuard, CsrfGuard)
@Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR, UserRole.BACKOFFICE)
@Controller('admin/whish')
export class WhishAdminController {
  constructor(private readonly payments: WhishPaymentsService) {}

  @Get('balance')
  async balance(@Query('currency') currency?: string) {
    const cur = (currency ?? 'USD').toUpperCase() as WhishCurrency;
    if (!WHISH_CURRENCIES.includes(cur)) {
      throw new ValidationError(`currency must be one of ${WHISH_CURRENCIES.join(', ')}`);
    }
    return this.payments.getBalance(cur);
  }

  @Get('payments')
  async list(@Query(new ZodPipe(listWhishPaymentsQuerySchema)) query: ListWhishPaymentsQuery) {
    return this.payments.listAll(query);
  }

  /**
   * Re-attempt settlement of one payment (cross-company). The operator's recovery
   * for a paid-but-unsettled link: asks Whish for the authoritative status and
   * books it if collected. Restricted to SUPER_ADMIN/ADMIN_OPERATOR (BACKOFFICE
   * is view-only) — overrides the class-level roles for this mutation.
   */
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR)
  @Post('payments/:id/refresh-status')
  @Audited({
    action: 'whish.payment_refreshed',
    entityType: 'whish_payment',
    idFrom: 'params.id',
  })
  async refresh(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.payments.adminRefreshStatus(id);
  }
}
