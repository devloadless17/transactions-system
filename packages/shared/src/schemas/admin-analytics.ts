import { z } from 'zod';
import { assertSaneDateRange, currencySchema } from './common';
import { topSourceSchema } from './analytics';

// ---------------- shared range ----------------
// Plain shape kept separate so derived schemas (flows) can reuse the fields;
// `.superRefine` returns a ZodEffects which is not `.extend`-able.
const dateRangeShape = {
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
};
export const adminAnalyticsRangeSchema = z.object(dateRangeShape).superRefine(assertSaneDateRange);
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
  // What upstream sources (e.g. Whish) charge the PLATFORM on this currency's
  // deposits — the platform's cost of funds. Computed per-deposit from each
  // source's fee schedule. Admin/system-only; never shown to companies.
  sourceFees: z.string(),
  // The platform's real take-home: feesEarned − sourceFees. Admin/system-only.
  netRevenue: z.string(),
  volumeOut: z.string(),
  netHeld: z.string(), // wallet total still parked in the platform (sum of available + pending + reserved)
  ingestCount: z.number().int(), // completed transaction (ingestion) count
  withdrawalCount: z.number().int(), // completed withdrawal count
});
export type CurrencyRollup = z.infer<typeof currencyRollupSchema>;

// What a single source charged the platform on its deposits in one currency over
// the range — drives the per-source "fees paid to <source>" breakdown card.
export const sourceFeeBreakdownSchema = z.object({
  sourceId: z.string().uuid(),
  sourceCode: z.string(),
  sourceName: z.string(),
  currency: z.string(),
  fees: z.string(),
});
export type SourceFeeBreakdown = z.infer<typeof sourceFeeBreakdownSchema>;

export const platformAnalyticsResponseSchema = z.object({
  range: z.object({ from: z.string(), to: z.string() }),
  byCurrency: z.array(currencyRollupSchema),
  // Per-source cost breakdown across every currency (e.g. "Whish · USD · $123").
  sourceFeeBreakdown: z.array(sourceFeeBreakdownSchema),
});
export type PlatformAnalyticsResponse = z.infer<typeof platformAnalyticsResponseSchema>;

// ---------------- flows: daily in vs out per currency ----------------
export const flowsRangeSchema = z
  .object({
    ...dateRangeShape,
    // Use the supported-currency enum (like every other money path) so an
    // unsupported code returns a clean 400 instead of an empty chart.
    currency: currencySchema,
  })
  .superRefine(assertSaneDateRange);
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
  // Top sources by volume for THIS currency+window. Carried here (the per-currency
  // endpoint the admin overview already fetches) so the admin dashboard's
  // "By source" tile doesn't need the heavy full overview() compute just for this.
  topSources: z.array(topSourceSchema),
});
export type FlowsResponse = z.infer<typeof flowsResponseSchema>;

// ---------------- operations queue ----------------
export const opsItemSchema = z.object({
  kind: z.enum(['withdrawal_pending', 'payout_pending', 'load_pending', 'transaction_reversed']),
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
  // Pending payouts and loads also reserve funds / await an operator. Counted
  // separately so the dashboard can show a combined "pending actions" total and
  // never reads "all clear" while payouts/loads sit in PENDING.
  pendingPayoutsCount: z.number().int(),
  pendingLoadsCount: z.number().int(),
  pendingWithdrawalsValue: z.record(z.string()), // { currency: amount } map
  recentReversalsCount: z.number().int(),
  items: z.array(opsItemSchema),
});
export type OperationsResponse = z.infer<typeof operationsResponseSchema>;
