import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { LoggerModule as PinoModule } from 'nestjs-pino';
import { nanoid } from 'nanoid';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Env } from '../../config/env.schema';
import { clientIp } from './client-ip';
import { redactUrl } from './redact-url';

const CORRELATION_HEADER = 'x-request-id';

@Module({
  imports: [
    PinoModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (cfg: ConfigService<Env, true>) => {
        const isDev = cfg.get('NODE_ENV', { infer: true }) === 'development';
        return {
          pinoHttp: {
            level: isDev ? 'debug' : 'info',
            // Attach a correlation id to every request. Use the inbound
            // header if the client/proxy provided one; otherwise mint one.
            genReqId: (req: IncomingMessage, res: ServerResponse) => {
              const inbound = (req.headers[CORRELATION_HEADER] as string | undefined)?.trim();
              const id = inbound || nanoid(12);
              res.setHeader(CORRELATION_HEADER, id);
              return id;
            },
            customProps: () => ({ service: 'txn-api' }),
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'res.headers["set-cookie"]',
                '*.password',
                '*.passwordHash',
                '*.token',
                '*.keyHash',
              ],
              censor: '[redacted]',
            },
            serializers: {
              req: (req) => ({
                id: req.id,
                method: req.method,
                url: redactUrl(req.url),
                ip: clientIp(req),
              }),
              res: (res) => ({ statusCode: res.statusCode }),
            },
            ...(isDev
              ? {
                  transport: {
                    target: 'pino-pretty',
                    options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l' },
                  },
                }
              : {}),
          },
        };
      },
    }),
  ],
})
export class AppLoggerModule {}
