import type { Request } from 'express';
import type { AuditChanges, UserRole } from '@app/shared';

export interface AuthPrincipal {
  userId: string;
  email: string;
  role: UserRole;
  companyId: string | null;
  // Set only when the principal was authenticated via a SOURCE API key.
  // Source keys post on behalf of an external provider (OMT, wish, ...).
  sourceId?: string | null;
  // Set when authenticated via a COMPANY API key (no real user row exists).
  // Services that write requestedById should pass null when this is true.
  apiKeyAuth?: true;
}

export interface AuthenticatedRequest extends Request {
  principal: AuthPrincipal;
  // Set to true by CompanyAccessGuard when the request was authenticated via a
  // company API key. CsrfGuard reads this to skip the double-submit check —
  // API keys are not susceptible to CSRF so the check is unnecessary.
  apiKeyAuth?: true;
  // Set by IngestController once the companySlug in the body has been resolved
  // to a company UUID. IngestLogInterceptor reads it to fill the UUID-typed
  // transaction_logs.company_id column — the body itself only carries the slug.
  ingestCompanyId?: string;
  // Field-level before→after diff published by a handler for THIS request;
  // AuditInterceptor merges it into the audit row's `metadata.changes`. The
  // interceptor can only see the request body and the result, never the
  // previous values, so the service that loaded them has to hand them over.
  // Publish through `recordAuditChanges` (modules/audit/audit-changes.ts): it
  // enforces the scalar/allowlist rules, and producers must call it only AFTER
  // the write commits.
  auditChanges?: AuditChanges;
}
