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
          response: response ?? null,
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

/** Mirror the GlobalExceptionFilter's shape so the logged response matches what the client got. */
function mapError(err: unknown): { statusCode: number; payload: unknown } {
  if (err instanceof DomainError) {
    return {
      statusCode: err.httpStatus,
      payload: { error: { code: err.code, message: err.message, details: err.details } },
    };
  }
  if (err instanceof ZodError) {
    return {
      statusCode: 400,
      payload: {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: err.issues,
        },
      },
    };
  }
  if (err instanceof HttpException) {
    const res = err.getResponse();
    return {
      statusCode: err.getStatus(),
      payload: typeof res === 'string' ? { error: { message: res } } : res,
    };
  }
  return {
    statusCode: 500,
    payload: { error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } },
  };
}
