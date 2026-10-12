import type { StreamableFile } from '@nestjs/common';
import { Money } from '@app/shared';
import { streamCsvKeyset } from './csv';
import { grossOf, storedFees } from '../modules/ledger/flow-ledger';
import { BACKOFFICE_CSV_COLUMNS, backofficeCsvCells } from './backoffice-view';

// Shared CSV projection for the three sibling money-movement flows
// (withdrawal / payout / load) — they have an identical row shape, so one
// header + one cell projector keeps every export consistent.
// Columns mirror what the app's own table shows (Debited/You-pay · Fee ·
// Recipient-gets/Credited) so the export can't be misread. We deliberately do
// NOT emit the raw requested `amount`: for an ON_TOP fee it equals the net and
// for a DEDUCTED fee it equals the gross, so a bare `amount` column silently
// duplicates one of the others depending on fee_application. `gross_amount` is
// the money that actually moves (net + fee + network fee); `net_amount` is what
// the recipient receives; `fee_application` says how the fees were applied.
export const FLOW_CSV_HEADER = [
  'id',
  'created_at',
  'processed_at',
  'company_id',
  'status',
  'currency',
  'gross_amount',
  'fee_amount',
  'net_amount',
  'fee_application',
  'payout_method',
  'external_reference',
  'recipient_name',
  'recipient_contact',
  'notes',
  'admin_notes',
  // The optional per-company network fee (0.00 when not charged). Appended last
  // so every existing column keeps its position for anyone already parsing it.
  'network_fee_amount',
] as const;

// One persisted withdrawal/payout/load row (the fields the three Prisma models
// share). Typed structurally so the same projector serves all three.
export interface FlowCsvRow {
  id: string;
  companyId: string;
  amount: { toString(): string };
  currency: string;
  feeAmount: { toString(): string };
  networkFeeAmount: { toString(): string };
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
// TWIN: the unified activity export derives the same two columns in SQL —
// FLOW_RECIPIENT_SQL in ../modules/activity/activity.service.ts. Keep the
// fallback ORDER identical in both places or the per-flow CSVs and the
// activity CSV will disagree about the same row's counterparty.
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
  // gross = net + fee + network fee = the money that actually moves (debited for
  // a withdrawal/payout, paid in for a load); matches the API's totalAmount and
  // the app's "Debited" / "You pay" column.
  // Built from the SAME quantized parts the API reports, so gross == totalAmount
  // and gross == fee + network fee + net in the exported columns. Quantizing each
  // part and then summing is safe here precisely because a sum of at-scale values
  // is at scale — unlike rounding a total and its parts independently, which
  // would not tie out.
  const fees = storedFees(r.feeAmount, r.networkFeeAmount);
  const { commission: fee, network: networkFee } = fees;
  const net = Money.fromDb(r.netAmount);
  const gross = grossOf(net, fees).toFixed(2);
  return [
    r.id,
    r.createdAt.toISOString(),
    r.processedAt?.toISOString() ?? '',
    r.companyId,
    r.status,
    r.currency.trim(),
    gross,
    fee.toFixed(2),
    net.toFixed(2),
    r.feeApplication,
    r.payoutMethod,
    r.externalReference ?? '',
    rec.name,
    rec.contact,
    r.notes ?? '',
    r.adminNotes ?? '',
    networkFee.toFixed(2),
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
  /**
   * Back office sees one money figure per row and nothing a fee could be
   * derived from (common/backoffice-view.ts): 'pay' keeps net_amount (what a
   * withdrawal/payout recipient is paid), 'collect' keeps gross_amount (what a
   * load collects). Every other money cell is blanked; the header is unchanged.
   */
  backoffice?: 'pay' | 'collect';
}): StreamableFile {
  const backoffice = opts.backoffice;
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
    toCells: backoffice
      ? (r) =>
          backofficeCsvCells(
            FLOW_CSV_HEADER,
            flowCsvCells(r),
            BACKOFFICE_CSV_COLUMNS.flow[backoffice],
          )
      : flowCsvCells,
  });
}
