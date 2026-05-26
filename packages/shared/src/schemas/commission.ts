import { z } from 'zod';
import { CommissionType } from '../enums';

const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/, 'must be a decimal string (e.g. "1.50")');

export const createCommissionRuleSchema = z
  .object({
    companyId: z.string().uuid().nullable().optional(),
    sourceId: z.string().uuid().nullable().optional(),
    minAmount: decimalString,
    maxAmount: decimalString,
    commissionType: z.nativeEnum(CommissionType),
    commissionValue: decimalString,
    priority: z.number().int().min(0).max(10_000).default(0),
    active: z.boolean().default(true),
  })
  .refine((v) => Number(v.minAmount) <= Number(v.maxAmount), {
    message: 'minAmount must be <= maxAmount',
    path: ['maxAmount'],
  });
export type CreateCommissionRuleInput = z.infer<typeof createCommissionRuleSchema>;

export const updateCommissionRuleSchema = z.object({
  minAmount: decimalString.optional(),
  maxAmount: decimalString.optional(),
  commissionType: z.nativeEnum(CommissionType).optional(),
  commissionValue: decimalString.optional(),
  priority: z.number().int().min(0).max(10_000).optional(),
  active: z.boolean().optional(),
});
export type UpdateCommissionRuleInput = z.infer<typeof updateCommissionRuleSchema>;

export const commissionRuleResponseSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid().nullable(),
  sourceId: z.string().uuid().nullable(),
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
});
export type ListCommissionRulesQuery = z.infer<typeof listCommissionRulesQuerySchema>;
