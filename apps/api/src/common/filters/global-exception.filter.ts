import { ArgumentsHost, Catch, ExceptionFilter, HttpException, Logger } from '@nestjs/common';
import { Request, Response } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@app/db';
import type { ApiError, ApiErrorEnvelope } from '@app/shared';
import { DomainError } from '../errors/domain.error';
import { redactUrl } from '../logging/redact-url';

/** A translated exception: the HTTP status plus the envelope's inner error object. */
interface TranslatedError {
  status: number;
  error: ApiError;
}

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger('GlobalExceptionFilter');

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    const { status, error } = this.translate(exception);

    const safeUrl = redactUrl(req.originalUrl);
    if (status >= 500) {
      this.logger.error(
        `${req.method} ${safeUrl} -> ${status} ${error.code}`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    } else {
      this.logger.warn(`${req.method} ${safeUrl} -> ${status} ${error.code}: ${error.message}`);
    }

    // Mirror the success envelope (ResponseEnvelopeInterceptor): same top-level
    // `success` + `statusCode`, with the error under `error` instead of `data`.
    const body: ApiErrorEnvelope = { success: false, statusCode: status, error };
    res.status(status).json(body);
  }

  private translate(exception: unknown): TranslatedError {
    if (exception instanceof DomainError) {
      return {
        status: exception.httpStatus,
        error: {
          code: exception.code,
          message: exception.message,
          details: exception.details,
        },
      };
    }

    if (exception instanceof ZodError) {
      return {
        status: 400,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: exception.issues,
        },
      };
    }

    // Map known Prisma errors to proper 4xx instead of leaking them as 500s.
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      return this.translatePrismaKnown(exception);
    }
    if (exception instanceof Prisma.PrismaClientValidationError) {
      return {
        status: 400,
        error: { code: 'VALIDATION_ERROR', message: 'Invalid database query input' },
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const response = exception.getResponse();
      const message =
        typeof response === 'string'
          ? response
          : ((response as { message?: string }).message ?? exception.message);
      return {
        status,
        error: {
          code: codeFromStatus(status),
          message,
          details: typeof response === 'object' ? (response as Record<string, unknown>) : undefined,
        },
      };
    }

    return {
      status: 500,
      error: {
        code: 'INTERNAL_ERROR',
        message: 'Internal server error',
      },
    };
  }

  private translatePrismaKnown(e: Prisma.PrismaClientKnownRequestError): TranslatedError {
    switch (e.code) {
      case 'P2002': // unique constraint violation
        return {
          status: 409,
          error: {
            code: 'CONFLICT',
            message: 'A record with these values already exists',
            details: { target: (e.meta as { target?: unknown } | undefined)?.target },
          },
        };
      case 'P2025': // record required but not found
        return { status: 404, error: { code: 'NOT_FOUND', message: 'Record not found' } };
      case 'P2003': // foreign-key constraint violation
        return {
          status: 409,
          error: {
            code: 'CONFLICT',
            message: 'Operation violates a reference constraint',
            details: { field: (e.meta as { field_name?: unknown } | undefined)?.field_name },
          },
        };
      case 'P2034': // write conflict / deadlock (normally retried by runSerializable)
        return {
          status: 409,
          error: { code: 'WRITE_CONFLICT', message: 'Write conflict, please retry' },
        };
      default:
        // Unknown known-error: surface the Prisma code but not internals.
        return {
          status: 400,
          error: { code: `DB_${e.code}`, message: 'Database request error' },
        };
    }
  }
}

function codeFromStatus(status: number): string {
  if (status === 400) return 'BAD_REQUEST';
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 403) return 'FORBIDDEN';
  if (status === 404) return 'NOT_FOUND';
  if (status === 409) return 'CONFLICT';
  if (status === 422) return 'UNPROCESSABLE';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'INTERNAL_ERROR';
  return `HTTP_${status}`;
}
