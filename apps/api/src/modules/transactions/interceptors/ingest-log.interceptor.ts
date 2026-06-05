import {
  type CallHandler,
  type ExecutionContext,
  HttpException,
  Injectable,
  type NestInterceptor,
} from '@nestjs/common';
import { type Observable, catchError, tap, throwError } from 'rxjs';
import { ZodError } from 'zod';
import { DomainError } from '../../../common/errors/domain.error';
import type { AuthenticatedRequest } from '../../../common/types/request.types';
import { TransactionLogsService } from '../../transaction-logs/transaction-logs.service';

/**
 * Records one TransactionLog (kind=INGEST) per source ingest call — the raw
 * request body plus the response we returned, INCLUDING rejected/4xx attempts
 * (the catchError branch). Best-effort and non-blocking: it never alters or
 * delays the real response/error, so it can't affect the money path.
 *
 * Scoped to the ingest POST route via @UseInterceptors on the handler.
 */
@Injectable()
export class IngestLogInterceptor implements NestInterceptor {
  constructor(private readonly logs: TransactionLogsService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const body: unknown = req.body;
    const sourceCode = typeof req.params?.sourceCode === 'string' ? req.params.sourceCode : null;

    return next.handle().pipe(
      tap((response: unknown) => {
        // The tap sees the RAW handler payload (this route-scoped interceptor runs
        // innermost, before the global ResponseEnvelopeInterceptor wraps it), so
        // extract the ids off the raw object — then store the envelope the client
        // actually received so the log mirrors the wire response.
        const r = asRecord(response);
        this.logs.record({
          kind: 'INGEST',
          companyId: str(r?.operatingId) ?? str(asRecord(body)?.operatingId),
          sourceCode,
          reference: str(r?.externalTransactionId) ?? str(asRecord(body)?.externalTransactionId),
          transactionId: str(r?.id),
          statusCode: 201,
          success: true,
          request: body ?? null,
          response: { success: true, statusCode: 201, data: response ?? null },
        });
      }),
      catchError((err: unknown) => {
        const { statusCode, payload } = mapError(err);
        this.logs.record({
          kind: 'INGEST',
          companyId: str(asRecord(body)?.operatingId),
          sourceCode,
          reference: str(asRecord(body)?.externalTransactionId),
          transactionId: null,
          statusCode,
          success: false,
          request: body ?? null,
          response: payload,
        });
        return throwError(() => err);
      }),
    );
  }
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}
function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

/**
 * Mirror the GlobalExceptionFilter's error envelope so the logged response
 * matches what the client got: `{ success: false, statusCode, error }`.
 */
function mapError(err: unknown): { statusCode: number; payload: unknown } {
  const { statusCode, error } = translate(err);
  return { statusCode, payload: { success: false, statusCode, error } };
}

function translate(err: unknown): { statusCode: number; error: unknown } {
  if (err instanceof DomainError) {
    return {
      statusCode: err.httpStatus,
      error: { code: err.code, message: err.message, details: err.details },
    };
  }
  if (err instanceof ZodError) {
    return {
      statusCode: 400,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: err.issues,
      },
    };
  }
  if (err instanceof HttpException) {
    const res = err.getResponse();
    return {
      statusCode: err.getStatus(),
      error: typeof res === 'string' ? { message: res } : res,
    };
  }
  return { statusCode: 500, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } };
}
