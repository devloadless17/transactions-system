import { z } from 'zod';

// =================================================================
// Super-admin transaction request/response logs.
//
// Two entry points are logged so the super admin can see exactly what came in
// and what we answered:
//   WHISH_LINK — a Whish payment-link generation (request we sent + Whish reply)
//   INGEST     — a source ingest call (request body + the response we returned,
//                including rejected/4xx attempts)
// =================================================================

export const TRANSACTION_LOG_KINDS = ['WHISH_LINK', 'INGEST'] as const;
export const transactionLogKindSchema = z.enum(TRANSACTION_LOG_KINDS);
export type TransactionLogKind = z.infer<typeof transactionLogKindSchema>;

// One log row. `request`/`response` carry the raw bodies (rendered in a detail
// drawer); they're small for these flows so we return them inline.
export const transactionLogResponseSchema = z.object({
  id: z.string().uuid(),
  kind: transactionLogKindSchema,
  companyId: z.string().uuid().nullable(),
  sourceCode: z.string().nullable(),
  // externalTransactionId (INGEST) or the Whish externalId (WHISH_LINK).
  reference: z.string().nullable(),
  transactionId: z.string().uuid().nullable(),
  statusCode: z.number().int(),
  success: z.boolean(),
  request: z.unknown(),
  response: z.unknown(),
  createdAt: z.string(),
});
export type TransactionLogResponse = z.infer<typeof transactionLogResponseSchema>;

export const listTransactionLogsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  kind: transactionLogKindSchema.optional(),
  companyId: z.string().uuid().optional(),
  // Query strings are text: the service maps "true"/"false" → boolean. (Kept as
  // a plain enum, not a transform, so ZodPipe's input===output typing holds.)
  success: z.enum(['true', 'false']).optional(),
  // Fuzzy match on `reference`. Bounded like every other string filter.
  search: z.string().trim().max(200).optional(),
});
export type ListTransactionLogsQuery = z.infer<typeof listTransactionLogsQuerySchema>;
