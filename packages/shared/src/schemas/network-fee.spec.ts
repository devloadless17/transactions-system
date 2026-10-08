import { describe, expect, it } from 'vitest';
import { commissionTierSchema } from './commission';
import { setNetworkFeeConfigSchema } from './network-fee';
import { sourceFeeRuleInputSchema } from './source';

const rate = (operationType: string, feeType: string, feeValue: string) => ({
  operationType,
  feeType,
  feeValue,
});

const parse = (body: unknown) => setNetworkFeeConfigSchema.safeParse(body);
const messages = (body: unknown): string[] => {
  const r = parse(body);
  return r.success ? [] : r.error.issues.map((i) => i.message);
};

describe('setNetworkFeeConfigSchema', () => {
  it("accepts the tech lead's example: 1% on deposits", () => {
    expect(parse({ enabled: true, rates: [rate('TRANSACTION', 'PERCENTAGE', '1')] }).success).toBe(
      true,
    );
  });

  it('accepts a rate on every flow, fixed and percentage', () => {
    const r = parse({
      enabled: true,
      rates: [
        rate('TRANSACTION', 'PERCENTAGE', '0.125'),
        rate('WITHDRAWAL', 'FIXED', '2'),
        rate('PAYOUT', 'FIXED', '0.5'),
        rate('LOAD', 'PERCENTAGE', '100'),
      ],
    });
    expect(r.success).toBe(true);
  });

  it('accepts switching OFF while keeping the rates (so turning it back on loses nothing)', () => {
    expect(parse({ enabled: false, rates: [rate('TRANSACTION', 'PERCENTAGE', '1')] }).success).toBe(
      true,
    );
    expect(parse({ enabled: false, rates: [] }).success).toBe(true);
  });

  it('refuses switching ON with no rate at all', () => {
    expect(messages({ enabled: true, rates: [] })).toContain(
      'Set a network fee for at least one flow, or turn the network fee off',
    );
  });

  it('refuses the same flow twice', () => {
    const m = messages({
      enabled: true,
      rates: [rate('WITHDRAWAL', 'FIXED', '1'), rate('WITHDRAWAL', 'FIXED', '2')],
    });
    expect(m.some((x) => x.includes('listed twice'))).toBe(true);
  });

  it.each([
    ['0', 'PERCENTAGE', 'must be greater than 0'],
    ['0.00', 'FIXED', 'must be greater than 0'],
    ['100.01', 'PERCENTAGE', 'between 0 and 100'],
    ['1.123456789', 'PERCENTAGE', 'at most 8 decimal places'],
    ['1.005', 'FIXED', 'at most 2 decimal places'],
  ])('refuses %s as a %s value (%s)', (feeValue, feeType, fragment) => {
    const m = messages({ enabled: true, rates: [rate('TRANSACTION', feeType, feeValue)] });
    expect(
      m.some((x) => x.includes(fragment)),
      m.join(' | '),
    ).toBe(true);
  });

  it('refuses an unknown flow or fee type', () => {
    expect(parse({ enabled: true, rates: [rate('DEPOSIT', 'FIXED', '1')] }).success).toBe(false);
    expect(parse({ enabled: true, rates: [rate('LOAD', 'FLAT', '1')] }).success).toBe(false);
  });

  it('refuses more rates than there are flows', () => {
    const five = ['TRANSACTION', 'WITHDRAWAL', 'PAYOUT', 'LOAD', 'LOAD'].map((op) =>
      rate(op, 'FIXED', '1'),
    );
    expect(parse({ enabled: true, rates: five }).success).toBe(false);
  });

  // A malformed number must fail validation (a 400), never throw out of a
  // refinement (a 500).
  it('a non-numeric value is a validation error, not a throw', () => {
    expect(() =>
      parse({ enabled: true, rates: [rate('TRANSACTION', 'PERCENTAGE', 'abc')] }),
    ).not.toThrow();
    expect(
      parse({ enabled: true, rates: [rate('TRANSACTION', 'PERCENTAGE', 'abc')] }).success,
    ).toBe(false);
  });
});

// The same malformed-number guard, on the two existing fee-rule schemas that
// used to throw a DecimalError (500) instead of failing validation (400).
describe('fee rule schemas never throw on a malformed number', () => {
  it.each([
    [{ minAmount: '0', maxAmount: null, commissionType: 'PERCENTAGE', commissionValue: 'abc' }],
    [{ minAmount: 'x', maxAmount: '5', commissionType: 'FIXED', commissionValue: '1' }],
    [{ minAmount: '0', maxAmount: 'y', commissionType: 'FIXED', commissionValue: '1' }],
  ])('commissionTierSchema %j', (tier) => {
    expect(() => commissionTierSchema.safeParse(tier)).not.toThrow();
    expect(commissionTierSchema.safeParse(tier).success).toBe(false);
  });

  it.each([
    [
      {
        channel: 'INGEST',
        minAmount: '0',
        maxAmount: null,
        feeType: 'PERCENTAGE',
        feeValue: 'abc',
      },
    ],
    [{ channel: 'INGEST', minAmount: 'x', maxAmount: '5', feeType: 'FIXED', feeValue: '1' }],
  ])('sourceFeeRuleInputSchema %j', (rule) => {
    expect(() => sourceFeeRuleInputSchema.safeParse(rule)).not.toThrow();
    expect(sourceFeeRuleInputSchema.safeParse(rule).success).toBe(false);
  });

  it('a valid tier still validates exactly as before', () => {
    expect(
      commissionTierSchema.safeParse({
        minAmount: '0',
        maxAmount: '100',
        commissionType: 'PERCENTAGE',
        commissionValue: '0.125',
      }).success,
    ).toBe(true);
  });
});
