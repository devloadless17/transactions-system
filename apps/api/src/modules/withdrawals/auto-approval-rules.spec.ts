import { describe, expect, it } from 'vitest';
import {
  autoApprovalSkipReason,
  describeSkipReason,
  type AutoApprovalGates,
  type AutoApprovalSubject,
} from './auto-approval-rules';

// A withdrawal that WOULD auto-approve, and a platform state that allows it.
const OK_SUBJECT: AutoApprovalSubject = {
  payoutMethod: 'WISH',
  currency: 'USD',
  netAmount: '100',
};
const OK_GATES: AutoApprovalGates = {
  enabled: true,
  enabledAt: new Date('2026-01-01T00:00:00Z'),
  circuitBreakerTrippedAt: null,
  maxAutoApproveAmount: '500',
  w2wEnabled: true,
  sessionConfigured: true,
};

const reasonFor = (s: Partial<AutoApprovalSubject> = {}, g: Partial<AutoApprovalGates> = {}) =>
  autoApprovalSkipReason({ ...OK_SUBJECT, ...s }, { ...OK_GATES, ...g });

describe('autoApprovalSkipReason — will auto-approve', () => {
  it('returns null for an in-scope, under-cap WISH/USD withdrawal', () => {
    expect(reasonFor()).toBeNull();
  });
});

describe('autoApprovalSkipReason — platform gates (mirror tick() order)', () => {
  it('CIRCUIT_BREAKER wins even when everything else is fine', () => {
    expect(reasonFor({}, { circuitBreakerTrippedAt: new Date() })).toBe('CIRCUIT_BREAKER');
  });

  it('breaker is checked before `enabled`', () => {
    expect(reasonFor({}, { circuitBreakerTrippedAt: new Date(), enabled: false })).toBe(
      'CIRCUIT_BREAKER',
    );
  });

  it('DISABLED when the feature is off', () => {
    expect(reasonFor({}, { enabled: false })).toBe('DISABLED');
  });

  it('DISABLED when enabled but enabledAt was never stamped', () => {
    expect(reasonFor({}, { enabled: true, enabledAt: null })).toBe('DISABLED');
  });

  it('W2W_DISABLED when the env flag is off', () => {
    expect(reasonFor({}, { w2wEnabled: false })).toBe('W2W_DISABLED');
  });

  it('SESSION_UNAVAILABLE when no healthy Whish session', () => {
    expect(reasonFor({}, { sessionConfigured: false })).toBe('SESSION_UNAVAILABLE');
  });
});

describe('autoApprovalSkipReason — per-withdrawal scoping', () => {
  // The user's explicit requirement: cash/crypto ALWAYS need a human, at ANY amount.
  it.each(['CASH', 'CRYPTO', 'BANK_TRANSFER', 'OTHER'])(
    '%s withdrawals are never auto-approved (large amount)',
    (method) => {
      expect(reasonFor({ payoutMethod: method, netAmount: '10' })).toBe('METHOD_NOT_SUPPORTED');
    },
  );

  it.each(['CASH', 'CRYPTO'])('%s withdrawals need a human even for a tiny amount', (method) => {
    expect(reasonFor({ payoutMethod: method, netAmount: '2' })).toBe('METHOD_NOT_SUPPORTED');
  });

  it('CURRENCY_NOT_SUPPORTED for non-USD', () => {
    expect(reasonFor({ currency: 'LBP' })).toBe('CURRENCY_NOT_SUPPORTED');
  });

  it('method is checked before currency', () => {
    expect(reasonFor({ payoutMethod: 'CASH', currency: 'LBP' })).toBe('METHOD_NOT_SUPPORTED');
  });
});

describe('autoApprovalSkipReason — Decimal-exact amount boundaries', () => {
  it('net exactly at the cap still auto-approves', () => {
    expect(reasonFor({ netAmount: '500' })).toBeNull();
  });

  it('one satoshi-scale unit over the cap is ABOVE_CAP', () => {
    expect(reasonFor({ netAmount: '500.00000001' })).toBe('ABOVE_CAP');
  });

  it('net exactly at the $1 minimum still auto-approves', () => {
    expect(reasonFor({ netAmount: '1' })).toBeNull();
  });

  it('a hair under $1 is BELOW_MIN_NET (flooring would send $0)', () => {
    expect(reasonFor({ netAmount: '0.99999999' })).toBe('BELOW_MIN_NET');
  });

  it('respects a custom cap from config', () => {
    expect(reasonFor({ netAmount: '750' }, { maxAutoApproveAmount: '1000' })).toBeNull();
    expect(reasonFor({ netAmount: '1000.5' }, { maxAutoApproveAmount: '1000' })).toBe('ABOVE_CAP');
  });

  it('trailing-zero decimals compare numerically, not as strings', () => {
    expect(reasonFor({ netAmount: '500.00' })).toBeNull();
    expect(reasonFor({ netAmount: '499.99999999' })).toBeNull();
  });

  it('below-min is checked before above-cap', () => {
    expect(reasonFor({ netAmount: '0.5' }, { maxAutoApproveAmount: '0.1' })).toBe('BELOW_MIN_NET');
  });
});

describe('describeSkipReason — short, phone-glanceable text', () => {
  const ctx = {
    payoutMethod: 'CASH',
    currency: 'USD',
    netAmount: '610.00',
    maxAutoApproveAmount: '500',
  };

  it('ABOVE_CAP names the cap and the NET amount (not the gross)', () => {
    expect(describeSkipReason('ABOVE_CAP', ctx)).toBe('above cap (610.00 > 500 USD)');
  });

  it.each([
    ['CASH', 'CASH withdrawal'],
    ['CRYPTO', 'CRYPTO withdrawal'],
  ])('METHOD_NOT_SUPPORTED for %s reads "%s"', (method, expected) => {
    expect(describeSkipReason('METHOD_NOT_SUPPORTED', { ...ctx, payoutMethod: method })).toBe(
      expected,
    );
  });

  it('platform reasons are terse', () => {
    expect(describeSkipReason('DISABLED', ctx)).toBe('auto-approval off');
    expect(describeSkipReason('CIRCUIT_BREAKER', ctx)).toBe(
      'auto-approval paused (circuit breaker)',
    );
    expect(describeSkipReason('W2W_DISABLED', ctx)).toBe('Whish transfers disabled');
    expect(describeSkipReason('SESSION_UNAVAILABLE', ctx)).toBe('no Whish session');
  });

  it('CURRENCY_NOT_SUPPORTED / BELOW_MIN_NET are terse', () => {
    expect(describeSkipReason('CURRENCY_NOT_SUPPORTED', { ...ctx, currency: 'LBP' })).toBe(
      'non-USD (LBP)',
    );
    expect(describeSkipReason('BELOW_MIN_NET', ctx)).toBe('net under 1 USD');
  });

  it('every reason stays short enough to read at a glance', () => {
    const reasons = [
      'CIRCUIT_BREAKER',
      'DISABLED',
      'W2W_DISABLED',
      'SESSION_UNAVAILABLE',
      'METHOD_NOT_SUPPORTED',
      'CURRENCY_NOT_SUPPORTED',
      'BELOW_MIN_NET',
      'ABOVE_CAP',
    ] as const;
    for (const r of reasons) {
      const msg = describeSkipReason(r, ctx);
      expect(msg.length).toBeGreaterThan(0);
      expect(msg.length).toBeLessThanOrEqual(40);
    }
  });
});
