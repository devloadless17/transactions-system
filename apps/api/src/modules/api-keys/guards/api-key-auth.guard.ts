import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import { UnauthorizedError } from '../../../common/errors/domain.error';
import type { AuthenticatedRequest, AuthPrincipal } from '../../../common/types/request.types';
import { UserRole } from '@app/shared';
import { ApiKeysService } from '../api-keys.service';
import { PrismaService } from '../../../database/prisma.service';
import { assertCompanyActive, assertSourceActive } from '../../../common/company-status';

/**
 * Authenticates ingestion endpoints with `Authorization: Bearer tsk_...`.
 * On success, sets a synthetic principal on the request so the rest of the
 * pipeline (which only knows about JWT principals) can identify the tenant.
 */
@Injectable()
export class ApiKeyAuthGuard implements CanActivate {
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
    // Company-scoped keys are gated on the tenant being active. Source keys
    // (companyId null) target a company per-request, gated downstream in the
    // ingest service; their own source must also still be active.
    await assertCompanyActive(this.prisma, result.companyId);
    await assertSourceActive(this.prisma, result.sourceId);

    const principal: AuthPrincipal = {
      // Use the key's id as the "user" surrogate.
      userId: result.keyId,
      email: `apikey:${result.keyId}`,
      role: UserRole.COMPANY_OWNER, // arbitrary — ingestion paths don't consult role
      companyId: result.companyId, // null for source keys
      sourceId: result.sourceId, // null for company keys
    };
    (req as AuthenticatedRequest).principal = principal;
    return true;
  }
}
