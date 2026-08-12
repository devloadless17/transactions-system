import { describe, expect, it } from 'vitest';
import { Money } from '@app/shared';
import {
  CommissionExceedsAmountError,
  CommissionResolverService,
  NoMatchingCommissionRuleError,
  type ResolvableRule,
} from './commission-resolver.service';

const company = '11111111-1111-1111-1111-111111111111';
const otherCompany = '22222222-2222-2222-2222-222222222222';
const source = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const otherSource = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function rule(partial: Partial<ResolvableRule>): ResolvableRule {
  return {
    id: partial.id ?? Math.random().toString(36).slice(2),
    companyId: partial.companyId ?? null,
    sourceId: partial.sourceId ?? null,
    operationType: partial.operationType ?? 'TRANSACTION',
    feeApplication: partial.feeApplication ?? 'DEDUCTED',
    minAmount: partial.minAmount ?? '0',
    maxAmount: partial.maxAmount ?? '999999999',
    commissionType: partial.commissionType ?? 'FIXED',
    commissionValue: partial.commissionValue ?? '0',
    priority: partial.priority ?? 0,
    active: partial.active ?? true,
    createdAt: partial.createdAt,
  };
}

const svc = new CommissionResolverService();

describe('CommissionResolverService', () => {
  describe('basic spec example', () => {
    // From the spec:
    //   1 → 100   => fixed 1$
    //   101 → 300 => fixed 5$
    //   301 → 1000 => 2%
    const sample: ResolvableRule[] = [
      rule({ minAmount: '1', maxAmount: '100', commissionType: 'FIXED', commissionValue: '1' }),
      rule({ minAmount: '101', maxAmount: '300', commissionType: 'FIXED', commissionValue: '5' }),
      rule({
        minAmount: '301',
        maxAmount: '1000',
        commissionType: 'PERCENTAGE',
        commissionValue: '2',
      }),
    ];

    it('matches the first bracket (fixed 1$)', () => {
      const r = svc.resolve({
        companyId: company,
        sourceId: source,
        operationType: 'TRANSACTION',
        amount: Money.of('50'),
        rules: sample,
      });
      expect(r.commissionAmount.toString()).toBe('1');
      expect(r.netAmount.toString()).toBe('49');
    });

    it('matches an open-ended top tier (maxAmount = null) for any large amount', () => {
      const openEnded: ResolvableRule = {
        ...rule({ minAmount: '500', commissionType: 'PERCENTAGE', commissionValue: '2.5' }),
        maxAmount: null,
      };
      const r = svc.resolve({
        companyId: company,
        sourceId: source,
        operationType: 'TRANSACTION',
        amount: Money.of('1000000000000'), // a trillion — no upper bound
        rules: [openEnded],
      });
      expect(r.commissionAmount.toString()).toBe('25000000000');
    });

    it('matches the second bracket (fixed 5$)', () => {
      const r = svc.resolve({
        companyId: company,
        sourceId: source,
        operationType: 'TRANSACTION',
        amount: Money.of('200'),
        rules: sample,
      });
      expect(r.commissionAmount.toString()).toBe('5');
      expect(r.netAmount.toString()).toBe('195');
    });

    it('matches the percentage bracket (2%)', () => {
      const r = svc.resolve({
        companyId: company,
        sourceId: source,
        operationType: 'TRANSACTION',
        amount: Money.of('500'),
        rules: sample,
      });
      expect(r.commissionAmount.toString()).toBe('10');
      expect(r.netAmount.toString()).toBe('490');
    });

    it('matches at the boundary (exact min)', () => {
      const r = svc.resolve({
        companyId: company,
        sourceId: source,
        operationType: 'TRANSACTION',
        amount: Money.of('101'),
        rules: sample,
      });
      expect(r.commissionAmount.toString()).toBe('5');
    });

    it('matches at the boundary (exact max)', () => {
      const r = svc.resolve({
        companyId: company,
        sourceId: source,
        operationType: 'TRANSACTION',
        amount: Money.of('1000'),
        rules: sample,
      });
      // 2% of 1000 = 20
      expect(r.commissionAmount.toString()).toBe('20');
    });

    it('throws when no rule covers the amount', () => {
      expect(() =>
        svc.resolve({
          companyId: company,
          sourceId: source,
          operationType: 'TRANSACTION',
          amount: Money.of('5000'),
          rules: sample,
        }),
      ).toThrow(NoMatchingCommissionRuleError);
    });
  });

  describe('specificity ranking', () => {
    it('company+source wins over company-only over source-only over global', () => {
      const global = rule({ commissionValue: '10', id: 'g' });
      const companyOnly = rule({ companyId: company, commissionValue: '20', id: 'c' });
      const sourceOnly = rule({ sourceId: source, commissionValue: '30', id: 's' });
      const both = rule({ companyId: company, sourceId: source, commissionValue: '40', id: 'b' });

      const r = svc.resolve({
        companyId: company,
        sourceId: source,
        operationType: 'TRANSACTION',
        amount: Money.of('50'),
        rules: [global, companyOnly, sourceOnly, both],
      });
      expect(r.rule.id).toBe('b');
      expect(r.commissionAmount.toString()).toBe('40');
    });

    it('a specific-company rule beats a global rule even with LOWER priority', () => {
      // Specificity dominates priority: a company-scoped rule always wins over an
      // "all companies" (global) rule for that company, regardless of priority.
      const global = rule({ commissionValue: '10', id: 'g', priority: 1000 });
      const companyOnly = rule({ companyId: company, commissionValue: '20', id: 'c', priority: 1 });
      const r = svc.resolve({
        companyId: company,
        sourceId: source,
        operationType: 'TRANSACTION',
        amount: Money.of('50'),
        rules: [global, companyOnly],
      });
      expect(r.rule.id).toBe('c');
      expect(r.commissionAmount.toString()).toBe('20');
    });

    it('falls back to source-only when company-specific is absent', () => {
      const global = rule({ commissionValue: '10', id: 'g' });
      const sourceOnly = rule({ sourceId: source, commissionValue: '30', id: 's' });
      const r = svc.resolve({
        companyId: company,
        sourceId: source,
        operationType: 'TRANSACTION',
        amount: Money.of('50'),
        rules: [global, sourceOnly],
      });
      expect(r.rule.id).toBe('s');
    });

    it('ignores rules for other companies', () => {
      const otherCo = rule({ companyId: otherCompany, commissionValue: '999', id: 'x' });
      const global = rule({ commissionValue: '5', id: 'g' });
      const r = svc.resolve({
        companyId: company,
        sourceId: source,
        operationType: 'TRANSACTION',
        amount: Money.of('50'),
        rules: [otherCo, global],
      });
      expect(r.rule.id).toBe('g');
    });

    it('ignores rules for other sources', () => {
      const otherSrc = rule({ sourceId: otherSource, commissionValue: '999', id: 'x' });
      const global = rule({ commissionValue: '5', id: 'g' });
      const r = svc.resolve({
        companyId: company,
        sourceId: source,
        operationType: 'TRANSACTION',
        amount: Money.of('50'),
        rules: [otherSrc, global],
      });
      expect(r.rule.id).toBe('g');
    });
  });

  describe('priority tie-break', () => {
    it('higher priority wins among same-specificity rules', () => {
      const low = rule({ sourceId: source, commissionValue: '1', priority: 0, id: 'low' });
      const high = rule({ sourceId: source, commissionValue: '2', priority: 100, id: 'high' });
      const r = svc.resolve({
        companyId: company,
        sourceId: source,
        operationType: 'TRANSACTION',
        amount: Money.of('50'),
        rules: [low, high],
      });
      expect(r.rule.id).toBe('high');
    });
  });

  describe('active flag', () => {
    it('skips inactive rules', () => {
      const inactive = rule({ commissionValue: '99', active: false, id: 'in' });
      const active = rule({ commissionValue: '1', id: 'on' });
      const r = svc.resolve({
        companyId: company,
        sourceId: source,
        operationType: 'TRANSACTION',
        amount: Money.of('50'),
        rules: [inactive, active],
      });
      expect(r.rule.id).toBe('on');
    });
  });

  describe('amount range', () => {
    it('skips rules whose amount range does not cover the input', () => {
      const lowRange = rule({ minAmount: '1', maxAmount: '10', commissionValue: '99', id: 'lo' });
      const correct = rule({ minAmount: '11', maxAmount: '100', commissionValue: '1', id: 'ok' });
      const r = svc.resolve({
        companyId: company,
        sourceId: source,
        operationType: 'TRANSACTION',
        amount: Money.of('50'),
        rules: [lowRange, correct],
      });
      expect(r.rule.id).toBe('ok');
    });
  });

  describe('decimal precision', () => {
    it('handles fractional percentage correctly', () => {
      const r = svc.resolve({
        companyId: company,
        sourceId: source,
        operationType: 'TRANSACTION',
        amount: Money.of('123.45'),
        rules: [
          rule({
            minAmount: '0',
            maxAmount: '10000',
            commissionType: 'PERCENTAGE',
            commissionValue: '2.5',
          }),
        ],
      });
      // 2.5% of 123.45 = 3.08625 exactly; quantized to cents (half-even, the
      // digit past the cent is 6) that books as 3.09.
      expect(r.commissionAmount.toString()).toBe('3.09');
    });
  });

  describe('commission cannot exceed amount (DEDUCTED)', () => {
    it('throws when a DEDUCTED fixed fee is larger than the amount', () => {
      expect(() =>
        svc.resolve({
          companyId: company,
          sourceId: source,
          operationType: 'TRANSACTION',
          amount: Money.of('100'),
          rules: [
            rule({
              minAmount: '1',
              maxAmount: '1000',
              commissionType: 'FIXED',
              commissionValue: '150',
              feeApplication: 'DEDUCTED',
            }),
          ],
        }),
      ).toThrow(CommissionExceedsAmountError);
    });

    it('throws when a DEDUCTED percentage fee exceeds 100% of the amount', () => {
      expect(() =>
        svc.resolve({
          companyId: company,
          sourceId: source,
          operationType: 'TRANSACTION',
          amount: Money.of('100'),
          rules: [
            rule({
              minAmount: '1',
              maxAmount: '1000',
              commissionType: 'PERCENTAGE',
              commissionValue: '150',
              feeApplication: 'DEDUCTED',
            }),
          ],
        }),
      ).toThrow(CommissionExceedsAmountError);
    });

    it('allows a fee EQUAL to the amount (net 0)', () => {
      const r = svc.resolve({
        companyId: company,
        sourceId: source,
        operationType: 'TRANSACTION',
        amount: Money.of('100'),
        rules: [
          rule({
            minAmount: '1',
            maxAmount: '1000',
            commissionType: 'FIXED',
            commissionValue: '100',
            feeApplication: 'DEDUCTED',
          }),
        ],
      });
      expect(r.commissionAmount.toString()).toBe('100');
      expect(r.netAmount.toString()).toBe('0');
    });

    it('does NOT throw for ON_TOP fees larger than the amount (fee is added on top)', () => {
      const r = svc.resolve({
        companyId: company,
        sourceId: source,
        operationType: 'WITHDRAWAL',
        amount: Money.of('100'),
        rules: [
          rule({
            operationType: 'WITHDRAWAL',
            minAmount: '1',
            maxAmount: '1000',
            commissionType: 'FIXED',
            commissionValue: '150',
            feeApplication: 'ON_TOP',
          }),
        ],
      });
      expect(r.commissionAmount.toString()).toBe('150');
    });
  });
});
