import { z } from 'zod';

// =================================================================
// CRM integration contract.
//
// We make an outbound HTTP POST to a company's own CRM endpoint for each
// transaction's status lifecycle. The company authenticates us with their API
// key (sent as `Authorization: Bearer <key>`). The CRM matches records by the
// stable `reference` and upserts, so one logical transaction visibly moves
// PENDING → COMPLETED (and FAILED / EXPIRED / REVERSED).
// =================================================================

export const CRM_EVENT_TYPES = [
  'transaction.pending',
  'transaction.completed',
  'transaction.failed',
  'transaction.expired',
  'transaction.reversed',
] as const;
export const crmEventTypeSchema = z.enum(CRM_EVENT_TYPES);
export type CrmEventType = z.infer<typeof crmEventTypeSchema>;

export const CRM_TRANSACTION_STATUSES = [
  'PENDING',
  'COMPLETED',
  'FAILED',
  'EXPIRED',
  'REVERSED',
] as const;
export const crmTransactionStatusSchema = z.enum(CRM_TRANSACTION_STATUSES);
export type CrmTransactionStatus = z.infer<typeof crmTransactionStatusSchema>;

// The transaction body inside a CRM event. `id` is null while a Whish link is
// still PENDING (no ledger transaction exists yet). `netAmount`/`commissionAmount`
// are present once the platform fee is known (i.e. once COMPLETED).
export const crmEventTransactionSchema = z.object({
  id: z.string().uuid().nullable(),
  status: crmTransactionStatusSchema,
  source: z.string(),
  externalTransactionId: z.string(),
  amount: z.string(),
  currency: z.string(),
  netAmount: z.string().nullable(),
  commissionAmount: z.string().nullable(),
  customer: z.string().nullable(),
  target: z.string().nullable(),
  phone: z.string().nullable(),
  note: z.string().nullable(),
  occurredAt: z.string(),
});
export type CrmEventTransaction = z.infer<typeof crmEventTransactionSchema>;

// The exact JSON body we POST to the company's CRM (and to the demo inbox).
export const crmEventPayloadSchema = z.object({
  event: crmEventTypeSchema,
  reference: z.string(),
  sentAt: z.string(),
  transaction: crmEventTransactionSchema,
});
export type CrmEventPayload = z.infer<typeof crmEventPayloadSchema>;

// ----- Company-managed config -----

export const setCrmConfigSchema = z.object({
  apiUrl: z.string().url(),
  apiKey: z.string().trim().min(1).max(200),
});
export type SetCrmConfigInput = z.infer<typeof setCrmConfigSchema>;

export const crmConfigResponseSchema = z.object({
  apiUrl: z.string().nullable(),
  hasApiKey: z.boolean(),
  enabled: z.boolean(),
  // When the demo CRM is in use, the public inbox URL we POST to (the company's
  // apiUrl points here). Null when it hasn't been enabled.
  demoUrl: z.string().nullable(),
});
export type CrmConfigResponse = z.infer<typeof crmConfigResponseSchema>;

// ----- Demo inbox feed (what the preview page renders) -----

export const crmDemoEventResponseSchema = z.object({
  reference: z.string(),
  event: crmEventTypeSchema,
  status: crmTransactionStatusSchema,
  transaction: crmEventTransactionSchema,
  receivedAt: z.string(),
});
export type CrmDemoEventResponse = z.infer<typeof crmDemoEventResponseSchema>;
