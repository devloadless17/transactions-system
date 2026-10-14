import { Controller, Get, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Prisma } from '@app/db';
import { PrismaService } from '../../database/prisma.service';
import { SkipResponseEnvelope } from '../../common/decorators/skip-response-envelope.decorator';
import { shutdownState } from '../../common/http/graceful-drain';

/**
 * Caddy marks its active health checks with this header (`health_headers` in
 * the Caddyfile), so the API can tell Caddy's checks from any other caller.
 */
export const PROXY_HEALTH_CHECK_HEADER = 'x-health-check';
const PROXY_HEALTH_CHECK_VALUE = 'caddy';

/**
 * How long a health check waits for the database's answer. Well inside every
 * checker's own timeout (Caddy 3s, the release script 3s, Docker 5s).
 */
export const DB_ANSWER_WAIT_MS = 1_500;
/**
 * How long the database may go without answering, while every connection is
 * busy, before the API counts as down. Twice the longest a transaction waits
 * for a connection (TX_MAX_WAIT_MS in prisma.service.ts): past it, work is
 * failing, not waiting its turn.
 */
export const DB_BUSY_LIMIT_MS = 30_000;

type DbState = 'ok' | 'busy' | 'down';

const isLoopback = (address: string | undefined): boolean =>
  address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';

// P2024: no connection came free within Prisma's pool timeout — the pool is
// busy, the database itself did not fail.
const isPoolTimeout = (err: unknown): boolean =>
  err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2024';

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
  /** When the database last answered a check (performance.now()). */
  private lastDbAnswerAt: number | null = null;
  /** The database check in flight, shared by every health check meanwhile. */
  private dbCheck: Promise<DbState | 'waiting'> | null = null;

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
    const db = await this.dbState();
    // Return 503 (not 200) when the DB is unreachable so the container/orchestrator
    // healthcheck actually fails and the instance is restarted / pulled from
    // rotation instead of staying "healthy" while serving 500s on every request.
    if (db === 'down') res.status(503);
    else if (req.headers[PROXY_HEALTH_CHECK_HEADER] === PROXY_HEALTH_CHECK_VALUE) {
      this.lastProxyCheckOkAt = performance.now();
    }
    return {
      status: db === 'down' ? 'degraded' : 'ok',
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

  /**
   * Is the database there? A check queues for a pool connection like any
   * other query, so in a burst (every connection busy) it waits behind the
   * work. That is busy, not down: the process serves, and the database
   * answered moments ago — so Caddy keeps routing here (there is nowhere
   * better: every colour shares this database), and a release does not take a
   * busy new version for a crashed one. Measured: with the pool held, SELECT 1
   * waited 4.7s, past Caddy's 3s timeout, which took the only API out of
   * rotation in the middle of the burst.
   *
   * Down: the database failed the check, or has not answered for
   * DB_BUSY_LIMIT_MS — or never has (a new release must reach its database
   * before it takes traffic). One check is in flight at a time, so health
   * checks never pile up in the pool queue themselves.
   */
  private async dbState(): Promise<DbState> {
    this.dbCheck ??= this.prisma
      .$queryRawUnsafe('SELECT 1')
      .then(
        (): DbState => {
          this.lastDbAnswerAt = performance.now();
          return 'ok';
        },
        (err: unknown): DbState | 'waiting' => (isPoolTimeout(err) ? 'waiting' : 'down'),
      )
      .finally(() => {
        this.dbCheck = null;
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = new Promise<'waiting'>((resolve) => {
      timer = setTimeout(() => resolve('waiting'), DB_ANSWER_WAIT_MS);
    });
    try {
      const answer = await Promise.race([this.dbCheck, waited]);
      if (answer !== 'waiting') return answer;
    } finally {
      clearTimeout(timer);
    }
    return this.lastDbAnswerAt !== null &&
      performance.now() - this.lastDbAnswerAt < DB_BUSY_LIMIT_MS
      ? 'busy'
      : 'down';
  }
}
