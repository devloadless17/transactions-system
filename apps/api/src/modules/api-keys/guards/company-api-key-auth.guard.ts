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
import { assertCompanyActive } from '../../../common/company-status';

/**
 * Returned when a request carries something that is clearly meant to be an API key
 * but not in the one accepted form. Every layer matches `Bearer ` / `tsk_` exactly,
 * so a lowercase scheme or a stray quote silently looks like "no key at all" —
 * naming the fault saves integrators from debugging a healthy key.
 */
export const MALFORMED_API_KEY_MESSAGE =
  'Malformed API key credential. Send it exactly as `Authorization: Bearer tsk_<prefix>_<secret>` — ' +
  'the `Bearer` scheme and the `tsk_` prefix are case-sensitive, separated by a single space.';

/**
 * True when the credential carries a `tsk_`-shaped token under any scheme or casing
 * (`bearer tsk_…`, `Bearer TSK_…`, `Token tsk_…`, a bare `tsk_…`). Purely a shape
 * check on what the caller sent — it never looks a key up, so it leaks nothing.
 */
export function looksLikeApiKey(auth: string | undefined): boolean {
  if (!auth) return false;
  const parts = auth.trim().split(/\s+/);
  const token = (parts.length > 1 ? parts.slice(1).join('') : parts[0]) ?? '';
  return token.toLowerCase().startsWith('tsk_');
}

/**
 * Authenticates server-to-server integration endpoints (a company's CRM) with
 * `Authorization: Bearer tsk_...`. Requires a COMPANY-scoped key — source keys
 * are rejected. On success sets a synthetic principal carrying the companyId so
 * the rest of the pipeline can scope to that tenant. No CSRF (API keys are a
 * separate trust model, like the ingest path).
 *
 * Every company-key request passes through here — the Whish Pay API directly,
 * and every `/v1/company/*` route via CompanyAccessGuard — so this is where
 * key GUESSING is limited: failed attempts per (IP, key prefix), checked before
 * the argon2 verification (see ApiKeyFailureLimiter). A working key never
 * counts, so this never slows a real integration; it is what lets the Whish Pay
 * API run without a per-IP request cap.
 */
@Injectable()
export class CompanyApiKeyAuthGuard implements CanActivate {
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
    const keys = this.failures.bucketsFor(req.ip, auth);
    await this.failures.assertNotBlocked(ctx, keys);

    if (!auth || !auth.startsWith('Bearer ')) {
      await this.failures.recordFailure(keys);
      // Distinguish "sent nothing" from "sent a key the wrong way" — the latter used
      // to report "Missing API key" for e.g. a lowercase `bearer tsk_...`.
      throw new UnauthorizedError(
        looksLikeApiKey(auth) ? MALFORMED_API_KEY_MESSAGE : 'Missing API key',
      );
    }
    const plaintext = auth.slice('Bearer '.length).trim();
    const result = await this.apiKeys.verify(plaintext);
    if (!result) {
      await this.failures.recordFailure(keys);
      throw new UnauthorizedError('Invalid or revoked API key');
    }
    // A real key, just the wrong kind (a SOURCE key) — not a guess, so it is not
    // counted as a failed attempt.
    if (!result.companyId) {
      throw new UnauthorizedError('A company API key is required for this endpoint');
    }
    await assertCompanyActive(this.prisma, result.companyId);
    await this.failures.recordSuccess(keys);

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
