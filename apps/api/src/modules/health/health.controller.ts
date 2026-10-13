import { Controller, Get, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { PrismaService } from '../../database/prisma.service';
import { SkipResponseEnvelope } from '../../common/decorators/skip-response-envelope.decorator';
import { shutdownState } from '../../common/http/graceful-drain';

/**
 * Caddy marks its active health checks with this header (`health_headers` in
 * the Caddyfile), so the API can tell Caddy's checks from any other caller.
 */
export const PROXY_HEALTH_CHECK_HEADER = 'x-health-check';
const PROXY_HEALTH_CHECK_VALUE = 'caddy';

const isLoopback = (address: string | undefined): boolean =>
  address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';

// Operational liveness/readiness probe: orchestrators and monitors read the raw
// {status,db} body and it sets its own 503 — keep it outside the API envelope.
@SkipResponseEnvelope()
@Controller('health')
export class HealthController {
  /**
   * When Caddy's health check last got a 200 here (performance.now()). Caddy
   * marks an upstream healthy on its first passing check, so a fresh value
   * means Caddy can route here right now — the release script waits for it
   * before draining the previous version (scripts/deploy/release.sh), however
   * long Caddy took to find this container.
   */
  private lastProxyCheckOkAt: number | null = null;

  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async health(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    // Shutting down (a deploy): 503 tells Caddy's active health check to stop
    // routing new requests here — it holds them for the new container — while
    // the requests already here finish. See common/http/graceful-drain.
    if (shutdownState.draining) {
      res.status(503);
      return { status: 'draining', timestamp: new Date().toISOString() };
    }
    let db: 'ok' | 'down' = 'ok';
    try {
      await this.prisma.$queryRawUnsafe('SELECT 1');
    } catch {
      db = 'down';
    }
    // Return 503 (not 200) when the DB is unreachable so the container/orchestrator
    // healthcheck actually fails and the instance is restarted / pulled from
    // rotation instead of staying "healthy" while serving 500s on every request.
    if (db === 'down') res.status(503);
    else if (req.headers[PROXY_HEALTH_CHECK_HEADER] === PROXY_HEALTH_CHECK_VALUE) {
      this.lastProxyCheckOkAt = performance.now();
    }
    return {
      status: db === 'ok' ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      db,
      // Only for a caller inside this container (the release script, via
      // `docker exec`): how long ago Caddy's health check last passed here.
      // Never sent through the proxy — every proxied caller's peer is Caddy.
      ...(isLoopback(req.socket?.remoteAddress)
        ? {
            proxyCheckedMsAgo:
              this.lastProxyCheckOkAt === null
                ? null
                : Math.round(performance.now() - this.lastProxyCheckOkAt),
          }
        : {}),
    };
  }
}
