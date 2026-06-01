import { z } from 'zod';
import { PayoutMethod, WithdrawalStatus } from '../enums';
import { currencySchema } from './common';
import { payoutDetailsSchema } from './payout-method';

const decimalString = z.string().regex(/^\d+(\.\d+)?$/, 'must be a positive decimal');

// Loads: company tops up its own wallet (money in, not out). On request
// we just persist the row in PENDING — no wallet or ledger move yet.
// The operator credits the wallet when they confirm real-world receipt
// of the funds, at which point ledger entries are written and the row
// transitions to COMPLETED.
//
// `payout.method` here is repurposed to record HOW the money arrived
// (Whish phone the company sent from, crypto tx hash, cash drop, etc).
export const createLoadSchema = z.object({
  amount: decimalString,
  currency: currencySchema,
  notes: z.string().trim().max(500).optional(),
  payout: payoutDetailsSchema,
});
export type CreateLoadInput = z.infer<typeof createLoadSchema>;

export const approveLoadSchema = z.object({
  externalReference: z.string().trim().min(2).max(200),
  notes: z.string().trim().max(500).optional(),
});
export type ApproveLoadInput = z.infer<typeof approveLoadSchema>;

export const rejectLoadSchema = z.object({
  notes: z.string().trim().max(500).optional(),
});
export type RejectLoadInput = z.infer<typeof rejectLoadSchema>;

export const loadResponseSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  amount: z.string(),
  currency: z.string(),
  feeAmount: z.string(),
  netAmount: z.string(),
  status: z.nativeEnum(WithdrawalStatus),
  payoutMethod: z.nativeEnum(PayoutMethod),
  payoutDetails: payoutDetailsSchema.nullable(),
  externalReference: z.string().nullable(),
  requestedById: z.string().uuid(),
  approvedById: z.string().uuid().nullable(),
  notes: z.string().nullable(),
  processedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type LoadResponse = z.infer<typeof loadResponseSchema>;

export const listLoadsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.nativeEnum(WithdrawalStatus).optional(),
  companyId: z.string().uuid().optional(),
  currency: currencySchema.optional(),
  payoutMethod: z.nativeEnum(PayoutMethod).optional(),
});
export type ListLoadsQuery = z.infer<typeof listLoadsQuerySchema>;
