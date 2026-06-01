import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { createWhishPaymentSchema, type CreateWhishPaymentInput } from '@app/shared';
import { ZodPipe } from '../../common/pipes/zod-validation.pipe';
import { CompanyApiKeyAuthGuard } from '../api-keys/guards/company-api-key-auth.guard';
import { ApiKeyRateLimitGuard } from '../api-keys/guards/api-key-rate-limit.guard';
import { ForbiddenError, ValidationError } from '../../common/errors/domain.error';
import type { AuthenticatedRequest } from '../../common/types/request.types';
import { WhishPaymentsService } from './whish-payments.service';

/**
 * Server-to-server Whish integration for a company's CRM.
 * Authenticated by a COMPANY API key (`Authorization: Bearer tsk_...`), NOT a
 * browser session — so there is no CSRF. The company mints the key under
 * /v1/company/api-keys (or an admin issues it), then its CRM calls these
 * endpoints to generate links and poll their status.
 */
@UseGuards(CompanyApiKeyAuthGuard, ApiKeyRateLimitGuard)
@Controller('integrations/whish')
export class IntegrationsWhishController {
  constructor(private readonly payments: WhishPaymentsService) {}

  /** Create a payment link. Returns the collectUrl + the numeric reference (externalId). */
  @Post('payments')
  async create(
    @Body(new ZodPipe(createWhishPaymentSchema)) body: CreateWhishPaymentInput,
    @Req() req: AuthenticatedRequest,
  ) {
    const companyId = req.principal?.companyId;
    if (!companyId) throw new ForbiddenError('Company API key required');
    return this.payments.createPayment(companyId, body);
  }

  /** Look up a payment by its reference (externalId). */
  @Get('payments/:reference')
  async get(@Param('reference') reference: string, @Req() req: AuthenticatedRequest) {
    const companyId = req.principal?.companyId;
    if (!companyId) throw new ForbiddenError('Company API key required');
    return this.payments.getByExternalId(companyId, parseReference(reference));
  }

  /** Force a fresh status pull from Whish for a payment (for missed callbacks). */
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
