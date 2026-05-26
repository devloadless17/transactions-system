import { z } from 'zod';

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
