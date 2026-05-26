import { Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { UserRole } from '@app/shared';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CsrfGuard } from '../auth/guards/csrf.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Audited } from '../audit/audit.decorator';
import type { AuthPrincipal } from '../../common/types/request.types';
import { ApiKeysService } from './api-keys.service';
import { ForbiddenError } from '../../common/errors/domain.error';

/**
 * Read/revoke only. Company-held API keys are no longer issued — all ingest
 * happens with source-bound keys minted by the super admin under
 * /v1/admin/sources/:sourceId/api-keys. We keep this read+revoke surface so
 * companies can still see and revoke any legacy keys still in the database.
 */
@UseGuards(JwtAuthGuard, RolesGuard, CsrfGuard)
@Roles(UserRole.COMPANY_OWNER, UserRole.COMPANY_MANAGER)
@Controller('company/api-keys')
export class ApiKeysController {
  constructor(private readonly apiKeys: ApiKeysService) {}

  @Get()
  async list(@CurrentUser() user: AuthPrincipal) {
    if (!user.companyId) throw new ForbiddenError('No company in session');
    return { data: await this.apiKeys.listByCompany(user.companyId) };
  }

  @Post(':id/revoke')
  @Audited({ action: 'api_key.revoked', entityType: 'api_key', idFrom: 'params.id' })
  async revoke(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthPrincipal) {
    if (!user.companyId) throw new ForbiddenError('No company in session');
    return this.apiKeys.revoke({ kind: 'company', companyId: user.companyId }, id);
  }
}
