import { z } from 'zod';
import { LedgerAccountType, LedgerDirection } from '../enums';
import { currencySchema } from './common';

export const listLedgerEntriesQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  currency: currencySchema.optional(),
  accountType: z.nativeEnum(LedgerAccountType).optional(),
  transactionId: z.string().uuid().optional(),
  withdrawalId: z.string().uuid().optional(),
  payoutId: z.string().uuid().optional(),
  loadId: z.string().uuid().optional(),
  // Inclusive ISO date-range bounds on createdAt, for period reconciliation and
  // the CSV export — same shape as the transactions list filter.
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
});
export type ListLedgerEntriesQuery = z.infer<typeof listLedgerEntriesQuerySchema>;

export const ledgerEntryResponseSchema = z.object({
  id: z.string().uuid(),
  companyId: z.string().uuid(),
  transactionId: z.string().uuid().nullable(),
  withdrawalId: z.string().uuid().nullable(),
  payoutId: z.string().uuid().nullable(),
  loadId: z.string().uuid().nullable(),
  accountType: z.nativeEnum(LedgerAccountType),
  direction: z.nativeEnum(LedgerDirection),
  amount: z.string(),
  currency: z.string(),
  metadata: z.record(z.unknown()).nullable(),
  createdAt: z.string(),
});
export type LedgerEntryResponse = z.infer<typeof ledgerEntryResponseSchema>;
