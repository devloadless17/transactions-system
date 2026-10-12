import { describe, expect, it } from 'vitest';
import { formatAmount, isNonZeroAmount, isPositiveAmount, isZeroAmount } from './format';

/**
 * `isPositiveAmount` decides whether an optional money figure (the network fee)
 * renders at all. Every company that is not charged one must render exactly as
 * before, so each "nothing here" shape the API or a stale cache can produce has
 * to come back false.
 */
describe('isPositiveAmount', () => {
  it('is true for any value above zero', () => {
    expect(isPositiveAmount('1')).toBe(true);
    expect(isPositiveAmount('0.5')).toBe(true);
    expect(isPositiveAmount('0.01')).toBe(true);
    expect(isPositiveAmount('1234.56')).toBe(true);
  });

  it('keeps a sub-cent value (it is still a charge)', () => {
    expect(isPositiveAmount('0.00000001')).toBe(true);
  });

  it('is false for every zero form the API emits', () => {
    expect(isPositiveAmount('0')).toBe(false);
    expect(isPositiveAmount('0.00')).toBe(false);
    expect(isPositiveAmount('0.00000000')).toBe(false);
  });

  it('is false for a missing or empty value', () => {
    expect(isPositiveAmount(undefined)).toBe(false);
    expect(isPositiveAmount(null)).toBe(false);
    expect(isPositiveAmount('')).toBe(false);
    expect(isPositiveAmount('   ')).toBe(false);
  });

  it('is false for a negative or unparseable value', () => {
    expect(isPositiveAmount('-1')).toBe(false);
    expect(isPositiveAmount('abc')).toBe(false);
    expect(isPositiveAmount('1,000')).toBe(false);
  });

  it('tolerates surrounding whitespace', () => {
    expect(isPositiveAmount(' 2 ')).toBe(true);
  });

  it('is never true where isZeroAmount is', () => {
    for (const s of ['0', '0.00', '1', '0.5', '', 'x']) {
      expect(isPositiveAmount(s) && isZeroAmount(s)).toBe(false);
    }
  });
});

/**
 * `isNonZeroAmount` decides whether a SIGNED aggregate (network-fee revenue in a
 * window) renders. That sum goes negative when a network-fee deposit booked
 * earlier is reversed inside the window, and the net revenue beside it still
 * counts it — so a negative has to render for the shown figures to add up, while
 * a platform that charges no network fee (zero, in every form) renders exactly
 * as before.
 */
describe('isNonZeroAmount', () => {
  it('is true for any value above zero', () => {
    expect(isNonZeroAmount('1')).toBe(true);
    expect(isNonZeroAmount('0.01')).toBe(true);
    expect(isNonZeroAmount('1234.56')).toBe(true);
    expect(isNonZeroAmount('0.00000001')).toBe(true);
  });

  it('is true for a negative value (a reversal inside the window)', () => {
    expect(isNonZeroAmount('-1')).toBe(true);
    expect(isNonZeroAmount('-0.01')).toBe(true);
    expect(isNonZeroAmount('-1234.56')).toBe(true);
    expect(isNonZeroAmount('-0.00000001')).toBe(true);
  });

  it('is false for every zero form the API emits', () => {
    expect(isNonZeroAmount('0')).toBe(false);
    expect(isNonZeroAmount('0.00')).toBe(false);
    expect(isNonZeroAmount('0.00000000')).toBe(false);
    expect(isNonZeroAmount('-0')).toBe(false);
    expect(isNonZeroAmount('-0.00')).toBe(false);
  });

  it('is false for a missing or empty value', () => {
    expect(isNonZeroAmount(undefined)).toBe(false);
    expect(isNonZeroAmount(null)).toBe(false);
    expect(isNonZeroAmount('')).toBe(false);
    expect(isNonZeroAmount('   ')).toBe(false);
  });

  it('is false for an unparseable value', () => {
    expect(isNonZeroAmount('abc')).toBe(false);
    expect(isNonZeroAmount('1,000')).toBe(false);
    expect(isNonZeroAmount('-')).toBe(false);
  });

  it('tolerates surrounding whitespace', () => {
    expect(isNonZeroAmount(' 2 ')).toBe(true);
    expect(isNonZeroAmount(' -2 ')).toBe(true);
  });

  it('agrees with isPositiveAmount on everything that is not negative', () => {
    for (const s of ['0', '0.00', '1', '0.5', '0.00000001', '', '   ', 'x', '1,000', null]) {
      expect(isNonZeroAmount(s)).toBe(isPositiveAmount(s));
    }
    expect(isNonZeroAmount(undefined)).toBe(isPositiveAmount(undefined));
  });

  it('is never true where isZeroAmount is', () => {
    for (const s of ['0', '0.00', '-0', '-0.00', '1', '-1', '0.5', '', 'x']) {
      expect(isNonZeroAmount(s) && isZeroAmount(s)).toBe(false);
    }
  });
});

describe('formatAmount (the figure a network-fee line shows)', () => {
  it('pads to cents', () => {
    expect(formatAmount('1')).toBe('1.00');
    expect(formatAmount('0.5')).toBe('0.50');
  });

  it('groups thousands', () => {
    expect(formatAmount('1234.5')).toBe('1,234.50');
  });

  it('truncates, never rounds up', () => {
    expect(formatAmount('1.999')).toBe('1.99');
  });
});
