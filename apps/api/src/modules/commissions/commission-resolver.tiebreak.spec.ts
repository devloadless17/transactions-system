import { describe, expect, it } from 'vitest';
import { Money } from '@app/shared';
import {
  CommissionResolverService,
  NoMatchingCommissionRuleError,
  type ResolvableRule,
} from './commission-resolver.service';

const svc = new CommissionResolverService();
const company = '11111111-1111-1111-1111-111111111111';

function rule(p: Partial<ResolvableRule>): ResolvableRule {
  return {
    id: p.id ?? 'id',
    companyId: p.companyId ?? null,
    sourceId: p.sourceId ?? null,
    operationType: 'TRANSACTION',
    feeApplication: 'DEDUCTED',
    minAmount: p.minAmount ?? '0',
    maxAmount: p.maxAmount ?? null,
    commissionType: p.commissionType ?? 'FIXED',
    commissionValue: p.commissionValue ?? '0',
    priority: p.priority ?? 100,
    active: true,
    createdAt: p.createdAt,
  };
}

describe('CommissionResolver determinism', () => {
  it('breaks an equal specificity+priority+createdAt tie by id ASC, INDEPENDENT of input order', () => {
    const a = rule({ id: 'aaaa', commissionValue: '1' });
    const b = rule({ id: 'bbbb', commissionValue: '2' });
    const pick = (rules: ResolvableRule[]) =>
      svc
        .resolve({
          companyId: company,
          sourceId: null,
          operationType: 'TRANSACTION',
          amount: Money.of('50'),
          rules,
        })
        .commissionAmount.toString();
    // Both rules tie on specificity (global), priority (100) and createdAt
    // (undefined). The lower id ('aaaa', value 1) must win regardless of the
    // order the candidates arrive in.
    expect(pick([a, b])).toBe('1');
    expect(pick([b, a])).toBe('1');
  });

  it('older createdAt wins over newer at equal specificity+priority (before the id tie-break)', () => {
    const older = rule({
      id: 'zzzz',
      commissionValue: '1',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    });
    const newer = rule({
      id: 'aaaa',
      commissionValue: '2',
      createdAt: new Date('2026-02-01T00:00:00Z'),
    });
    const r = svc.resolve({
      companyId: company,
      sourceId: null,
      operationType: 'TRANSACTION',
      amount: Money.of('50'),
      rules: [newer, older],
    });
    // Older wins despite its higher id — createdAt ranks above the id tie-break.
    expect(r.commissionAmount.toString()).toBe('1');
  });
});

describe('CommissionResolver coverage contract (ingest must never 422 a real deposit)', () => {
  // The admin UI and the seed build a TOTAL ladder: zero-based, 8dp-contiguous
  // (next.min = prev.max + 1e-8) and OPEN at the top (last maxAmount = null). With
  // such a ladder every amount resolves, so ingest's throwing resolve() never 422s.
  // Low tier is PERCENTAGE so even sub-$1 deposits are priced below their amount
  // (a FIXED low-tier fee that exceeds a tiny amount is a separate, correct guard —
  // CommissionExceedsAmountError — not a coverage gap).
  const total: ResolvableRule[] = [
    rule({ minAmount: '0', maxAmount: '100', commissionType: 'PERCENTAGE', commissionValue: '1' }),
    rule({ minAmount: '100.00000001', maxAmount: '300', commissionValue: '5' }),
    rule({
      minAmount: '300.00000001',
      maxAmount: null,
      commissionType: 'PERCENTAGE',
      commissionValue: '2',
    }),
  ];
  const price = (amount: string, rules: ResolvableRule[] = total) =>
    svc
      .resolve({
        companyId: company,
        sourceId: null,
        operationType: 'TRANSACTION',
        amount: Money.of(amount),
        rules,
      })
      .commissionAmount.toString();

  it('prices fractional amounts at tier boundaries (no representable gap)', () => {
    expect(price('100.50')).toBe('5'); // in the gap of a NAIVE [.,100]/[101,.] ladder → tier 2
    expect(price('100.00000001')).toBe('5'); // exact start of tier 2
    expect(price('100')).toBe('1'); // exact end of tier 1 (1% of 100)
    expect(price('0.5')).toBe('0.005'); // zero-based low end (1% of 0.5)
  });

  it('prices amounts above every finite tier via the open-ended top tier', () => {
    expect(price('1500')).toBe('30'); // 2% of 1500 — would 422 against a finite top
    expect(price('100000000')).toBe('2000000');
  });

  it('a GAPPED / finite-topped ladder 422s amounts it fails to cover (the seed-fix regression guard)', () => {
    const gapped: ResolvableRule[] = [
      rule({ minAmount: '1', maxAmount: '100', commissionValue: '1' }),
      rule({ minAmount: '101', maxAmount: '1000', commissionValue: '5' }),
    ];
    expect(() => price('100.50', gapped)).toThrow(NoMatchingCommissionRuleError); // inter-tier gap
    expect(() => price('0.5', gapped)).toThrow(NoMatchingCommissionRuleError); // below first min
    expect(() => price('1500', gapped)).toThrow(NoMatchingCommissionRuleError); // above finite top
  });
});
