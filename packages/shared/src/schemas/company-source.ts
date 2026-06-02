import { z } from 'zod';

// Admin-managed opt-in linking a company to a source. A SOURCE API key may only
// ingest transactions for companies that have an enabled pairing with its source.
export const setCompanySourceSchema = z.object({
  companyId: z.string().uuid(),
  enabled: z.boolean().default(true),
});
export type SetCompanySourceInput = z.infer<typeof setCompanySourceSchema>;

export const companySourceResponseSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  companyName: z.string().nullable(),
  companySlug: z.string().nullable(),
  sourceId: z.string().uuid(),
  enabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CompanySourceResponse = z.infer<typeof companySourceResponseSchema>;
