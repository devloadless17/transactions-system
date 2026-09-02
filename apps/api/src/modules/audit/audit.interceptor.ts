import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap } from 'rxjs';
import type { AuthenticatedRequest } from '../../common/types/request.types';
import { AUDIT_METADATA_KEY, type AuditMetadata } from './audit.decorator';
import { AuditService } from './audit.service';

/**
 * Reads `@Audited()` metadata around a route handler and writes an audit_logs
 * row on BOTH success and failure. A denied/failed money or admin mutation
 * (rejected approval, authz ForbiddenError, ConflictError) leaves a trail with
 * `outcome: 'error'` for fraud/incident forensics — not just the happy path.
 *
 * Best-effort: an audit-write error is logged but doesn't change the request
 * outcome; on the error path the original error still propagates unchanged.
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

    // For COMPANY API-key auth the principal is synthetic: principal.userId is the
    // api_keys.id, which is NOT a users.id. Writing it to audit_logs.actor_id (FK ->
    // users) raises a 23503 that the best-effort .catch() would silently swallow,
    // dropping the audit trail for exactly the programmatic money ops that need it.
    // Mirror the money-op controllers: actorId null, key id preserved in metadata.
    const apiKeyId = principal?.apiKeyAuth ? principal.userId : null;

    const write = (result: unknown, outcome: 'success' | 'error', err?: unknown) => {
      const entityId = pickPath(result, req, meta.idFrom) ?? null;
      const companyId = pickPath(result, req, meta.companyIdFrom) ?? principal?.companyId ?? null;
      const metadata: Record<string, unknown> = {
        method: req.method,
        path: req.originalUrl,
        outcome,
      };
      if (apiKeyId) metadata.apiKeyId = apiKeyId;
      if (outcome === 'error') {
        metadata.error = err instanceof Error ? err.message : String(err);
        const status = (err as { status?: number } | undefined)?.status;
        if (typeof status === 'number') metadata.status = status;
      }
      // Field-level before→after diff, if the handler published one via
      // `recordAuditChanges` — the interceptor sees the body and the result but
      // never the previous values, so only the service that loaded them can
      // supply this. Producers publish post-commit, so a diff present on an
      // 'error' outcome is the truthful reading: the write landed and a later
      // step failed. Absent diff writes NO `changes` key, leaving rows from
      // routes that haven't adopted it byte-identical to before.
      if (req.auditChanges && Object.keys(req.auditChanges).length > 0) {
        metadata.changes = req.auditChanges;
      }
      this.audit
        .record({
          actorId: apiKeyId ? null : (principal?.userId ?? null),
          companyId,
          action: meta.action,
          entityType: meta.entityType,
          entityId,
          metadata,
          ipAddress: ip,
          userAgent,
        })
        .catch((e) => this.logger.warn(`audit write failed: ${e}`));
    };

    // Audit the happy path AND failures (denied/conflicting/rejected money
    // actions). `tap`'s error callback observes without swallowing, so the
    // original error still propagates to the exception filter unchanged.
    return next.handle().pipe(
      tap({
        next: (result) => write(result, 'success'),
        error: (err) => write(undefined, 'error', err),
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
