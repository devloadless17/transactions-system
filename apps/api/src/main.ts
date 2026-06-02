import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Logger as PinoLogger } from 'nestjs-pino';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { ServerOptions } from 'socket.io';
import type { INestApplicationContext } from '@nestjs/common';
import { AppModule } from './app.module';
import type { Env } from './config/env.schema';
import { CSRF_HEADER_NAME } from './modules/auth/auth.constants';

/**
 * Socket.IO adapter that applies the same credentialed CORS allowlist as the
 * HTTP server, so only our web origins can open an authenticated socket
 * (the handshake carries the auth cookie — origin:true would invite
 * cross-site websocket hijacking).
 */
class CorsIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly origins: string[],
  ) {
    super(app);
  }

  override createIOServer(port: number, options?: ServerOptions): unknown {
    return super.createIOServer(port, {
      ...options,
      cors: { origin: this.origins, credentials: true },
    });
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

  app.set('trust proxy', 1);
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

  // Realtime (Socket.IO) shares the HTTP server and the same CORS allowlist.
  app.useWebSocketAdapter(new CorsIoAdapter(app, allowed));

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
