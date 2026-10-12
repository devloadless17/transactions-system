import { formatAmount } from '@/lib/format';

/**
 * The pure half of the admin review dialog (withdrawals / payouts / loads): the
 * sentence that tells the operator what approving or rejecting means, and the
 * toast once it is done. Kept out of the component so what each role is told is
 * unit-tested (review-copy.spec.ts) — back office must never be told a fee
 * exists, nor be shown a figure the API does not send it.
 */

export type ReviewAction = 'approve' | 'reject';

// Past tense for the success toast, spelled out per action: appending "d" to the
// action only works for "approve" ("reject" + "d" reads "rejectd").
const ACTION_DONE: Record<ReviewAction, string> = {
  approve: 'approved',
  reject: 'rejected',
};

/** Success toast for a settled review, e.g. "Withdrawal approved" / "Load rejected". */
export function reviewDoneMessage(noun: string, action: ReviewAction): string {
  return `${noun.charAt(0).toUpperCase()}${noun.slice(1)} ${ACTION_DONE[action]}`;
}

/**
 * The instruction at the top of the review dialog.
 *
 * Full admins get both sides of the split. BACKOFFICE gets the same instruction
 * built from the ONE figure the API sends it for that kind — `totalAmount` to
 * collect for a load, `netAmount` to pay for a withdrawal or payout; the rest is
 * stripped server-side (common/backoffice-view.ts) — and no mention of a fee, of
 * the amount the wallet is credited, or of the amount that was reserved: any of
 * those next to its figure would reveal the fee.
 */
export function reviewDescription(args: {
  action: ReviewAction;
  // Loads are INbound (collected from the company); withdrawals and payouts are
  // OUTbound (paid to the recipient).
  isLoad: boolean;
  backoffice: boolean;
  // Full admins only: a network fee was charged next to the commission.
  hasNetworkFee: boolean;
  // The reviewed row. Back office's carries only one of the two figures.
  withdrawal: { totalAmount?: string | null; netAmount?: string | null; currency: string };
}): string {
  const { action, isLoad, backoffice, hasNetworkFee, withdrawal: w } = args;

  if (backoffice) {
    const amount = `${formatAmount(isLoad ? w.totalAmount : w.netAmount)} ${w.currency}`;
    if (action === 'approve') {
      return isLoad
        ? `Confirm you received ${amount} from the company, then approve to credit their wallet.`
        : `Pay the recipient ${amount} out-of-band, then record the reference here.`;
    }
    return isLoad
      ? `The ${amount} will not be collected, and the company's wallet is not credited.`
      : `The recipient will not be paid ${amount}, and the company keeps its funds.`;
  }

  if (action === 'approve') {
    return isLoad
      ? // INbound: the operator collects the gross (incl. fee) from the
        // company, then approves to credit the wallet with the net.
        `Confirm you received ${formatAmount(w.totalAmount)} ${w.currency} (${hasNetworkFee ? 'fees' : 'fee'} included) from the company, then approve to credit their wallet with ${formatAmount(w.netAmount)} ${w.currency}.`
      : // OUTbound: the operator pays the recipient the net; the system
        // already deducted the fee from the wallet.
        `Pay the recipient ${formatAmount(w.netAmount)} ${w.currency} out-of-band (${hasNetworkFee ? 'the fees are' : 'the fee is'} already deducted), then record the reference here.`;
  }
  return `Reserved ${formatAmount(w.totalAmount)} ${w.currency} returns to available.`;
}
