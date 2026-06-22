import { describe, expect, it } from 'vitest';
import {
  CommissionType,
  FeeApplication,
  FeeOperationType,
  createCommissionRuleGroupSchema,
} from '@app/shared';
import { expand } from './commissions.service';

describe('commission group: per-operation fee application', () => {
  it('expand() writes each operation’s own feeApplication across the shared tiers', () => {
    const rows = expand('group-1', {
      name: 'mixed',
      companyIds: ['11111111-1111-1111-1111-111111111111'],
      operations: [
        { operationType: FeeOperationType.TRANSACTION, feeApplication: FeeApplication.DEDUCTED },
        { operationType: FeeOperationType.WITHDRAWAL, feeApplication: FeeApplication.ON_TOP },
      ],
      priority: 100,
      active: true,
      tiers: [
        {
          minAmount: '0',
          maxAmount: null,
          commissionType: CommissionType.PERCENTAGE,
          commissionValue: '1.7',
        },
      ],
    });

    // 1 company × 2 operations × 1 tier = 2 rows.
    expect(rows).toHaveLength(2);
    const deposit = rows.find((r) => r.operationType === 'TRANSACTION')!;
    const withdrawal = rows.find((r) => r.operationType === 'WITHDRAWAL')!;
    // Each operation keeps its own application…
    expect(deposit.feeApplication).toBe('DEDUCTED');
    expect(withdrawal.feeApplication).toBe('ON_TOP');
    // …at the SAME fee schedule (one rule, shared tiers).
    expect(deposit.commissionValue).toBe('1.7');
    expect(withdrawal.commissionValue).toBe('1.7');
  });

  it('expand() fans out company × operation × tier (global null company)', () => {
    const rows = expand('g', {
      name: null,
      companyIds: null, // global → single null-company row set
      operations: [
        { operationType: FeeOperationType.TRANSACTION, feeApplication: FeeApplication.DEDUCTED },
        { operationType: FeeOperationType.WITHDRAWAL, feeApplication: FeeApplication.ON_TOP },
      ],
      priority: 100,
      active: true,
      tiers: [
        {
          minAmount: '0',
          maxAmount: '100',
          commissionType: CommissionType.FIXED,
          commissionValue: '1',
        },
        {
          minAmount: '100.00000001',
          maxAmount: null,
          commissionType: CommissionType.FIXED,
          commissionValue: '2',
        },
      ],
    });
    expect(rows).toHaveLength(4); // 1 × 2 ops × 2 tiers
    expect(rows.every((r) => r.companyId === null)).toBe(true);
  });

  it('schema accepts deposits-deducted + withdrawals-on-top in ONE rule', () => {
    const parsed = createCommissionRuleGroupSchema.safeParse({
      operations: [
        { operationType: 'TRANSACTION', feeApplication: 'DEDUCTED' },
        { operationType: 'WITHDRAWAL', feeApplication: 'ON_TOP' },
      ],
      tiers: [
        { minAmount: '0', maxAmount: null, commissionType: 'PERCENTAGE', commissionValue: '1.7' },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('schema rejects the same operation listed twice', () => {
    const parsed = createCommissionRuleGroupSchema.safeParse({
      operations: [
        { operationType: 'TRANSACTION', feeApplication: 'DEDUCTED' },
        { operationType: 'TRANSACTION', feeApplication: 'ON_TOP' },
      ],
      tiers: [{ minAmount: '0', maxAmount: null, commissionType: 'FIXED', commissionValue: '1' }],
    });
    expect(parsed.success).toBe(false);
  });
});
