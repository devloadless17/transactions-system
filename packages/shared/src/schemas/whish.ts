import { z } from 'zod';
import { WHISH_CURRENCIES, WhishPaymentStatus } from '../enums';
import { paginationSchema } from './common';

const decimalString = z.string().regex(/^\d+(\.\d+)?$/, 'must be a positive decimal');

// What a company submits to mint a Whish payment link.
export const createWhishPaymentSchema = z.object({
  amount: decimalString,
  currency: z.enum(WHISH_CURRENCIES),
  invoice: z.string().trim().min(1).max(200),
  // Optional client key — a retried create with the same key returns the same
  // payment instead of minting a duplicate link.
  idempotencyKey: z.string().trim().min(8).max(120).optional(),
});
export type CreateWhishPaymentInput = z.infer<typeof createWhishPaymentSchema>;

// Per-company outbound webhook config.
export const setWhishWebhookSchema = z.object({
  url: z.string().url(),
});
export type SetWhishWebhookInput = z.infer<typeof setWhishWebhookSchema>;

// Client-facing Whish config (drives which currency options the UI shows).
export const whishClientConfigSchema = z.object({
  enabledCurrencies: z.array(z.string()),
});
export type WhishClientConfig = z.infer<typeof whishClientConfigSchema>;

export const whishWebhookConfigSchema = z.object({
  url: z.string().nullable(),
  hasSecret: z.boolean(),
  // The signing secret — returned only when freshly generated/rotated.
  secret: z.string().optional(),
});
export type WhishWebhookConfig = z.infer<typeof whishWebhookConfigSchema>;

export const listWhishPaymentsQuerySchema = paginationSchema.extend({
  status: z.nativeEnum(WhishPaymentStatus).optional(),
});
export type ListWhishPaymentsQuery = z.infer<typeof listWhishPaymentsQuerySchema>;

// externalId is a DB bigint; serialized as a string in responses.
export const whishPaymentResponseSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  externalId: z.string(),
  status: z.nativeEnum(WhishPaymentStatus),
  amount: z.string(),
  currency: z.string(),
  invoice: z.string(),
  collectUrl: z.string().nullable(),
  payerPhoneNumber: z.string().nullable(),
  transactionId: z.string().uuid().nullable(),
  createdAt: z.string(),
  paidAt: z.string().nullable(),
});
export type WhishPaymentResponse = z.infer<typeof whishPaymentResponseSchema>;
