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
 * Admin-only management of API keys bound to a source (OMT, wish, ...).
 * Keys issued here authenticate /v1/ingest/transactions requests where the
 * external provider posts a transaction to a company via `companyId`.
 */
@UseGuards(JwtAuthGuard, RolesGuard, CsrfGuard)
@Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR)
@Controller('admin/sources/:sourceId/api-keys')
export class SourceApiKeysController {
  constructor(
    private readonly apiKeys: ApiKeysService,
    private readonly prisma: PrismaService,
  ) {}

  @Post()
  @Audited({ action: 'source_api_key.created', entityType: 'api_key', idFrom: 'result.apiKey.id' })
  async create(
    @Param('sourceId', new ParseUUIDPipe()) sourceId: string,
    @Body(new ZodPipe(createApiKeySchema)) body: CreateApiKeyInput,
  ) {
    await this.assertSourceExists(sourceId);
    return this.apiKeys.create({ kind: 'source', sourceId }, body);
  }

  @Get()
  async list(@Param('sourceId', new ParseUUIDPipe()) sourceId: string) {
    await this.assertSourceExists(sourceId);
    return { data: await this.apiKeys.listBySource(sourceId) };
  }

  @Post(':id/revoke')
  @Audited({ action: 'source_api_key.revoked', entityType: 'api_key', idFrom: 'params.id' })
  async revoke(
    @Param('sourceId', new ParseUUIDPipe()) sourceId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    await this.assertSourceExists(sourceId);
    return this.apiKeys.revoke({ kind: 'source', sourceId }, id);
  }

  @Post(':id/rotate')
  @Audited({ action: 'source_api_key.rotated', entityType: 'api_key', idFrom: 'result.apiKey.id' })
  async rotate(
    @Param('sourceId', new ParseUUIDPipe()) sourceId: string,
    @Param('id', new ParseUUIDPipe()) id: string,
  ) {
    await this.assertSourceExists(sourceId);
    return this.apiKeys.rotate({ kind: 'source', sourceId }, id);
  }

  private async assertSourceExists(sourceId: string) {
    const source = await this.prisma.runAsAdmin((tx) =>
      tx.source.findUnique({ where: { id: sourceId } }),
    );
    if (!source) throw new NotFoundError('Source', sourceId);
  }
}
