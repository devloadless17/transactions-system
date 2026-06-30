import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { StreamableFile } from '@nestjs/common';
import {
  approveWithdrawalSchema,
  cancelRequestSchema,
  createWithdrawalSchema,
  listWithdrawalsQuerySchema,
  rejectWithdrawalSchema,
  resolveProcessingSchema,
  updateWithdrawalAutoApprovalSchema,
  UserRole,
  type ApproveWithdrawalInput,
  type CancelRequestInput,
  type CreateWithdrawalInput,
  type ListWithdrawalsQuery,
  type RejectWithdrawalInput,
  type ResolveProcessingInput,
  type UpdateWithdrawalAutoApprovalInput,
} from '@app/shared';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
import { CompanyAccessGuard } from '../api-keys/guards/company-access.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CsrfGuard } from '../auth/guards/csrf.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Audited } from '../audit/audit.decorator';
import type { AuthPrincipal } from '../../common/types/request.types';
import { SkipResponseEnvelope } from '../../common/decorators/skip-response-envelope.decorator';
import { ForbiddenError } from '../../common/errors/domain.error';
import { WithdrawalsService } from './withdrawals.service';
import { AutoApprovalConfigStore } from './auto-approval-config.store';
import { WithdrawalAutoApprovalService } from './withdrawal-auto-approval.service';

@UseGuards(CompanyAccessGuard, RolesGuard, CsrfGuard)
@Controller()
export class WithdrawalsController {
  constructor(
    private readonly withdrawals: WithdrawalsService,
    private readonly autoApproval: AutoApprovalConfigStore,
    private readonly autoApprovalRunner: WithdrawalAutoApprovalService,
  ) {}

  // ---------------- Company endpoints ----------------

  @Roles(UserRole.COMPANY_OWNER, UserRole.COMPANY_MANAGER)
  @Post('company/withdrawals')
  @Audited({ action: 'withdrawal.requested', entityType: 'withdrawal', idFrom: 'result.id' })
  async request(
    @Body(new ZodPipe(createWithdrawalSchema)) body: CreateWithdrawalInput,
    @CurrentUser() user: AuthPrincipal,
  ) {
    if (!user.companyId) throw new ForbiddenError('No company in session');
    const result = await this.withdrawals.request(
      user.companyId,
      user.apiKeyAuth ? null : user.userId,
      body,
      user.apiKeyAuth ? user.userId : null,
    );
    // Fast lane for auto-approval: a WISH request is the only auto-approvable kind,
    // so nudge the processor to run just after the hold window instead of waiting
    // for the 15s poll. No-op when auto-approval is OFF (the nudge re-checks).
    if (result.payoutMethod === 'WISH') this.autoApprovalRunner.nudge();
    return result;
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
  @Get('company/withdrawals/export.csv')
  @SkipResponseEnvelope()
  companyExport(
    @Query(new ZodPipe(listWithdrawalsQuerySchema)) query: ListWithdrawalsQuery,
    @CurrentUser() user: AuthPrincipal,
  ): StreamableFile {
    if (!user.companyId) throw new ForbiddenError('No company in session');
    return this.withdrawals.streamCsv({ companyId: user.companyId, query });
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
  @Get('admin/withdrawals/export.csv')
  @SkipResponseEnvelope()
  adminExport(
    @Query(new ZodPipe(listWithdrawalsQuerySchema)) query: ListWithdrawalsQuery,
  ): StreamableFile {
    return this.withdrawals.streamCsv({ query });
  }

  // Auto-approval config (SUPER_ADMIN only). Declared BEFORE the `:id` routes so
  // the literal `auto-approval` segment isn't captured by the UUID param route.
  @Roles(UserRole.SUPER_ADMIN)
  @Get('admin/withdrawals/auto-approval')
  async getAutoApproval() {
    return this.autoApproval.getConfig();
  }

  @Roles(UserRole.SUPER_ADMIN)
  @Put('admin/withdrawals/auto-approval')
  @Audited({ action: 'withdrawal.auto_approval_config_updated', entityType: 'withdrawal' })
  async updateAutoApproval(
    @Body(new ZodPipe(updateWithdrawalAutoApprovalSchema)) body: UpdateWithdrawalAutoApprovalInput,
  ) {
    return this.autoApproval.update(body);
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

  // Operator escape hatch for a row stuck in PROCESSING (auto-approval left it
  // ambiguous): confirm-and-settle or revert-to-pending. SUPER_ADMIN only.
  @Roles(UserRole.SUPER_ADMIN)
  @Post('admin/withdrawals/:id/resolve-processing')
  @Audited({
    action: 'withdrawal.resolve_processing',
    entityType: 'withdrawal',
    idFrom: 'params.id',
  })
  async resolveProcessing(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(resolveProcessingSchema)) body: ResolveProcessingInput,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.withdrawals.resolveProcessing(id, user.userId, body);
  }
}
