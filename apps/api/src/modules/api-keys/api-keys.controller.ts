import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { createApiKeySchema, UserRole, type CreateApiKeyInput } from '@app/shared';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
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
 * Company-held API keys for server-to-server integrations (e.g. a company's CRM
 * generating Whish payment links). The COMPANY_OWNER can mint, list, and revoke
 * keys self-serve. Source-provider ingest keys are managed separately by the
 * super admin under /v1/admin/sources/:sourceId/api-keys.
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

  @Roles(UserRole.COMPANY_OWNER)
  @Post()
  @Audited({ action: 'api_key.created', entityType: 'api_key', idFrom: 'result.apiKey.id' })
  async create(
    @Body(new ZodPipe(createApiKeySchema)) body: CreateApiKeyInput,
    @CurrentUser() user: AuthPrincipal,
  ) {
    if (!user.companyId) throw new ForbiddenError('No company in session');
    return this.apiKeys.create({ kind: 'company', companyId: user.companyId }, body);
  }

  @Post(':id/revoke')
  @Audited({ action: 'api_key.revoked', entityType: 'api_key', idFrom: 'params.id' })
  async revoke(@Param('id', new ParseUUIDPipe()) id: string, @CurrentUser() user: AuthPrincipal) {
    if (!user.companyId) throw new ForbiddenError('No company in session');
    return this.apiKeys.revoke({ kind: 'company', companyId: user.companyId }, id);
  }
}
