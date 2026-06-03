import { z } from 'zod';
import { SUPPORTED_CURRENCIES } from '../enums';

export const uuidSchema = z.string().uuid();

export const currencySchema = z.enum(SUPPORTED_CURRENCIES);

/**
 * A money amount as a decimal STRING (never a float). Bounded to the ledger's
 * scale — at most 8 fractional digits — and 12 integer digits, matching the
 * Decimal(20,8) DB columns, so out-of-range garbage is rejected at the edge
 * instead of relying on downstream rounding / DB CHECKs. Shared by every flow
 * (transaction / withdrawal / payout / load / whish) so the rule lives once.
 */
export const moneyAmountSchema = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'must be a positive decimal')
  .refine((v) => (v.split('.')[1]?.length ?? 0) <= 8, 'at most 8 decimal places')
  .refine((v) => v.split('.')[0]!.length <= 12, 'amount is too large');

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type Pagination = z.infer<typeof paginationSchema>;

export const paginatedResponseSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({
    data: z.array(item),
    meta: z.object({
      page: z.number().int(),
      pageSize: z.number().int(),
      total: z.number().int(),
      totalPages: z.number().int(),
    }),
  });

export type PaginatedResponse<T> = {
  data: T[];
  meta: { page: number; pageSize: number; total: number; totalPages: number };
};
