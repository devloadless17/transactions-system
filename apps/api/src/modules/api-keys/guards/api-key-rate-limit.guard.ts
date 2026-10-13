/* eslint-disable @typescript-eslint/consistent-type-imports --
 * NestJS DI: the classes below are constructor-injected, so they must be VALUE
 * imports. `import type` elides them and `emitDecoratorMetadata` then writes
 * `Object` into design:paramtypes, which makes Nest fail to resolve the
 * provider at runtime. The lint rule cannot see that distinction.
 */
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Injectable, SetMetadata } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../../common/types/request.types';
import type { Env } from '../../../config/env.schema';
import { RateLimitError } from '../../../common/errors/domain.error';
import { ApiKeyRateLimitStore } from '../api-key-rate-limit.store';

const WINDOW_SECONDS = 60;

/**
 * Shared per-API-key fixed-window check. `max <= 0` disables it entirely.
 * Fails OPEN when the counter is unreachable — a Redis outage must never stop
 * money traffic.
 */
async function enforce(
  ctx: ExecutionContext,
  limits: ApiKeyRateLimitStore,
  max: number,
  // Each surface gets its OWN counter namespace. Sharing one would let ingest
  // traffic drain the Whish-Pay budget for the same key (a company key reaches
  // ApiKeyAuthGuard on /v1/ingest — the 403 comes later, in the handler).
  namespace: string,
): Promise<boolean> {
  if (max <= 0) return true;
  const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  // The auth guard runs first and populates principal; key id is the userId surrogate.
  const keyId = req.principal?.userId;
  if (!keyId) return true;

  const hit = await limits.hit(`${namespace}:${keyId}`, WINDOW_SECONDS);
  if (!hit) return true;

  // Standard RateLimit headers (draft IETF naming) so clients can self-pace.
  const res = ctx.switchToHttp().getResponse<Response>();
  res.setHeader('RateLimit-Limit', max);
  res.setHeader('RateLimit-Remaining', Math.max(0, max - hit.count));
  res.setHeader('RateLimit-Reset', hit.resetSeconds);

  if (hit.count > max) {
    res.setHeader('Retry-After', hit.resetSeconds);
    // A typed domain error → the GlobalExceptionFilter emits the clean, flat
    // { success:false, statusCode:429, error:{ code:'RATE_LIMITED', message, details } }.
    throw new RateLimitError({ limit: max, windowSeconds: WINDOW_SECONDS });
  }
  return true;
}

/**
 * The per-key budgets of the company Whish Pay API. Each is its OWN counter, so
 * one kind of call can never use up another:
 *   - `create`  — creating a payment link (one call to Whish's API);
 *   - `refresh` — re-reading a link's status from Whish (one call to Whish);
 *   - `lookup`  — reading a link from our own database (no Whish call).
 * Without separate counters a CRM that polls its links while customers pay —
 * production sees ~4 polls per link — would spend the budget its next link
 * creation needs, and customers would be refused a payment link.
 */
export type IntegrationBudgetName = 'create' | 'refresh' | 'lookup';

const INTEGRATION_BUDGET_KEY = 'integration:rate-limit-budget';

/** Which per-key budget a Whish Pay API handler spends (see ApiKeyRateLimitGuard). */
export const IntegrationBudget = (budget: IntegrationBudgetName) =>
  SetMetadata(INTEGRATION_BUDGET_KEY, budget);

/**
 * Per-API-key limiter for the company Whish Pay API (`/v1/integrations/whish/*`)
 * and the per-link calls of its dashboard twin (`/v1/company/whish/payments`,
 * where a signed-in user spends a per-user budget). The calls that reach WHISH — `create` and `refresh` — stay capped
 * (INTEGRATION_CREATE_RATE_LIMIT_MAX each): a runaway CRM loop would burn our upstream
 * quota and cost, and nothing is stranded by asking it to slow down — the
 * customer has not paid yet. A `lookup` only reads our database and gets a far
 * larger budget (INTEGRATION_LOOKUP_RATE_LIMIT_MAX). A handler without a budget
 * spends `create`, the strictest.
 *
 * These are the ONLY request caps on that API — it opts out of the global
 * per-IP throttler, which would otherwise cap a company's whole server at 100
 * calls a minute per endpoint. Key guessing is limited separately, per failed
 * attempt, by CompanyApiKeyAuthGuard.
 */
@Injectable()
export class ApiKeyRateLimitGuard implements CanActivate {
  private readonly max: Record<IntegrationBudgetName, number>;

  constructor(
    config: ConfigService<Env, true>,
    private readonly limits: ApiKeyRateLimitStore,
    private readonly reflector: Reflector,
  ) {
    const whishCalls = config.get('INTEGRATION_CREATE_RATE_LIMIT_MAX', { infer: true });
    this.max = {
      create: whishCalls,
      refresh: whishCalls,
      lookup: config.get('INTEGRATION_LOOKUP_RATE_LIMIT_MAX', { infer: true }),
    };
  }

  canActivate(ctx: ExecutionContext): Promise<boolean> {
    const budget =
      this.reflector.getAllAndOverride<IntegrationBudgetName | undefined>(INTEGRATION_BUDGET_KEY, [
        ctx.getHandler(),
        ctx.getClass(),
      ]) ?? 'create';
    return enforce(ctx, this.limits, this.max[budget], `rl:integration:${budget}`);
  }
}

/**
 * Per-API-key limiter for SOURCE INGEST. UNLIMITED by default
 * (`INGEST_RATE_LIMIT_MAX=0`) and that is the deliberate policy: a source
 * calling this endpoint is pushing money that has ALREADY left the payer, so
 * refusing it cannot slow anything down — it can only strand real funds behind
 * a partner's retry logic. The abuse surface worth policing here is failed
 * authentication, which ApiKeyAuthGuard limits per IP.
 *
 * Set a positive value only to rein in one misbehaving partner; it is read from
 * the server env, so it is tunable without shipping a deploy.
 */
@Injectable()
export class IngestRateLimitGuard implements CanActivate {
  private readonly max: number;

  constructor(
    config: ConfigService<Env, true>,
    private readonly limits: ApiKeyRateLimitStore,
  ) {
    this.max = config.get('INGEST_RATE_LIMIT_MAX', { infer: true });
  }

  canActivate(ctx: ExecutionContext): Promise<boolean> {
    return enforce(ctx, this.limits, this.max, 'rl:ingest');
  }
}
