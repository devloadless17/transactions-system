import { describe, expect, it } from 'vitest';
import {
  CommissionType,
  FeeApplication,
  FeeOperationType,
  createCommissionRuleGroupSchema,
} from '@app/shared';
import { expand, groupRowsToResponse } from './commissions.service';

describe('commission group: per-operation tiers & fee application', () => {
  it('expand() writes each operation’s own ladder and feeApplication', () => {
    const rows = expand('group-1', {
      name: 'mixed',
      companyIds: ['11111111-1111-1111-1111-111111111111'],
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
      priority: 100,
      active: true,
    });

    // 1 company × (1 tier + 1 tier) = 2 rows.
    expect(rows).toHaveLength(2);
    const deposit = rows.find((r) => r.operationType === 'TRANSACTION')!;
    const withdrawal = rows.find((r) => r.operationType === 'WITHDRAWAL')!;
    // Each operation keeps its own application…
    expect(deposit.feeApplication).toBe('DEDUCTED');
    expect(withdrawal.feeApplication).toBe('ON_TOP');
    // …AND its own fee schedule: deposits 1%, withdrawals 2%.
    expect(deposit.commissionValue).toBe('1');
    expect(withdrawal.commissionValue).toBe('2');
  });

  it('expand() fans out company × operation × tier with unequal ladder sizes', () => {
    const rows = expand('g', {
      name: null,
      companyIds: ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'],
      operations: [
        {
          operationType: FeeOperationType.TRANSACTION,
          feeApplication: FeeApplication.DEDUCTED,
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
      priority: 100,
      active: true,
    });
    // 2 companies × (2-tier deposit ladder + 1-tier withdrawal ladder) = 6 rows.
    expect(rows).toHaveLength(6);
    expect(rows.filter((r) => r.operationType === 'TRANSACTION')).toHaveLength(4);
    expect(rows.filter((r) => r.operationType === 'WITHDRAWAL')).toHaveLength(2);
  });

  it('expand() with null companyIds writes a single global (null company) row set', () => {
    const rows = expand('g', {
      name: null,
      companyIds: null,
      operations: [
        {
          operationType: FeeOperationType.TRANSACTION,
          feeApplication: FeeApplication.DEDUCTED,
          tiers: [
            {
              minAmount: '0',
              maxAmount: null,
              commissionType: CommissionType.FIXED,
              commissionValue: '1',
            },
          ],
        },
      ],
      priority: 100,
      active: true,
    });
    expect(rows).toHaveLength(1);
    expect(rows.every((r) => r.companyId === null)).toBe(true);
  });

  it('groupRowsToResponse() is the inverse of expand(): per-op tiers, deduped across companies', () => {
    const input = {
      name: 'mixed',
      companyIds: ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222'],
      operations: [
        {
          operationType: FeeOperationType.TRANSACTION,
          feeApplication: FeeApplication.DEDUCTED,
          tiers: [
            {
              minAmount: '0',
              maxAmount: '99.99999999',
              commissionType: CommissionType.PERCENTAGE,
              commissionValue: '1',
            },
            {
              minAmount: '100',
              maxAmount: null,
              commissionType: CommissionType.PERCENTAGE,
              commissionValue: '0.5',
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
      priority: 100,
      active: true,
    };
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    const rows = expand('g', input).map((r, i) => ({
      ...r,
      id: `row-${i}`,
      groupId: 'g',
      name: r.name ?? null,
      companyId: r.companyId ?? null,
      sourceId: null,
      minAmount: { toString: () => String(r.minAmount) },
      maxAmount: r.maxAmount == null ? null : { toString: () => String(r.maxAmount) },
      commissionValue: { toString: () => String(r.commissionValue) },
      priority: r.priority ?? 100,
      active: r.active ?? true,
      createdAt,
    }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const group = groupRowsToResponse('g', rows as any);
    expect(group.operations).toHaveLength(2);
    const deposit = group.operations.find((o) => o.operationType === 'TRANSACTION')!;
    const withdrawal = group.operations.find((o) => o.operationType === 'WITHDRAWAL')!;
    // Tiers repeat per company in storage but come back deduped, per operation,
    // sorted ascending by min.
    expect(deposit.tiers).toEqual([
      {
        minAmount: '0',
        maxAmount: '99.99999999',
        commissionType: 'PERCENTAGE',
        commissionValue: '1',
      },
      { minAmount: '100', maxAmount: null, commissionType: 'PERCENTAGE', commissionValue: '0.5' },
    ]);
    expect(deposit.feeApplication).toBe('DEDUCTED');
    expect(withdrawal.tiers).toEqual([
      { minAmount: '0', maxAmount: null, commissionType: 'PERCENTAGE', commissionValue: '2' },
    ]);
    expect(withdrawal.feeApplication).toBe('ON_TOP');
    expect(group.companyIds).toEqual(input.companyIds);
  });

  it('schema accepts deposits 1% + withdrawals 2% in ONE rule', () => {
    const parsed = createCommissionRuleGroupSchema.safeParse({
      operations: [
        {
          operationType: 'TRANSACTION',
          feeApplication: 'DEDUCTED',
          tiers: [
            { minAmount: '0', maxAmount: null, commissionType: 'PERCENTAGE', commissionValue: '1' },
          ],
        },
        {
          operationType: 'WITHDRAWAL',
          feeApplication: 'ON_TOP',
          tiers: [
            { minAmount: '0', maxAmount: null, commissionType: 'PERCENTAGE', commissionValue: '2' },
          ],
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('schema rejects the same operation listed twice', () => {
    const parsed = createCommissionRuleGroupSchema.safeParse({
      operations: [
        {
          operationType: 'TRANSACTION',
          feeApplication: 'DEDUCTED',
          tiers: [
            { minAmount: '0', maxAmount: null, commissionType: 'FIXED', commissionValue: '1' },
          ],
        },
        {
          operationType: 'TRANSACTION',
          feeApplication: 'ON_TOP',
          tiers: [
            { minAmount: '0', maxAmount: null, commissionType: 'FIXED', commissionValue: '1' },
          ],
        },
      ],
    });
    expect(parsed.success).toBe(false);
  });

  it('schema rejects an overlapping ladder on ONE op and points at that op', () => {
    const parsed = createCommissionRuleGroupSchema.safeParse({
      operations: [
        {
          operationType: 'TRANSACTION',
          feeApplication: 'DEDUCTED',
          tiers: [
            { minAmount: '0', maxAmount: '100', commissionType: 'FIXED', commissionValue: '1' },
            {
              minAmount: '100.00000001',
              maxAmount: null,
              commissionType: 'FIXED',
              commissionValue: '2',
            },
          ],
        },
        {
          operationType: 'WITHDRAWAL',
          feeApplication: 'ON_TOP',
          tiers: [
            // Overlap: second tier starts inside the first.
            { minAmount: '0', maxAmount: '100', commissionType: 'FIXED', commissionValue: '1' },
            { minAmount: '50', maxAmount: null, commissionType: 'FIXED', commissionValue: '2' },
          ],
        },
      ],
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      // The issue must nest under the offending operation so the UI can attribute it.
      const overlap = parsed.error.issues.find((i) => i.message.includes('overlap'));
      expect(overlap?.path).toEqual(['operations', 1, 'tiers']);
    }
  });
});
