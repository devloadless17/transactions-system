import { z } from 'zod';
import { WHISH_CURRENCIES, WhishTransferStatus } from '../enums';
import { moneyAmountSchema, paginationSchema } from './common';

// A recipient phone for a Whish W2W transfer. Whish expects a bare msisdn (e.g.
// "71505894") but operators may paste a "+" prefix, so allow it and let the
// service normalise. Bounded to keep obvious garbage out at the edge.
export const whishPhoneSchema = z
  .string()
  .trim()
  .regex(/^\+?\d{6,15}$/, 'must be a phone number (digits only, optional leading +)');

// What a SUPER_ADMIN submits to send a W2W transfer. The amount typed is exactly
// what is transferred (receivableAmount == transferAmount — no fee math). The
// optional `reference` is our idempotency key; when omitted the service mints one
// and returns it. The same value is sent to Whish as the `note` so a Whish-app
// transaction can be traced back to our row.
export const sendWhishTransferSchema = z.object({
  amount: moneyAmountSchema,
  recipientPhone: whishPhoneSchema,
  currency: z.enum(WHISH_CURRENCIES).default('USD'),
  reference: z.string().trim().min(8).max(64).optional(),
});
export type SendWhishTransferInput = z.infer<typeof sendWhishTransferSchema>;

// One transfer row, as returned to the admin UI. `recipientPhone` is full here
// because the whole transfers surface is SUPER_ADMIN-only.
export const whishTransferResponseSchema = z.object({
  id: z.string().uuid(),
  reference: z.string(),
  recipientPhone: z.string(),
  amount: z.string(),
  currency: z.string(),
  status: z.nativeEnum(WhishTransferStatus),
  traceId: z.string().nullable(),
  upstreamMessage: z.string().nullable(),
  source: z.string(),
  createdAt: z.string(),
});
export type WhishTransferResponse = z.infer<typeof whishTransferResponseSchema>;

export const listWhishTransfersQuerySchema = paginationSchema.extend({
  status: z.nativeEnum(WhishTransferStatus).optional(),
  // Fuzzy match on phone or reference.
  search: z.string().trim().max(64).optional(),
});
export type ListWhishTransfersQuery = z.infer<typeof listWhishTransfersQuerySchema>;

// What a SUPER_ADMIN pastes to (re)seed the captured Whish consumer-app session.
// These are the headers proxied off a logged-in Whish mobile-app session; they
// expire, so the UI lets ops re-capture and replace them without a redeploy.
export const updateWhishSessionSchema = z.object({
  token: z.string().trim().min(1).max(256),
  uid: z.string().trim().min(1).max(256),
  sessionId: z.string().trim().min(1).max(256),
  deviceId: z.string().trim().min(1).max(64),
  serverId: z.string().trim().min(1).max(64),
  itelVersion: z.string().trim().min(1).max(32),
  osVersion: z.string().trim().min(1).max(32),
  operatingSystem: z.string().trim().min(1).max(8),
  userAgent: z.string().trim().min(1).max(256),
  // Seed the monotonic counter from the captured session (the `sessionCounter`
  // header seen on the last real request). Defaults to 0.
  sessionCounter: z.coerce.number().int().min(0).default(0),
});
export type UpdateWhishSessionInput = z.infer<typeof updateWhishSessionSchema>;

// Non-secret status of the session credentials, for the admin panel. NEVER
// returns the secret fields — only whether they're configured + health signals.
export const whishSessionStatusSchema = z.object({
  configured: z.boolean(),
  deviceId: z.string().nullable(),
  serverId: z.string().nullable(),
  itelVersion: z.string().nullable(),
  sessionCounter: z.number().int().nullable(),
  lastRotatedAt: z.string().nullable(),
  lastAuthFailureAt: z.string().nullable(),
});
export type WhishSessionStatus = z.infer<typeof whishSessionStatusSchema>;
