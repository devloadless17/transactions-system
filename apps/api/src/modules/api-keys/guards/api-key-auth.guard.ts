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
import { RateLimitError, UnauthorizedError } from '../../../common/errors/domain.error';
import type { AuthenticatedRequest, AuthPrincipal } from '../../../common/types/request.types';
import { UserRole } from '@app/shared';
import { ApiKeysService } from '../api-keys.service';
import { ApiKeyRateLimitStore } from '../api-key-rate-limit.store';
import { PrismaService } from '../../../database/prisma.service';
import type { Env } from '../../../config/env.schema';
import { assertCompanyActive, assertSourceActive } from '../../../common/company-status';

const FAILURE_WINDOW_SECONDS = 60;

/**
 * Failure budgets are keyed by client IP **and the presented key prefix**, not
 * by IP alone.
 *
 * Keying by IP alone has a collateral-lockout flaw: the budget is checked
 * BEFORE verification, so an attacker who fills an IP's budget also blocks a
 * legitimate key arriving from that same IP (shared NAT / cloud egress) — and
 * the success that would clear the budget can never happen. That would stop a
 * real deposit, which this system does not do.
 *
 * Scoping by prefix isolates them: a working key never fails, so its bucket is
 * always empty. Meanwhile the budget still bounds the thing actually worth
 * bounding — argon2 CPU burn, which only occurs when a presented prefix
 * matches a live key. Prefixes that aren't well-formed share one bucket, so an
 * attacker can't mint unbounded Redis keys with junk.
 */
export function failureBucketKey(ip: string, authHeader: string | undefined): string {
  const m = /^Bearer\s+tsk_([A-Za-z0-9]{8})_/.exec(authHeader ?? '');
  return `rl:authfail:${ip}:${m ? m[1] : 'na'}`;
}

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
  private readonly failureMax: number;

  constructor(
    private readonly apiKeys: ApiKeysService,
    private readonly prisma: PrismaService,
    private readonly limits: ApiKeyRateLimitStore,
    config: ConfigService<Env, true>,
  ) {
    this.failureMax = config.get('AUTH_FAILURE_MAX_PER_MIN', { infer: true });
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request>();
    // `trust proxy` is configured from the real proxy chain, so req.ip is the
    // client, not Cloudflare's edge. Without an IP we skip the limiter rather
    // than bucket every caller together — a shared bucket could be filled by
    // one attacker and would then block real deposits.
    const failureKey = req.ip ? failureBucketKey(req.ip, req.headers.authorization) : null;

    if (failureKey) {
      const seen = await this.limits.peek(failureKey, FAILURE_WINDOW_SECONDS);
      if (seen && seen.count >= this.failureMax) {
        throw new RateLimitError({ limit: this.failureMax, windowSeconds: FAILURE_WINDOW_SECONDS });
      }
    }

    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith('Bearer ')) {
      await this.recordFailure(failureKey);
      throw new UnauthorizedError('Missing API key');
    }
    const plaintext = auth.slice('Bearer '.length).trim();
    const result = await this.apiKeys.verify(plaintext);
    if (!result) {
      await this.recordFailure(failureKey);
      throw new UnauthorizedError('Invalid or revoked API key');
    }
    // Company-scoped keys are gated on the tenant being active. Source keys
    // (companyId null) target a company per-request, gated downstream in the
    // ingest service; their own source must also still be active.
    await assertCompanyActive(this.prisma, result.companyId);
    await assertSourceActive(this.prisma, result.sourceId);

    // The credential is good: wipe this IP's failure budget (see class docs).
    if (failureKey) await this.limits.clear(failureKey, FAILURE_WINDOW_SECONDS);

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

  /** Best-effort: a counter outage must never change the auth outcome. */
  private async recordFailure(key: string | null): Promise<void> {
    if (!key) return;
    await this.limits.hit(key, FAILURE_WINDOW_SECONDS).catch(() => undefined);
  }
}
