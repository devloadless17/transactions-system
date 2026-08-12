import { describe, expect, it } from 'vitest';
import { Money, MONEY_SCALE } from '@app/shared';

describe('Money', () => {
  describe('construction and equality', () => {
    it('parses string, number, and decimal inputs identically', () => {
      expect(Money.of('1.50').eq(Money.of(1.5))).toBe(true);
      expect(Money.of('0').isZero()).toBe(true);
      expect(Money.zero().isZero()).toBe(true);
    });

    it('preserves precision past JS float limits', () => {
      const a = Money.of('0.1');
      const b = Money.of('0.2');
      // 0.1 + 0.2 === 0.3 in decimal arithmetic (unlike JS floats).
      expect(a.add(b).eq(Money.of('0.3'))).toBe(true);
    });

    it('persists at the platform money scale (whole cents)', () => {
      const v = Money.of('123.45678901234567');
      // Half-even at 2 dp: the digit after the cent is 6, so it rounds up.
      expect(v.toString()).toBe('123.46');
    });

    it('keeps full precision in flight — only persistence quantizes', () => {
      // 0.125% of 1000 is 1.25 exactly; the RATE never gets rounded to 2 dp,
      // which is what makes sub-basis-point pricing expressible.
      expect(Money.of('1000').percent('0.125').toString()).toBe('1.25');
    });
  });

  describe('arithmetic', () => {
    it('add/sub/mul/div preserve sign', () => {
      const ten = Money.of('10');
      const three = Money.of('3');
      expect(ten.add(three).toString()).toBe('13');
      expect(ten.sub(three).toString()).toBe('7');
      expect(three.mul(4).toString()).toBe('12');
      expect(ten.div(4).toString()).toBe('2.5');
    });

    it('percent applies fractional percentages correctly', () => {
      expect(Money.of('200').percent('2.5').toString()).toBe('5');
      expect(Money.of('1000').percent('0.1').toString()).toBe('1');
    });

    it('mul by -1 flips sign and isNegative reports correctly', () => {
      const neg = Money.of('5').mul(-1);
      expect(neg.isNegative()).toBe(true);
      expect(neg.isPositive()).toBe(false);
      expect(neg.toString()).toBe('-5');
    });
  });

  describe('rounding', () => {
    it('uses bankers rounding (half-to-even)', () => {
      // 1.005 at 2 dp -> 1.00 (banker's) not 1.01
      expect(Money.of('1.005').toFixed(2)).toBe('1.00');
      // 1.015 at 2 dp -> 1.02 (banker's)
      expect(Money.of('1.015').toFixed(2)).toBe('1.02');
    });

    it('round() clamps to MONEY_SCALE', () => {
      const long = Money.of('1.123456789012345');
      expect(long.round().toString().split('.')[1]?.length).toBeLessThanOrEqual(MONEY_SCALE);
    });
  });

  describe('comparison', () => {
    it('gte/lte boundary cases', () => {
      const a = Money.of('100');
      expect(a.gte(Money.of('100'))).toBe(true);
      expect(a.lte(Money.of('100'))).toBe(true);
      expect(a.gt(Money.of('100'))).toBe(false);
      expect(a.lt(Money.of('100'))).toBe(false);
    });

    it('cmp returns -1/0/1', () => {
      expect(Money.of('1').cmp(Money.of('2'))).toBe(-1);
      expect(Money.of('2').cmp(Money.of('1'))).toBe(1);
      expect(Money.of('1').cmp(Money.of('1'))).toBe(0);
    });
  });

  describe('isZero / isPositive edge cases', () => {
    it('zero is neither positive nor negative', () => {
      const z = Money.zero();
      expect(z.isZero()).toBe(true);
      expect(z.isPositive()).toBe(false);
      expect(z.isNegative()).toBe(false);
    });

    it('one cent is still positive at the money scale', () => {
      const tiny = Money.of('0.01');
      expect(tiny.isPositive()).toBe(true);
      expect(tiny.isZero()).toBe(false);
    });

    it('sub-cent values round to zero', () => {
      expect(Money.of('0.001').round().isZero()).toBe(true);
    });

    it('floorToScale never rounds a balance UP past what is held', () => {
      // Half-even would give 10.01 and let a flow reserve money that is not there.
      expect(Money.of('10.005').floorToScale().toString()).toBe('10');
      expect(Money.of('10.009').floorToScale().toString()).toBe('10');
    });

    it('a sub-cent debt floors to zero, so it cannot deadlock money-out', () => {
      // Money-out blocks while a debt is outstanding, and a load settles it. Both
      // sides floor, so a residue below one cent is not "outstanding" to either:
      // it neither blocks a withdrawal nor needs a load to clear it. If the two
      // sides disagreed, such a residue would block every withdrawal forever with
      // no path to clear it.
      expect(Money.of('0.004').floorToScale().isPositive()).toBe(false);
      expect(Money.of('0.009').floorToScale().isPositive()).toBe(false);
      // A real, payable debt still blocks.
      expect(Money.of('0.01').floorToScale().isPositive()).toBe(true);
    });

    it('ceilToScale clears a sub-cent debt completely', () => {
      // Flooring would leave a remainder that stays isPositive() forever and
      // keeps blocking money-out.
      expect(Money.of('0.001').ceilToScale().toString()).toBe('0.01');
    });

    it('isAtScale distinguishes a persistable amount from an over-precise one', () => {
      expect(Money.of('10.05').isAtScale()).toBe(true);
      expect(Money.of('10.055').isAtScale()).toBe(false);
    });

    it('toExactString keeps every digit, unlike toString', () => {
      const legacy = Money.of('10.00500000');
      // Exactly half a cent, so BANKER'S rounding applies: the preceding digit
      // (0) is even, so it stays put rather than rounding up. That is the whole
      // point of half-even — no systematic upward bias across many rows.
      expect(legacy.toString()).toBe('10');
      expect(legacy.toExactString()).toBe('10.005');
    });

    it('half-even rounds toward the EVEN cent in both directions', () => {
      expect(Money.of('10.005').toString()).toBe('10'); // 0 is even → down
      expect(Money.of('10.015').toString()).toBe('10.02'); // 1 is odd → up
    });
  });
});
