import { describe, expect, it, vi } from 'vitest';
import { Money, type FeeOperationType } from '@app/shared';
import type { PrismaClient } from '@app/db';
import {
  CommissionExceedsAmountError,
  CommissionResolverService,
  type ResolvableRule,
} from './commission-resolver.service';
import type { CommissionsRepository } from './commissions.repository';
import { FeesService } from './fees.service';

/**
 * FeesService prices the money flows (withdrawal / payout / load). With the
 * network fee OFF it must return exactly what it returned before — commission,
 * application, and the same throw — and never touch the rate table.
 */

const CO = '11111111-1111-1111-1111-111111111111';

function rule(partial: Partial<ResolvableRule>): ResolvableRule {
  return {
    id: 'r1',
    companyId: null,
    sourceId: null,
    operationType: 'WITHDRAWAL',
    feeApplication: 'ON_TOP',
    minAmount: '0',
    maxAmount: null,
    commissionType: 'FIXED',
    commissionValue: '2',
    priority: 0,
    active: true,
    ...partial,
  };
}

function setup(opts: {
  rules: ResolvableRule[];
  switchOn?: boolean;
  rate?: { feeType: 'FIXED' | 'PERCENTAGE'; feeValue: string } | null;
}) {
  const repo = {
    loadCandidates: vi.fn().mockResolvedValue(opts.rules),
  } as unknown as CommissionsRepository;
  const companyFindUnique = vi
    .fn()
    .mockResolvedValue({ networkFeeEnabled: opts.switchOn ?? false });
  const rateFindUnique = vi
    .fn()
    .mockResolvedValue(
      opts.rate
        ? { feeType: opts.rate.feeType, feeValue: { toString: () => opts.rate!.feeValue } }
        : null,
    );
  const tx = {
    company: { findUnique: companyFindUnique },
    companyNetworkFee: { findUnique: rateFindUnique },
  } as unknown as PrismaClient;
  const svc = new FeesService(new CommissionResolverService(), repo);
  const resolve = (amount: string, operationType: FeeOperationType = 'WITHDRAWAL') =>
    svc.resolveFlowFee(tx, { companyId: CO, amount: Money.of(amount), operationType });
  return { resolve, companyFindUnique, rateFindUnique };
}

describe('FeesService.resolveFlowFee', () => {
  describe('network fee OFF — behaves exactly as before', () => {
    it('returns the commission and the rule application, network 0', async () => {
      const { resolve, rateFindUnique } = setup({ rules: [rule({})] });
      const r = await resolve('100');
      expect(r.fees.commission.toString()).toBe('2');
      expect(r.fees.network.isZero()).toBe(true);
      expect(r.feeApplication).toBe('ON_TOP');
      // A company with the switch off never touches the rate table.
      expect(rateFindUnique).not.toHaveBeenCalled();
    });

    it('no matching rule is still free and DEDUCTED', async () => {
      const { resolve } = setup({ rules: [] });
      const r = await resolve('100');
      expect(r.fees.commission.isZero()).toBe(true);
      expect(r.fees.network.isZero()).toBe(true);
      expect(r.feeApplication).toBe('DEDUCTED');
    });

    it('still throws CommissionExceedsAmountError for a DEDUCTED fee above the amount', async () => {
      const { resolve, companyFindUnique } = setup({
        rules: [rule({ feeApplication: 'DEDUCTED', commissionValue: '50' })],
      });
      await expect(resolve('10')).rejects.toBeInstanceOf(CommissionExceedsAmountError);
      // The commission is resolved first, exactly as before — the network
      // fee is never even read for a request that is refused anyway.
      expect(companyFindUnique).not.toHaveBeenCalled();
    });
  });

  describe('network fee ON', () => {
    it('adds the network fee beside the commission, applied the same way', async () => {
      const { resolve } = setup({
        rules: [rule({})],
        switchOn: true,
        rate: { feeType: 'PERCENTAGE', feeValue: '1' },
      });
      const r = await resolve('100');
      expect(r.fees.commission.toString()).toBe('2');
      expect(r.fees.network.toString()).toBe('1');
      expect(r.feeApplication).toBe('ON_TOP');
    });

    it('switch on but this flow has no rate → no network fee', async () => {
      const { resolve } = setup({ rules: [rule({})], switchOn: true, rate: null });
      const r = await resolve('100');
      expect(r.fees.network.isZero()).toBe(true);
    });

    it('no commission rule: a withdrawal network fee stays ON_TOP (recipient gets the full amount)', async () => {
      const { resolve } = setup({
        rules: [],
        switchOn: true,
        rate: { feeType: 'FIXED', feeValue: '1' },
      });
      const r = await resolve('100', 'WITHDRAWAL');
      expect(r.fees.commission.isZero()).toBe(true);
      expect(r.fees.network.toString()).toBe('1');
      expect(r.feeApplication).toBe('ON_TOP');
    });

    it('no commission rule: payouts and loads use DEDUCTED, their conventional default', async () => {
      for (const op of ['PAYOUT', 'LOAD'] as const) {
        const { resolve } = setup({
          rules: [],
          switchOn: true,
          rate: { feeType: 'FIXED', feeValue: '1' },
        });
        const r = await resolve('100', op);
        expect(r.feeApplication).toBe('DEDUCTED');
      }
    });
  });
});
