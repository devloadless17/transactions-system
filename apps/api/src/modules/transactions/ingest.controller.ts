import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import {
  currencySchema,
  moneyAmountSchema,
  type IngestTransactionInput,
  type TransactionResponse,
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

// ---------------------------------------------------------------------------
// External (source-facing) field names. The outside world speaks `operatingId`
// + `tradingAccount`; internally these are still `companyId` + `target`. The
// rename lives ONLY at this HTTP boundary — backend, DB and every other API are
// untouched. Requests are translated in, responses are translated back out.
// ---------------------------------------------------------------------------
const sourcePayloadSchema = z
  .object({
    customer: z.string().trim().max(200).optional(),
    tradingAccount: z.string().trim().max(200).optional(),
    phone: z.string().trim().max(40).optional(),
    note: z.string().trim().max(1000).optional(),
  })
  .passthrough();

const ingestSourceTransactionSchema = z.object({
  operatingId: z.string().uuid(),
  externalTransactionId: z.string().trim().min(1).max(200),
  amount: moneyAmountSchema,
  currency: currencySchema,
  payload: sourcePayloadSchema.default({}),
  idempotencyKey: z.string().trim().min(8).max(120).optional(),
});
type IngestSourceTransactionInput = z.infer<typeof ingestSourceTransactionSchema>;

/** Translate a source-facing payload into the internal one (tradingAccount -> target). */
function toInternalInput(body: IngestSourceTransactionInput): IngestTransactionInput {
  const { tradingAccount, ...payloadRest } = body.payload;
  return {
    companyId: body.operatingId,
    externalTransactionId: body.externalTransactionId,
    amount: body.amount,
    currency: body.currency,
    payload:
      tradingAccount === undefined ? payloadRest : { ...payloadRest, target: tradingAccount },
    idempotencyKey: body.idempotencyKey,
  };
}

/**
 * Translate an internal transaction response back to source-facing names.
 * Deliberately OMITS `commissionAmount` and `netAmount`: sources must not see
 * the fee Rival takes (netAmount would also reveal it as `amount − netAmount`).
 */
function toSourceTransaction(r: TransactionResponse) {
  return {
    id: r.id,
    operatingId: r.companyId,
    sourceId: r.sourceId,
    sourceCode: r.sourceCode,
    externalTransactionId: r.externalTransactionId,
    amount: r.amount,
    currency: r.currency,
    status: r.status,
    customer: r.customer,
    tradingAccount: r.target,
    phone: r.phone,
    note: r.note,
    processedAt: r.processedAt,
    createdAt: r.createdAt,
  };
}

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
    @Body(new ZodPipe(ingestSourceTransactionSchema)) body: IngestSourceTransactionInput,
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

    const tx = await this.transactions.ingest(
      { kind: 'source', sourceId: principal.sourceId },
      toInternalInput(body),
    );
    return toSourceTransaction(tx);
  }

  /**
   * Discovery endpoint for sources. Returns every ACTIVE + visible company so
   * the provider can cache the `operatingId` and use it in subsequent POSTs.
   * Source-key-authenticated; company keys (legacy) are rejected.
   */
  @Get('companies')
  async listCompanies(@Req() req: AuthenticatedRequest) {
    if (!req.principal?.sourceId) {
      throw new ForbiddenError('this endpoint requires a source API key');
    }
    const { data } = await this.transactions.listVisibleCompanies();
    return {
      data: data.map((c) => ({
        operatingId: c.id,
        slug: c.slug,
        name: c.name,
        defaultCurrency: c.defaultCurrency,
      })),
    };
  }
}
