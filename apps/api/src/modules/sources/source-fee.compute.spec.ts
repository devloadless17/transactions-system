import { describe, expect, it } from 'vitest';
import { Money, SourceFeeChannel } from '@app/shared';
import { computeSourceFee, type SourceFeeRuleRow } from './source-fee.compute';

// A row factory mirroring the source_fee_rule columns computeSourceFee reads.
// minAmount/maxAmount/feeValue are stored as strings here; the production rows
// arrive as Prisma Decimals but the function only relies on `.toString()`.
function rule(overrides: Partial<SourceFeeRuleRow>): SourceFeeRuleRow {
  return {
    channel: SourceFeeChannel.INGEST,
    minAmount: '0',
    maxAmount: null,
    feeType: 'PERCENTAGE',
    feeValue: '1',
    active: true,
    ...overrides,
  };
}

describe('computeSourceFee', () => {
  it('at a touching [min,max] boundary the LOWEST-min tier wins', () => {
    // INGEST tiers [0,10] flat $1 and [10,∞] 1%. Both bands include exactly $10
    // (inclusive ends), so the lower-min flat tier must win → $1, not 10c.
    // Declared high-tier-first so the result only holds if we sort ascending.
    const rules: SourceFeeRuleRow[] = [
      { ...rule({ minAmount: '10', maxAmount: null, feeType: 'PERCENTAGE', feeValue: '1' }) },
      { ...rule({ minAmount: '0', maxAmount: '10', feeType: 'FIXED', feeValue: '1' }) },
    ];
    const fee = computeSourceFee(rules, SourceFeeChannel.INGEST, Money.of('10'));
    // Lowest-min (flat $1) tier — NOT the 1% tier ($0.10). Flipping the sort
    // direction would pick the 1% tier and break this.
    expect(fee.toString()).toBe('1');
  });

  it('only matches tiers of the requested channel', () => {
    // A WHISH_PAY tier that would otherwise match the amount must be ignored
    // when pricing an INGEST deposit, and vice-versa.
    const rules: SourceFeeRuleRow[] = [
      rule({ channel: SourceFeeChannel.INGEST, minAmount: '0', feeType: 'FIXED', feeValue: '1' }),
      rule({
        channel: SourceFeeChannel.WHISH_PAY,
        minAmount: '0',
        feeType: 'FIXED',
        feeValue: '5',
      }),
    ];
    expect(computeSourceFee(rules, SourceFeeChannel.INGEST, Money.of('100')).toString()).toBe('1');
    expect(computeSourceFee(rules, SourceFeeChannel.WHISH_PAY, Money.of('100')).toString()).toBe(
      '5',
    );
  });

  it('returns 0 when no tier of the channel matches', () => {
    // Only a WHISH_PAY tier exists; an INGEST lookup has nothing to match.
    const rules: SourceFeeRuleRow[] = [
      rule({
        channel: SourceFeeChannel.WHISH_PAY,
        minAmount: '0',
        feeType: 'FIXED',
        feeValue: '5',
      }),
    ];
    const fee = computeSourceFee(rules, SourceFeeChannel.INGEST, Money.of('100'));
    expect(fee.eq(Money.zero())).toBe(true);
    expect(fee.toString()).toBe('0');
  });

  it('applies a FIXED fee verbatim regardless of amount', () => {
    const rules: SourceFeeRuleRow[] = [
      rule({ minAmount: '0', maxAmount: null, feeType: 'FIXED', feeValue: '2.5' }),
    ];
    expect(computeSourceFee(rules, SourceFeeChannel.INGEST, Money.of('1000')).toString()).toBe(
      '2.5',
    );
  });

  it('applies a PERCENTAGE fee as a percent of the amount', () => {
    const rules: SourceFeeRuleRow[] = [
      rule({ minAmount: '0', maxAmount: null, feeType: 'PERCENTAGE', feeValue: '2.5' }),
    ];
    // 2.5% of 200 = 5.
    expect(computeSourceFee(rules, SourceFeeChannel.INGEST, Money.of('200')).toString()).toBe('5');
  });

  it('rounds the fee ROUND_HALF_EVEN (banker’s), not half-up', () => {
    // Half-even matters most on an exact half. 50% of 0.05 = 0.025 → at the cent
    // scale the preceding digit (2) is EVEN, so it stays: 0.02. Half-up would
    // give 0.03, and biasing every such fee upward would quietly overcharge.
    const halfRules: SourceFeeRuleRow[] = [
      rule({ minAmount: '0', maxAmount: null, feeType: 'PERCENTAGE', feeValue: '50' }),
    ];
    expect(computeSourceFee(halfRules, SourceFeeChannel.INGEST, Money.of('0.05')).toString()).toBe(
      '0.02',
    );

    // 50% of 0.07 = 0.035 → preceding digit (3) is ODD, so it rounds up: 0.04.
    // Together these two pin the *even* rule rather than a fixed direction.
    expect(computeSourceFee(halfRules, SourceFeeChannel.INGEST, Money.of('0.07')).toString()).toBe(
      '0.04',
    );

    // A sub-basis-point RATE keeps its precision — only the resulting money is
    // quantized. 0.125% of 1000 is exactly 1.25.
    const rateRules: SourceFeeRuleRow[] = [
      rule({ minAmount: '0', maxAmount: null, feeType: 'PERCENTAGE', feeValue: '0.125' }),
    ];
    expect(computeSourceFee(rateRules, SourceFeeChannel.INGEST, Money.of('1000')).toString()).toBe(
      '1.25',
    );
  });

  it('matches the open-ended top tier for arbitrarily large amounts', () => {
    // [0,100] flat $1 then [100,∞] 1%. An amount well past 100 must use the
    // null-max top tier.
    const rules: SourceFeeRuleRow[] = [
      rule({ minAmount: '0', maxAmount: '100', feeType: 'FIXED', feeValue: '1' }),
      rule({ minAmount: '100', maxAmount: null, feeType: 'PERCENTAGE', feeValue: '1' }),
    ];
    // 1% of 1_000_000 = 10_000.
    expect(computeSourceFee(rules, SourceFeeChannel.INGEST, Money.of('1000000')).toString()).toBe(
      '10000',
    );
  });

  it('ignores inactive tiers and amounts outside every band', () => {
    const rules: SourceFeeRuleRow[] = [
      // Would match $50 but is inactive.
      rule({ minAmount: '0', maxAmount: '100', feeType: 'FIXED', feeValue: '9', active: false }),
      // Active but band [200,300] excludes $50.
      rule({ minAmount: '200', maxAmount: '300', feeType: 'FIXED', feeValue: '3' }),
    ];
    expect(computeSourceFee(rules, SourceFeeChannel.INGEST, Money.of('50')).toString()).toBe('0');
  });

  it('is DETERMINISTIC for a (mis)configured equal-min pair, regardless of row order', () => {
    // Two active INGEST tiers sharing the same min ($0) — an overlap the schema
    // should reject, but the pricing function must still be deterministic if it
    // ever occurs. The higher fee wins so cost is never understated, and the
    // result is independent of the order the rows arrive in.
    const lo = rule({ minAmount: '0', maxAmount: '100', feeType: 'FIXED', feeValue: '1' });
    const hi = rule({ minAmount: '0', maxAmount: '100', feeType: 'FIXED', feeValue: '5' });
    expect(computeSourceFee([lo, hi], SourceFeeChannel.INGEST, Money.of('50')).toString()).toBe(
      '5',
    );
    expect(computeSourceFee([hi, lo], SourceFeeChannel.INGEST, Money.of('50')).toString()).toBe(
      '5',
    );
  });
});
