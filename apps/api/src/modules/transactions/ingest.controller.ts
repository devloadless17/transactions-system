import {
  Body,
  Controller,
  Get,
  Logger,
  Param,
  Post,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { z } from 'zod';
import {
  currencySchema,
  quantizedAmountSchema,
  slugSchema,
  type IngestTransactionInput,
  type TransactionResponse,
} from '@app/shared';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
import { ApiKeyAuthGuard } from '../api-keys/guards/api-key-auth.guard';
import { IngestRateLimitGuard } from '../api-keys/guards/api-key-rate-limit.guard';
import { DomainError, ForbiddenError, ValidationError } from '../../common/errors/domain.error';
import { PrismaService } from '../../database/prisma.service';
import { TransactionsService } from './transactions.service';
import { IngestLogInterceptor } from './interceptors/ingest-log.interceptor';
import type { AuthenticatedRequest } from '../../common/types/request.types';

// Source codes look like `omt`, `wish_money_code`, `bank_transfer`. Keep the
// path constraint loose; we still validate against the DB.
const SOURCE_CODE_PATTERN = /^[a-z0-9][a-z0-9_-]{0,49}$/;

// ---------------------------------------------------------------------------
// External (source-facing) field names. The outside world speaks `companySlug`
// + `tradingAccount`; internally these are `companyId` (UUID) + `target`. The
// translation lives ONLY at this HTTP boundary — backend, DB and every other
// API are untouched. Company UUIDs are deliberately NEVER exposed to sources:
// the slug (handed to each provider by Rival Payments) is their identifier in
// both requests and responses.
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
  // The shared slug rule (same definition company create/rename validate with),
  // so the two ends of the slug contract can never drift; the DB lookup is
  // still the authority on whether the slug exists.
  companySlug: slugSchema,
  externalTransactionId: z.string().trim().min(1).max(200),
  // Money IN: the deposit already happened at the source, so a sub-cent amount is
  // quantized rather than rejected — a 400 here would strand real money that the
  // source cannot re-send on our schedule.
  amount: quantizedAmountSchema('in'),
  currency: currencySchema,
  payload: sourcePayloadSchema.default({}),
  idempotencyKey: z.string().trim().min(8).max(120).optional(),
});
type IngestSourceTransactionInput = z.infer<typeof ingestSourceTransactionSchema>;

/** Translate a source-facing payload into the internal one (tradingAccount -> target). */
function toInternalInput(
  body: IngestSourceTransactionInput,
  companyId: string,
): IngestTransactionInput {
  const { tradingAccount, ...payloadRest } = body.payload;
  return {
    companyId,
    externalTransactionId: body.externalTransactionId,
    amount: body.amount,
    currency: body.currency,
    payload:
      tradingAccount === undefined ? payloadRest : { ...payloadRest, target: tradingAccount },
    idempotencyKey: body.idempotencyKey,
  };
}

// Internal pricing-configuration failures that must not cross the source
// boundary as-is: their codes name our commission model, and their `details`
// carry internal identifiers (company/source UUIDs, rule ids) and fee figures.
// Sources see one neutral, actionable 422 instead; the ORIGINAL error is
// still thrown inside the service, so the operator alert, the
// txn_ingest_no_rule_total metric, and the server logs keep the real cause.
const INTERNAL_PRICING_ERROR_CODES = new Set(['NO_COMMISSION_RULE', 'COMMISSION_EXCEEDS_AMOUNT']);

/**
 * Map an internal pricing-config error to the neutral source-facing 422.
 * Everything else passes through unchanged. Exported for unit tests.
 */
export function toSourceFacingError(e: unknown, companySlug: string): unknown {
  if (e instanceof DomainError && INTERNAL_PRICING_ERROR_CODES.has(e.code)) {
    return new DomainError(
      'ENTITY_NOT_READY',
      `Entity '${companySlug}' cannot accept transactions right now. Contact Rival Payments.`,
      422,
      { companySlug },
    );
  }
  return e;
}

/**
 * Translate an internal transaction response back to source-facing names.
 * Deliberately OMITS `commissionAmount` and `netAmount` (sources must not see
 * the fee Rival takes — netAmount would also reveal it as `amount − netAmount`)
 * and every internal UUID: the company is identified by its slug, the source by
 * its code.
 */
