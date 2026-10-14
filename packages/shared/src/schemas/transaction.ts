import { z } from 'zod';
import { FeeApplication, TransactionStatus, WhishPaymentStatus } from '../enums';
import { currencySchema, moneyAmountSchema, quantizedAmountSchema } from './common';

// Money IN. A sub-cent amount is quantized, never rejected: the deposit already
// happened at the provider, so a 400 here would strand real money.
const decimalString = quantizedAmountSchema('in');

// Recognised fields inside the ingest payload. They are PLAIN STRINGS (not
// nested objects) so they're easy to read, display, and reason about — the
// `customer` who paid, the `target` they paid, a contact `phone`, and a free
// `note`. `.passthrough()` keeps any extra provider-specific keys (branch code,
// terminal id, OMT fields, …) the source attaches alongside them.
export const transactionPayloadSchema = z
  .object({
    customer: z.string().trim().max(200).optional(),
    target: z.string().trim().max(200).optional(),
    phone: z.string().trim().max(40).optional(),
    note: z.string().trim().max(1000).optional(),
  })
  .passthrough();
export type TransactionPayload = z.infer<typeof transactionPayloadSchema>;

// What external providers POST to /v1/ingest/transactions.
//
// The source is identified by the Authorization Bearer key. The body carries
// the target `companyId` + the transaction. Descriptive details (customer,
// target, phone, note, plus any extra provider keys) go under `payload`.
//
// Providers discover the available company ids via GET /v1/ingest/companies.
export const ingestTransactionSchema = z.object({
  companyId: z.string().uuid(),
  externalTransactionId: z.string().trim().min(1).max(200),
  amount: decimalString,
  currency: currencySchema,

  // Typed known fields (customer/target/phone/note) + passthrough extras.
  // Stored verbatim for audit.
  payload: transactionPayloadSchema.default({}),

  // Optional client-supplied idempotency key. If omitted, the
  // (sourceId, externalTransactionId) pair acts as one.
  idempotencyKey: z.string().trim().min(8).max(120).optional(),
});
export type IngestTransactionInput = z.infer<typeof ingestTransactionSchema>;

// --------------------------- manual deposit (admin) --------------------------
// A deposit a super admin enters by hand while its source is not yet sending it
// through the ingest API. It is booked through the SAME ingest path, so it is
// the same deposit. `externalTransactionId` must be the SOURCE's own reference:
// when the source later sends that deposit through the API, it is recognised
// as already booked and not credited twice.

// Blank form fields mean "not provided" — never stored as "".
const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : undefined));

export const manualDepositPreviewSchema = z.object({
  sourceId: z.string().uuid(),
  companyId: z.string().uuid(),
  // A human is typing it: whole cents, refused rather than silently rounded.
  amount: moneyAmountSchema,
  currency: currencySchema,
});
export type ManualDepositPreviewInput = z.infer<typeof manualDepositPreviewSchema>;

export const createManualDepositSchema = manualDepositPreviewSchema.extend({
  externalTransactionId: z.string().trim().min(1).max(200),
  // The same descriptive fields a source sends in its payload.
  customer: optionalText(200),
  target: optionalText(200),
  phone: optionalText(40),
  note: optionalText(1000),
});
export type CreateManualDepositInput = z.infer<typeof createManualDepositSchema>;

// What the deposit would book — the same pricing the booking uses.
export const manualDepositPreviewResponseSchema = z.object({
  amount: z.string(),
  currency: z.string(),
  feeApplication: z.nativeEnum(FeeApplication),
  commissionAmount: z.string(),
  networkFeeAmount: z.string(),
  // What the company's wallet is credited.
  netAmount: z.string(),
});
export type ManualDepositPreview = z.infer<typeof manualDepositPreviewResponseSchema>;

export const transactionResponseSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  sourceId: z.string().uuid(),
  sourceCode: z.string(),
  externalTransactionId: z.string(),
  amount: z.string(),
  currency: z.string(),
  commissionAmount: z.string(),
  // Optional per-company network fee taken on this deposit, next to the
  // commission. "0" when the company is not charged one.
  networkFeeAmount: z.string(),
  netAmount: z.string(),
  status: z.nativeEnum(TransactionStatus),
  // Refunded to the customer (a Whish refund). The status is then REVERSED, as
  // for an operator's reversal; these say the money also went back to the payer.
  refunded: z.boolean(),
  refundedAt: z.string().nullable(),
  // Descriptive fields lifted from the ingest payload (null when not provided).
  customer: z.string().nullable(),
  target: z.string().nullable(),
  phone: z.string().nullable(),
  note: z.string().nullable(),
  processedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type TransactionResponse = z.infer<typeof transactionResponseSchema>;

// Admin list rows also say which Whish Pay payment (if any) a deposit settled,
// so the Deposits page can offer Refund on exactly those and show a refunded
// one as such. Admin-only: company and source responses never carry it.
export const adminTransactionResponseSchema = transactionResponseSchema.extend({
  whishPayment: z
    .object({ id: z.string().uuid(), status: z.nativeEnum(WhishPaymentStatus) })
    .nullable(),
});
export type AdminTransactionResponse = z.infer<typeof adminTransactionResponseSchema>;

export const transactionDetailResponseSchema = z.object({
  transaction: transactionResponseSchema.extend({
    payload: z.record(z.unknown()).nullable(),
    idempotencyKey: z.string().nullable(),
  }),
  ledgerEntries: z.array(
    z.object({
      id: z.string().uuid(),
      accountType: z.string(),
      direction: z.string(),
      amount: z.string(),
      currency: z.string(),
      metadata: z.record(z.unknown()).nullable(),
      createdAt: z.string(),
    }),
  ),
});
export type TransactionDetailResponse = z.infer<typeof transactionDetailResponseSchema>;

// ----- Discovery endpoint -----
// External providers (Wish, OMT, ...) may call GET /v1/ingest/companies to
// discover which companies they can ingest for; they cache the slugs and use
// them as `companySlug` in the POST body. This is the SERVICE-side shape — the
// `id` here is internal and the ingest controller strips it at the HTTP
// boundary (company UUIDs are never exposed to sources; the wire item is just
// { slug, name, defaultCurrency }).
export const ingestCompanyListItemSchema = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  name: z.string(),
  defaultCurrency: z.string(),
});
export type IngestCompanyListItem = z.infer<typeof ingestCompanyListItemSchema>;

export const ingestCompanyListResponseSchema = z.object({
  data: z.array(ingestCompanyListItemSchema),
});
export type IngestCompanyListResponse = z.infer<typeof ingestCompanyListResponseSchema>;

export const listTransactionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.nativeEnum(TransactionStatus).optional(),
  sourceId: z.string().uuid().optional(),
  currency: currencySchema.optional(),
  // Admin-only: filter by company.
  companyId: z.string().uuid().optional(),
  // ISO date strings.
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  // Free text: the source's reference, the id, the payer's phone (typed any
  // way), customer, target or note. Bounded like every other string filter (it
  // feeds a LIKE and a cache key).
  search: z.string().trim().max(200).optional(),
});
export type ListTransactionsQuery = z.infer<typeof listTransactionsQuerySchema>;
