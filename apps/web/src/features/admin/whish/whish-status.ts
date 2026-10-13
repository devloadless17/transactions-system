import type { WhishPaymentResponse } from '@app/shared';

/** Badge colour for a Whish payment status — shared by the admin and company views. */
export function whishStatusVariant(s: WhishPaymentResponse['status']) {
  if (s === 'PAID') return 'success' as const;
  if (s === 'FAILED' || s === 'EXPIRED') return 'destructive' as const;
  // Money went back to the payer on purpose: worth noticing, not a failure.
  if (s === 'REFUNDED') return 'warning' as const;
  return 'secondary' as const;
}
