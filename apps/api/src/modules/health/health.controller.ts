import { Controller, Get, Res } from '@nestjs/common';
import type { Response } from 'express';
import { PrismaService } from '../../database/prisma.service';
import { SkipResponseEnvelope } from '../../common/decorators/skip-response-envelope.decorator';
import { shutdownState } from '../../common/http/graceful-drain';

// Operational liveness/readiness probe: orchestrators and monitors read the raw
// {status,db} body and it sets its own 503 — keep it outside the API envelope.
@SkipResponseEnvelope()
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async health(@Res({ passthrough: true }) res: Response) {
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
    return {
      status: db === 'ok' ? 'ok' : 'degraded',
      timestamp: new Date().toISOString(),
      db,
    };
  }
}
