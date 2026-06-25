import { z } from 'zod';

// =================================================================
// CRM integration contract.
//
// We make an outbound HTTP POST to a company's own CRM endpoint for each money
// event's status lifecycle. The company authenticates us with their API key
// (sent as `Authorization: Bearer <key>`). The CRM matches records by the
// stable `reference` and upserts, so one logical record visibly moves through
// its lifecycle in place.
//
// Two event families, each carrying a differently-shaped body:
//   • transaction.*  — deposits (Whish Pay + source ingest). Body: `transaction`.
//                      PENDING → COMPLETED (or FAILED / EXPIRED / REVERSED).
//   • withdrawal.*   — withdrawals, i.e. money out. Body: `withdrawal`.
//                      PENDING → COMPLETED / REJECTED / CANCELLED.
// Payouts and loads are intentionally NOT pushed to the CRM — those flows are
// managed over the REST API only.
// =================================================================

export const CRM_EVENT_TYPES = [
  'transaction.pending',
  'transaction.completed',
  'transaction.failed',
  'transaction.expired',
  'transaction.reversed',
  'withdrawal.pending',
  'withdrawal.completed',
  'withdrawal.rejected',
  'withdrawal.cancelled',
] as const;
export const crmEventTypeSchema = z.enum(CRM_EVENT_TYPES);
export type CrmEventType = z.infer<typeof crmEventTypeSchema>;

// The two event families, split by the body they carry.
export type CrmTransactionEvent = Extract<CrmEventType, `transaction.${string}`>;
export type CrmWithdrawalEvent = Extract<CrmEventType, `withdrawal.${string}`>;

export const CRM_TRANSACTION_STATUSES = [
  'PENDING',
  'COMPLETED',
  'FAILED',
  'EXPIRED',
  'REVERSED',
] as const;
export const crmTransactionStatusSchema = z.enum(CRM_TRANSACTION_STATUSES);
export type CrmTransactionStatus = z.infer<typeof crmTransactionStatusSchema>;

// Withdrawal lifecycle statuses (money out). REJECTED = an admin declined the
// request; CANCELLED = the company withdrew its own still-pending request.
export const CRM_WITHDRAWAL_STATUSES = ['PENDING', 'COMPLETED', 'REJECTED', 'CANCELLED'] as const;
export const crmWithdrawalStatusSchema = z.enum(CRM_WITHDRAWAL_STATUSES);
export type CrmWithdrawalStatus = z.infer<typeof crmWithdrawalStatusSchema>;

// Every status any CRM event can carry — the union of both families. Used by the
// demo inbox feed, which lists events of either kind side by side.
export const CRM_EVENT_STATUSES = [
  'PENDING',
  'COMPLETED',
  'FAILED',
  'EXPIRED',
  'REVERSED',
  'REJECTED',
  'CANCELLED',
] as const;
export const crmEventStatusSchema = z.enum(CRM_EVENT_STATUSES);
export type CrmEventStatus = z.infer<typeof crmEventStatusSchema>;

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
  tradingAccount: z.string().nullable(),
  phone: z.string().nullable(),
  note: z.string().nullable(),
  occurredAt: z.string(),
});
export type CrmEventTransaction = z.infer<typeof crmEventTransactionSchema>;

// The withdrawal body inside a `withdrawal.*` CRM event. Mirrors the withdrawal
// REST resource (GET /company/withdrawals/:id) field-for-field so the webhook
// and the API speak the same language. Money is shown three consistent ways:
//   totalAmount = what left your wallet,  feeAmount = the platform fee we charged,
//   netAmount   = what the recipient gets   (totalAmount − feeAmount = netAmount).
export const crmEventWithdrawalSchema = z.object({
  id: z.string().uuid(),
  status: crmWithdrawalStatusSchema,
  totalAmount: z.string(),
  feeAmount: z.string(),
  netAmount: z.string(),
  currency: z.string(),
  payoutMethod: z.string(),
  // A human label for the destination — recipient name, account holder, or
  // wallet address, depending on the method. Null when none applies.
  recipient: z.string().nullable(),
  // Your off-platform proof the money moved (wire id, tx hash, receipt…). Set
  // once the withdrawal is COMPLETED; null beforehand.
  externalReference: z.string().nullable(),
  // The company's own request note (set once, immutable).
  note: z.string().nullable(),
  // The admin's note — e.g. the reason a request was REJECTED. Kept separate so
  // neither note overwrites the other.
  adminNote: z.string().nullable(),
  occurredAt: z.string(),
});
export type CrmEventWithdrawal = z.infer<typeof crmEventWithdrawalSchema>;

// The exact JSON body we POST to the company's CRM (and to the demo inbox).
// Exactly ONE of `transaction` / `withdrawal` is present, selected by the event
// family: `transaction.*` carries `transaction`, `withdrawal.*` carries
// `withdrawal`. (Modeled as two optional fields rather than a discriminated
// union so a single CRM endpoint can validate every event with this one schema.)
export const crmEventPayloadSchema = z
  .object({
    event: crmEventTypeSchema,
    reference: z.string(),
    sentAt: z.string(),
    transaction: crmEventTransactionSchema.optional(),
    withdrawal: crmEventWithdrawalSchema.optional(),
  })
  .refine((p) => (p.transaction ? 1 : 0) + (p.withdrawal ? 1 : 0) === 1, {
    message: 'exactly one of transaction / withdrawal must be present',
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
  status: crmEventStatusSchema,
  // Whichever body the event carried (see crmEventPayloadSchema); the other null.
  transaction: crmEventTransactionSchema.nullable(),
  withdrawal: crmEventWithdrawalSchema.nullable(),
  receivedAt: z.string(),
});
export type CrmDemoEventResponse = z.infer<typeof crmDemoEventResponseSchema>;
