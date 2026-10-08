import { z } from 'zod';
import {
  CommissionType,
  FEE_OPERATION_LABEL,
  FEE_OPERATION_TYPES,
  FeeOperationType,
} from '../enums';
import { Money } from '../money';
import { MONEY_INPUT_DP, RATE_INPUT_DP, isDecimalString, rateStringSchema } from './common';
import { commissionValueWithinBounds } from './commission';

// ---------------------------------------------------------------------------
// Network fee — an optional, per-company second platform fee charged next to
// the commission. Priced per flow (deposits, withdrawals, payouts, loads), each
// either a PERCENTAGE rate or a FIXED dollar amount; a flow without a rate is
// not charged. The company's master switch decides whether any of it applies.
// Configured by a SUPER_ADMIN only; never exposed on a company-facing route.
// ---------------------------------------------------------------------------

/** One flow's network fee rate, as an admin enters it. */
export const networkFeeRateInputSchema = z
  .object({
    operationType: z.nativeEnum(FeeOperationType),
    feeType: z.nativeEnum(CommissionType),
    // Permissive here on purpose, like commissionTierSchema: a PERCENTAGE value
    // is a RATE and keeps its precision. The superRefine narrows FIXED to cents.
    feeValue: rateStringSchema,
  })
  .superRefine((r, ctx) => {
    // A malformed value already failed its own check (see isDecimalString).
    if (!isDecimalString(r.feeValue)) return;
    if (!Money.of(r.feeValue).isPositive()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['feeValue'],
        message: 'must be greater than 0 — leave the flow out to not charge a network fee',
      });
    }
    if (!commissionValueWithinBounds(r.feeType, r.feeValue)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['feeValue'],
        message: 'a PERCENTAGE network fee must be between 0 and 100',
      });
    }
    const dp = r.feeValue.split('.')[1]?.length ?? 0;
    const max = r.feeType === CommissionType.FIXED ? MONEY_INPUT_DP : RATE_INPUT_DP;
    if (dp > max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['feeValue'],
        message:
          r.feeType === CommissionType.FIXED
            ? `a FIXED network fee is an amount — at most ${MONEY_INPUT_DP} decimal places`
            : `a PERCENTAGE rate takes at most ${RATE_INPUT_DP} decimal places`,
      });
    }
  });
export type NetworkFeeRateInput = z.infer<typeof networkFeeRateInputSchema>;

/**
 * Replace a company's whole network-fee configuration in one call: the master
 * switch plus every flow's rate (a flow left out is not charged). Switching it
 * OFF may keep the rates, so turning it back on doesn't lose the setup.
 */
export const setNetworkFeeConfigSchema = z
  .object({
    enabled: z.boolean(),
    rates: z.array(networkFeeRateInputSchema).max(FEE_OPERATION_TYPES.length),
  })
  .superRefine((v, ctx) => {
    const seen = new Set<FeeOperationType>();
    v.rates.forEach((r, i) => {
      if (seen.has(r.operationType)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rates', i, 'operationType'],
          message: `Each flow can appear once — ${FEE_OPERATION_LABEL[r.operationType]} is listed twice`,
        });
      }
      seen.add(r.operationType);
    });
    if (v.enabled && v.rates.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['rates'],
        message: 'Set a network fee for at least one flow, or turn the network fee off',
      });
    }
  });
export type SetNetworkFeeConfigInput = z.infer<typeof setNetworkFeeConfigSchema>;

export const networkFeeRateSchema = z.object({
  operationType: z.nativeEnum(FeeOperationType),
  feeType: z.nativeEnum(CommissionType),
  feeValue: z.string(),
});
export type NetworkFeeRate = z.infer<typeof networkFeeRateSchema>;

export const networkFeeConfigResponseSchema = z.object({
  enabled: z.boolean(),
  // Ordered deposits, withdrawals, payouts, loads. A flow that is absent is not
  // charged a network fee.
  rates: z.array(networkFeeRateSchema),
});
export type NetworkFeeConfigResponse = z.infer<typeof networkFeeConfigResponseSchema>;
