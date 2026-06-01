import { z } from 'zod';
import { PayoutMethod, WithdrawalStatus } from '../enums';
import { currencySchema } from './common';
import { payoutDetailsSchema } from './payout-method';

// Re-export for callers that still pull payout-method types from this
// module. The canonical location is `./payout-method`.
export {
  payoutDetailsSchema,
  type PayoutDetails,
  type BankPayoutDetails,
  type CryptoPayoutDetails,
  type CashPayoutDetails,
  type WishPayoutDetails,
  type OtherPayoutDetails,
} from './payout-method';

const decimalString = z.string().regex(/^\d+(\.\d+)?$/, 'must be a positive decimal');

// Withdrawals: company pays an external third party. Funds move
// available → reserved on request, reserved → external on approval.
export const createWithdrawalSchema = z.object({
  amount: decimalString,
  currency: currencySchema,
  notes: z.string().trim().max(500).optional(),
  payout: payoutDetailsSchema,
});
export type CreateWithdrawalInput = z.infer<typeof createWithdrawalSchema>;

export const approveWithdrawalSchema = z.object({
  // The off-platform reference proving the money moved: bank wire ID,
  // crypto tx hash, receipt number, etc. Required because the whole
  // point of "approve" is *recording the fact the admin sent it*.
  externalReference: z.string().trim().min(2).max(200),
  notes: z.string().trim().max(500).optional(),
});
export type ApproveWithdrawalInput = z.infer<typeof approveWithdrawalSchema>;

export const rejectWithdrawalSchema = z.object({
  notes: z.string().trim().max(500).optional(),
});
export type RejectWithdrawalInput = z.infer<typeof rejectWithdrawalSchema>;

// Company-initiated cancel of a PENDING request (withdrawal/payout/load).
export const cancelRequestSchema = z.object({
  notes: z.string().trim().max(500).optional(),
});
export type CancelRequestInput = z.infer<typeof cancelRequestSchema>;

export const withdrawalResponseSchema = z.object({
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
export type WithdrawalResponse = z.infer<typeof withdrawalResponseSchema>;

export const listWithdrawalsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.nativeEnum(WithdrawalStatus).optional(),
  companyId: z.string().uuid().optional(),
  currency: currencySchema.optional(),
  payoutMethod: z.nativeEnum(PayoutMethod).optional(),
});
export type ListWithdrawalsQuery = z.infer<typeof listWithdrawalsQuerySchema>;
