import 'reflect-metadata';
import { timingSafeEqual } from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response, NextFunction } from 'express';
import { Logger as PinoLogger } from 'nestjs-pino';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import IORedis from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';
import type { INestApplicationContext } from '@nestjs/common';
import { noStore } from './common/http/no-store';
import { drainHttpServer, drainMiddleware, trackUpgrades } from './common/http/graceful-drain';
import { stopBackgroundJobs } from './common/lifecycle/background-jobs';
import { trustedProxies } from './common/http/trusted-proxies';
import { corsOriginCheck } from './common/http/cors-origin';
import { AppModule } from './app.module';
import type { Env } from './config/env.schema';
import { CSRF_HEADER_NAME } from './modules/auth/auth.constants';

/**
 * Socket.IO adapter that applies the same credentialed CORS allowlist as the
 * HTTP server, so only our web origins can open an authenticated socket
 * (the handshake carries the auth cookie — origin:true would invite
 * cross-site websocket hijacking).
 *
 * It also attaches the Redis adapter (`@socket.io/redis-adapter`) so realtime
 * `invalidate` hints emitted on one API replica reach clients connected to
 * another. Without it, the default in-memory adapter drops cross-instance
 * events whenever the API runs >1 replica behind a non-sticky load balancer.
 * Wiring is unconditional when REDIS_URL is set: on a single instance it is a
 * harmless no-op (the local emit still works), and on a fleet it is correct.
 * If Redis is unreachable the socket server keeps serving from the in-memory
 * adapter (degraded — cross-instance events are dropped — but never crashing),
 * matching the fail-open posture of the cache and throttler.
 */
class CorsIoAdapter extends IoAdapter {
  private readonly logger = new Logger(CorsIoAdapter.name);

  constructor(
    app: INestApplicationContext,
    private readonly origins: string[],
    private readonly redisUrl: string,
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions): unknown {
    const server = super.createIOServer(port, {
      ...options,
      cors: { origin: this.origins, credentials: true },
    }) as Server;

    if (this.redisUrl) {
      // pub + sub must be SEPARATE connections: once a client issues SUBSCRIBE it
      // can't run normal commands, so the adapter publishes on `pubClient` and
      // listens on a duplicated `subClient` (the adapter's required contract).
      const pubClient = new IORedis(this.redisUrl, {
        maxRetriesPerRequest: null,
        enableOfflineQueue: true,
        lazyConnect: false,
      });
      const subClient = pubClient.duplicate();
      // createAdapter() is synchronous and succeeds even when Redis is down, so
      // "attached" says nothing about connectivity. Gate the logs on the REAL
      // connection lifecycle instead: announce 'enabled' only once both clients
      // are ready, and warn on every error (rate-limited) — otherwise a dead
      // Redis in a multi-replica deploy silently drops cross-instance events
      // while the boot log claims the adapter is enabled.
      let readyCount = 0;
      const onReady = () => {
        readyCount += 1;
        if (readyCount === 2) {
          this.logger.log('Socket.IO Redis adapter connected (cross-replica realtime).');
        }
      };
      pubClient.once('ready', onReady);
      subClient.once('ready', onReady);
      let lastWarnAt = 0;
      const onError = (e: Error) => {
        const now = Date.now();
        if (now - lastWarnAt < 30_000) return; // rate-limit: ioredis retries forever
        lastWarnAt = now;
        this.logger.warn(
          `redis adapter unavailable — realtime degraded to in-memory (cross-instance events dropped): ${e.message}`,
        );
      };
      pubClient.on('error', onError);
      subClient.on('error', onError);
      try {
        server.adapter(createAdapter(pubClient, subClient));
      } catch (e) {
        this.logger.warn(
          `failed to attach redis adapter — realtime stays in-memory: ${(e as Error).message}`,
        );
        void pubClient.quit().catch(() => undefined);
        void subClient.quit().catch(() => undefined);
      }
    }

    return server;
  }
}

// A background run in progress gets this long to finish during a shutdown.
const JOB_DRAIN_MS = 40_000;
// After an uncaught exception the zero-loss shutdown still runs, but the
// process must not linger in that state: it exits by then whatever happens.
const CRASH_EXIT_CAP_MS = 15_000;

