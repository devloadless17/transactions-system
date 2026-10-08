import { z } from 'zod';
import { CommissionType, FeeApplication, FeeOperationType } from '../enums';
import { Money } from '../money';
import {
  MONEY_INPUT_DP,
  RATE_INPUT_DP,
  isDecimalString,
  moneyAmountSchema,
  rateStringSchema,
} from './common';

// Amounts and fee values are money; they are never negative. (A negative
// commission would credit the company on a fee, and a negative range bound is
// meaningless.) Comparisons below use Money/Decimal — never JS float — so a
// 20,8-digit value cannot slip past the bound through float precision loss.
// Tier BOUNDS are money amounts: cents, like every other amount on the platform.
// The tier VALUE is dual-typed (dollars when FIXED, a rate when PERCENTAGE), so it
// is validated per-type in the superRefine on commissionTierSchema below — a rate
// keeps its precision, because 0.125% is a real price and not a rounding error.
const nonNegativeDecimalString = moneyAmountSchema;

const HUNDRED = Money.of('100');

/**
 * A PERCENTAGE fee must be in [0, 100]: a value > 100 guarantees the computed
 * commission exceeds the amount for a DEDUCTED fee, which would produce a
 * negative net and an unbalanced ledger that 500s every ingest in that bracket.
 * FIXED values are only bounded to be non-negative here; the resolver enforces
 * commission <= amount at compute time (see CommissionExceedsAmountError).
 */
export function commissionValueWithinBounds(
  commissionType: CommissionType,
  value: string,
): boolean {
  if (commissionType === CommissionType.PERCENTAGE) {
    // A malformed value is reported by its own field check; don't throw here.
    return !isDecimalString(value) || Money.of(value).lte(HUNDRED);
  }
  return true;
}

export const listCommissionRulesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(50),
  companyId: z.string().uuid().nullable().optional(),
  sourceId: z.string().uuid().nullable().optional(),
  operationType: z.nativeEnum(FeeOperationType).optional(),
});
export type ListCommissionRulesQuery = z.infer<typeof listCommissionRulesQuerySchema>;

// ---------------------------------------------------------------------------
// Commission rule GROUPS
//
// In the admin UI one "rule" prices a set of companies and a set of operations,
// where EACH operation carries its own amount-tier ladder (e.g. deposits 1%,
// withdrawals 2%). The API stores that as many individual CommissionRule rows
// (one per company × operation × tier) sharing a `groupId`, so the hot-path
// resolver/index/cache are untouched. These schemas describe the grouped shape
// the admin endpoints accept and return.
// ---------------------------------------------------------------------------

/** One amount bracket. `maxAmount: null` = open-ended ("and above") top tier. */
export const commissionTierSchema = z
  .object({
    minAmount: nonNegativeDecimalString,
    maxAmount: nonNegativeDecimalString.nullable(),
    commissionType: z.nativeEnum(CommissionType),
    // Permissive here on purpose: a PERCENTAGE value is a RATE and keeps its
    // precision. The superRefine below narrows only the FIXED case to cents.
    // (A field-level 2dp cap would fire FIRST and make that split unreachable.)
    commissionValue: rateStringSchema,
  })
  .refine(
    (t) =>
      t.maxAmount === null ||
      !isDecimalString(t.minAmount) ||
      !isDecimalString(t.maxAmount) ||
      Money.of(t.minAmount).lte(Money.of(t.maxAmount)),
    {
      message: 'minAmount must be <= maxAmount',
      path: ['maxAmount'],
    },
  )
  .refine((t) => commissionValueWithinBounds(t.commissionType, t.commissionValue), {
    message: 'PERCENTAGE value must be between 0 and 100',
    path: ['commissionValue'],
  })
  // The dual-typed split. A FIXED value IS money, so it takes cents like any
  // amount; a PERCENTAGE value is a RATE and keeps full precision. A field-level
  // refine can't express this because the rule depends on the sibling type field.
  .superRefine((t, ctx) => {
    const dp = t.commissionValue.split('.')[1]?.length ?? 0;
    const max = t.commissionType === CommissionType.FIXED ? MONEY_INPUT_DP : RATE_INPUT_DP;
    if (dp > max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['commissionValue'],
        message:
          t.commissionType === CommissionType.FIXED
            ? `a FIXED commission is an amount — at most ${MONEY_INPUT_DP} decimal places`
            : `a PERCENTAGE rate takes at most ${RATE_INPUT_DP} decimal places`,
      });
    }
  });
export type CommissionTierInput = z.infer<typeof commissionTierSchema>;

/**
 * Validate the tier ladder: brackets must not overlap, must be ordered, and only
 * the highest bracket may be open-ended ("and above"). Keeps pricing
 * deterministic (no two tiers of the same scope ever match one amount).
 *
 * NOTE — boundary convention differs DELIBERATELY from source-fee rules: commission
 * tiers must NOT touch (e.g. [1,100],[101,300]); a touching boundary is rejected
 * here. Source-fee tiers (schemas/source.ts) intentionally ALLOW touching
 * ([0,10],[10,∞]) and resolve the shared point to the lower tier. Don't assume one
 * resolver's rule when editing the other.
 */
