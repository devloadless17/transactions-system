import { Body, Controller, Get, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { createApiKeySchema, UserRole, type CreateApiKeyInput } from '@app/shared';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CsrfGuard } from '../auth/guards/csrf.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { Audited } from '../audit/audit.decorator';
import { PrismaService } from '../../database/prisma.service';
import { NotFoundError } from '../../common/errors/domain.error';
import { ApiKeysService } from './api-keys.service';

/**
 * Admin-side issuance of company API keys — a platform admin can mint an
 * integration key on a company's behalf (the company owner can also do it
 * self-serve under /v1/company/api-keys).
 */
@UseGuards(JwtAuthGuard, RolesGuard, CsrfGuard)
@Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR)
@Controller('admin/companies/:companyId/api-keys')
export class AdminCompanyApiKeysController {
  constructor(
    private readonly apiKeys: ApiKeysService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  async list(@Param('companyId', new ParseUUIDPipe()) companyId: string) {
    await this.assertCompanyExists(companyId);
    return { data: await this.apiKeys.listByCompany(companyId) };
  }

  @Post()
  @Audited({
    action: 'company_api_key.created',
    entityType: 'api_key',
    idFrom: 'result.apiKey.id',
    companyIdFrom: 'params.companyId',
  })
  async create(
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Body(new ZodPipe(createApiKeySchema)) body: CreateApiKeyInput,
  ) {
    await this.assertCompanyExists(companyId);
    return this.apiKeys.create({ kind: 'company', companyId }, body);
  }

  @Post(':id/revoke')
  @Audited({
    action: 'company_api_key.revoked',
    entityType: 'api_key',
    idFrom: 'params.id',
    companyIdFrom: 'params.companyId',
  })
  async revoke(
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    await this.assertCompanyExists(companyId);
    return this.apiKeys.revoke({ kind: 'company', companyId }, id);
  }

  private async assertCompanyExists(companyId: string) {
    const company = await this.prisma.runAsAdmin((tx) =>
      tx.company.findUnique({ where: { id: companyId } }),
    );
    if (!company) throw new NotFoundError('Company', companyId);
  }
}
