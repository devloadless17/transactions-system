import { z } from 'zod';
import { FeeApplication, PayoutMethod, WithdrawalStatus } from '../enums';
import { currencySchema, moneyAmountSchema } from './common';
import { createPayoutDetailsSchema, payoutDetailsSchema } from './payout-method';

const decimalString = moneyAmountSchema;

// Payouts: company withdraws funds to itself. Funds move
// available → reserved on request, reserved → external on approval.
// Same shape as Withdrawal — the only difference is who the recipient is.
export const createPayoutSchema = z.object({
  amount: decimalString,
  currency: currencySchema,
  notes: z.string().trim().max(500).optional(),
  payout: createPayoutDetailsSchema,
});
export type CreatePayoutInput = z.infer<typeof createPayoutSchema>;

export const approvePayoutSchema = z.object({
  externalReference: z.string().trim().min(2).max(200),
  notes: z.string().trim().max(500).optional(),
});
export type ApprovePayoutInput = z.infer<typeof approvePayoutSchema>;

export const rejectPayoutSchema = z.object({
  notes: z.string().trim().max(500).optional(),
});
export type RejectPayoutInput = z.infer<typeof rejectPayoutSchema>;

export const payoutResponseSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  amount: z.string(),
  currency: z.string(),
  feeAmount: z.string(),
  feeApplication: z.nativeEnum(FeeApplication),
  netAmount: z.string(),
  // Total the company is actually charged = net + fee (the money that moves).
  // Equals `amount` for a DEDUCTED fee; for ON_TOP the fee is added on top, so
  // this exceeds the requested `amount`.
  totalAmount: z.string(),
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
export type PayoutResponse = z.infer<typeof payoutResponseSchema>;

export const listPayoutsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.nativeEnum(WithdrawalStatus).optional(),
  companyId: z.string().uuid().optional(),
  currency: currencySchema.optional(),
  payoutMethod: z.nativeEnum(PayoutMethod).optional(),
  // ISO date strings — filter by request (createdAt) time.
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
export type ListPayoutsQuery = z.infer<typeof listPayoutsQuerySchema>;
