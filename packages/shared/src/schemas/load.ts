import { z } from 'zod';
import { FeeApplication, PayoutMethod, WithdrawalStatus } from '../enums';
import { currencySchema, quantizedAmountSchema } from './common';
import { createPayoutDetailsSchema, payoutDetailsSchema } from './payout-method';

// Money IN. A sub-cent amount is quantized, never rejected: the deposit already
// happened at the provider, so a 400 here would strand real money.
const decimalString = quantizedAmountSchema('in');

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
  payout: createPayoutDetailsSchema,
});
export type CreateLoadInput = z.infer<typeof createLoadSchema>;

export const approveLoadSchema = z.object({
  externalReference: z.string().trim().min(2).max(200),
  notes: z.string().trim().max(500).optional(),
});
export type ApproveLoadInput = z.infer<typeof approveLoadSchema>;

// Super-admin-only: load a company's wallet directly. For funds received
// off-platform in real life (the company handed us money) without them filing a
// request. It behaves exactly as if the company requested this load and we
// accepted it — same commission rule, ledger entries, and wallet credit — done
// in a single step. `payout` records how/where the money arrived (same field a
// company-requested load uses); `externalReference` is our proof of receipt
// (defaulted server-side when omitted).
export const adminLoadSchema = z.object({
  companyId: z.string().uuid(),
  amount: decimalString,
  currency: currencySchema,
  notes: z.string().trim().max(500).optional(),
  payout: createPayoutDetailsSchema,
  externalReference: z.string().trim().min(2).max(200).optional(),
});
export type AdminLoadInput = z.infer<typeof adminLoadSchema>;

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
  // Optional per-company network fee, applied the same way as `feeAmount`
  // (see feeApplication). "0" when the company is not charged one.
  networkFeeAmount: z.string(),
  feeApplication: z.nativeEnum(FeeApplication),
  netAmount: z.string(),
  // Total the company is actually charged = net + fee + networkFee (the money
  // that moves). Equals `amount` for DEDUCTED fees; for ON_TOP the fees are
  // added on top, so this exceeds the requested `amount`.
  totalAmount: z.string(),
  status: z.nativeEnum(WithdrawalStatus),
  payoutMethod: z.nativeEnum(PayoutMethod),
  payoutDetails: payoutDetailsSchema.nullable(),
  externalReference: z.string().nullable(),
  requestedById: z.string().uuid().nullable(),
  approvedById: z.string().uuid().nullable(),
  // Company's own request note (immutable) vs the admin's action note (e.g. the
  // rejection reason shown to the company) — kept separate, neither overwrites.
  notes: z.string().nullable(),
  adminNotes: z.string().nullable(),
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
  // ISO date strings — filter by request (createdAt) time.
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
export type ListLoadsQuery = z.infer<typeof listLoadsQuerySchema>;
