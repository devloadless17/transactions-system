import { z } from 'zod';
import { PayoutMethod } from '../enums';

// Per-method payout details. Shared across the three processes
// (withdrawals, payouts, loads) so the operator-facing UI looks the same
// regardless of which flow the row came from.
//
// Each method requires its own fields. The discriminated union enforces
// that the right fields exist for the chosen method — without this,
// admins would approve transfers without knowing where to send the money
// (or where it came from, for a load).

const bankPayoutSchema = z.object({
  method: z.literal(PayoutMethod.BANK_TRANSFER),
  accountHolder: z.string().trim().min(2).max(120),
  accountNumber: z.string().trim().min(4).max(40),
  bankName: z.string().trim().min(2).max(120),
  swiftBic: z.string().trim().min(8).max(11).optional(),
  routingNumber: z.string().trim().min(3).max(20).optional(),
  instructions: z.string().trim().max(500).optional(),
});

const cryptoPayoutSchema = z.object({
  method: z.literal(PayoutMethod.CRYPTO),
  network: z.string().trim().min(2).max(40),
  walletAddress: z.string().trim().min(20).max(200),
  memo: z.string().trim().max(120).optional(),
  instructions: z.string().trim().max(500).optional(),
});

const cashPayoutSchema = z.object({
  method: z.literal(PayoutMethod.CASH),
  recipientName: z.string().trim().min(2).max(120),
  recipientPhone: z.string().trim().min(4).max(30),
  // Optional: a load (money in) has no pickup, and an outbound cash handover
  // can be arranged off the location field. Empty input is treated as absent
  // (same idiom as the optional `instructions`/`memo` fields).
  pickupLocation: z.string().trim().max(200).optional(),
  instructions: z.string().trim().max(500).optional(),
});

// A WISH recipient phone. Deliberately TOLERANT of how integrators/operators format
// a number (a leading +, spaces, dashes, parens) — the transfer service strips those
// to a bare msisdn before sending to Whish — but it must actually be phone-SHAPED:
// 6–15 digits and no letters. The old `min(4)` accepted "N/A" / a name, which then
// only failed late at Whish (a confusing, delayed auto-transfer failure). This keeps
// every real phone format an API caller might send while rejecting non-phones early.
const wishRecipientPhoneSchema = z
  .string()
  .trim()
  .max(30)
  .refine((v) => /^[+(\d][\d\s().+-]*$/.test(v), {
    message: 'recipientPhone must be a phone number (digits, with optional + ( ) - and spaces)',
  })
  .refine(
    (v) => {
      const digits = (v.match(/\d/g) ?? []).length;
      return digits >= 6 && digits <= 15;
    },
    { message: 'recipientPhone must contain 6–15 digits' },
  );

const wishPayoutSchema = z.object({
  method: z.literal(PayoutMethod.WISH),
  recipientName: z.string().trim().min(2).max(120),
  recipientPhone: wishRecipientPhoneSchema,
  instructions: z.string().trim().max(500).optional(),
});

const otherPayoutSchema = z.object({
  method: z.literal(PayoutMethod.OTHER),
  description: z.string().trim().min(2).max(500),
  instructions: z.string().trim().max(500).optional(),
});

export const payoutDetailsSchema = z.discriminatedUnion('method', [
  bankPayoutSchema,
  cryptoPayoutSchema,
  cashPayoutSchema,
  wishPayoutSchema,
  otherPayoutSchema,
]);
export type PayoutDetails = z.infer<typeof payoutDetailsSchema>;

// Restricted union — used for CREATING new withdrawals/payouts/loads. Cash,
// Whish, and crypto are accepted (in display order); bank transfer and "other"
// are rejected at the API. The full union above stays in use for reading
// legacy rows.
export const createPayoutDetailsSchema = z.discriminatedUnion('method', [
  cashPayoutSchema,
  wishPayoutSchema,
  cryptoPayoutSchema,
]);
export type CreatePayoutDetails = z.infer<typeof createPayoutDetailsSchema>;

export type BankPayoutDetails = z.infer<typeof bankPayoutSchema>;
export type CryptoPayoutDetails = z.infer<typeof cryptoPayoutSchema>;
export type CashPayoutDetails = z.infer<typeof cashPayoutSchema>;
export type WishPayoutDetails = z.infer<typeof wishPayoutSchema>;
export type OtherPayoutDetails = z.infer<typeof otherPayoutSchema>;
