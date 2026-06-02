import { z } from 'zod';
import { CommissionType, FeeApplication, FeeOperationType } from '../enums';
import { Money } from '../money';

// Amounts and fee values are money; they are never negative. (A negative
// commission would credit the company on a fee, and a negative range bound is
// meaningless.) Comparisons below use Money/Decimal — never JS float — so a
// 20,8-digit value cannot slip past the bound through float precision loss.
const nonNegativeDecimalString = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'must be a non-negative decimal string (e.g. "1.50")');

const HUNDRED = Money.of('100');

/**
 * A PERCENTAGE fee must be in [0, 100]: a value > 100 guarantees the computed
 * commission exceeds the amount for a DEDUCTED fee, which would produce a
 * negative net and an unbalanced ledger that 500s every ingest in that bracket.
 * FIXED values are only bounded to be non-negative here; the resolver enforces
 * commission <= amount at compute time (see CommissionExceedsAmountError).
 */
function commissionValueWithinBounds(commissionType: CommissionType, value: string): boolean {
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
  maxAmount: z.string(),
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
