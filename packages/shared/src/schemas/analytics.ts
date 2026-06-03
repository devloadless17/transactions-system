import { z } from 'zod';
import { currencySchema } from './common';

export const analyticsRangeSchema = z.object({
  // ISO date strings. Defaults to last 30 days when omitted.
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  // Optional admin filter.
  companyId: z.string().uuid().optional(),
  currency: currencySchema.optional(),
});
export type AnalyticsRange = z.infer<typeof analyticsRangeSchema>;

export const kpiResponseSchema = z.object({
  totalVolume: z.string(),
  // Aggregate platform commission. Omitted on company-scoped responses: a
  // company sees the fee on each individual transaction, never a running
  // total (that figure is the platform's revenue, for admins only).
  totalFees: z.string().optional(),
  transactionCount: z.number().int(),
  averageAmount: z.string(),
  currency: z.string(),
});
export type KpiResponse = z.infer<typeof kpiResponseSchema>;

export const dailyBucketSchema = z.object({
  date: z.string(), // YYYY-MM-DD
  volume: z.string(),
  fees: z.string(),
  count: z.number().int(),
});
export type DailyBucket = z.infer<typeof dailyBucketSchema>;

export const dailySeriesResponseSchema = z.object({
  currency: z.string(),
  buckets: z.array(dailyBucketSchema),
});
export type DailySeriesResponse = z.infer<typeof dailySeriesResponseSchema>;

export const topSourceSchema = z.object({
  sourceId: z.string().uuid(),
  sourceCode: z.string(),
  volume: z.string(),
  fees: z.string(),
  count: z.number().int(),
});
export type TopSource = z.infer<typeof topSourceSchema>;

export const topCompanySchema = z.object({
  companyId: z.string().uuid(),
  companyName: z.string(),
  volume: z.string(),
  count: z.number().int(),
});
export type TopCompany = z.infer<typeof topCompanySchema>;

// One operation type's volume: settled (COMPLETED) money plus what's still
// in-flight (awaiting approval / processing). Amounts are Decimal strings.
export const volumeMetricSchema = z.object({
  completedTotal: z.string(),
  // Of the completed total: how much actually moved to/from the external party
  // (net) vs. the platform's fee. completedTotal = completedNet + completedFees
  // for DEDUCTED fees; for ON_TOP the fee is charged on top (net == total). The
  // sum of completedFees across all flow types equals the platform's revenue.
  completedNet: z.string(),
  completedFees: z.string(),
  completedCount: z.number().int(),
  pendingTotal: z.string(),
  pendingCount: z.number().int(),
});
export type VolumeMetric = z.infer<typeof volumeMetricSchema>;

// Money movement broken out by operation type so a company sees deposits
// (source ingestion), withdrawals, loads, and payouts side by side.
export const volumeBreakdownSchema = z.object({
  deposits: volumeMetricSchema,
  withdrawals: volumeMetricSchema,
  loads: volumeMetricSchema,
  payouts: volumeMetricSchema,
});
export type VolumeBreakdown = z.infer<typeof volumeBreakdownSchema>;

export const overviewResponseSchema = z.object({
  range: z.object({ from: z.string(), to: z.string() }),
  currency: z.string(),
  kpi: kpiResponseSchema,
  volume: volumeBreakdownSchema,
  daily: dailySeriesResponseSchema,
  topSources: z.array(topSourceSchema),
  topCompanies: z.array(topCompanySchema).optional(),
});
export type OverviewResponse = z.infer<typeof overviewResponseSchema>;

// One company's activity through a single source. Used by the admin
// source-detail drilldown ("by source, each company").
export const sourceCompanyBreakdownSchema = z.object({
  companyId: z.string().uuid(),
  companyName: z.string(),
  volume: z.string(),
  fees: z.string(),
  count: z.number().int(),
});
export type SourceCompanyBreakdown = z.infer<typeof sourceCompanyBreakdownSchema>;

// Wallet reconciliation for a company, per currency. The company dashboard
// shows these as cards so the math is self-evident:
//   deposits.net + loads.net - withdrawals.total - payouts.total = wallet available
// In-flows (deposits, loads) count COMPLETED only (money lands on settlement).
// Out-flows (withdrawals, payouts) count COMPLETED + in-flight, because the
// funds are reserved out of `available` the moment the request is made. `total`
// is net + fee (what actually leaves the wallet); `gross` is net + fee on the
// in-flow side too, so gross - net is the (unshown) fee.
//
// from/to scope the cards to a date window (by request time) so the dashboard's
// range picker drives them. The identity above holds exactly only for an
// all-time window — the live wallet balance tile is always all-time, by design.
export const walletSummaryQuerySchema = z.object({
  currency: currencySchema.optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
export type WalletSummaryQuery = z.infer<typeof walletSummaryQuerySchema>;

export const walletSummaryResponseSchema = z.object({
  currency: z.string(),
  deposits: z.object({ gross: z.string(), net: z.string() }),
  loads: z.object({ gross: z.string(), net: z.string() }),
  withdrawals: z.object({ total: z.string() }),
  payouts: z.object({ total: z.string() }),
});
export type WalletSummaryResponse = z.infer<typeof walletSummaryResponseSchema>;

export const sourceOverviewResponseSchema = z.object({
  range: z.object({ from: z.string(), to: z.string() }),
  currency: z.string(),
  source: z.object({
    id: z.string().uuid(),
    code: z.string(),
    name: z.string(),
  }),
  kpi: kpiResponseSchema,
  daily: dailySeriesResponseSchema,
  // Every company that transacted through this source in the range, by volume.
  byCompany: z.array(sourceCompanyBreakdownSchema),
});
export type SourceOverviewResponse = z.infer<typeof sourceOverviewResponseSchema>;
