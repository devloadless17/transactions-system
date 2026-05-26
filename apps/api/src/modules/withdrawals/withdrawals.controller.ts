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
  createWithdrawalSchema,
  listWithdrawalsQuerySchema,
  rejectWithdrawalSchema,
  UserRole,
  type ApproveWithdrawalInput,
  type CreateWithdrawalInput,
  type ListWithdrawalsQuery,
  type RejectWithdrawalInput,
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
import { WithdrawalsService } from './withdrawals.service';

@UseGuards(JwtAuthGuard, RolesGuard, CsrfGuard)
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
    return this.withdrawals.request(user.companyId, user.userId, body);
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

  // ---------------- Admin endpoints ----------------

  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR)
  @Get('admin/withdrawals')
  async adminList(@Query(new ZodPipe(listWithdrawalsQuerySchema)) query: ListWithdrawalsQuery) {
    return this.withdrawals.list({ query });
  }

  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR)
  @Get('admin/withdrawals/:id')
  async adminGet(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.withdrawals.getById(id);
  }

  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR)
  @Post('admin/withdrawals/:id/approve')
  @Audited({ action: 'withdrawal.approved', entityType: 'withdrawal', idFrom: 'params.id' })
  async approve(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(approveWithdrawalSchema)) body: ApproveWithdrawalInput,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.withdrawals.approve(id, user.userId, body);
  }

  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR)
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
