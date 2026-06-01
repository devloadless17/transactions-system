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
  approveLoadSchema,
  cancelRequestSchema,
  createLoadSchema,
  listLoadsQuerySchema,
  rejectLoadSchema,
  UserRole,
  type ApproveLoadInput,
  type CancelRequestInput,
  type CreateLoadInput,
  type ListLoadsQuery,
  type RejectLoadInput,
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
import { LoadsService } from './loads.service';

@UseGuards(JwtAuthGuard, RolesGuard, CsrfGuard)
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
    return this.loads.request(user.companyId, user.userId, body);
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

  @Roles(UserRole.COMPANY_OWNER, UserRole.COMPANY_MANAGER)
  @Post('company/loads/:id/cancel')
  @Audited({ action: 'load.cancelled', entityType: 'load', idFrom: 'params.id' })
  async cancel(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(cancelRequestSchema)) body: CancelRequestInput,
    @CurrentUser() user: AuthPrincipal,
  ) {
    if (!user.companyId) throw new ForbiddenError('No company in session');
    return this.loads.cancel(id, user.companyId, user.userId, body);
  }

  // ---------------- Admin endpoints ----------------

  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR)
  @Get('admin/loads')
  async adminList(@Query(new ZodPipe(listLoadsQuerySchema)) query: ListLoadsQuery) {
    return this.loads.list({ query });
  }

  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR)
  @Get('admin/loads/:id')
  async adminGet(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.loads.getById(id);
  }

  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR)
  @Post('admin/loads/:id/approve')
  @Audited({ action: 'load.approved', entityType: 'load', idFrom: 'params.id' })
  async approve(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(approveLoadSchema)) body: ApproveLoadInput,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.loads.approve(id, user.userId, body);
  }

  @Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR)
  @Post('admin/loads/:id/reject')
  @Audited({ action: 'load.rejected', entityType: 'load', idFrom: 'params.id' })
  async reject(
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body(new ZodPipe(rejectLoadSchema)) body: RejectLoadInput,
    @CurrentUser() user: AuthPrincipal,
  ) {
    return this.loads.reject(id, user.userId, body);
  }
}
