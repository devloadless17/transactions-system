import type { StreamableFile } from '@nestjs/common';
import { Money } from '@app/shared';
import { streamCsvKeyset } from './csv';

// Shared CSV projection for the three sibling money-movement flows
// (withdrawal / payout / load) — they have an identical row shape, so one
// header + one cell projector keeps every export consistent.
export const FLOW_CSV_HEADER = [
  'id',
  'created_at',
  'processed_at',
  'company_id',
  'status',
  'currency',
  'amount',
  'fee_amount',
  'net_amount',
  'total_amount',
  'fee_application',
  'payout_method',
  'external_reference',
  'recipient_name',
  'recipient_contact',
  'notes',
  'admin_notes',
] as const;

// One persisted withdrawal/payout/load row (the fields the three Prisma models
// share). Typed structurally so the same projector serves all three.
export interface FlowCsvRow {
  id: string;
  companyId: string;
  amount: { toString(): string };
  currency: string;
  feeAmount: { toString(): string };
  netAmount: { toString(): string };
  feeApplication: string;
  status: string;
  payoutMethod: string;
  payoutDetails: unknown;
  externalReference: string | null;
  notes: string | null;
  adminNotes: string | null;
  processedAt: Date | null;
  createdAt: Date;
}

// Best-effort recipient name + contact across the payout-method variants
// (cash/Whish → name + phone; crypto → network + wallet; bank → holder +
// account; other → description). Reads the JSON detail defensively.
function recipient(details: unknown): { name: string; contact: string } {
  if (!details || typeof details !== 'object') return { name: '', contact: '' };
  const d = details as Record<string, string | undefined>;
  return {
    name: d.recipientName ?? d.accountHolder ?? d.network ?? d.description ?? '',
    contact: d.recipientPhone ?? d.walletAddress ?? d.accountNumber ?? d.bankName ?? '',
  };
}

export function flowCsvCells(r: FlowCsvRow): Array<string | null> {
  const rec = recipient(r.payoutDetails);
  // total = net + fee (the money that actually moves); matches the API response.
  const total = Money.of(r.netAmount.toString()).add(Money.of(r.feeAmount.toString())).toString();
  return [
    r.id,
    r.createdAt.toISOString(),
    r.processedAt?.toISOString() ?? '',
    r.companyId,
    r.status,
    r.currency.trim(),
    r.amount.toString(),
    r.feeAmount.toString(),
    r.netAmount.toString(),
    total,
    r.feeApplication,
    r.payoutMethod,
    r.externalReference ?? '',
    rec.name,
    rec.contact,
    r.notes ?? '',
    r.adminNotes ?? '',
  ];
}

/**
 * Stream a flow list (withdrawals/payouts/loads) as CSV using the shared keyset
 * walker. The caller supplies the base `where` (built exactly like its list
 * query) and a page fetcher; this adds the keyset predicate, ordering and limit.
 */
export function streamFlowCsv(opts: {
  noun: string;
  baseWhere: Record<string, unknown>;
  findPage: (pageWhere: Record<string, unknown>, take: number) => Promise<FlowCsvRow[]>;
  now: number;
}): StreamableFile {
  return streamCsvKeyset<FlowCsvRow>({
    filename: `${opts.noun}-${opts.now}.csv`,
    header: FLOW_CSV_HEADER,
    fetchPage: (cursor, take) => {
      const pageWhere = cursor
        ? {
            ...opts.baseWhere,
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: cursor.id } },
            ],
          }
        : opts.baseWhere;
      return opts.findPage(pageWhere, take);
    },
    cursorOf: (r) => ({ createdAt: r.createdAt, id: r.id }),
    toCells: flowCsvCells,
  });
}
