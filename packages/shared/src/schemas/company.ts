import { z } from 'zod';
import { CompanyStatus } from '../enums';
import { currencySchema } from './common';
import { companyScopedCommissionRuleSchema } from './commission';

// slugs: lowercase alphanumeric + dashes, 2-50 chars
const slugRegex = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;

export const createCompanySchema = z.object({
  name: z.string().trim().min(2).max(120),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(slugRegex, 'slug must be 2-50 chars, lowercase, alphanumeric or dashes'),
  defaultCurrency: currencySchema,
  ownerEmail: z.string().email(),
  ownerName: z.string().trim().min(2).max(120).optional(),
  // Optional starter commission rule, created atomically with the company so it
  // can accept (and price) transactions immediately — preventing the "company
  // exists but every ingest fails NO_COMMISSION_RULE" trap. Omit to rely on a
  // global default rule or to configure pricing later on the Commissions page.
  commission: companyScopedCommissionRuleSchema.optional(),
});
export type CreateCompanyInput = z.infer<typeof createCompanySchema>;

export const updateCompanySchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  status: z.nativeEnum(CompanyStatus).optional(),
  visible: z.boolean().optional(),
});
export type UpdateCompanyInput = z.infer<typeof updateCompanySchema>;

export const companyResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  status: z.nativeEnum(CompanyStatus),
  visible: z.boolean(),
  defaultCurrency: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CompanyResponse = z.infer<typeof companyResponseSchema>;

/**
 * A company's wallet balance in one currency. Kept per-currency (rather than a
 * single scalar) because a company may hold a wallet per currency — only USD
 * exists today, but the shape stays correct when more are added.
 */
export const companyBalanceSchema = z.object({
  currency: z.string(),
  availableBalance: z.string(),
});
export type CompanyBalance = z.infer<typeof companyBalanceSchema>;

/**
 * A company row on the admin list. `balances` is present ONLY for SUPER_ADMIN —
 * company money is not visible to ADMIN_OPERATOR or BACKOFFICE, who may see that
 * a tenant exists but not how much it holds. Omitted (not zeroed) otherwise, so
 * a missing field can never be mistaken for an empty wallet.
 */
export const companyListItemSchema = companyResponseSchema.extend({
  balances: z.array(companyBalanceSchema).optional(),
});
export type CompanyListItem = z.infer<typeof companyListItemSchema>;

/**
 * Paginated companies plus `totals` — the summed available balance per currency
 * across EVERY company matching the query, not just the current page. Like
 * `balances`, present only for SUPER_ADMIN.
 */
export type CompanyListResponse = {
  data: CompanyListItem[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
  totals?: CompanyBalance[];
};

export const listCompaniesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  // Opt-in: computing balances costs an extra wallet query, and most callers of
  // this list (e.g. the admin company-name filter) only want names. Asking for
  // it does NOT grant it — a SUPER_ADMIN role is still required.
  // A permissive string (only `'true'` opts in, at the controller) so a stray
  // value like `?withBalances=1` degrades to "no balances" instead of 400-ing
  // the whole list. Kept as a string, not transformed, because ZodPipe requires
  // the schema's input and output types to match.
  withBalances: z.string().optional(),
  search: z.string().trim().optional(),
  status: z.nativeEnum(CompanyStatus).optional(),
  // Comma-separated company ids — resolve names for just the rows on screen
  // (the admin lists fetch only the companies they actually display, instead of
  // pulling the whole company list).
  ids: z.string().trim().optional(),
});
export type ListCompaniesQuery = z.infer<typeof listCompaniesQuerySchema>;

export const createCompanyResponseSchema = z.object({
  company: companyResponseSchema,
  owner: z.object({
    id: z.string().uuid(),
    email: z.string().email(),
    temporaryPassword: z.string(),
  }),
});
export type CreateCompanyResponse = z.infer<typeof createCompanyResponseSchema>;
