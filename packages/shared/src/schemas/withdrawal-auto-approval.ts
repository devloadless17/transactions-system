import { z } from 'zod';
import { moneyAmountSchema } from './common';

// Config for auto-approving company withdrawals payable via Whish (W2W). The
// feature ships OFF (`enabled` defaults false) — flipping it on is the only thing
// that ever begins auto-processing, and only for requests created AFTER the flip
// (`enabledAt`). `holdSeconds` is the cancel/safety window before a request is
// claimed; `maxAutoApproveAmount` caps what may auto-pay (bigger → manual).
export const updateWithdrawalAutoApprovalSchema = z
  .object({
    enabled: z.boolean().optional(),
    holdSeconds: z.coerce.number().int().min(0).max(86_400).optional(),
    maxAutoApproveAmount: moneyAmountSchema.optional(),
    failureThreshold: z.coerce.number().int().min(1).max(100).optional(),
    // Operator action to manually un-pause a tripped circuit breaker.
    clearBreaker: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, 'no fields to update');
export type UpdateWithdrawalAutoApprovalInput = z.infer<typeof updateWithdrawalAutoApprovalSchema>;

// Non-secret config + live circuit-breaker health for the admin panel.
export const withdrawalAutoApprovalConfigSchema = z.object({
  enabled: z.boolean(),
  enabledAt: z.string().nullable(),
  holdSeconds: z.number().int(),
  maxAutoApproveAmount: z.string(),
  // Circuit breaker: non-null trippedAt = auto-approval is paused by the system.
  circuitBreakerTrippedAt: z.string().nullable(),
  consecutiveFailures: z.number().int(),
  failureThreshold: z.number().int(),
  updatedAt: z.string().nullable(),
});
export type WithdrawalAutoApprovalConfig = z.infer<typeof withdrawalAutoApprovalConfigSchema>;

// Operator escape hatch for a withdrawal stuck in PROCESSING (an UNKNOWN transfer
// the operator has reconciled by hand): either CONFIRM the money moved and settle
// it, or REVERT it to PENDING (money did NOT move) so it can be retried/rejected.
export const resolveProcessingSchema = z.object({
  action: z.enum(['complete', 'revert']),
  // Required when completing — the Whish reference / proof recorded on the row.
  externalReference: z.string().trim().min(2).max(200).optional(),
  notes: z.string().trim().max(500).optional(),
});
export type ResolveProcessingInput = z.infer<typeof resolveProcessingSchema>;
