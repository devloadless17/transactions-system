import { describe, expect, it } from 'vitest';
import { CommissionType, FeeApplication, FeeOperationType, SourceFeeChannel } from '../enums';
import { setSourceFeeRulesSchema } from './source';
import { createCommissionRuleGroupSchema } from './commission';
import { crmEventPayloadSchema } from './crm';

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
      {
        operationType: FeeOperationType.TRANSACTION,
        feeApplication: FeeApplication.DEDUCTED,
        tiers: tiers.map((t) => ({
          minAmount: t.minAmount,
          maxAmount: t.maxAmount,
          commissionType: t.commissionType ?? CommissionType.FIXED,
          commissionValue: t.commissionValue ?? '1',
        })),
      },
    ],
    priority: 100,
    active: true,
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

  it('ACCEPTS a different ladder per operation (deposits 1%, withdrawals 2%)', () => {
    const base = commissionGroup([{ minAmount: '0', maxAmount: null }]);
    const result = createCommissionRuleGroupSchema.safeParse({
      ...base,
      operations: [
        {
          operationType: FeeOperationType.TRANSACTION,
          feeApplication: FeeApplication.DEDUCTED,
          tiers: [
            {
              minAmount: '0',
              maxAmount: null,
              commissionType: CommissionType.PERCENTAGE,
              commissionValue: '1',
            },
          ],
        },
        {
          operationType: FeeOperationType.WITHDRAWAL,
          feeApplication: FeeApplication.ON_TOP,
          tiers: [
            {
              minAmount: '0',
              maxAmount: null,
              commissionType: CommissionType.PERCENTAGE,
              commissionValue: '2',
            },
          ],
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('REJECTS a group whose SECOND operation has a bad ladder, pathed to that op', () => {
    const base = commissionGroup([{ minAmount: '0', maxAmount: null }]);
    const result = createCommissionRuleGroupSchema.safeParse({
      ...base,
      operations: [
        ...base.operations,
        {
          operationType: FeeOperationType.WITHDRAWAL,
          feeApplication: FeeApplication.ON_TOP,
          tiers: [
            {
              minAmount: '1',
              maxAmount: '100',
              commissionType: CommissionType.FIXED,
              commissionValue: '1',
            },
            {
              minAmount: '100',
              maxAmount: null,
              commissionType: CommissionType.FIXED,
              commissionValue: '2',
            },
          ],
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const overlap = result.error.issues.find((i) => /Tiers overlap/.test(i.message));
      expect(overlap?.path).toEqual(['operations', 1, 'tiers']);
    }
  });
});

// The CRM webhook body carries EXACTLY ONE of `transaction` (deposit events) or
// `withdrawal` (withdrawal events), selected by the event family. Lock that
// invariant so a future change can't let a body go out empty or double-bodied.
describe('crmEventPayloadSchema (deposit vs withdrawal body)', () => {
  const depositBody = {
    id: '0f8d2c4e-1a2b-4c3d-9e8f-7a6b5c4d3e2f',
    status: 'COMPLETED',
    source: 'whish',
    externalTransactionId: '184523',
    amount: '100.00',
    currency: 'USD',
    netAmount: '97.50',
    commissionAmount: '2.50',
    networkFeeAmount: '0',
    customer: 'John Doe',
    tradingAccount: null,
    phone: '+9613000000',
    note: 'Invoice #5512',
    occurredAt: '2026-06-22T09:19:58.000Z',
  };
  const withdrawalBody = {
    id: 'd4f2a1c0-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
    status: 'COMPLETED',
    amount: '500.00',
    totalAmount: '500.00',
    feeAmount: '5.00',
    networkFeeAmount: '0',
    netAmount: '495.00',
    feeApplication: 'DEDUCTED',
    currency: 'USD',
    payoutMethod: 'CASH',
    payoutDetails: {
      method: 'CASH',
      recipientName: 'Acme Ltd',
      recipientPhone: '+9613000000',
      pickupLocation: 'Beirut',
      instructions: 'Call on arrival',
    },
    note: 'Weekly settlement',
    adminNote: null,
    externalReference: 'WIRE-88231',
    createdAt: '2026-06-22T09:00:00.000Z',
    processedAt: '2026-06-22T09:19:58.000Z',
    occurredAt: '2026-06-22T09:19:58.000Z',
  };

  it('ACCEPTS a deposit event carrying only `transaction`', () => {
    const result = crmEventPayloadSchema.safeParse({
      event: 'transaction.completed',
      reference: 'whish:184523',
      sentAt: '2026-06-22T09:20:00.123Z',
      transaction: depositBody,
    });
    expect(result.success).toBe(true);
  });

  it('ACCEPTS a withdrawal event carrying only `withdrawal`', () => {
    const result = crmEventPayloadSchema.safeParse({
      event: 'withdrawal.completed',
      reference: 'withdrawal:d4f2a1c0-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
      sentAt: '2026-06-22T09:20:00.123Z',
      withdrawal: withdrawalBody,
    });
    expect(result.success).toBe(true);
  });

  it('REJECTS an event carrying BOTH `transaction` and `withdrawal`', () => {
    const result = crmEventPayloadSchema.safeParse({
      event: 'withdrawal.completed',
      reference: 'withdrawal:d4f2a1c0-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
      sentAt: '2026-06-22T09:20:00.123Z',
      transaction: depositBody,
      withdrawal: withdrawalBody,
    });
    expect(result.success).toBe(false);
  });

  it('REJECTS an event carrying NEITHER body', () => {
    const result = crmEventPayloadSchema.safeParse({
      event: 'transaction.pending',
      reference: 'whish:184523',
      sentAt: '2026-06-22T09:20:00.123Z',
    });
    expect(result.success).toBe(false);
  });

  it('REJECTS an unknown event type', () => {
    const result = crmEventPayloadSchema.safeParse({
      event: 'payout.completed',
      reference: 'payout:1',
      sentAt: '2026-06-22T09:20:00.123Z',
      withdrawal: withdrawalBody,
    });
    expect(result.success).toBe(false);
  });

  // The network fee travels on every money event, mirroring the REST resource:
  // "0" when the company is not charged one, null only before the fees are known.
  it('ACCEPTS a pending Whish deposit whose fees are not known yet (all null)', () => {
    const result = crmEventPayloadSchema.safeParse({
      event: 'transaction.pending',
      reference: 'whish:184523',
      sentAt: '2026-06-22T09:20:00.123Z',
      transaction: {
        ...depositBody,
        id: null,
        status: 'PENDING',
        netAmount: null,
        commissionAmount: null,
        networkFeeAmount: null,
      },
    });
    expect(result.success).toBe(true);
  });

  it('REJECTS a withdrawal body without networkFeeAmount', () => {
    const { networkFeeAmount: _omit, ...withoutNetworkFee } = withdrawalBody;
    const result = crmEventPayloadSchema.safeParse({
      event: 'withdrawal.completed',
      reference: 'withdrawal:d4f2a1c0-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
      sentAt: '2026-06-22T09:20:00.123Z',
      withdrawal: withoutNetworkFee,
    });
    expect(result.success).toBe(false);
  });
});
