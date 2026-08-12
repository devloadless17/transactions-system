import { describe, expect, it } from 'vitest';
import { createWhishPaymentSchema, whishAmountIssue } from './whish';
import { WHISH_AMOUNT_RULES } from '../enums';

/**
 * Whish Pay v1.4.4 publishes per-currency amount rules (USD: at most 2 decimal
 * places, minimum 1.00) but does NOT enforce them — verified against the live
 * sandbox, which mints a real link for "0.50" and "10.005" and will take a 0.50
 * link all the way to the payer's OTP step.
 *
 * So `whishAmountIssue` reports the divergence for logging, and the create
 * schema deliberately does NOT reject: blocking those amounts would refuse
 * payments the provider is willing to collect.
 */

const valid = {
  currency: 'USD' as const,
  invoice: 'Order #1',
};

describe('whishAmountIssue — USD', () => {
  it.each(['1', '1.0', '1.00', '1.5', '25.00', '999999.99'])('accepts %o', (amount) => {
    expect(whishAmountIssue(amount, 'USD')).toBeNull();
  });

  it.each([
    ['0', /at least 1/],
    ['0.99', /at least 1/],
    ['0.01', /at least 1/],
  ])('rejects %o as below the minimum', (amount, message) => {
    expect(whishAmountIssue(amount, 'USD')).toMatch(message);
  });

  it.each(['1.005', '25.000', '10.123456'])('rejects %o for too many decimals', (amount) => {
    expect(whishAmountIssue(amount, 'USD')).toMatch(/2 decimal places/);
  });

  it('reports the precision problem before the minimum one', () => {
    // "0.005" violates both; the decimals message is the actionable one.
    expect(whishAmountIssue('0.005', 'USD')).toMatch(/2 decimal places/);
  });

  it('says nothing about a currency it has no rule for', () => {
    // The currency enum has already rejected it; don't invent a second error.
    expect(whishAmountIssue('0.01', 'EUR')).toBeNull();
  });
});

// Table-driven so a newly enabled currency (e.g. LBP) is covered the moment its
// rule is added to WHISH_AMOUNT_RULES, without touching this file.
describe('every configured currency rule is self-consistent', () => {
  it.each(Object.entries(WHISH_AMOUNT_RULES))('%s', (currency, rule) => {
    // Its own minimum must be an acceptable amount.
    expect(whishAmountIssue(rule.minAmount, currency)).toBeNull();
    // One cent/unit below the minimum must not be.
    const belowMin = rule.maxDecimals === 0 ? '1' : '0.01';
    expect(whishAmountIssue(belowMin, currency)).not.toBeNull();
    // One digit past the allowed precision must not be.
    const tooPrecise = `${rule.minAmount}.${'0'.repeat(rule.maxDecimals)}1`;
    expect(whishAmountIssue(tooPrecise, currency)).toMatch(/decimal|whole numbers/);
  });
});

describe('createWhishPaymentSchema does NOT block on the advisory rules', () => {
  it('accepts a well-formed body', () => {
    expect(createWhishPaymentSchema.safeParse({ ...valid, amount: '50.00' }).success).toBe(true);
  });

  // The whole point: Whish accepts these, so we must not be stricter than the
  // payment provider and refuse money it would collect.
  it.each(['0.50', '0.01', '10.005'])(
    'accepts %o even though it departs from the docs',
    (amount) => {
      expect(createWhishPaymentSchema.safeParse({ ...valid, amount }).success).toBe(true);
    },
  );

  it('still rejects a non-decimal amount', () => {
    expect(createWhishPaymentSchema.safeParse({ ...valid, amount: 'abc' }).success).toBe(false);
  });

  it('still rejects an unsupported currency', () => {
    const res = createWhishPaymentSchema.safeParse({ ...valid, currency: 'EUR', amount: '50.00' });
    expect(res.success).toBe(false);
  });
});
