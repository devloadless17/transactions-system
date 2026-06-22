import { describe, expect, it } from 'vitest';
import { CommissionType, FeeApplication, FeeOperationType, SourceFeeChannel } from '../enums';
import { setSourceFeeRulesSchema } from './source';
import { createCommissionRuleGroupSchema } from './commission';

// These specs lock the DELIBERATELY-OPPOSITE boundary conventions of the two
// tier ladders so a future refactor can't silently flip one to match the other:
//   - source-fee tiers (setSourceFeeRulesSchema) ALLOW touching at a boundary
//     ([0,10] then [10,inf]) and resolve the shared point to the lower tier;
//   - commission tiers (validateTierLadder via createCommissionRuleGroupSchema)
//     REJECT touching ([1,100] then [100,...] is an overlap; [1,100],[101,300]
//     is required).
// Both reject a PERCENTAGE value above 100.

function sourceFeeRule(
  overrides: Partial<{
    channel: SourceFeeChannel;
    minAmount: string;
    maxAmount: string | null;
    feeType: CommissionType;
    feeValue: string;
    active: boolean;
  }> = {},
) {
  return {
    channel: SourceFeeChannel.INGEST,
    minAmount: '0',
    maxAmount: '10' as string | null,
    feeType: CommissionType.FIXED,
    feeValue: '1',
    active: true,
    ...overrides,
  };
}

describe('setSourceFeeRulesSchema (source-fee tier ladder)', () => {
  it('ACCEPTS tiers that touch at a boundary ([0,10] then [10,inf])', () => {
    const result = setSourceFeeRulesSchema.safeParse({
      rules: [
        sourceFeeRule({ minAmount: '0', maxAmount: '10' }),
        sourceFeeRule({ minAmount: '10', maxAmount: null }),
      ],
    });
    expect(result.success).toBe(true);
  });

  it('REJECTS genuinely overlapping tiers ([0,10] then [5,inf])', () => {
    const result = setSourceFeeRulesSchema.safeParse({
      rules: [
        sourceFeeRule({ minAmount: '0', maxAmount: '10' }),
        sourceFeeRule({ minAmount: '5', maxAmount: null }),
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /overlapping tiers/.test(i.message))).toBe(true);
    }
  });

  it('REJECTS an open-ended tier that is not the highest band', () => {
    const result = setSourceFeeRulesSchema.safeParse({
      rules: [
        sourceFeeRule({ minAmount: '0', maxAmount: null }),
        sourceFeeRule({ minAmount: '10', maxAmount: '20' }),
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => /open-ended .* must be the highest band/.test(i.message)),
      ).toBe(true);
    }
  });

  it('REJECTS a PERCENTAGE fee value above 100', () => {
    const result = setSourceFeeRulesSchema.safeParse({
      rules: [sourceFeeRule({ feeType: CommissionType.PERCENTAGE, feeValue: '100.00000001' })],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /PERCENTAGE fee/.test(i.message))).toBe(true);
    }
  });

  it('treats touching boundaries per-channel (different channels never overlap)', () => {
    const result = setSourceFeeRulesSchema.safeParse({
      rules: [
        sourceFeeRule({ channel: SourceFeeChannel.INGEST, minAmount: '0', maxAmount: null }),
        sourceFeeRule({ channel: SourceFeeChannel.WHISH_PAY, minAmount: '0', maxAmount: null }),
      ],
    });
    expect(result.success).toBe(true);
  });
});

function commissionGroup(
  tiers: Array<{
    minAmount: string;
    maxAmount: string | null;
    commissionValue?: string;
    commissionType?: CommissionType;
  }>,
) {
  return {
    name: 'Standard fees',
    companyIds: null,
    operations: [
      { operationType: FeeOperationType.TRANSACTION, feeApplication: FeeApplication.DEDUCTED },
    ],
    priority: 100,
    active: true,
    tiers: tiers.map((t) => ({
      minAmount: t.minAmount,
      maxAmount: t.maxAmount,
      commissionType: t.commissionType ?? CommissionType.FIXED,
      commissionValue: t.commissionValue ?? '1',
    })),
  };
}

describe('createCommissionRuleGroupSchema (commission tier ladder)', () => {
  it('REJECTS tiers that touch at a boundary ([1,100] then [100,inf])', () => {
    const result = createCommissionRuleGroupSchema.safeParse(
      commissionGroup([
        { minAmount: '1', maxAmount: '100' },
        { minAmount: '100', maxAmount: null },
      ]),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /Tiers overlap/.test(i.message))).toBe(true);
    }
  });

  it('ACCEPTS strictly-separated tiers ([1,100] then [101,300])', () => {
    const result = createCommissionRuleGroupSchema.safeParse(
      commissionGroup([
        { minAmount: '1', maxAmount: '100' },
        { minAmount: '101', maxAmount: '300' },
      ]),
    );
    expect(result.success).toBe(true);
  });

  it('REJECTS an open-ended tier that is not the highest bracket', () => {
    const result = createCommissionRuleGroupSchema.safeParse(
      commissionGroup([
        { minAmount: '1', maxAmount: null },
        { minAmount: '101', maxAmount: '300' },
      ]),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) => /Only the highest tier can be open-ended/.test(i.message)),
      ).toBe(true);
    }
  });

  it('REJECTS a PERCENTAGE commission value above 100', () => {
    const result = createCommissionRuleGroupSchema.safeParse(
      commissionGroup([
        {
          minAmount: '1',
          maxAmount: '100',
          commissionType: CommissionType.PERCENTAGE,
          commissionValue: '100.00000001',
        },
      ]),
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((i) => /PERCENTAGE value/.test(i.message))).toBe(true);
    }
  });
});
