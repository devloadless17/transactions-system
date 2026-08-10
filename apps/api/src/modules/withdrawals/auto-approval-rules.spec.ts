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
const HEALTHY_SESSION = {
  configured: true,
  lastRotatedAt: null as Date | null,
  lastAuthFailureAt: null as Date | null,
};
const OK_GATES: AutoApprovalGates = {
  enabled: true,
  enabledAt: new Date('2026-01-01T00:00:00Z'),
  circuitBreakerTrippedAt: null,
  maxAutoApproveAmount: '500',
  w2wEnabled: true,
  session: HEALTHY_SESSION,
  simulate: false,
};

const reasonFor = (s: Partial<AutoApprovalSubject> = {}, g: Partial<AutoApprovalGates> = {}) =>
  autoApprovalSkipReason({ ...OK_SUBJECT, ...s }, { ...OK_GATES, ...g });

describe('autoApprovalSkipReason — will auto-approve', () => {
  it('returns null for an in-scope, under-cap WISH/USD withdrawal', () => {
    expect(reasonFor()).toBeNull();
  });
});

describe('autoApprovalSkipReason — platform gates (mirror tick() order)', () => {
  const TRIPPED = new Date('2026-06-01T10:00:00Z');

  it('CIRCUIT_BREAKER wins even when everything else is fine', () => {
    expect(reasonFor({}, { circuitBreakerTrippedAt: TRIPPED })).toBe('CIRCUIT_BREAKER');
  });

  it('breaker is checked before `enabled`', () => {
    expect(reasonFor({}, { circuitBreakerTrippedAt: TRIPPED, enabled: false })).toBe(
      'CIRCUIT_BREAKER',
    );
  });

  // tick() calls maybeAutoResume() and CONTINUES when the session was re-pasted
  // after the trip. Reporting CIRCUIT_BREAKER there would page a human for a
  // withdrawal the poller is about to auto-settle.
  it('does NOT report CIRCUIT_BREAKER when the breaker would auto-resume', () => {
    expect(
      reasonFor(
        {},
        {
          circuitBreakerTrippedAt: TRIPPED,
          session: {
            configured: true,
            lastRotatedAt: new Date('2026-06-01T10:05:00Z'), // refreshed AFTER the trip
            lastAuthFailureAt: null,
          },
        },
      ),
    ).toBeNull();
  });

  it('still reports CIRCUIT_BREAKER when the session was rotated BEFORE the trip', () => {
    expect(
      reasonFor(
        {},
        {
          circuitBreakerTrippedAt: TRIPPED,
          session: {
            configured: true,
            lastRotatedAt: new Date('2026-06-01T09:00:00Z'),
            lastAuthFailureAt: null,
          },
        },
      ),
    ).toBe('CIRCUIT_BREAKER');
  });

  it('still reports CIRCUIT_BREAKER when a rotated session has an auth failure', () => {
    expect(
      reasonFor(
        {},
        {
          circuitBreakerTrippedAt: TRIPPED,
          session: {
            configured: true,
            lastRotatedAt: new Date('2026-06-01T10:05:00Z'),
            lastAuthFailureAt: new Date('2026-06-01T10:06:00Z'),
          },
        },
      ),
    ).toBe('CIRCUIT_BREAKER');
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
    expect(reasonFor({}, { session: { ...HEALTHY_SESSION, configured: false } })).toBe(
      'SESSION_UNAVAILABLE',
    );
  });
});

// Mirrors tick()'s simulate branch: settling never touches Whish, so none of the
// Whish-side gates (breaker / W2W env flag / session) may block or page a human —
// while the admin toggle and the per-withdrawal scoping still apply unchanged.
describe('autoApprovalSkipReason — simulate mode (staging)', () => {
  const TRIPPED = new Date('2026-06-01T10:00:00Z');
  const NO_WHISH = {
    simulate: true,
    w2wEnabled: false,
    session: { ...HEALTHY_SESSION, configured: false },
    circuitBreakerTrippedAt: TRIPPED,
  };

  it('auto-approves with W2W off, no session, and a tripped breaker', () => {
    expect(reasonFor({}, NO_WHISH)).toBeNull();
  });

  it('the admin toggle still gates (DISABLED)', () => {
    expect(reasonFor({}, { ...NO_WHISH, enabled: false })).toBe('DISABLED');
    expect(reasonFor({}, { ...NO_WHISH, enabledAt: null })).toBe('DISABLED');
  });

  it('per-withdrawal scoping still applies', () => {
    expect(reasonFor({ payoutMethod: 'CASH' }, NO_WHISH)).toBe('METHOD_NOT_SUPPORTED');
    expect(reasonFor({ currency: 'LBP' }, NO_WHISH)).toBe('CURRENCY_NOT_SUPPORTED');
    expect(reasonFor({ netAmount: '0.5' }, NO_WHISH)).toBe('BELOW_MIN_NET');
    expect(reasonFor({ netAmount: '500.01' }, NO_WHISH)).toBe('ABOVE_CAP');
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
