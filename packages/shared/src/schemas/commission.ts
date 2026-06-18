import { z } from 'zod';
import { CommissionType, FeeApplication, FeeOperationType } from '../enums';
import { Money } from '../money';

// Amounts and fee values are money; they are never negative. (A negative
// commission would credit the company on a fee, and a negative range bound is
// meaningless.) Comparisons below use Money/Decimal — never JS float — so a
// 20,8-digit value cannot slip past the bound through float precision loss.
const nonNegativeDecimalString = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'must be a non-negative decimal string (e.g. "1.50")')
  // Bound to the ledger's Decimal(20,8) scale (matching moneyAmountSchema) so a
  // rule value can't be silently rounded on store or overflow the column.
  .refine((v) => (v.split('.')[1]?.length ?? 0) <= 8, 'at most 8 decimal places')
  .refine((v) => v.split('.')[0]!.length <= 12, 'integer part is at most 12 digits');

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
    return Money.of(value).lte(HUNDRED);
  }
  return true;
}

export const createCommissionRuleSchema = z
  .object({
    companyId: z.string().uuid().nullable().optional(),
    sourceId: z.string().uuid().nullable().optional(),
    operationType: z.nativeEnum(FeeOperationType).default(FeeOperationType.TRANSACTION),
    feeApplication: z.nativeEnum(FeeApplication).default(FeeApplication.DEDUCTED),
    minAmount: nonNegativeDecimalString,
    maxAmount: nonNegativeDecimalString,
    commissionType: z.nativeEnum(CommissionType),
    commissionValue: nonNegativeDecimalString,
    priority: z.number().int().min(0).max(10_000).default(0),
    active: z.boolean().default(true),
  })
  .refine((v) => Money.of(v.minAmount).lte(Money.of(v.maxAmount)), {
    message: 'minAmount must be <= maxAmount',
    path: ['maxAmount'],
  })
  .refine((v) => commissionValueWithinBounds(v.commissionType, v.commissionValue), {
    message: 'PERCENTAGE commissionValue must be between 0 and 100',
    path: ['commissionValue'],
  });
export type CreateCommissionRuleInput = z.infer<typeof createCommissionRuleSchema>;

export const updateCommissionRuleSchema = z
  .object({
    companyId: z.string().uuid().nullable().optional(),
    sourceId: z.string().uuid().nullable().optional(),
    operationType: z.nativeEnum(FeeOperationType).optional(),
    feeApplication: z.nativeEnum(FeeApplication).optional(),
    minAmount: nonNegativeDecimalString.optional(),
    maxAmount: nonNegativeDecimalString.optional(),
    commissionType: z.nativeEnum(CommissionType).optional(),
    commissionValue: nonNegativeDecimalString.optional(),
    priority: z.number().int().min(0).max(10_000).optional(),
    active: z.boolean().optional(),
  })
  // Cross-field checks only fire when both sides are present in the patch.
  .refine(
    (v) =>
      v.minAmount === undefined ||
      v.maxAmount === undefined ||
      Money.of(v.minAmount).lte(Money.of(v.maxAmount)),
    {
      message: 'minAmount must be <= maxAmount',
      path: ['maxAmount'],
    },
  )
  .refine(
    (v) =>
      v.commissionType === undefined ||
      v.commissionValue === undefined ||
      commissionValueWithinBounds(v.commissionType, v.commissionValue),
    { message: 'PERCENTAGE commissionValue must be between 0 and 100', path: ['commissionValue'] },
  );
export type UpdateCommissionRuleInput = z.infer<typeof updateCommissionRuleSchema>;

