import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor,
  StreamableFile,
} from '@nestjs/common';
import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { map, type Observable } from 'rxjs';
import type { ApiSuccessEnvelope } from '@app/shared';
import { SKIP_RESPONSE_ENVELOPE } from '../decorators/skip-response-envelope.decorator';

/**
 * Wraps every successful JSON response in the platform envelope
 * `{ success: true, statusCode, data }` so callers get a single, predictable
 * shape and can read the status code straight from the body. Errors are handled
 * separately by the GlobalExceptionFilter (which emits the matching
 * `{ success: false, statusCode, error }`).
 *
 * Registered as the FIRST (outermost) global interceptor so its `map` runs LAST
 * on the response path — every other interceptor (audit id-extraction, metrics,
 * the route-scoped ingest log) still observes the raw handler payload.
 *
 * Skipped, leaving the body untouched, when:
 *  - the route opts out with @SkipResponseEnvelope() (CSV, health, inbound acks),
 *  - there is no body (204 / undefined / null) — a 204 must not carry one,
 *  - the payload is non-JSON (string/Buffer/StreamableFile, or a non-JSON
 *    Content-Type was already set, e.g. text/csv).
 */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const skip = this.reflector.getAllAndOverride<boolean>(SKIP_RESPONSE_ENVELOPE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skip) return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    // Nest applies the route's status code AFTER the interceptor chain, so
    // res.statusCode is still the default 200 here. Derive the real one the
    // same way Nest does: an explicit @HttpCode wins, otherwise POST → 201 and
    // every other verb → 200.
    const explicit = this.reflector.get<number | undefined>(
      HTTP_CODE_METADATA,
      context.getHandler(),
    );
    const statusCode = explicit ?? (req.method === 'POST' ? 201 : 200);

    return next.handle().pipe(
      map((data: unknown): unknown => {
        if (data === undefined || data === null) return data; // 204 / void
        if (res.statusCode === 204) return data;
        if (typeof data === 'string' || Buffer.isBuffer(data) || data instanceof StreamableFile) {
          return data; // non-JSON producers (CSV, downloads)
        }
        const contentType = res.getHeader('content-type');
        if (typeof contentType === 'string' && !contentType.includes('application/json')) {
          return data; // a non-JSON Content-Type was set explicitly (e.g. text/csv)
        }
        return { success: true, statusCode, data } satisfies ApiSuccessEnvelope<unknown>;
      }),
    );
  }
}
