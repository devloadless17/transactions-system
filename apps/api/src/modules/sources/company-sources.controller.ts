import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  setCompanySourceSchema,
  UserRole,
  type CompanySourceResponse,
  type SetCompanySourceInput,
} from '@app/shared';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../auth/guards/roles.guard';
import { CsrfGuard } from '../auth/guards/csrf.guard';
import { Roles } from '../auth/decorators/roles.decorator';
import { Audited } from '../audit/audit.decorator';
import { PrismaService } from '../../database/prisma.service';
import { NotFoundError } from '../../common/errors/domain.error';
import { CompanySourcesService } from './company-sources.service';

/**
 * Admin-only management of which companies a source may ingest for. A SOURCE API
 * key can only post transactions to companies enabled here.
 */
@UseGuards(JwtAuthGuard, RolesGuard, CsrfGuard)
@Roles(UserRole.SUPER_ADMIN, UserRole.ADMIN_OPERATOR)
@Controller('admin/sources/:sourceId/companies')
export class CompanySourcesController {
  constructor(
    private readonly companySources: CompanySourcesService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  async list(
    @Param('sourceId', new ParseUUIDPipe()) sourceId: string,
  ): Promise<{ data: CompanySourceResponse[] }> {
    await this.assertSourceExists(sourceId);
    return { data: await this.companySources.listForSource(sourceId) };
  }

  @Post()
  @Audited({ action: 'company_source.set', entityType: 'company_source', idFrom: 'result.id' })
  async set(
    @Param('sourceId', new ParseUUIDPipe()) sourceId: string,
    @Body(new ZodPipe(setCompanySourceSchema)) body: SetCompanySourceInput,
  ): Promise<CompanySourceResponse> {
    await this.assertSourceExists(sourceId);
    return this.companySources.set(sourceId, body);
  }

  @Delete(':companyId')
  @Audited({
    action: 'company_source.removed',
    entityType: 'company_source',
    idFrom: 'params.companyId',
  })
  async remove(
    @Param('sourceId', new ParseUUIDPipe()) sourceId: string,
    @Param('companyId', new ParseUUIDPipe()) companyId: string,
  ): Promise<{ removed: boolean }> {
    await this.assertSourceExists(sourceId);
    await this.companySources.remove(sourceId, companyId);
    return { removed: true };
  }

  private async assertSourceExists(sourceId: string): Promise<void> {
    const source = await this.prisma.runAsAdmin((tx) =>
      tx.source.findUnique({ where: { id: sourceId } }),
    );
    if (!source) throw new NotFoundError('Source', sourceId);
  }
}
