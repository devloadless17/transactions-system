import { z } from 'zod';

// ---------------- shared range ----------------
export const adminAnalyticsRangeSchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
export type AdminAnalyticsRange = z.infer<typeof adminAnalyticsRangeSchema>;

// ---------------- platform multi-currency ----------------
export const currencyRollupSchema = z.object({
  currency: z.string(),
  // Money in = every settled in-flow (transaction ingestion + load approvals);
  // money out = every settled out-flow (withdrawal + payout approvals). Both
  // are net + fee (the money that actually moved): summing the raw `amount`
  // column would equal net+fee only for DEDUCTED fees and undercount ON_TOP by
  // the fee. Mirrors the per-company cards and walletSummary.
  volumeIn: z.string(),
  feesEarned: z.string(), // platform fee revenue (FEE ledger, all flows)
  volumeOut: z.string(),
  netHeld: z.string(), // wallet total still parked in the platform (sum of available + pending + reserved)
  ingestCount: z.number().int(), // completed transaction (ingestion) count
  withdrawalCount: z.number().int(), // completed withdrawal count
});
export type CurrencyRollup = z.infer<typeof currencyRollupSchema>;

export const platformAnalyticsResponseSchema = z.object({
  range: z.object({ from: z.string(), to: z.string() }),
  byCurrency: z.array(currencyRollupSchema),
});
export type PlatformAnalyticsResponse = z.infer<typeof platformAnalyticsResponseSchema>;

// ---------------- flows: daily in vs out per currency ----------------
export const flowsRangeSchema = adminAnalyticsRangeSchema.extend({
  currency: z.string().length(3),
});
export type FlowsRange = z.infer<typeof flowsRangeSchema>;

export const flowsBucketSchema = z.object({
  date: z.string(),
  in: z.string(), // money in that day (transactions + loads), net + fee
  out: z.string(), // money out that day (withdrawals + payouts), net + fee
  fees: z.string(), // fees earned that day (FEE ledger, all flows)
});
export type FlowsBucket = z.infer<typeof flowsBucketSchema>;

export const flowsResponseSchema = z.object({
  currency: z.string(),
  range: z.object({ from: z.string(), to: z.string() }),
  buckets: z.array(flowsBucketSchema),
});
export type FlowsResponse = z.infer<typeof flowsResponseSchema>;

// ---------------- operations queue ----------------
export const opsItemSchema = z.object({
  kind: z.enum(['withdrawal_pending', 'transaction_reversed']),
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  companyName: z.string(),
  summary: z.string(),
  amount: z.string().nullable(),
  currency: z.string().nullable(),
  createdAt: z.string(),
});
export type OpsItem = z.infer<typeof opsItemSchema>;

export const operationsResponseSchema = z.object({
  pendingWithdrawalsCount: z.number().int(),
  pendingWithdrawalsValue: z.record(z.string()), // { currency: amount } map
  recentReversalsCount: z.number().int(),
  items: z.array(opsItemSchema),
});
export type OperationsResponse = z.infer<typeof operationsResponseSchema>;
