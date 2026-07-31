import { z } from 'zod';
import { ActivityDirection, ActivityKind } from '../enums';
import { currencySchema } from './common';

// One row in the unified activity feed — a single COMPLETED money operation
// (deposit, load, withdrawal, or payout) normalised to a common shape so the
// four sibling tables can be shown in one chronological list.
export const activityItemSchema = z.object({
  id: z.string().uuid(),
  kind: z.nativeEnum(ActivityKind),
  direction: z.nativeEnum(ActivityDirection),
  // Gross amount — the money that actually moves (net + fee); matches
  // totalAmount on the flow resources. Always amount = fee + net.
  amount: z.string(),
  currency: z.string(),
  fee: z.string(),
  net: z.string(),
  // Human label: source code (deposits) or payout method (withdrawal/payout/load).
  description: z.string(),
  // Counterparty / recipient detail (customer, phone, masked account, …), if any.
  details: z.string().nullable(),
  // External reference: externalTransactionId (deposit) or externalReference (w/p/l).
  reference: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  // Admin scope only — null on the company feed.
  companyId: z.string().uuid().nullable(),
  companyName: z.string().nullable(),
  // Running wallet (available) balance after this operation. Only populated in
  // "balance mode" (single currency, no kind/direction/search filter); null otherwise.
  balanceAfter: z.string().nullable(),
});
export type ActivityItem = z.infer<typeof activityItemSchema>;

export const listActivityQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  direction: z.nativeEnum(ActivityDirection).optional(),
  kind: z.nativeEnum(ActivityKind).optional(),
  currency: currencySchema.optional(),
  // Admin-only: filter by company.
  companyId: z.string().uuid().optional(),
  // ISO date strings — filter by createdAt.
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  // Fuzzy match on reference / description / details.
  search: z.string().trim().max(200).optional(),
});
export type ListActivityQuery = z.infer<typeof listActivityQuerySchema>;

// Paginated activity, plus whether the running-balance column is populated.
export type ActivityListResponse = {
  data: ActivityItem[];
  meta: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
    balanceMode: boolean;
  };
};
