import type { ActivityItem } from '@app/shared';

/**
 * The figure a unified-activity row leads with (list row + detail drawer).
 *
 * Every row carries gross = fee + net. Withdrawals lead with the NET, because
 * that is the figure companies have always read here — for an on-top fee it is
 * the amount they requested (5,000 with "fee 125" beneath, which together make
 * the 5,125 actually debited), and it stays truthful for a deducted fee too,
 * where net + fee is again exactly the debit. Every other kind leads with the
 * gross that moved.
 *
 * Presentation only: the drawer's Amount/Fee/Net summary and the CSV export
 * always carry the full gross/fee/net split, so nothing here hides the fee.
 */
export function activityHeadlineAmount(item: ActivityItem): string {
  return item.kind === 'WITHDRAWAL' ? item.net : item.amount;
}
