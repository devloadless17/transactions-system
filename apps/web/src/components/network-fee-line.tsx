import { formatAmount, isPositiveAmount } from '@/lib/format';

/**
 * The optional network fee as a muted second line under a fee figure
 * ("+ 1.00 network"). Renders nothing unless it is > 0, so for a company that
 * is not charged one the cell renders exactly as before — drop it in beside the
 * existing value: `<>{fee}<NetworkFeeLine amount={x.networkFeeAmount} /></>`.
 */
export function NetworkFeeLine({ amount }: { amount: string | null | undefined }) {
  if (!isPositiveAmount(amount)) return null;
  return (
    <div className="whitespace-nowrap text-xs text-muted-foreground">
      + {formatAmount(amount)} network
    </div>
  );
}
