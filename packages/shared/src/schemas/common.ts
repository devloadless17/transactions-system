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

/**
 * The platform-wide response envelope. EVERY JSON API response carries the same
 * top-level shape so any caller (our web app, a source provider, a partner CRM)
 * can branch on `success` and read `statusCode` straight from the body instead
 * of only the HTTP status line.
 *
 *  - Success: `{ success: true, statusCode, data }` — the handler's payload
 *    lives under `data` (for list endpoints that's `{ data: [...], meta }`, so
 *    the array is at `data.data`).
 *  - Error:   `{ success: false, statusCode, error: { code, message, details? } }`
 *
 * `success` is the discriminant: a success body never has `error`, an error
 * body never has `data`. A handful of non-JSON / no-body endpoints are exempt
 * (see @SkipResponseEnvelope on the API side): CSV exports, Prometheus
 * `/metrics`, the health probe, 204 responses, and inbound provider acks.
 */
export type ApiError = {
  code: string;
  message: string;
  details?: unknown;
};

export type ApiSuccessEnvelope<T> = {
  success: true;
  statusCode: number;
  data: T;
};

export type ApiErrorEnvelope = {
  success: false;
  statusCode: number;
  error: ApiError;
};

export type ApiEnvelope<T> = ApiSuccessEnvelope<T> | ApiErrorEnvelope;
