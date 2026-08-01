import { z } from 'zod';
import { FeeApplication, PayoutMethod, WithdrawalStatus } from '../enums';
import { currencySchema, moneyAmountSchema } from './common';
import { createPayoutDetailsSchema, payoutDetailsSchema } from './payout-method';

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

const decimalString = moneyAmountSchema;

// Withdrawals: company pays an external third party. Funds move
// available → reserved on request, reserved → external on approval.
export const createWithdrawalSchema = z.object({
  amount: decimalString,
  currency: currencySchema,
  notes: z.string().trim().max(500).optional(),
  payout: createPayoutDetailsSchema,
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
  feeApplication: z.nativeEnum(FeeApplication),
  netAmount: z.string(),
  // Sub-dollar cents kept by the platform when an auto Whish transfer floored the
  // net to a whole dollar (0 for everything else). Recorded for audit/leftover totals.
  roundingRemainder: z.string(),
  // Total the company is actually charged = net + fee (the money that moves).
  // Equals `amount` for a DEDUCTED fee; for ON_TOP the fee is added on top, so
  // this exceeds the requested `amount`.
  totalAmount: z.string(),
  status: z.nativeEnum(WithdrawalStatus),
  payoutMethod: z.nativeEnum(PayoutMethod),
  payoutDetails: payoutDetailsSchema.nullable(),
  externalReference: z.string().nullable(),
  requestedById: z.string().uuid().nullable(),
  approvedById: z.string().uuid().nullable(),
  // The company's own request note (set once, immutable).
  notes: z.string().nullable(),
  // The admin's note recorded when actioning the request (e.g. the rejection
  // reason shown to the company). Kept separate so neither overwrites the other.
  adminNotes: z.string().nullable(),
  processedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // Auto-approval summary (Whish WISH withdrawals), derived from metadata so the
  // admin queue can show WHY a row is PENDING/PROCESSING. Null when never
  // auto-touched. `needsReconcile` = an ambiguous (UNKNOWN) transfer awaiting an
  // operator; `needsAttention` = transfer succeeded but settle is retrying;
  // `terminal` = a clean failure dropped back to the manual queue.
  autoApproval: z
    .object({
      status: z.string(),
      needsReconcile: z.boolean().optional(),
      needsAttention: z.boolean().optional(),
      terminal: z.boolean().optional(),
      errorDetail: z.string().nullish(),
      // Why a terminal auto-transfer failed, so the queue can distinguish an operator
      // problem (INVALID_RECIPIENT) from a receiver/Whish one (RECEIVER, TEMPORARY).
      failureCategory: z.enum(['INVALID_RECIPIENT', 'RECEIVER', 'TEMPORARY', 'GENERIC']).nullish(),
    })
    .nullish(),
});
export type WithdrawalResponse = z.infer<typeof withdrawalResponseSchema>;

export const listWithdrawalsQuerySchema = z.object({
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
export type ListWithdrawalsQuery = z.infer<typeof listWithdrawalsQuerySchema>;
