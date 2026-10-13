import { z } from 'zod';
import {
  WHISH_AMOUNT_RULES,
  WHISH_CURRENCIES,
  WhishPaymentStatus,
  type WhishAmountRule,
  type WhishCurrency,
} from '../enums';
import { paginationSchema, quantizedAmountSchema } from './common';
import { Money } from '../money';

// Money IN via the payment provider. Quantized, never rejected — Whish itself
// accepts amounts its documentation discourages, and we must not be stricter
// than the provider that will actually collect the money.
const decimalString = quantizedAmountSchema('in');

/**
 * Whish's own DOCUMENTED per-currency amount rules (v1.4.4: USD at most 2
 * decimals, minimum 1.00). Returns a human description of how an amount departs
 * from them, or null when it is within them.
 *
 * ADVISORY ONLY — deliberately not enforced. Verified against the live v1.4.4
 * sandbox on 2026-08-12: Whish accepts `"0.50"` and `"10.005"`, mints a real
 * collectUrl for both, and the hosted payment page takes a `0.50` link all the
 * way to the OTP step. Rejecting those here would block payments the provider
 * is perfectly willing to collect. We log the divergence instead, so it stays
 * visible if Whish ever starts enforcing what it documents.
 */
export function whishAmountIssue(amount: string, currency: string): string | null {
  // Widened to WhishAmountRule on purpose: WHISH_AMOUNT_RULES is `as const`, so
  // with a single currency configured TypeScript narrows maxDecimals to the
  // literal `2` and calls the zero-decimal branch below unreachable. That branch
  // is for LBP, one line away from being enabled.
  const rule: WhishAmountRule | undefined = WHISH_AMOUNT_RULES[currency as WhishCurrency];
  if (!rule) return null; // unknown currency — the enum already rejected it
  const decimals = amount.split('.')[1]?.length ?? 0;
  if (decimals > rule.maxDecimals) {
    return rule.maxDecimals === 0
      ? `${currency} amounts must be whole numbers (no decimal places)`
      : `${currency} amounts support at most ${rule.maxDecimals} decimal places`;
  }
  if (Money.of(amount).lt(Money.of(rule.minAmount))) {
    return `${currency} amounts must be at least ${rule.minAmount}`;
  }
  return null;
}

/**
 * True when a URL points at THIS machine — a loopback or unspecified address.
 *
 * Such a URL is only ever reachable by the process that wrote it, so as a payer
 * redirect it dead-ends every customer, and as a webhook target it is an SSRF
 * shape we refuse at dispatch anyway.
 *
 * Verified against the live Whish sandbox: Whish itself answers a bare HTTP 403
 * (an HTML error page, not JSON) for `localhost` and `127.0.0.1` in any of the
 * four URLs it is given — which surfaced to companies as the opaque toast
 * "Whish returned a non-JSON response (HTTP 403)" long after the URL was saved.
 *
 * We go slightly BEYOND Whish here, and deliberately: Whish accepts `[::1]` and
 * `0.0.0.0`, but a payer's phone can no more reach those than it can localhost,
 * so accepting them just trades a clear error for a link that silently dies
 * after payment. Private LAN addresses (192.168.x, 10.x) are NOT rejected —
 * Whish accepts them and an intranet flow is at least conceivable.
 */
export function isLoopbackUrl(raw: string): boolean {
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return false; // not parseable — the .url() check reports that instead
  }
  // new URL() keeps IPv6 brackets and does NOT normalize an IPv4-mapped
  // address away: `[::ffff:127.0.0.1]` parses to `[::ffff:7f00:1]`. Strip the
  // brackets, the mapping prefix, and any trailing root dot (`localhost.`)
  // so every spelling of loopback lands on the same checks. (Decimal/hex
  // IPv4 forms like `http://2130706433/` are already normalized to 127.x by
  // the WHATWG parser itself.)
  const bare = host.replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const unmapped = bare.replace(/^::ffff:/, '');
  return (
    bare === 'localhost' ||
    bare.endsWith('.localhost') ||
    bare === '::1' ||
    bare === '::' ||
    unmapped === '0.0.0.0' ||
    /^127\./.test(unmapped) ||
    // IPv4-mapped loopback in hex-group form: ::ffff:7f00:1 (7f = 127).
    /^7f[0-9a-f]{2}:/.test(unmapped)
  );
}

// A customer-facing redirect URL. Must be a real http(s) URL (no javascript:,
// data:, etc.), bounded in length, and reachable by someone other than the
// machine that saved it. Used for where the PAYER lands after a Whish payment,
// and for the company's outbound webhook target.
export const redirectUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2048)
  .url('must be a valid URL')
  .refine((u) => /^https?:\/\//i.test(u), 'must start with http:// or https://')
  .refine(
    (u) => !isLoopbackUrl(u),
    'must be a publicly reachable address — localhost and 127.0.0.1 only work on your own machine, ' +
      'so your customers (and the payment provider) cannot open them. Use your real domain, or leave ' +
      'this empty to use the platform pages.',
  );

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

// Per-company outbound webhook config. The platform POSTs event data here
// server-side, so bound the URL the same way as the payer redirect URLs: a real
// http(s) URL of sane length (no `javascript:`/`data:`/garbage). Connection-level
// SSRF (private/loopback targets) is still enforced separately at dispatch time.
export const setWhishWebhookSchema = z.object({
  url: redirectUrlSchema,
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
  // Admin-only: filter to a single company. Ignored by the company-scoped list
  // (it always forces the session company).
  companyId: z.string().uuid().optional(),
  // ISO date strings — filter by created (createdAt) time.
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  // Fuzzy match across the invoice text, payer phone, and numeric reference —
  // so a company can find a link by an MT5 / OWM / order id buried in the
  // free-text invoice. Bounded like every other string filter (it feeds a LIKE).
  search: z.string().trim().max(200).optional(),
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
  // True when the payment is PAID at Whish but settlement into the ledger failed.
  // It needs operator attention — surfaced here so it's visible in the UI/API
  // instead of only in logs. Note: the 60s reconciler does NOT auto-retry a
  // needsAttention row; clearing it requires a manual refresh once the underlying
  // cause is fixed.
  needsAttention: z.boolean(),
  // The exact settlement failure reason (the thrown ingest error message) when
  // needsAttention is true; null otherwise. Lets the UI show the real cause rather
  // than a hard-coded guess.
  settlementError: z.string().nullable(),
  createdAt: z.string(),
  paidAt: z.string().nullable(),
  // When the payment was refunded to the payer (status REFUNDED); null otherwise.
  refundedAt: z.string().nullable(),
});
export type WhishPaymentResponse = z.infer<typeof whishPaymentResponseSchema>;

// Admin: refund a PAID payment to the payer through Whish. Always the full
// amount — Whish's refund call takes no amount. The reason is sent to Whish as
// `refundReason` and recorded on the reversal.
export const refundWhishPaymentSchema = z.object({
  reason: z.string().trim().min(3).max(255),
});
export type RefundWhishPaymentInput = z.infer<typeof refundWhishPaymentSchema>;
