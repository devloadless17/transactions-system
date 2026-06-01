import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import IORedis, { type Redis } from 'ioredis';
import { HttpException } from '@nestjs/common';
import type { AuthenticatedRequest } from '../../../common/types/request.types';
import type { Env } from '../../../config/env.schema';

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

    const bucket = Math.floor(Date.now() / 1000 / WINDOW_SECONDS);
    const k = `rl:ingest:${keyId}:${bucket}`;
    try {
      const count = await this.redis.incr(k);
      if (count === 1) await this.redis.expire(k, WINDOW_SECONDS + 5);
      if (count > MAX_PER_WINDOW) {
        throw new HttpException(
          {
            error: {
              code: 'RATE_LIMITED',
              message: `Rate limit exceeded: ${MAX_PER_WINDOW} requests per ${WINDOW_SECONDS}s`,
              details: { limit: MAX_PER_WINDOW, windowSeconds: WINDOW_SECONDS },
            },
          },
          429,
        );
      }
      return true;
    } catch (err) {
      if (err instanceof HttpException) throw err;
      this.logger.warn(`rate-limit Redis error, allowing: ${(err as Error).message}`);
      return true;
    }
  }
}
