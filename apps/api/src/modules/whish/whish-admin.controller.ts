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
import {
  WHISH_CURRENCIES,
  listWhishPaymentsQuerySchema,
  refundWhishPaymentSchema,
  UserRole,
  type ListWhishPaymentsQuery,
  type RefundWhishPaymentInput,
  type WhishCurrency,
} from '@app/shared';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CsrfGuard } from '../auth/guards/csrf.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { backofficeList, backofficeWhishPayment, isBackoffice } from '../../common/backoffice-view';
import type { AuthPrincipal } from '../../common/types/request.types';
import { Audited } from '../audit/audit.decorator';
import { SkipResponseEnvelope } from '../../common/decorators/skip-response-envelope.decorator';
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
  async list(
    @Query(new ZodPipe(listWhishPaymentsQuerySchema)) query: ListWhishPaymentsQuery,
    @CurrentUser() user: AuthPrincipal,
  ) {
    const page = await this.payments.listAll(query);
    return isBackoffice(user) ? backofficeList(page, backofficeWhishPayment) : page;
  }

  // Declared BEFORE `payments/:id` so the literal `export.csv` isn't captured by
  // the UUID param route.
  @Get('payments/export.csv')
  @SkipResponseEnvelope()
  exportPayments(
    @Query(new ZodPipe(listWhishPaymentsQuerySchema)) query: ListWhishPaymentsQuery,
    @CurrentUser() user: AuthPrincipal,
  ): StreamableFile {
    return this.payments.streamCsv({ query, backoffice: isBackoffice(user) });
  }

  /** One payment by id (across companies) — e.g. an audit-log deep link. */
  @Get('payments/:id')
  async getOne(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthPrincipal) {
    const payment = await this.payments.adminGetById(id);
    return isBackoffice(user) ? backofficeWhishPayment(payment) : payment;
  }

  /**
   * Re-attempt settlement of one payment (cross-company). The operator's recovery
   * for a paid-but-unsettled link: asks Whish for the authoritative status and
   * books it if collected — and, on a paid one, books a refund Whish has since
   * confirmed. Restricted to SUPER_ADMIN/ADMIN_OPERATOR (BACKOFFICE is
   * view-only) — overrides the class-level roles for this mutation.
   */
  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR)
  @Post('payments/:id/refresh-status')
  @Audited({
    action: 'whish.payment_refreshed',
    entityType: 'whish_payment',
    idFrom: 'params.id',
  })
  async refresh(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthPrincipal) {
    return this.payments.adminRefreshStatus(id, user.userId);
  }

  /**
   * Refund a paid payment to its payer through Whish (always the full amount)
   * and reverse its settled deposit. Real money leaves the platform's Whish
   * account, so — like Transfer Money — it is SUPER_ADMIN only. Companies never
   * refund themselves: they ask the platform, and a super admin presses Refund.
   * (Refresh stays open to ADMIN_OPERATOR: it can only BOOK a refund a super
   * admin already sent and Whish confirmed — it never asks Whish to pay.)
   */
  @Roles(UserRole.SUPER_ADMIN)
  @Post('payments/:id/refund')
  @Audited({
    action: 'whish.payment_refunded',
    entityType: 'whish_payment',
    idFrom: 'params.id',
  })
  async refund(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(refundWhishPaymentSchema)) body: RefundWhishPaymentInput,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.payments.refundPayment(id, { actorId: user.userId, reason: body.reason });
  }
}
