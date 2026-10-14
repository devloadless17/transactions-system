import { z } from 'zod';

// Live count of PENDING (needs-action) requests per money flow. Powers the
// sidebar request badges. The admin side reuses the analytics operations
// endpoint (OperationsResponse); this is the company-scoped equivalent
// returned by GET /company/operations/counts.
export const pendingCountsSchema = z.object({
  withdrawals: z.number().int(),
  payouts: z.number().int(),
  loads: z.number().int(),
});
export type PendingCounts = z.infer<typeof pendingCountsSchema>;

// Money a person must look at now (admin only — GET /admin/operations/attention).
// Not part of the company API: PendingCounts above is, so it keeps its shape.
// - stuckWithdrawals: withdrawals held in PROCESSING — a Whish transfer whose
//   outcome is unknown, or one that has not finished within minutes. The money
//   stays reserved until someone decides.
// - whishNeedsAttention: Whish Pay payments a customer paid that did not reach
//   the company's wallet (settlement needs a person).
// `oldestAt` (ISO) is when the oldest of them started, null when count is 0.
const attentionItemSchema = z.object({
  count: z.number().int(),
  oldestAt: z.string().nullable(),
});
export const adminAttentionSchema = z.object({
  stuckWithdrawals: attentionItemSchema,
  whishNeedsAttention: attentionItemSchema,
});
export type AdminAttention = z.infer<typeof adminAttentionSchema>;
