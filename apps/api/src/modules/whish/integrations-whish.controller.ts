import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { createWhishPaymentSchema, type CreateWhishPaymentInput } from '@app/shared';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
import { CompanyApiKeyAuthGuard } from '../api-keys/guards/company-api-key-auth.guard';
import {
  ApiKeyRateLimitGuard,
  IntegrationBudget,
} from '../api-keys/guards/api-key-rate-limit.guard';
import { ForbiddenError, ValidationError } from '../../common/errors/domain.error';
import type { AuthenticatedRequest } from '../../common/types/request.types';
import { WhishPaymentsService } from './whish-payments.service';

/**
 * Server-to-server Whish integration for a company's CRM.
 * Authenticated by a COMPANY API key (`Authorization: Bearer tsk_...`), NOT a
 * browser session — so there is no CSRF. The company mints the key under
 * /v1/company/api-keys (or an admin issues it), then its CRM calls these
 * endpoints to generate links and poll their status.
 *
 * This is how a company's customers start a deposit, so it must keep up with a
 * big company's peak — every customer's link comes from the SAME company
 * server. It therefore opts out of the global per-IP throttler (100 calls a
 * minute per endpoint per IP would refuse the 101st customer of the minute).
 * Its limits are per API key, one budget per kind of call (see
 * ApiKeyRateLimitGuard), and key guessing is limited per failed attempt by
 * CompanyApiKeyAuthGuard.
 */
@SkipThrottle()
@UseGuards(CompanyApiKeyAuthGuard, ApiKeyRateLimitGuard)
@Controller('integrations/whish')
export class IntegrationsWhishController {
  constructor(private readonly payments: WhishPaymentsService) {}

  /** Create a payment link. Returns the collectUrl + the numeric reference (externalId). */
  @IntegrationBudget('create')
  @Post('payments')
  async create(
    @Body(new ZodPipe(createWhishPaymentSchema)) body: CreateWhishPaymentInput,
    @Req() req: AuthenticatedRequest,
  ) {
    const companyId = req.principal?.companyId;
    if (!companyId) throw new ForbiddenError('Company API key required');
    return this.payments.createPayment(companyId, body);
  }

  /** Look up a payment by its reference (externalId). Our database only — no Whish call. */
  @IntegrationBudget('lookup')
  @Get('payments/:reference')
  async get(@Param('reference') reference: string, @Req() req: AuthenticatedRequest) {
    const companyId = req.principal?.companyId;
    if (!companyId) throw new ForbiddenError('Company API key required');
    return this.payments.getByExternalId(companyId, parseReference(reference));
  }

  /** Force a fresh status pull from Whish for a payment (for missed callbacks). */
  @IntegrationBudget('refresh')
  @Post('payments/:reference/refresh')
  async refresh(@Param('reference') reference: string, @Req() req: AuthenticatedRequest) {
    const companyId = req.principal?.companyId;
    if (!companyId) throw new ForbiddenError('Company API key required');
    return this.payments.refreshByExternalId(companyId, parseReference(reference));
  }
}

function parseReference(reference: string): number {
  const n = Number(reference);
  if (!Number.isInteger(n) || n <= 0) {
    throw new ValidationError('reference must be a positive integer (externalId)');
  }
  return n;
}
