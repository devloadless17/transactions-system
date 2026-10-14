import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import {
  adminLoadSchema,
  approveLoadSchema,
  cancelRequestSchema,
  createLoadSchema,
  listLoadsQuerySchema,
  rejectLoadSchema,
  UserRole,
  type AdminLoadInput,
  type ApproveLoadInput,
  type CancelRequestInput,
  type CreateLoadInput,
  type ListLoadsQuery,
  type RejectLoadInput,
} from '@app/shared';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
import { CompanyAccessGuard } from '../api-keys/guards/company-access.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CsrfGuard } from '../auth/guards/csrf.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { backofficeList, backofficeLoad, isBackoffice } from '../../common/backoffice-view';
import { Audited } from '../audit/audit.decorator';
import type { AuthPrincipal } from '../../common/types/request.types';
import { SkipResponseEnvelope } from '../../common/decorators/skip-response-envelope.decorator';
import { ForbiddenError } from '../../common/errors/domain.error';
import { LoadsService } from './loads.service';

@UseGuards(CompanyAccessGuard, RolesGuard, CsrfGuard)
@Controller()
export class LoadsController {
  constructor(private readonly loads: LoadsService) {}

  // ---------------- Company endpoints ----------------

  @Roles(UserRole.COMPANY_OWNER, UserRole.COMPANY_MANAGER)
  @Post('company/loads')
  @Audited({ action: 'load.requested', entityType: 'load', idFrom: 'result.id' })
  async request(
    @Body(new ZodPipe(createLoadSchema)) body: CreateLoadInput,
    @CurrentUser() user: AuthPrincipal,
  ) {
    if (!user.companyId) throw new ForbiddenError('No company in session');
    return this.loads.request(
      user.companyId,
      user.apiKeyAuth ? null : user.userId,
      body,
      user.apiKeyAuth ? user.userId : null,
    );
  }

  @Roles(UserRole.COMPANY_OWNER, UserRole.COMPANY_MANAGER, UserRole.COMPANY_VIEWER)
  @Get('company/loads')
  async companyList(
    @Query(new ZodPipe(listLoadsQuerySchema)) query: ListLoadsQuery,
    @CurrentUser() user: AuthPrincipal,
  ) {
    if (!user.companyId) throw new ForbiddenError('No company in session');
    return this.loads.list({ companyId: user.companyId, query });
  }

  @Roles(UserRole.COMPANY_OWNER, UserRole.COMPANY_MANAGER, UserRole.COMPANY_VIEWER)
  @Get('company/loads/export.csv')
  @SkipResponseEnvelope()
  companyExport(
    @Query(new ZodPipe(listLoadsQuerySchema)) query: ListLoadsQuery,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<StreamableFile> {
    if (!user.companyId) throw new ForbiddenError('No company in session');
    return this.loads.streamCsv({ companyId: user.companyId, query });
  }

  @Roles(UserRole.COMPANY_OWNER, UserRole.COMPANY_MANAGER, UserRole.COMPANY_VIEWER)
  @Get('company/loads/:id')
  async companyGet(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthPrincipal,
  ) {
    if (!user.companyId) throw new ForbiddenError('No company in session');
    return this.loads.getById(id, user.companyId);
  }

  @Roles(UserRole.COMPANY_OWNER, UserRole.COMPANY_MANAGER)
  @Post('company/loads/:id/cancel')
  @Audited({ action: 'load.cancelled', entityType: 'load', idFrom: 'params.id' })
  async cancel(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(cancelRequestSchema)) body: CancelRequestInput,
    @CurrentUser() user: AuthPrincipal,
  ) {
    if (!user.companyId) throw new ForbiddenError('No company in session');
    // API-key callers carry the keyId as userId (not a real users row); mirror
    // `request` and store null for cancelledById so the FK isn't violated.
    return this.loads.cancel(id, user.companyId, user.apiKeyAuth ? null : user.userId, body);
  }

  // ---------------- Admin endpoints ----------------

  // Super-admin only: directly load a company's wallet for funds received
  // off-platform (no company request needed). Same commission + ledger + wallet
  // effect as the company requesting a load and us accepting it.
  @Roles(UserRole.SUPER_ADMIN)
  @Post('admin/loads')
  @Audited({ action: 'load.admin_loaded', entityType: 'load', idFrom: 'result.id' })
  async adminCreate(
    @Body(new ZodPipe(adminLoadSchema)) body: AdminLoadInput,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.loads.adminLoad(body.companyId, user.userId, body);
  }

  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR, UserRole.BACKOFFICE)
  @Get('admin/loads')
  async adminList(
    @Query(new ZodPipe(listLoadsQuerySchema)) query: ListLoadsQuery,
    @CurrentUser() user: AuthPrincipal,
  ) {
    const page = await this.loads.list({ query });
    return isBackoffice(user) ? backofficeList(page, backofficeLoad) : page;
  }

  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR, UserRole.BACKOFFICE)
  @Get('admin/loads/export.csv')
  @SkipResponseEnvelope()
  adminExport(
    @Query(new ZodPipe(listLoadsQuerySchema)) query: ListLoadsQuery,
    @CurrentUser() user: AuthPrincipal,
  ): Promise<StreamableFile> {
    return this.loads.streamCsv({ query, backoffice: isBackoffice(user) });
  }

  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR, UserRole.BACKOFFICE)
  @Get('admin/loads/:id')
  async adminGet(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthPrincipal) {
    const row = await this.loads.getById(id);
    return isBackoffice(user) ? backofficeLoad(row) : row;
  }

  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR, UserRole.BACKOFFICE)
  @Post('admin/loads/:id/approve')
  @Audited({ action: 'load.approved', entityType: 'load', idFrom: 'params.id' })
  async approve(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(approveLoadSchema)) body: ApproveLoadInput,
    @CurrentUser() user: AuthPrincipal,
  ) {
    const row = await this.loads.approve(id, user.userId, body);
    return isBackoffice(user) ? backofficeLoad(row) : row;
  }

  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR, UserRole.BACKOFFICE)
  @Post('admin/loads/:id/reject')
  @Audited({ action: 'load.rejected', entityType: 'load', idFrom: 'params.id' })
  async reject(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(rejectLoadSchema)) body: RejectLoadInput,
    @CurrentUser() user: AuthPrincipal,
  ) {
    const row = await this.loads.reject(id, user.userId, body);
    return isBackoffice(user) ? backofficeLoad(row) : row;
  }
}
