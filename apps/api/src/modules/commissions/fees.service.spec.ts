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
 * application, and the same throw.
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
  // ONE read answers "is the switch on?" and "what is the rate?" together: the
  // rate row is returned only when the company's switch is on.
  const rateFindFirst = vi
    .fn()
    .mockResolvedValue(
      opts.switchOn && opts.rate
        ? { feeType: opts.rate.feeType, feeValue: { toString: () => opts.rate!.feeValue } }
        : null,
    );
  const tx = { companyNetworkFee: { findFirst: rateFindFirst } } as unknown as PrismaClient;
  const svc = new FeesService(new CommissionResolverService(), repo);
  const resolve = (amount: string, operationType: FeeOperationType = 'WITHDRAWAL') =>
    svc.resolveFlowFee(tx, { companyId: CO, amount: Money.of(amount), operationType });
  return { resolve, rateFindFirst };
}

describe('FeesService.resolveFlowFee', () => {
  describe('network fee OFF — behaves exactly as before', () => {
    it('returns the commission and the rule application, network 0', async () => {
      const { resolve, rateFindFirst } = setup({ rules: [rule({})] });
      const r = await resolve('100');
      expect(r.fees.commission.toString()).toBe('2');
      expect(r.fees.network.isZero()).toBe(true);
      expect(r.feeApplication).toBe('ON_TOP');
      // Exactly one read, and it asks for the rate only if the switch is on —
      // the switch and the rate can never come from two different moments.
      expect(rateFindFirst).toHaveBeenCalledTimes(1);
      expect(rateFindFirst).toHaveBeenCalledWith({
        where: {
          companyId: CO,
          operationType: 'WITHDRAWAL',
          company: { networkFeeEnabled: true },
        },
        select: { feeType: true, feeValue: true },
      });
    });

    it('rates saved but the switch OFF → no network fee', async () => {
      const { resolve } = setup({
        rules: [rule({})],
        switchOn: false,
        rate: { feeType: 'PERCENTAGE', feeValue: '1' },
      });
      const r = await resolve('100');
      expect(r.fees.network.isZero()).toBe(true);
      expect(r.feeApplication).toBe('ON_TOP');
    });

    it('no matching rule is still free and DEDUCTED', async () => {
      const { resolve } = setup({ rules: [] });
      const r = await resolve('100');
      expect(r.fees.commission.isZero()).toBe(true);
      expect(r.fees.network.isZero()).toBe(true);
      expect(r.feeApplication).toBe('DEDUCTED');
    });

    it('still throws CommissionExceedsAmountError for a DEDUCTED fee above the amount', async () => {
      const { resolve, rateFindFirst } = setup({
        rules: [rule({ feeApplication: 'DEDUCTED', commissionValue: '50' })],
      });
      await expect(resolve('10')).rejects.toBeInstanceOf(CommissionExceedsAmountError);
      // The commission is resolved first, exactly as before — the network
      // fee is never even read for a request that is refused anyway.
      expect(rateFindFirst).not.toHaveBeenCalled();
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
    describe('an amount no tier covers (a hole or an edge in the ladder)', () => {
      const on = { switchOn: true, rate: { feeType: 'FIXED', feeValue: '5' } } as const;

      it("follows the flow's own rules: a DEDUCTED withdrawal ladder stays DEDUCTED below its first tier", async () => {
        const { resolve } = setup({
          rules: [rule({ companyId: CO, feeApplication: 'DEDUCTED', minAmount: '100' })],
          ...on,
        });
        const below = await resolve('99.99', 'WITHDRAWAL');
        expect(below.fees.commission.isZero()).toBe(true);
        expect(below.fees.network.toString()).toBe('5');
        // Not the WITHDRAWAL default (ON_TOP): the same config must not flip
        // between ON_TOP and DEDUCTED one cent apart.
        expect(below.feeApplication).toBe('DEDUCTED');
        const inside = await resolve('100', 'WITHDRAWAL');
        expect(inside.feeApplication).toBe('DEDUCTED');
      });

      it('an ON_TOP payout ladder stays ON_TOP above its last tier', async () => {
        const { resolve } = setup({
          rules: [
            rule({
              operationType: 'PAYOUT',
              feeApplication: 'ON_TOP',
              minAmount: '0',
              maxAmount: '1000',
            }),
          ],
          ...on,
        });
        expect((await resolve('1000', 'PAYOUT')).feeApplication).toBe('ON_TOP');
        expect((await resolve('1000.01', 'PAYOUT')).feeApplication).toBe('ON_TOP');
      });

      it("the company's own rules outrank global ones", async () => {
        const { resolve } = setup({
          rules: [
            rule({ id: 'g', companyId: null, feeApplication: 'ON_TOP', minAmount: '500' }),
            rule({ id: 'c', companyId: CO, feeApplication: 'DEDUCTED', minAmount: '100' }),
          ],
          ...on,
        });
        expect((await resolve('50', 'WITHDRAWAL')).feeApplication).toBe('DEDUCTED');
      });

      it('rules that disagree fall back to the flow default', async () => {
        const { resolve } = setup({
          rules: [
            rule({
              id: 'a',
              companyId: CO,
              feeApplication: 'DEDUCTED',
              minAmount: '100',
              maxAmount: '200',
            }),
            rule({ id: 'b', companyId: CO, feeApplication: 'ON_TOP', minAmount: '300' }),
          ],
          ...on,
        });
        expect((await resolve('50', 'WITHDRAWAL')).feeApplication).toBe('ON_TOP');
        expect((await resolve('250', 'WITHDRAWAL')).feeApplication).toBe('ON_TOP');
      });

      it('without a network fee the hole stays DEDUCTED exactly as before', async () => {
        const { resolve } = setup({
          rules: [rule({ companyId: CO, feeApplication: 'ON_TOP', minAmount: '100' })],
        });
        const r = await resolve('50', 'WITHDRAWAL');
        expect(r.fees.network.isZero()).toBe(true);
        expect(r.feeApplication).toBe('DEDUCTED');
      });
    });
  });
});
