import type { ActivityItem } from '@app/shared';

/**
 * The figure a unified-activity row leads with (list row + detail drawer).
 *
 * Every row carries gross = fee + network fee + net (the network fee is "0"
 * for a company that is not charged one). Withdrawals lead with the NET,
 * because that is the figure companies have always read here — for on-top fees
 * it is the amount they requested (5,000 with "fee 125" beneath, which together
 * make the 5,125 actually debited), and it stays truthful for deducted fees
 * too, where net + fee + network fee is again exactly the debit. Every other
 * kind leads with the gross that moved.
 *
 * Presentation only: the drawer's Amount/Fee/Net summary and the CSV export
 * always carry the full gross/fee/net split, so nothing here hides the fee.
 */
export function activityHeadlineAmount(item: ActivityItem): string {
  return item.kind === 'WITHDRAWAL' ? item.net : item.amount;
}

/**
 * The one figure BACKOFFICE sees for a row — the same "Amount" its deposits,
 * withdrawals, payouts and loads lists show, and never a fee: what the customer
 * paid (deposit), what the recipient is paid (withdrawal/payout), what is
 * collected (load). The API sends back office exactly that figure in `amount`
 * and strips fee/networkFee/net (common/backoffice-view.ts).
 */
export function backofficeActivityAmount(item: ActivityItem): string {
  return item.amount;
}

/**
 * The one figure BACKOFFICE sees on a withdrawal / payout / load RECORD (the
 * detail drawers): what is collected for a load (`totalAmount`), what the
 * recipient is paid for a withdrawal or payout (`netAmount`). The API sends
 * back office only that one of the pair and strips the other
 * (common/backoffice-view.ts), so a record that lacks the figure its kind calls
 * for falls back to the one it does carry — its own single figure — and can
 * never render "—" while it has one.
 */
export function backofficeFlowAmount(
  record: { totalAmount?: string | null; netAmount?: string | null },
  isLoad: boolean,
): string | null | undefined {
  return isLoad
    ? (record.totalAmount ?? record.netAmount)
    : (record.netAmount ?? record.totalAmount);
}
