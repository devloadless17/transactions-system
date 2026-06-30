import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { UnauthorizedError } from '../../../common/errors/domain.error';
import type { AuthenticatedRequest, AuthPrincipal } from '../../../common/types/request.types';
import { UserRole } from '@app/shared';
import { ApiKeysService } from '../api-keys.service';
import { PrismaService } from '../../../database/prisma.service';
import { assertCompanyActive } from '../../../common/company-status';

/**
 * Authenticates server-to-server integration endpoints (a company's CRM) with
 * `Authorization: Bearer tsk_...`. Requires a COMPANY-scoped key — source keys
 * are rejected. On success sets a synthetic principal carrying the companyId so
 * the rest of the pipeline can scope to that tenant. No CSRF (API keys are a
 * separate trust model, like the ingest path).
 */
@Injectable()
export class CompanyApiKeyAuthGuard implements CanActivate {
  constructor(
    private readonly apiKeys: ApiKeysService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      throw new UnauthorizedError('Missing API key');
    }
    const plaintext = auth.slice('Bearer '.length).trim();
    const result = await this.apiKeys.verify(plaintext);
    if (!result) throw new UnauthorizedError('Invalid or revoked API key');
    if (!result.companyId) {
      throw new UnauthorizedError('A company API key is required for this endpoint');
    }
    await assertCompanyActive(this.prisma, result.companyId);

    const principal: AuthPrincipal = {
      userId: result.keyId,
      email: `apikey:${result.keyId}`,
      // Surrogate role so integration paths (ingest/whish/withdrawals/payouts/loads)
      // that gate on @Roles(COMPANY_OWNER) accept the key. Dashboard-only management
      // surfaces (api-keys CRUD, team, CRM webhook config) are additionally fronted by
      // SessionOnlyGuard, which rejects `apiKeyAuth` — so a leaked key can move money
      // per its grants but cannot mint keys, manage users, or repoint the webhook.
      role: UserRole.COMPANY_OWNER,
      companyId: result.companyId,
      sourceId: null,
      apiKeyAuth: true,
    };
    (req as AuthenticatedRequest).principal = principal;
    return true;
  }
}
