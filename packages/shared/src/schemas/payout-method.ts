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

// W2W is NOT Lebanese-only, so we do NOT force every recipient to be Lebanese. But a
// number that EXPLICITLY carries the Lebanese 961 country code must be a well-formed
// Lebanese mobile — the national part is 8 digits, or exactly 7 when it starts with 3
// (the `+961 3…` family). That catches the real prod bug (9617075183 — 961 + only 7
// digits, non-3 prefix) up front, instead of it failing LATE at Whish as
// `auth.wrong_phone_format`. Any OTHER country code / bare-local number is left to the
// tolerant shape check above, so a valid international recipient is never blocked.
// Exported so the API/tests can reuse the exact same normalisation.
export function lebaneseMobileNsn(raw: string): string {
  let d = raw.replace(/\D/g, '');
  if (d.startsWith('00961')) d = d.slice(5);
  else if (d.startsWith('961')) d = d.slice(3);
  if (d.startsWith('0')) d = d.slice(1);
  return d;
}

export function isValidLebaneseMobile(raw: string): boolean {
  const nsn = lebaneseMobileNsn(raw);
  return nsn.startsWith('3') ? nsn.length === 7 : nsn.length === 8;
}

/** True unless the number carries a 961 country code AND is a malformed Lebanese mobile. */
export function isValidWishRecipientPhone(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  const hasLebaneseCountryCode = digits.startsWith('00961') || digits.startsWith('961');
  // Only the 961-tagged numbers are held to the Lebanese rule; everything else
  // (other country codes, bare local) passes on the tolerant shape alone.
  return hasLebaneseCountryCode ? isValidLebaneseMobile(raw) : true;
}

// CREATE-only: the tolerant phone shape PLUS the 961-scoped Lebanese-MSISDN check.
// Deliberately NOT applied to the read/`wishPayoutSchema` union — legacy rows may hold
// a number that predates this rule, and re-parsing one on read must never throw.
const wishRecipientPhoneCreateSchema = wishRecipientPhoneSchema.refine(isValidWishRecipientPhone, {
  message:
    'a Lebanese (+961) recipientPhone must be 8 digits after the country code (or 7 digits when it starts with 3)',
});

const wishPayoutCreateSchema = wishPayoutSchema.extend({
  recipientPhone: wishRecipientPhoneCreateSchema,
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
  wishPayoutCreateSchema,
  cryptoPayoutSchema,
]);
export type CreatePayoutDetails = z.infer<typeof createPayoutDetailsSchema>;

export type BankPayoutDetails = z.infer<typeof bankPayoutSchema>;
export type CryptoPayoutDetails = z.infer<typeof cryptoPayoutSchema>;
export type CashPayoutDetails = z.infer<typeof cashPayoutSchema>;
export type WishPayoutDetails = z.infer<typeof wishPayoutSchema>;
export type OtherPayoutDetails = z.infer<typeof otherPayoutSchema>;
