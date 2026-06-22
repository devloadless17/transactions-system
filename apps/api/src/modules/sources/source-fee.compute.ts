import { Money, type SourceFeeChannel } from '@app/shared';

/** The shape of a source_fee_rule row needed to price a deposit. */
export interface SourceFeeRuleRow {
  channel: string;
  minAmount: { toString(): string };
  maxAmount: { toString(): string } | null;
  feeType: string;
  feeValue: { toString(): string };
  active: boolean;
}

/**
 * The source fee a single deposit costs the platform, frozen at settlement.
 *
 * Picks the LOWEST-`min` active tier of `channel` whose `[min, max]` band
 * (both inclusive) contains `amount` — so at a touching boundary the lower tier
 * wins (e.g. with INGEST tiers [0,10] $1 and [10,∞] 1%, exactly $10 → the flat
 * $1 tier). Applies FIXED or PERCENTAGE and rounds ROUND_HALF_EVEN, identical to
 * how `commission_amount` is computed — so the whole money stack shares one
 * rounding discipline (this replaces the old SQL `round()` which was half-up).
 *
 * TOTAL by design: returns 0 when no tier matches and never throws, so it can be
 * computed in the deposit path without any risk of blocking a real settlement.
 */
export function computeSourceFee(
  rules: SourceFeeRuleRow[],
  channel: SourceFeeChannel,
  amount: Money,
): Money {
  const tier = rules
    .filter((r) => r.active && r.channel === channel)
    .filter((r) => {
      const min = Money.of(r.minAmount.toString());
      const withinMax = r.maxAmount === null || amount.lte(Money.of(r.maxAmount.toString()));
      return amount.gte(min) && withinMax;
    })
    .sort((a, b) => Money.of(a.minAmount.toString()).cmp(Money.of(b.minAmount.toString())))[0];

  if (!tier) return Money.zero();
  const fee =
    tier.feeType === 'FIXED'
      ? Money.of(tier.feeValue.toString())
      : amount.percent(tier.feeValue.toString());
  return fee.round();
}
