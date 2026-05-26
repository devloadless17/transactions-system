import { SetMetadata } from '@nestjs/common';

export const AUDIT_METADATA_KEY = 'audit';

/**
 * How to extract an entity id from the response or request.
 *   - 'result.id'      — top-level `id` on the JSON response
 *   - 'result.company.id' — nested
 *   - 'params.id'      — read from req.params
 */
export type AuditIdFrom = string;

export interface AuditMetadata {
  action: string;
  entityType: string;
  idFrom?: AuditIdFrom;
  // When the response is a wrapping object (e.g. CreateCompanyResponse),
  // identify the company id from a specific path. Defaults to
  // principal.companyId for tenant-scoped routes.
  companyIdFrom?: AuditIdFrom;
}

/**
 * Mark a route handler for audit logging. The AuditInterceptor reads
 * this metadata after the handler returns and writes a row.
 */
export const Audited = (metadata: AuditMetadata) => SetMetadata(AUDIT_METADATA_KEY, metadata);
