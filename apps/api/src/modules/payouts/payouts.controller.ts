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
  approvePayoutSchema,
  cancelRequestSchema,
  createPayoutSchema,
  listPayoutsQuerySchema,
  rejectPayoutSchema,
  UserRole,
  type ApprovePayoutInput,
  type CancelRequestInput,
  type CreatePayoutInput,
  type ListPayoutsQuery,
  type RejectPayoutInput,
} from '@app/shared';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CsrfGuard } from '../auth/guards/csrf.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Audited } from '../audit/audit.decorator';
import type { AuthPrincipal } from '../../common/types/request.types';
import { ForbiddenError } from '../../common/errors/domain.error';
import { PayoutsService } from './payouts.service';

@UseGuards(JwtAuthGuard, RolesGuard, CsrfGuard)
@Controller()
export class PayoutsController {
  constructor(private readonly payouts: PayoutsService) {}

  // ---------------- Company endpoints ----------------

  @Roles(UserRole.COMPANY_OWNER, UserRole.COMPANY_MANAGER)
  @Post('company/payouts')
  @Audited({ action: 'payout.requested', entityType: 'payout', idFrom: 'result.id' })
  async request(
    @Body(new ZodPipe(createPayoutSchema)) body: CreatePayoutInput,
    @CurrentUser() user: AuthPrincipal,
  ) {
    if (!user.companyId) throw new ForbiddenError('No company in session');
    return this.payouts.request(user.companyId, user.userId, body);
  }

  @Roles(UserRole.COMPANY_OWNER, UserRole.COMPANY_MANAGER, UserRole.COMPANY_VIEWER)
  @Get('company/payouts')
  async companyList(
    @Query(new ZodPipe(listPayoutsQuerySchema)) query: ListPayoutsQuery,
    @CurrentUser() user: AuthPrincipal,
  ) {
    if (!user.companyId) throw new ForbiddenError('No company in session');
    return this.payouts.list({ companyId: user.companyId, query });
  }

  @Roles(UserRole.COMPANY_OWNER, UserRole.COMPANY_MANAGER)
  @Post('company/payouts/:id/cancel')
  @Audited({ action: 'payout.cancelled', entityType: 'payout', idFrom: 'params.id' })
  async cancel(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(cancelRequestSchema)) body: CancelRequestInput,
    @CurrentUser() user: AuthPrincipal,
  ) {
    if (!user.companyId) throw new ForbiddenError('No company in session');
    return this.payouts.cancel(id, user.companyId, user.userId, body);
  }

  // ---------------- Admin endpoints ----------------

  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR)
  @Get('admin/payouts')
  async adminList(@Query(new ZodPipe(listPayoutsQuerySchema)) query: ListPayoutsQuery) {
    return this.payouts.list({ query });
  }

  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR)
  @Get('admin/payouts/:id')
  async adminGet(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.payouts.getById(id);
  }

  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR)
  @Post('admin/payouts/:id/approve')
  @Audited({ action: 'payout.approved', entityType: 'payout', idFrom: 'params.id' })
  async approve(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(approvePayoutSchema)) body: ApprovePayoutInput,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.payouts.approve(id, user.userId, body);
  }

  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR)
  @Post('admin/payouts/:id/reject')
  @Audited({ action: 'payout.rejected', entityType: 'payout', idFrom: 'params.id' })
  async reject(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(rejectPayoutSchema)) body: RejectPayoutInput,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.payouts.reject(id, user.userId, body);
  }
}
