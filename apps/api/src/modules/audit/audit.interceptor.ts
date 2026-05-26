import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap } from 'rxjs';
import type { AuthenticatedRequest } from '../../common/types/request.types';
import { AUDIT_METADATA_KEY, type AuditMetadata } from './audit.decorator';
import { AuditService } from './audit.service';

/**
 * Reads `@Audited()` metadata after a route handler completes. On
 * success, writes an audit_logs row. Failures are NOT audited (the
 * GlobalExceptionFilter logs them separately).
 *
 * Best-effort: an audit-write error is logged but doesn't fail the
 * request — the operation has already succeeded.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(
    private readonly audit: AuditService,
    private readonly reflector: Reflector,
  ) {}

  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    const meta = this.reflector.getAllAndOverride<AuditMetadata | undefined>(AUDIT_METADATA_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (!meta) return next.handle();

    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = req.principal;
    const ip = req.ip ?? null;
    const userAgent = (req.headers['user-agent'] as string | undefined) ?? null;

    return next.handle().pipe(
      tap((result) => {
        const entityId = pickPath(result, req, meta.idFrom) ?? null;
        const companyId = pickPath(result, req, meta.companyIdFrom) ?? principal?.companyId ?? null;
        this.audit
          .record({
            actorId: principal?.userId ?? null,
            companyId,
            action: meta.action,
            entityType: meta.entityType,
            entityId,
            metadata: { method: req.method, path: req.originalUrl },
            ipAddress: ip,
            userAgent,
          })
          .catch((err) => this.logger.warn(`audit write failed: ${err}`));
      }),
    );
  }
}

function pickPath(
  result: unknown,
  req: AuthenticatedRequest,
  path: string | undefined,
): string | null {
  if (!path) return null;
  const root = path.split('.')[0];
  const rest = path.split('.').slice(1);
  const obj =
    root === 'result' ? result : root === 'params' ? req.params : root === 'body' ? req.body : null;
  let cur: unknown = obj;
  for (const seg of rest) {
    if (cur && typeof cur === 'object' && seg in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return null;
    }
  }
  return typeof cur === 'string' ? cur : null;
}
