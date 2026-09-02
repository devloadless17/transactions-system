import { z } from 'zod';

/**
 * A field-level before→after diff carried in an audit row's `metadata.changes`,
 * so `company.updated` says WHICH fields changed rather than just that something did.
 *
 * Values are JSON SCALARS only, and that is deliberate rather than incidental:
 * `z.unknown()` would let a whole entity row type-check into an audit row, and on
 * `companies` that row carries `webhookSecret` / `crmApiKey` / `crmDemoToken`
 * beside `name` — in a table ADMIN_OPERATOR can read. Producers must also pass an
 * explicit field allowlist; see `diffFields` / `recordAuditChanges` in the API.
 */
const auditScalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
export const auditChangeSchema = z.object({
  from: auditScalarSchema,
  to: auditScalarSchema,
});
export const auditChangesSchema = z.record(auditChangeSchema);
export type AuditChanges = z.infer<typeof auditChangesSchema>;

/**
 * Narrow an audit row's untyped `metadata` to its change map, or null when the
 * row carries none — which is every row written before this existed, and every
 * route that hasn't adopted it.
 */
export function auditChangesOf(
  metadata: Record<string, unknown> | null | undefined,
): AuditChanges | null {
  const parsed = auditChangesSchema.safeParse((metadata as { changes?: unknown } | null)?.changes);
  return parsed.success && Object.keys(parsed.data).length > 0 ? parsed.data : null;
}

export const auditLogResponseSchema = z.object({
  id: z.string().uuid(),
  actorId: z.string().uuid().nullable(),
  actorEmail: z.string().nullable(),
  companyId: z.string().uuid().nullable(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string().nullable(),
  metadata: z.record(z.unknown()).nullable(),
  ipAddress: z.string().nullable(),
  createdAt: z.string(),
});
export type AuditLogResponse = z.infer<typeof auditLogResponseSchema>;

export const listAuditLogsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  companyId: z.string().uuid().optional(),
  entityType: z.string().trim().optional(),
  action: z.string().trim().optional(),
});
export type ListAuditLogsQuery = z.infer<typeof listAuditLogsQuerySchema>;
