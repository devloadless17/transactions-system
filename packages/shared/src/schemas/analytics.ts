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
  totalFees: z.string(),
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

export const overviewResponseSchema = z.object({
  range: z.object({ from: z.string(), to: z.string() }),
  currency: z.string(),
  kpi: kpiResponseSchema,
  daily: dailySeriesResponseSchema,
  topSources: z.array(topSourceSchema),
  topCompanies: z.array(topCompanySchema).optional(),
});
export type OverviewResponse = z.infer<typeof overviewResponseSchema>;
