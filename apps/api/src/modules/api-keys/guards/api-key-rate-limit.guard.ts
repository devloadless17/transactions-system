import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis, { type Redis } from 'ioredis';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../../common/types/request.types';
import type { Env } from '../../../config/env.schema';
import { DomainError, RateLimitError } from '../../../common/errors/domain.error';

const WINDOW_SECONDS = 60;
const MAX_PER_WINDOW = 300; // 5 rps avg, burst friendly

/**
 * Per-API-key rate limiter for ingestion endpoints. Uses Redis INCR
 * with EXPIRE for a simple fixed-window counter. Falls open (allows
 * the request) if Redis is unavailable, to avoid blocking ingestion
 * during cache outages.
 */
@Injectable()
export class ApiKeyRateLimitGuard implements CanActivate {
  private readonly logger = new Logger(ApiKeyRateLimitGuard.name);
  private readonly redis: Redis;
  private healthy = true;

  constructor(config: ConfigService<Env, true>) {
    this.redis = new IORedis(config.get('REDIS_URL', { infer: true }), {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });
    this.redis.on('error', () => {
      this.healthy = false;
    });
    this.redis.on('ready', () => {
      this.healthy = true;
    });
  }

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (!this.healthy) return true;
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    // ApiKeyAuthGuard runs first and populates principal; key id is the userId surrogate.
    const keyId = req.principal?.userId;
    if (!keyId) return true;

    const nowSec = Math.floor(Date.now() / 1000);
    const bucket = Math.floor(nowSec / WINDOW_SECONDS);
    const k = `rl:ingest:${keyId}:${bucket}`;
    try {
      const count = await this.redis.incr(k);
      if (count === 1) await this.redis.expire(k, WINDOW_SECONDS + 5);

      // Standard RateLimit headers (draft IETF naming) so clients can self-pace.
      const resetSec = (bucket + 1) * WINDOW_SECONDS - nowSec;
      const res = ctx.switchToHttp().getResponse<Response>();
      res.setHeader('RateLimit-Limit', MAX_PER_WINDOW);
      res.setHeader('RateLimit-Remaining', Math.max(0, MAX_PER_WINDOW - count));
      res.setHeader('RateLimit-Reset', resetSec);

      if (count > MAX_PER_WINDOW) {
        res.setHeader('Retry-After', resetSec);
        // A typed domain error → the GlobalExceptionFilter emits the clean, flat
        // { success:false, statusCode:429, error:{ code:'RATE_LIMITED', message, details } }.
        throw new RateLimitError({ limit: MAX_PER_WINDOW, windowSeconds: WINDOW_SECONDS });
      }
      return true;
    } catch (err) {
      if (err instanceof DomainError) throw err;
      this.logger.warn(`rate-limit Redis error, allowing: ${(err as Error).message}`);
      return true;
    }
  }
}