function validateTierLadder(tiers: CommissionTierInput[], ctx: z.RefinementCtx): void {
  // A tier with a malformed bound has already failed its own check; ordering an
  // unparseable ladder would throw (see isDecimalString).
  if (
    !tiers.every(
      (t) => isDecimalString(t.minAmount) && (t.maxAmount === null || isDecimalString(t.maxAmount)),
    )
  ) {
    return;
  }
  const sorted = [...tiers].sort((a, b) =>
    Money.of(a.minAmount).gte(Money.of(b.minAmount)) ? 1 : -1,
  );
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i]!;
    const isLast = i === sorted.length - 1;
    if (t.maxAmount === null && !isLast) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Only the highest tier can be open-ended ("and above")',
        path: ['tiers'],
      });
    }
    if (i > 0) {
      const prev = sorted[i - 1]!;
      // prev.max must exist and be strictly below this tier's min, else overlap.
      if (prev.maxAmount === null || Money.of(prev.maxAmount).gte(Money.of(t.minAmount))) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'Tiers overlap — each bracket must start above the previous one ends',
          path: ['tiers'],
        });
      }
    }
  }
}

/**
 * One operation a rule prices: how its fee is applied (deducted vs on top) AND
 * its own fee-tier ladder. Each operation carries its own ladder, so one rule
 * can price e.g. deposits at 1% deducted but withdrawals at 2% on top.
 */
export const commissionOperationSchema = z
  .object({
    operationType: z.nativeEnum(FeeOperationType),
    feeApplication: z.nativeEnum(FeeApplication).default(FeeApplication.DEDUCTED),
    tiers: z.array(commissionTierSchema).min(1, 'add at least one tier'),
  })
  .superRefine((op, ctx) => validateTierLadder(op.tiers, ctx));
export type CommissionOperationInput = z.infer<typeof commissionOperationSchema>;

/** Validate a group: no operation repeats (each op's ladder is checked on the op). */
function validateGroup(v: { operations: CommissionOperationInput[] }, ctx: z.RefinementCtx): void {
  const seen = new Set<FeeOperationType>();
  for (const op of v.operations) {
    if (seen.has(op.operationType)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Each operation can appear once — "${op.operationType}" is listed twice`,
        path: ['operations'],
      });
    }
    seen.add(op.operationType);
  }
}

// companyIds: null or [] = ALL companies (a single global row per operation/tier);
// a non-empty list targets exactly those companies.
const baseGroupShape = {
  // Optional admin-facing label, e.g. "Standard fees".
  name: z.string().trim().max(120).nullable().default(null),
  companyIds: z.array(z.string().uuid()).nullable().default(null),
  // Which operations this rule prices, each with its own fee application AND
  // its own fee-tier ladder. No default: a default set of operations would
  // imply a default fee schedule, which must always be explicit.
  operations: z.array(commissionOperationSchema).min(1, 'pick at least one operation'),
  priority: z.number().int().min(0).max(10_000).default(100),
  active: z.boolean().default(true),
};

export const createCommissionRuleGroupSchema = z.object(baseGroupShape).superRefine(validateGroup);
export type CreateCommissionRuleGroupInput = z.infer<typeof createCommissionRuleGroupSchema>;

// The same rule spec WITHOUT `companyIds` — used to create a starter rule for a
// single, just-created company (the server injects that company's id). Lets
// company onboarding set pricing atomically so a company is never left unpriced.
const { companyIds: _omitCompanyIds, ...companyScopedShape } = baseGroupShape;
export const companyScopedCommissionRuleSchema = z
  .object(companyScopedShape)
  .superRefine(validateGroup);
export type CompanyScopedCommissionRuleInput = z.infer<typeof companyScopedCommissionRuleSchema>;

// A group PATCH fully replaces the spec (re-expands the rows), so it mirrors create.
export const updateCommissionRuleGroupSchema = createCommissionRuleGroupSchema;
export type UpdateCommissionRuleGroupInput = CreateCommissionRuleGroupInput;

export const commissionRuleGroupResponseSchema = z.object({
  groupId: z.string().uuid(),
  name: z.string().nullable(),
  // null = all companies (global).
  companyIds: z.array(z.string().uuid()).nullable(),
  // Each priced operation with its own fee application and its own tier ladder.
  operations: z.array(
    z.object({
      operationType: z.nativeEnum(FeeOperationType),
      feeApplication: z.nativeEnum(FeeApplication),
      tiers: z.array(
        z.object({
          minAmount: z.string(),
          maxAmount: z.string().nullable(),
          commissionType: z.nativeEnum(CommissionType),
          commissionValue: z.string(),
        }),
      ),
    }),
  ),
  priority: z.number().int(),
  active: z.boolean(),
  createdAt: z.string(),
});
export type CommissionRuleGroupResponse = z.infer<typeof commissionRuleGroupResponseSchema>;
