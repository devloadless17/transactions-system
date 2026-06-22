import { z } from 'zod';
import { CommissionType, SourceFeeChannel, SourceStatus } from '../enums';
import { Money } from '../money';

const codeRegex = /^[a-z][a-z0-9_]{1,49}$/;

export const createSourceSchema = z.object({
  name: z.string().trim().min(2).max(120),
  code: z.string().trim().toLowerCase().regex(codeRegex, 'code must be 2-50 chars, [a-z0-9_]'),
  metadata: z.record(z.unknown()).optional(),
});
export type CreateSourceInput = z.infer<typeof createSourceSchema>;

export const updateSourceSchema = z.object({
  name: z.string().trim().min(2).max(120).optional(),
  status: z.nativeEnum(SourceStatus).optional(),
  metadata: z.record(z.unknown()).nullable().optional(),
});
export type UpdateSourceInput = z.infer<typeof updateSourceSchema>;

export const sourceResponseSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  code: z.string(),
  status: z.nativeEnum(SourceStatus),
  metadata: z.record(z.unknown()).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SourceResponse = z.infer<typeof sourceResponseSchema>;

// ---------------- source fee schedule (cost the source charges the platform) ----
// What an upstream source takes from the PLATFORM on each deposit — the inverse
// of a commission rule. Tiered like commission rules: an amount band per channel
// with a FIXED amount or a PERCENTAGE rate. Admin/system-only.

// Money values are decimal strings, never floats — bounded to the ledger's
// Decimal(20,8) scale so a value can't be silently rounded or overflow the column.
const feeDecimalString = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'must be a non-negative decimal string (e.g. "1.50")')
  .refine((v) => (v.split('.')[1]?.length ?? 0) <= 8, 'at most 8 decimal places')
  .refine((v) => v.split('.')[0]!.length <= 12, 'integer part is at most 12 digits');

const HUNDRED = Money.of('100');

export const sourceFeeRuleInputSchema = z
  .object({
    channel: z.nativeEnum(SourceFeeChannel),
    minAmount: feeDecimalString,
    // null = open-ended top tier (no upper bound).
    maxAmount: feeDecimalString.nullable(),
    feeType: z.nativeEnum(CommissionType),
    feeValue: feeDecimalString,
    active: z.boolean().default(true),
  })
  .refine((v) => v.maxAmount === null || Money.of(v.minAmount).lte(Money.of(v.maxAmount)), {
    message: 'minAmount must be <= maxAmount',
    path: ['maxAmount'],
  })
  .refine((v) => v.feeType !== CommissionType.PERCENTAGE || Money.of(v.feeValue).lte(HUNDRED), {
    message: 'a PERCENTAGE fee must be between 0 and 100',
    path: ['feeValue'],
  });
export type SourceFeeRuleInput = z.infer<typeof sourceFeeRuleInputSchema>;

// Replace a source's whole fee schedule in one call (like the commission
// rule-group editor). Per channel, tiers must not genuinely overlap — touching
// at a boundary (e.g. [0,10] then [10,∞]) is allowed and resolves to the
// LOWER tier (so [0,10] includes exactly 10); only one open-ended (null max)
// tier per channel, and it must be the highest band.
//
// NOTE — this touching-boundary convention is DELIBERATELY the opposite of
// commission rules (schemas/commission.ts validateTierLadder), which forbid
// touching. Source fees read naturally as "≤ $10 → …, above $10 → …", so the
// resolver (analytics/source-fees + source-fee.compute) picks the lowest-min
// matching tier. Don't assume the commission rule when editing this one.
export const setSourceFeeRulesSchema = z
  .object({
    rules: z.array(sourceFeeRuleInputSchema).max(50),
  })
  .superRefine((v, ctx) => {
    const byChannel = new Map<string, SourceFeeRuleInput[]>();
    for (const r of v.rules) {
      const list = byChannel.get(r.channel) ?? [];
      list.push(r);
      byChannel.set(r.channel, list);
    }
    for (const [, list] of byChannel) {
      const sorted = [...list].sort((a, b) => Money.of(a.minAmount).cmp(Money.of(b.minAmount)));
      for (let i = 0; i < sorted.length; i++) {
        const cur = sorted[i]!;
        // An open-ended tier must be the last band in its channel.
        if (cur.maxAmount === null && i !== sorted.length - 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `open-ended (no max) tier must be the highest band for channel ${cur.channel}`,
            path: ['rules'],
          });
        }
        if (i === 0) continue;
        const prev = sorted[i - 1]!;
        // prev must be bounded, and cur.min must start at/after prev.max.
        if (prev.maxAmount === null || Money.of(cur.minAmount).lt(Money.of(prev.maxAmount))) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `overlapping tiers for channel ${cur.channel}`,
            path: ['rules'],
          });
        }
      }
    }
  });
export type SetSourceFeeRulesInput = z.infer<typeof setSourceFeeRulesSchema>;

export const sourceFeeRuleResponseSchema = z.object({
  id: z.string().uuid(),
  sourceId: z.string().uuid(),
  channel: z.nativeEnum(SourceFeeChannel),
  minAmount: z.string(),
  maxAmount: z.string().nullable(),
  feeType: z.nativeEnum(CommissionType),
  feeValue: z.string(),
  active: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SourceFeeRuleResponse = z.infer<typeof sourceFeeRuleResponseSchema>;
