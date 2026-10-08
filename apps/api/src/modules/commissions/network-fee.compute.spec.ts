import { describe, expect, it } from 'vitest';
import { Money } from '@app/shared';
import { CommissionResolverService } from './commission-resolver.service';
import { boundDepositNetworkFee, computeNetworkFee, type NetworkFeeRate } from './network-fee';

const pct = (feeValue: string): NetworkFeeRate => ({ feeType: 'PERCENTAGE', feeValue });
const fixed = (feeValue: string): NetworkFeeRate => ({ feeType: 'FIXED', feeValue });

describe('computeNetworkFee', () => {
  it("prices the tech lead's example: 1% of $100 is $1", () => {
    expect(computeNetworkFee(Money.of('100'), pct('1')).toString()).toBe('1');
  });

  it('no rate (switch off, or flow not charged) is 0', () => {
    expect(computeNetworkFee(Money.of('100'), null).isZero()).toBe(true);
  });

  // Quantized ONCE to cents, half-even — never a sub-cent figure on a ledger leg.
  it.each([
    ['100.00', '0.125', '0.12'], // 0.125 → half-even down
    ['12.00', '0.125', '0.02'], // 0.015 → half-even up
    ['4.00', '0.125', '0'], // 0.005 → half-even down to 0 (no leg booked)
    ['0.50', '1', '0'], // 0.005 → 0
    ['1.50', '1', '0.02'], // 0.015 → 0.02
    ['2.50', '1', '0.02'], // 0.025 → 0.02
    ['33.33', '3.333333', '1.11'],
    ['250.50', '2.5', '6.26'], // 6.2625 → 6.26
  ])('%s at %s%% → %s', (amount, rate, expected) => {
    const fee = computeNetworkFee(Money.of(amount), pct(rate));
    expect(fee.toString()).toBe(expected);
    expect(fee.isAtScale()).toBe(true);
  });

  it('a FIXED fee is its dollar value whatever the amount', () => {
    expect(computeNetworkFee(Money.of('3'), fixed('2')).toString()).toBe('2');
    expect(computeNetworkFee(Money.of('5000'), fixed('0.5')).toString()).toBe('0.5');
  });

  // Same formula as the commission, by construction: a network fee of X is
  // priced exactly like a commission rule of X. Proven against the real
  // resolver rather than restated.
  it('matches the commission formula for every amount × rate', () => {
    const resolver = new CommissionResolverService();
    for (const amount of [
      '0.01',
      '0.99',
      '1.00',
      '9.99',
      '18.67',
      '100.00',
      '123.45',
      '12345.67',
    ]) {
      for (const rate of [
        pct('0.125'),
        pct('1'),
        pct('3.333333'),
        pct('50'),
        fixed('0.01'),
        fixed('2'),
      ]) {
        const res = resolver.resolveOptional({
          companyId: 'co',
          sourceId: null,
          operationType: 'TRANSACTION',
          amount: Money.of(amount),
          rules: [
            {
              id: 'r',
              companyId: null,
              sourceId: null,
              operationType: 'TRANSACTION',
              feeApplication: 'ON_TOP', // ON_TOP: never capped, so the raw formula shows
              minAmount: '0',
              maxAmount: null,
              commissionType: rate.feeType,
              commissionValue: rate.feeValue,
              priority: 0,
              active: true,
            },
          ],
        });
        expect(computeNetworkFee(Money.of(amount), rate).toExactString()).toBe(
          res!.commissionAmount.toExactString(),
        );
      }
    }
  });
});

describe('boundDepositNetworkFee', () => {
  const bound = (
    amount: string,
    commission: string,
    computed: string,
    app: 'DEDUCTED' | 'ON_TOP' = 'DEDUCTED',
  ) =>
    boundDepositNetworkFee({
      amount: Money.of(amount),
      commission: Money.of(commission),
      feeApplication: app,
      computed: Money.of(computed),
    });

  it('leaves a network fee that fits untouched', () => {
    const r = bound('100', '2', '1');
    expect(r.network.toString()).toBe('1');
    expect(r.capped).toBe(false);
  });

  it('a fee that exactly uses what the commission leaves is not "capped"', () => {
    const r = bound('3', '2', '1');
    expect(r.network.toString()).toBe('1');
    expect(r.capped).toBe(false);
  });

  it('caps a DEDUCTED network fee at what the commission leaves (net 0, deposit still books)', () => {
    // A 0.50 deposit, 0.10 commission, FIXED 1.00 network fee.
    const r = bound('0.50', '0.10', '1');
    expect(r.network.toString()).toBe('0.4');
    expect(r.capped).toBe(true);
  });

  it('takes nothing when the commission already uses the whole deposit', () => {
    const r = bound('2', '2', '0.02');
    expect(r.network.isZero()).toBe(true);
    expect(r.capped).toBe(true);
  });

  it('a zero network fee is never "capped", even with no room', () => {
    const r = bound('2', '2', '0');
    expect(r.network.isZero()).toBe(true);
    expect(r.capped).toBe(false);
  });

  it('never bounds an ON_TOP fee (it is charged on top of the amount)', () => {
    const r = bound('0.50', '0.10', '1', 'ON_TOP');
    expect(r.network.toString()).toBe('1');
    expect(r.capped).toBe(false);
  });

  it('net = amount − commission − network is never negative', () => {
    for (const amount of ['0.01', '0.50', '1', '2', '10', '100']) {
      for (const commission of ['0', '0.01', '0.5', '1', '2']) {
        if (Money.of(commission).gt(Money.of(amount))) continue;
        for (const computed of ['0', '0.01', '1', '5', '100']) {
          const { network } = bound(amount, commission, computed);
          const net = Money.of(amount).sub(Money.of(commission)).sub(network);
          expect(net.isNegative(), `${amount}/${commission}/${computed}`).toBe(false);
        }
      }
    }
  });
});
