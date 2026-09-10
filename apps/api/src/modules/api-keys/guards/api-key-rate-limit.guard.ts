/* eslint-disable @typescript-eslint/consistent-type-imports --
 * NestJS DI: the classes below are constructor-injected, so they must be VALUE
 * imports. `import type` elides them and `emitDecoratorMetadata` then writes
 * `Object` into design:paramtypes, which makes Nest fail to resolve the
 * provider at runtime. The lint rule cannot see that distinction.
 */
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
): Promise<boolean> {
  if (max <= 0) return true;
  const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
  // The auth guard runs first and populates principal; key id is the userId surrogate.
  const keyId = req.principal?.userId;
  if (!keyId) return true;

  const hit = await limits.hit(`rl:ingest:${keyId}`, WINDOW_SECONDS);
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
 * Per-API-key limiter for COMPANY-facing integration endpoints (Whish Pay link
 * creation). Stays capped by default: these calls fan out to Whish's own API,
 * so a runaway CRM loop would burn our upstream quota and cost, and nothing is
 * stranded by asking it to slow down — the customer has not paid yet.
 */
@Injectable()
export class ApiKeyRateLimitGuard implements CanActivate {
  private readonly max: number;

  constructor(
    config: ConfigService<Env, true>,
    private readonly limits: ApiKeyRateLimitStore,
  ) {
    this.max = config.get('INTEGRATION_RATE_LIMIT_MAX', { infer: true });
  }

  canActivate(ctx: ExecutionContext): Promise<boolean> {
    return enforce(ctx, this.limits, this.max);
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
    return enforce(ctx, this.limits, this.max);
  }
}