export const commissionRuleResponseSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid().nullable(),
  sourceId: z.string().uuid().nullable(),
  operationType: z.nativeEnum(FeeOperationType),
  feeApplication: z.nativeEnum(FeeApplication),
  minAmount: z.string(),
  // null = open-ended top tier ("and above").
  maxAmount: z.string().nullable(),
  commissionType: z.nativeEnum(CommissionType),
  commissionValue: z.string(),
  priority: z.number().int(),
  active: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type CommissionRuleResponse = z.infer<typeof commissionRuleResponseSchema>;

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
// In the admin UI one "rule" applies the SAME amount-tier ladder to a set of
// companies and a set of operations. The API stores that as many individual
// CommissionRule rows (one per company × operation × tier) sharing a `groupId`,
// so the hot-path resolver/index/cache are untouched. These schemas describe the
// grouped shape the admin endpoints accept and return.
// ---------------------------------------------------------------------------

/** One amount bracket. `maxAmount: null` = open-ended ("and above") top tier. */
export const commissionTierSchema = z
  .object({
    minAmount: nonNegativeDecimalString,
    maxAmount: nonNegativeDecimalString.nullable(),
    commissionType: z.nativeEnum(CommissionType),
    commissionValue: nonNegativeDecimalString,
  })
  .refine((t) => t.maxAmount === null || Money.of(t.minAmount).lte(Money.of(t.maxAmount)), {
    message: 'minAmount must be <= maxAmount',
    path: ['maxAmount'],
  })
  .refine((t) => commissionValueWithinBounds(t.commissionType, t.commissionValue), {
    message: 'PERCENTAGE value must be between 0 and 100',
    path: ['commissionValue'],
  });
export type CommissionTierInput = z.infer<typeof commissionTierSchema>;

/**
 * Validate the tier ladder: brackets must not overlap, must be ordered, and only
 * the highest bracket may be open-ended ("and above"). Keeps pricing
 * deterministic (no two tiers of the same scope ever match one amount).
 */
function validateTierLadder(tiers: CommissionTierInput[], ctx: z.RefinementCtx): void {
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

// companyIds: null or [] = ALL companies (a single global row per operation/tier);
// a non-empty list targets exactly those companies.
const baseGroupShape = {
  // Optional admin-facing label, e.g. "Standard fees".
  name: z.string().trim().max(120).nullable().default(null),
  companyIds: z.array(z.string().uuid()).nullable().default(null),
  operationTypes: z
    .array(z.nativeEnum(FeeOperationType))
    .min(1, 'pick at least one operation')
    .default([FeeOperationType.TRANSACTION, FeeOperationType.WITHDRAWAL]),
  feeApplication: z.nativeEnum(FeeApplication).default(FeeApplication.DEDUCTED),
  priority: z.number().int().min(0).max(10_000).default(100),
  active: z.boolean().default(true),
  tiers: z.array(commissionTierSchema).min(1, 'add at least one tier'),
};

export const createCommissionRuleGroupSchema = z
  .object(baseGroupShape)
  .superRefine((v, ctx) => validateTierLadder(v.tiers, ctx));
export type CreateCommissionRuleGroupInput = z.infer<typeof createCommissionRuleGroupSchema>;

// A group PATCH fully replaces the spec (re-expands the rows), so it mirrors create.
export const updateCommissionRuleGroupSchema = createCommissionRuleGroupSchema;
export type UpdateCommissionRuleGroupInput = CreateCommissionRuleGroupInput;

export const commissionRuleGroupResponseSchema = z.object({
  groupId: z.string().uuid(),
  name: z.string().nullable(),
  // null = all companies (global).
  companyIds: z.array(z.string().uuid()).nullable(),
  operationTypes: z.array(z.nativeEnum(FeeOperationType)),
  feeApplication: z.nativeEnum(FeeApplication),
  priority: z.number().int(),
  active: z.boolean(),
  tiers: z.array(
    z.object({
      minAmount: z.string(),
      maxAmount: z.string().nullable(),
      commissionType: z.nativeEnum(CommissionType),
      commissionValue: z.string(),
    }),
  ),
  createdAt: z.string(),
});
export type CommissionRuleGroupResponse = z.infer<typeof commissionRuleGroupResponseSchema>;
