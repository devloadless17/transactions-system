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
  // Log loudly, then close gracefully (Prisma/Redis disconnect, timers cleared)
  // and exit non-zero so the orchestrator's restart policy brings up a clean
  // instance. A hard timeout guards against a hung shutdown.
  process.on('uncaughtException', (err) => {
    logger.error(`Uncaught exception — shutting down: ${err.stack ?? err.message}`);
    const force = setTimeout(() => process.exit(1), 5000);
    force.unref();
    void app
      .close()
      .catch(() => undefined)
      .finally(() => process.exit(1));
  });

  app.set('trust proxy', 1);
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
    origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
      if (!origin || allowed.includes(origin)) cb(null, true);
      else cb(new Error(`Origin ${origin} not allowed`));
    },
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

  // Graceful shutdown. Every deploy / rolling restart sends SIGTERM; without
  // this, Nest tears the process down immediately and drops in-flight requests —
  // including a withdrawal/ingest mid serializable transaction. enableShutdownHooks
  // registers signal handlers that stop accepting new connections, let in-flight
  // requests finish, then run OnModuleDestroy (Prisma $disconnect, Redis quit,
  // reconciliation/maintenance timer clears) before exit.
  app.enableShutdownHooks();

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
