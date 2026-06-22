import { z } from 'zod';
import { WHISH_CURRENCIES, WhishPaymentStatus } from '../enums';
import { moneyAmountSchema, paginationSchema } from './common';

const decimalString = moneyAmountSchema;

// A customer-facing redirect URL. Must be a real http(s) URL (no javascript:,
// data:, etc.) and bounded in length. Used for where the PAYER lands after a
// Whish payment — never for any server-side fetch, so this is about input
// hygiene, not SSRF (the browser, not the platform, follows it).
export const redirectUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .url('must be a valid URL')
  .refine((u) => /^https?:\/\//i.test(u), 'must start with http:// or https://');

// What a company submits to mint a Whish payment link.
export const createWhishPaymentSchema = z.object({
  amount: decimalString,
  currency: z.enum(WHISH_CURRENCIES),
  invoice: z.string().trim().min(1).max(200),
  // Optional client key — a retried create with the same key returns the same
  // payment instead of minting a duplicate link.
  idempotencyKey: z.string().trim().min(8).max(120).optional(),
  // Optional per-link override of where the payer is sent after paying. When
  // omitted, the company's saved defaults are used, then the platform pages.
  successRedirectUrl: redirectUrlSchema.optional(),
  failureRedirectUrl: redirectUrlSchema.optional(),
});
export type CreateWhishPaymentInput = z.infer<typeof createWhishPaymentSchema>;

// Per-company default redirect URLs (the saved defaults behind the per-link
// override above). null = fall back to the platform's /pay pages.
export const whishRedirectConfigSchema = z.object({
  successUrl: z.string().nullable(),
  failureUrl: z.string().nullable(),
});
export type WhishRedirectConfig = z.infer<typeof whishRedirectConfigSchema>;

export const setWhishRedirectConfigSchema = z.object({
  successUrl: redirectUrlSchema.nullable(),
  failureUrl: redirectUrlSchema.nullable(),
});
export type SetWhishRedirectConfigInput = z.infer<typeof setWhishRedirectConfigSchema>;

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
  // Filter to payments flagged for operator attention (PAID at Whish but the
  // wallet couldn't be settled). Query strings are text, so the service treats
  // only the literal "true" as enabling the filter. (Kept as an enum rather than
  // a transform so the schema stays a plain ZodObject the ZodPipe accepts.)
  needsAttention: z.enum(['true', 'false']).optional(),
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
  // True when the payment is PAID at Whish but settlement into the ledger failed
  // (usually its commission rule changed after the link was minted). The
  // reconciler keeps retrying, but it needs operator attention — surfaced here so
  // it's visible in the UI/API instead of only in logs.
  needsAttention: z.boolean(),
  createdAt: z.string(),
  paidAt: z.string().nullable(),
});
export type WhishPaymentResponse = z.infer<typeof whishPaymentResponseSchema>;
