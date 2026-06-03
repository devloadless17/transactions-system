import { z } from 'zod';
import { TransactionStatus } from '../enums';
import { currencySchema, moneyAmountSchema } from './common';

const decimalString = moneyAmountSchema;

// What external providers POST to /v1/ingest/transactions.
//
// The source is identified by the Authorization Bearer key. The body
// carries the target `companyId` + the transaction. Anything else the
// provider wants to attach (customer phone/name, target, note, branch
// code, terminal id, OMT-specific fields, …) goes under the free-form
// `payload`.
//
// Providers discover the available company ids via GET /v1/ingest/companies.
export const ingestTransactionSchema = z.object({
  companyId: z.string().uuid(),
  externalTransactionId: z.string().trim().min(1).max(200),
  amount: decimalString,
  currency: currencySchema,

  // Free-form catchall. Stored verbatim for audit.
  payload: z.record(z.unknown()).default({}),

  // Optional client-supplied idempotency key. If omitted, the
  // (sourceId, externalTransactionId) pair acts as one.
  idempotencyKey: z.string().trim().min(8).max(120).optional(),
});
export type IngestTransactionInput = z.infer<typeof ingestTransactionSchema>;

export const transactionResponseSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  sourceId: z.string().uuid(),
  sourceCode: z.string(),
  externalTransactionId: z.string(),
  amount: z.string(),
  currency: z.string(),
  commissionAmount: z.string(),
  netAmount: z.string(),
  status: z.nativeEnum(TransactionStatus),
  processedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type TransactionResponse = z.infer<typeof transactionResponseSchema>;

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
// External providers (Wish, OMT, ...) call GET /v1/ingest/companies once on
// startup to discover which companies they can ingest for. They cache the
// ids and use them as `companyId` in the POST body. `slug` and `name` are
// returned for human-friendly display only.
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
  // Fuzzy: matches externalTransactionId.
  search: z.string().trim().optional(),
});
export type ListTransactionsQuery = z.infer<typeof listTransactionsQuerySchema>;
