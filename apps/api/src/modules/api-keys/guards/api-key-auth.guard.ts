/* eslint-disable @typescript-eslint/consistent-type-imports --
 * NestJS DI: the classes below are constructor-injected, so they must be VALUE
 * imports. `import type` elides them and `emitDecoratorMetadata` then writes
 * `Object` into design:paramtypes, which makes Nest fail to resolve the
 * provider at runtime. The lint rule cannot see that distinction.
 */
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Request } from 'express';
import { UnauthorizedError } from '../../../common/errors/domain.error';
import type { AuthenticatedRequest, AuthPrincipal } from '../../../common/types/request.types';
import { UserRole } from '@app/shared';
import { ApiKeysService } from '../api-keys.service';
import { ApiKeyRateLimitStore } from '../api-key-rate-limit.store';
import { ApiKeyFailureLimiter } from '../api-key-failure-limiter';
import { PrismaService } from '../../../database/prisma.service';
import type { Env } from '../../../config/env.schema';
import { assertCompanyActive, assertSourceActive } from '../../../common/company-status';

// The bucket helpers live with the shared limiter; re-exported for existing importers.
export {
  credentialPrefix,
  failureBucketKey,
  ipFailureBucketKey,
  trustedKey,
} from '../api-key-failure-limiter';

/**
 * Authenticates ingestion endpoints with `Authorization: Bearer tsk_...`.
 * On success, sets a synthetic principal on the request so the rest of the
 * pipeline (which only knows about JWT principals) can identify the tenant.
 *
 * ---------------------------------------------------------------------------
 * Rate limiting lives HERE, on FAILED attempts, not on accepted traffic.
 * ---------------------------------------------------------------------------
 * Ingest carries money that has already left the payer, so throttling a source
 * with a WORKING key can only strand real funds (see INGEST_RATE_LIMIT_MAX,
 * unlimited by default). The surface worth limiting is the opposite one: an
 * attacker guessing keys. Two reasons it needs a ceiling —
 *   1. brute force: nothing else caps key-guessing on this route (the ingest
 *      controller opts out of the global per-IP throttler on purpose), and
 *   2. CPU: `verify()` runs argon2 for every live key sharing the presented
 *      8-char prefix, so anyone who learns a valid prefix can burn ~50-100ms of
 *      CPU per request, unbounded.
 * The check runs BEFORE `verify()` precisely so a blocked attacker never
 * reaches the argon2 work. A valid key never counts toward the budget, and a
 * success CLEARS it, so a real partner cannot be locked out as collateral.
 */
@Injectable()
export class ApiKeyAuthGuard implements CanActivate {
  private readonly failures: ApiKeyFailureLimiter;

  constructor(
    private readonly apiKeys: ApiKeysService,
    private readonly prisma: PrismaService,
    limits: ApiKeyRateLimitStore,
    config: ConfigService<Env, true>,
  ) {
    this.failures = new ApiKeyFailureLimiter(
      limits,
      config.get('AUTH_FAILURE_MAX_PER_MIN', { infer: true }),
    );
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    const auth = req.headers.authorization;
    // `trust proxy` is configured from the real proxy chain, so req.ip is the
    // client, not Cloudflare's edge. Without an IP the limiter is skipped rather
    // than bucketing every caller together (see ApiKeyFailureLimiter).
    const keys = this.failures.bucketsFor(req.ip, auth);
    await this.failures.assertNotBlocked(ctx, keys);

    if (!auth || !auth.startsWith('Bearer ')) {
      await this.failures.recordFailure(keys);
      throw new UnauthorizedError('Missing API key');
    }
    const plaintext = auth.slice('Bearer '.length).trim();
    const result = await this.apiKeys.verify(plaintext);
    if (!result) {
      await this.failures.recordFailure(keys);
      throw new UnauthorizedError('Invalid or revoked API key');
    }
    // Company-scoped keys are gated on the tenant being active. Source keys
    // (companyId null) target a company per-request, gated downstream in the
    // ingest service; their own source must also still be active.
    await assertCompanyActive(this.prisma, result.companyId);
    await assertSourceActive(this.prisma, result.sourceId);

    // The credential is good: clear its budget and mark it trusted so a later
    // flood against this IP cannot block it.
    await this.failures.recordSuccess(keys);

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
