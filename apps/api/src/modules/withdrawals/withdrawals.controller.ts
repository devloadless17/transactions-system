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
  approveWithdrawalSchema,
  cancelRequestSchema,
  createWithdrawalSchema,
  listWithdrawalsQuerySchema,
  rejectWithdrawalSchema,
  UserRole,
  type ApproveWithdrawalInput,
  type CancelRequestInput,
  type CreateWithdrawalInput,
  type ListWithdrawalsQuery,
  type RejectWithdrawalInput,
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
import { WithdrawalsService } from './withdrawals.service';

@UseGuards(CompanyAccessGuard, RolesGuard, CsrfGuard)
@Controller()
export class WithdrawalsController {
  constructor(private readonly withdrawals: WithdrawalsService) {}

  // ---------------- Company endpoints ----------------

  @Roles(UserRole.COMPANY_OWNER, UserRole.COMPANY_MANAGER)
  @Post('company/withdrawals')
  @Audited({ action: 'withdrawal.requested', entityType: 'withdrawal', idFrom: 'result.id' })
  async request(
    @Body(new ZodPipe(createWithdrawalSchema)) body: CreateWithdrawalInput,
    @CurrentUser() user: AuthPrincipal,
  ) {
    if (!user.companyId) throw new ForbiddenError('No company in session');
    return this.withdrawals.request(
      user.companyId,
      user.apiKeyAuth ? null : user.userId,
      body,
      user.apiKeyAuth ? user.userId : null,
    );
  }

  @Roles(UserRole.COMPANY_OWNER, UserRole.COMPANY_MANAGER, UserRole.COMPANY_VIEWER)
  @Get('company/withdrawals')
  async companyList(
    @Query(new ZodPipe(listWithdrawalsQuerySchema)) query: ListWithdrawalsQuery,
    @CurrentUser() user: AuthPrincipal,
  ) {
    if (!user.companyId) throw new ForbiddenError('No company in session');
    return this.withdrawals.list({ companyId: user.companyId, query });
  }

  @Roles(UserRole.COMPANY_OWNER, UserRole.COMPANY_MANAGER, UserRole.COMPANY_VIEWER)
  @Get('company/withdrawals/:id')
  async companyGet(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthPrincipal,
  ) {
    if (!user.companyId) throw new ForbiddenError('No company in session');
    return this.withdrawals.getById(id, user.companyId);
  }

  @Roles(UserRole.COMPANY_OWNER, UserRole.COMPANY_MANAGER)
  @Post('company/withdrawals/:id/cancel')
  @Audited({ action: 'withdrawal.cancelled', entityType: 'withdrawal', idFrom: 'params.id' })
  async cancel(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(cancelRequestSchema)) body: CancelRequestInput,
    @CurrentUser() user: AuthPrincipal,
  ) {
    if (!user.companyId) throw new ForbiddenError('No company in session');
    // API-key callers carry the keyId as userId (not a real users row); mirror
    // `request` and store null for cancelledById so the FK isn't violated.
    return this.withdrawals.cancel(id, user.companyId, user.apiKeyAuth ? null : user.userId, body);
  }

  // ---------------- Admin endpoints ----------------

  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR, UserRole.BACKOFFICE)
  @Get('admin/withdrawals')
  async adminList(@Query(new ZodPipe(listWithdrawalsQuerySchema)) query: ListWithdrawalsQuery) {
    return this.withdrawals.list({ query });
  }

  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR, UserRole.BACKOFFICE)
  @Get('admin/withdrawals/:id')
  async adminGet(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.withdrawals.getById(id);
  }

  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR, UserRole.BACKOFFICE)
  @Post('admin/withdrawals/:id/approve')
  @Audited({ action: 'withdrawal.approved', entityType: 'withdrawal', idFrom: 'params.id' })
  async approve(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(approveWithdrawalSchema)) body: ApproveWithdrawalInput,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.withdrawals.approve(id, user.userId, body);
  }

  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR, UserRole.BACKOFFICE)
  @Post('admin/withdrawals/:id/reject')
  @Audited({ action: 'withdrawal.rejected', entityType: 'withdrawal', idFrom: 'params.id' })
  async reject(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(rejectWithdrawalSchema)) body: RejectWithdrawalInput,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.withdrawals.reject(id, user.userId, body);
  }
}
