import { z } from 'zod';
import { SUPPORTED_CURRENCIES } from '../enums';
import { MONEY_SCALE, Money } from '../money';

export const uuidSchema = z.string().uuid();

export const currencySchema = z.enum(SUPPORTED_CURRENCIES);

/** Max fraction digits a money AMOUNT may carry on the wire. Mirrors MONEY_SCALE. */
export const MONEY_INPUT_DP = MONEY_SCALE;

/**
 * Max fraction digits a RATE may carry. A rate is not money: it is only ever
 * multiplied by an amount, and the PRODUCT is quantized at the compute site, so
 * keeping it precise costs nothing and lets a source price at 0.125%.
 */
export const RATE_INPUT_DP = 8;

const decimalStringBase = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'must be a positive decimal')
  .refine((v) => v.split('.')[0]!.length <= 12, 'amount is too large');

const fractionDigits = (v: string): number => v.split('.')[1]?.length ?? 0;

/**
 * True when `v` is a decimal string `Money.of` can parse. zod keeps running
 * object-level refinements after a field's OWN check has failed (the value is
 * "dirty", not aborted), so a refinement that calls `Money.of` on a malformed
 * value would throw a DecimalError — a 500 — instead of failing validation with
 * a 400. Every such refinement guards with this first; the field's own error
 * already reports the bad value.
 */
export function isDecimalString(v: unknown): v is string {
  return typeof v === 'string' && /^\d+(\.\d+)?$/.test(v);
}

/**
 * A money amount as a decimal STRING (never a float). Bounded to the platform
 * money scale — at most 2 fractional digits, i.e. whole cents — and 12 integer
 * digits. Shared by every flow (transaction / withdrawal / payout / load /
 * whish) so the rule lives once.
 *
 * NOTE this is the strict form, used where a human is at a keyboard (admin
 * config). Money-MOVING surfaces do NOT reject a sub-cent amount — see
 * `quantizeAmountInput`: refusing a deposit that already happened upstream, or a
 * payment a provider is willing to collect, strands real money.
 */
export const moneyAmountSchema = decimalStringBase.refine(
  (v) => fractionDigits(v) <= MONEY_INPUT_DP,
  `at most ${MONEY_INPUT_DP} decimal places`,
);

/** A percentage rate as a decimal string — precise, because it is not money. */
export const rateStringSchema = decimalStringBase.refine(
  (v) => fractionDigits(v) <= RATE_INPUT_DP,
  `at most ${RATE_INPUT_DP} decimal places`,
);

/**
 * A money amount on a MONEY-MOVING surface: accepted even when it carries more
 * precision than the platform scale, then quantized ONCE here so everything
 * downstream derives from a single at-scale figure.
 *
 * Why accept rather than reject:
 *   - Source ingest: the deposit already happened at the provider. A 400 strands
 *     real money and the source cannot redeploy on our schedule.
 *   - Whish collect: the payer has already paid, and Whish accepts amounts its
 *     own docs discourage — we must never be stricter than the payment provider.
 *   - Money-OUT (withdrawal / payout): accepted, but rounded DOWN, because we
 *     must never move more money than was actually requested.
 *
 * `direction` picks the rounding: 'in' uses banker's rounding (no systematic
 * bias on money we receive), 'out' floors (never overpay).
 */
export const quantizedAmountSchema = (direction: 'in' | 'out' = 'in') =>
  decimalStringBase.transform((v) => {
    const m = Money.of(v);
    return (direction === 'out' ? m.floorToScale() : m.round()).toString();
  });

/**
 * Reject an inverted or absurdly-wide date range before any per-day bucket loop
 * or unindexed aggregate runs. Shared by the analytics range schemas, whose
 * endpoints are throttle-exempt — so an unbounded range would otherwise be a
 * cheap way to force a huge scan + bucket array. `.datetime()` has already
 * validated the string format upstream, so a parse failure here just no-ops.
 *
 * This cap governs EXPLICIT custom ranges only, and deliberately stays that way.
 * `preset=all` is a disjoint axis (see `analyticsPresetShape`): it carries no
 * bounds at all, so this refinement never sees it and cannot be weakened by it.
 * That path is bounded differently — by server-derived origins the client can't
 * influence, adaptive bucket granularity, the shared cache, and a statement
 * timeout. A sentinel like `from=1970-01-01` would instead have forced a magic
 * timestamp exception right here, which is exactly what this must never grow.
 */
export function assertSaneDateRange(r: { from?: string; to?: string }, ctx: z.RefinementCtx): void {
  if (!r.from || !r.to) return;
  const from = Date.parse(r.from);
  const to = Date.parse(r.to);
  if (Number.isNaN(from) || Number.isNaN(to)) return;
  if (to < from) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['to'],
      message: 'to must be on or after from',
    });
  } else if (to - from > 366 * 24 * 3600 * 1000) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['to'],
      message: 'date range must not exceed 366 days',
    });
  }
}

/**
 * Opt out of the default 30-day analytics window and report on everything.
 *
 * A separate field rather than a wide `from`/`to` because the analytics
 * endpoints cap explicit ranges at 366 days (`assertSaneDateRange`) — this asks
 * the server to resolve the lower bound itself (the company's, source's, or the
 * platform's creation date) and to widen the bucket accordingly.
 *
 * Only the ANALYTICS schemas carry it. List endpoints (transactions, ledger,
 * activity, withdrawals, …) apply no default window at all, so for them "all
 * time" is simply omitting `from`/`to` — sending a preset there would be
 * stripped by zod and silently mean nothing.
 */
export const analyticsPresetShape = {
  preset: z.enum(['all']).optional(),
};

/**
 * `preset` and an explicit `from`/`to` are mutually exclusive.
 *
 * Rejected rather than ignored: silently dropping the bounds would let a caller
 * believe it had asked for a capped window when it had actually asked for all
 * of history, and silently dropping the preset would return 30 days labelled as
 * all time. Either way the response wouldn't match the request.
 */
export function assertPresetExclusive(
  r: { preset?: string; from?: string; to?: string },
  ctx: z.RefinementCtx,
): void {
  if (!r.preset) return;
  if (r.from || r.to) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['preset'],
      message: 'preset cannot be combined with from/to',
    });
  }
}

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
