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
