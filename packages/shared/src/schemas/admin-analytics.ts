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
  volumeIn: z.string(), // sum of completed transaction amounts
  feesEarned: z.string(), // platform fee revenue
  volumeOut: z.string(), // sum of completed withdrawal amounts
  netHeld: z.string(), // wallet total still parked in the platform (sum of available + pending + reserved)
  ingestCount: z.number().int(),
  withdrawalCount: z.number().int(),
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
  in: z.string(), // ingestion volume that day
  out: z.string(), // withdrawal volume that day
  fees: z.string(), // fees earned that day
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