function toSourceTransaction(r: TransactionResponse, companySlug: string, replayed: boolean) {
  return {
    id: r.id,
    companySlug,
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
    // True when this request matched an existing transaction (an idempotent
    // replay of the same idempotencyKey, or the same externalTransactionId for
    // this source) and booked NO new money; false for a newly-created one.
    replayed,
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
// Opt out of the global per-IP ThrottlerGuard (RATE_LIMIT_MAX, default 100/60s):
// a single high-volume provider egresses from one IP, so an IP limiter would cap
// real money traffic and silently 429 legitimate bursts. Accepted ingest volume
// is UNLIMITED by default (IngestRateLimitGuard / INGEST_RATE_LIMIT_MAX=0) —
// this endpoint carries money that already left the payer, so throttling it can
// only strand funds. Abuse is policed where it actually happens: ApiKeyAuthGuard
// rate-limits FAILED authentications per IP.
@SkipThrottle()
@UseGuards(ApiKeyAuthGuard, IngestRateLimitGuard)
@Controller('ingest')
export class IngestController {
  private readonly logger = new Logger(IngestController.name);

  constructor(
    private readonly transactions: TransactionsService,
    private readonly prisma: PrismaService,
  ) {}

  @Post(':sourceCode/transactions')
  @UseInterceptors(IngestLogInterceptor)
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

    // Verify the key belongs to the source named in the URL, and resolve the
    // body's companySlug to the internal company UUID. Both by natural key,
    // under runAsAdmin — no tenant scope exists yet at this point.
    const [urlSource, company] = await this.prisma.runAsAdmin((tx) =>
      Promise.all([
        tx.source.findUnique({ where: { code: sourceCode } }),
        tx.company.findUnique({ where: { slug: body.companySlug } }),
      ]),
    );
    // Hand the resolved UUID to IngestLogInterceptor as soon as it is known —
    // the log's company_id column is UUID-typed and the body only carries the
    // slug. Set BEFORE the guard checks below so even a rejected attempt (e.g.
    // a source/URL mismatch) is attributed to the company it targeted.
    if (company) req.ingestCompanyId = company.id;

    if (!urlSource) throw new ValidationError(`source '${sourceCode}' not found`);
    if (urlSource.id !== principal.sourceId) {
      throw new ForbiddenError('API key is not bound to this source');
    }
    // NOTE deliberately no `visible` filter: visible gates ONLY the discovery
    // list below. Deactivation (status !== ACTIVE) is the real off-switch.
    if (!company || company.status !== 'ACTIVE') {
      throw new ValidationError(`company '${body.companySlug}' not found or inactive`);
    }

    try {
      const tx = await this.transactions.ingest(
        {
          kind: 'source',
          sourceId: principal.sourceId,
          // Both rows were resolved + ACTIVE-checked just above — skip the
          // service's duplicate lookup round-trip on this hot path.
          preloaded: { source: urlSource, company },
        },
        toInternalInput(body, company.id),
      );
      return toSourceTransaction(tx, company.slug, tx.replayed);
    } catch (e) {
      const translated = toSourceFacingError(e, company.slug);
      if (translated !== e) {
        // The neutral wire error (also mirrored into transaction_logs) hides
        // the internal cause on purpose — so record it HERE, or the original
        // pricing error would leave no server-side trace of which rule
        // misfired.
        const cause = e as DomainError;
        this.logger.warn(
          `ingest pricing 422 translated to ENTITY_NOT_READY: co=${company.id} ` +
            `slug=${company.slug} src=${sourceCode} ${cause.code}: ${cause.message}`,
        );
      }
      throw translated;
    }
  }

  /**
   * Discovery endpoint for sources. Returns every ACTIVE + visible company so
   * the provider can cache the `slug` and use it in subsequent POSTs. Company
   * UUIDs are never exposed here. Source-key-authenticated; company keys
   * (legacy) are rejected. Kept live but no longer part of the partner docs —
   * providers are normally handed their slugs directly.
   */
  @Get('companies')
  async listCompanies(@Req() req: AuthenticatedRequest) {
    if (!req.principal?.sourceId) {
      throw new ForbiddenError('this endpoint requires a source API key');
    }
    const { data } = await this.transactions.listVisibleCompanies();
    return {
      data: data.map((c) => ({
        slug: c.slug,
        name: c.name,
        defaultCurrency: c.defaultCurrency,
      })),
    };
  }
}
