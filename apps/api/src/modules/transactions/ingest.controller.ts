import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import {
  ingestTransactionSchema,
  type IngestTransactionInput,
  type IngestCompanyListResponse,
} from '@app/shared';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
import { ApiKeyAuthGuard } from '../api-keys/guards/api-key-auth.guard';
import { ApiKeyRateLimitGuard } from '../api-keys/guards/api-key-rate-limit.guard';
import { ForbiddenError, ValidationError } from '../../common/errors/domain.error';
import { PrismaService } from '../../database/prisma.service';
import { TransactionsService } from './transactions.service';
import type { AuthenticatedRequest } from '../../common/types/request.types';

// Source codes look like `omt`, `wish_money_code`, `bank_transfer`. Keep the
// path constraint loose; we still validate against the DB.
const SOURCE_CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,49}$/;

/**
 * External provider ingestion. Authenticated by SOURCE API key, NOT JWT.
 * No CSRF guard — API keys are not subject to CSRF (separate trust model).
 *
 * The URL path encodes the source (`omt`, `wish_money_code`, ...) and the
 * Authorization Bearer key MUST be bound to that same source. URL/key
 * mismatches are rejected with 403.
 */
@UseGuards(ApiKeyAuthGuard, ApiKeyRateLimitGuard)
@Controller('ingest')
export class IngestController {
  constructor(
    private readonly transactions: TransactionsService,
    private readonly prisma: PrismaService,
  ) {}

  @Post(':sourceCode/transactions')
  async ingest(
    @Param('sourceCode') sourceCode: string,
    @Body(new ZodPipe(ingestTransactionSchema)) body: IngestTransactionInput,
    @Req() req: AuthenticatedRequest,
  ) {
    if (!SOURCE_CODE_PATTERN.test(sourceCode)) {
      throw new ValidationError('invalid source code in URL');
    }

    const principal = req.principal;
    if (!principal?.sourceId) {
      throw new ForbiddenError('this endpoint requires a source API key');
    }

    // Verify the key belongs to the source named in the URL.
    const urlSource = await this.prisma.runAsAdmin((tx) =>
      tx.source.findUnique({ where: { code: sourceCode } }),
    );
    if (!urlSource) throw new ValidationError(`source '${sourceCode}' not found`);
    if (urlSource.id !== principal.sourceId) {
      throw new ForbiddenError('API key is not bound to this source');
    }

    return this.transactions.ingest({ kind: 'source', sourceId: principal.sourceId }, body);
  }

  /**
   * Discovery endpoint for sources. Returns every ACTIVE + visible company so
   * the provider can cache the id and use it as `companyId` in subsequent POSTs.
   * Source-key-authenticated; company keys (legacy) are rejected.
   */
  @Get('companies')
  async listCompanies(@Req() req: AuthenticatedRequest): Promise<IngestCompanyListResponse> {
    if (!req.principal?.sourceId) {
      throw new ForbiddenError('this endpoint requires a source API key');
    }
    return this.transactions.listVisibleCompanies();
  }
}