async function bootstrap() {
  // bodyParser stays enabled (Nest's express parses JSON by default).
  // The body-size cap is enforced by overriding NestExpressApplication settings below.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
  });
  app.useLogger(app.get(PinoLogger));
  const config = app.get(ConfigService<Env, true>);
  const logger = new Logger('Bootstrap');

  // Safety net: a detached/fire-and-forget promise that rejects (e.g. a best-effort
  // webhook delivery or notification whose error path wasn't caught) must NOT take
  // the whole process down. Node's default is to throw on an unhandled rejection,
  // which for a money API would drop every in-flight request. Log it loudly instead
  // so monitoring still surfaces the bug, but keep serving.
  process.on('unhandledRejection', (reason) => {
    logger.error(
      `Unhandled promise rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`,
    );
  });

  // An uncaught SYNCHRONOUS throw leaves the process in an undefined state — for a
  // money API, continuing to serve from there is more dangerous than restarting.
  // Log loudly, then shut down and exit non-zero so the restart policy brings up
  // a clean instance. The shutdown is the same zero-loss one a deploy uses
  // (below): the throw almost always comes from one code path, and the requests
  // in flight on other connections — deposits, withdrawals — are finished rather
  // than dropped, while Caddy holds new ones for the restarted container. Capped
  // at CRASH_EXIT_CAP_MS, so a broken process cannot linger.
  // Filled in once the server is up (below); until then a crash is a plain close.
  const graceful: { shutdown?: (reason: string, exitCode: number) => Promise<void> } = {};
  process.on('uncaughtException', (err) => {
    logger.error(`Uncaught exception — shutting down: ${err.stack ?? err.message}`);
    const force = setTimeout(() => process.exit(1), CRASH_EXIT_CAP_MS);
    force.unref();
    if (graceful.shutdown) {
      void graceful.shutdown('uncaughtException', 1);
      return;
    }
    // Still booting: nothing is being served yet.
    void app
      .close()
      .catch(() => undefined)
      .finally(() => process.exit(1));
  });

  // Trust only the hop we are attached to (the container network the edge proxy
  // reaches us over). The proxy alone decides who the visitor is and hands over
  // ONE address — see ./common/http/trusted-proxies and the Caddyfile.
  app.set('trust proxy', trustedProxies());
  // First middleware: once a shutdown starts, every response closes its
  // connection — part of the zero-loss shutdown below (./common/http/graceful-drain).
  app.use(drainMiddleware);
  trackUpgrades(app.getHttpServer());
  // Every response here is authenticated and tenant-scoped — nothing may be
  // cached by a browser, proxy or CDN. Registered before the routes so it
  // covers streamed CSV exports and error responses too. See ./common/http/no-store.
  app.use(noStore);
  // Tighter helmet config. CSP stays off for /docs (Swagger UI) which we
  // mount before this would matter; turn it on for everything else.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'", "'unsafe-inline'"],
          'style-src': ["'self'", "'unsafe-inline'"],
          'img-src': ["'self'", 'data:'],
          'connect-src': ["'self'"],
          'frame-ancestors': ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  // Body size cap. Anything larger than 256kb is abuse for this API.
  app.useBodyParser('json', { limit: '256kb' });
  app.useBodyParser('urlencoded', { extended: true, limit: '256kb' });
  app.use(cookieParser());

  // Protect /metrics with a bearer token when configured. Prometheus metrics
  // leak operational/tenant topology, so they should not be world-readable in
  // production. When METRICS_TOKEN is empty (dev) the endpoint stays open.
  const metricsToken = config.get('METRICS_TOKEN', { infer: true });
  if (metricsToken) {
    const expected = Buffer.from(`Bearer ${metricsToken}`);
    app.use('/metrics', (req: Request, res: Response, next: NextFunction) => {
      // Constant-time compare (matches the project's timing-safe posture for
      // secrets) so a correct prefix of the token can't be recovered byte-by-byte.
      const provided = Buffer.from(req.headers.authorization ?? '');
      if (provided.length === expected.length && timingSafeEqual(provided, expected)) {
        return next();
      }
      res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'metrics token required' } });
    });
  } else if (config.get('NODE_ENV', { infer: true }) === 'production') {
    logger.warn('METRICS_TOKEN is not set — /metrics is publicly readable in production.');
  }

  const allowed = config
    .get('ALLOWED_ORIGINS', { infer: true })
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.enableCors({
    origin: corsOriginCheck(allowed),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', CSRF_HEADER_NAME],
  });

  // Realtime (Socket.IO) shares the HTTP server and the same CORS allowlist, and
  // uses the Redis adapter so invalidations propagate across API replicas.
  app.useWebSocketAdapter(
    new CorsIoAdapter(app, allowed, config.get('REDIS_URL', { infer: true })),
  );

  // Apply the API prefix to everything EXCEPT operational endpoints. /metrics
  // and /docs live at root so ops tooling can hit them without knowing the
  // versioned prefix.
  const apiPrefix = config.get('API_GLOBAL_PREFIX', { infer: true });
  app.setGlobalPrefix(apiPrefix, {
    exclude: ['/metrics', '/docs', '/docs-json'],
  });

  // OpenAPI / Swagger UI at /docs. Only mounted in non-production by default.
  if (config.get('NODE_ENV', { infer: true }) !== 'production') {
    const doc = new DocumentBuilder()
      .setTitle('Transactions System API')
      .setDescription(
        'Multi-tenant transaction & settlement platform. All routes under /' +
          apiPrefix +
          ' use cookie auth except /' +
          apiPrefix +
          '/ingest/* which uses a Bearer API key.',
      )
      .setVersion('1.0')
      .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'tsk_<prefix>_<secret>' })
      .addCookieAuth('txn_access')
      .build();
    const document = SwaggerModule.createDocument(app, doc);
    SwaggerModule.setup('docs', app, document, {
      jsonDocumentUrl: '/docs-json',
      swaggerOptions: { persistAuthorization: true },
    });
  }

  // Zero-loss shutdown. Every deploy sends SIGTERM, and this is a money system:
  // nothing in flight may be dropped. Nest's own enableShutdownHooks() is NOT used —
  // it runs the module destroy hooks (Prisma $disconnect, Redis quit) BEFORE it
  // stops the HTTP server, so a request arriving in between could fail, and its
  // close waited forever on Caddy's keep-alive connections. Instead, in order:
  //   1. the HTTP side drains: /v1/health turns 503 so Caddy stops routing here
  //      (it holds new requests for the next container), and every request
  //      already here runs to completion (./common/http/graceful-drain);
  //   2. at the same time the background jobs stop starting new runs and the
  //      one in progress finishes (./common/lifecycle/background-jobs);
  //   3. only then does Nest close the database, Redis and the rest — nothing
  //      is using them any more.
  // docker-compose gives this 60s (stop_grace_period); it normally takes ~3s.
  let stopping = false;
  const shutdown = async (reason: string, exitCode = 0): Promise<void> => {
    if (stopping) return;
    stopping = true;
    // Steady clock: a wall clock can be stepped (NTP, VM time sync) mid-shutdown.
    const t0 = performance.now();
    const since = () => `${Math.round(performance.now() - t0)}ms`;
    logger.log(`${reason}: draining — health now 503, finishing everything in flight`);
    const [, unfinished] = await Promise.all([
      drainHttpServer(app.getHttpServer()).then(() => logger.log(`HTTP drained (${since()})`)),
      stopBackgroundJobs(JOB_DRAIN_MS).then((left) => {
        logger.log(`Background jobs stopped (${since()})`);
        return left;
      }),
    ]);
    if (unfinished.length) {
      logger.warn(`Background jobs still running at shutdown: ${unfinished.join(', ')}`);
    }
    // A failure closing Postgres/Redis must not leave the process hanging until Docker
    // kills it: everything in flight is already done, so log it and exit regardless.
    await app.close().catch((err: unknown) => {
      logger.error(
        `Shutdown: closing connections failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    logger.log(`Shutdown complete (${since()})`);
    process.exit(exitCode);
  };
  graceful.shutdown = shutdown;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(signal, (s: NodeJS.Signals) => void shutdown(s));
  }

  const port = config.get('API_PORT', { infer: true });
  const host = config.get('API_HOST', { infer: true });
  await app.listen(port, host);
  logger.log(
    `API listening on http://${host}:${port}/${config.get('API_GLOBAL_PREFIX', { infer: true })}`,
  );
}

bootstrap().catch((err) => {
  console.error(err);
  process.exit(1);
});
