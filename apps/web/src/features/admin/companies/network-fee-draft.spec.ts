import { describe, expect, it } from 'vitest';
import {
  CommissionType,
  FeeOperationType,
  setNetworkFeeConfigSchema,
  type NetworkFeeConfigResponse,
} from '@app/shared';
import {
  buildInput,
  confirmSaveMessage,
  draftFromConfig,
  exampleOn100,
  formatNetworkFeeRate,
  isDirty,
  rateError,
  rateSummary,
  type NetworkFeeDraft,
} from './network-fee-draft';

/**
 * The network-fee card decides what a tenant is charged, so its draft → API
 * body mapping is pinned here: blank flows are not charged, every value the
 * card accepts is one the API accepts, and the "On $100" example matches the
 * API's own arithmetic.
 */

const OFF: NetworkFeeConfigResponse = { enabled: false, rates: [] };
const ON: NetworkFeeConfigResponse = {
  enabled: true,
  rates: [
    {
      operationType: FeeOperationType.TRANSACTION,
      feeType: CommissionType.PERCENTAGE,
      feeValue: '1',
    },
    { operationType: FeeOperationType.WITHDRAWAL, feeType: CommissionType.FIXED, feeValue: '2' },
  ],
};

function withRate(
  draft: NetworkFeeDraft,
  op: FeeOperationType,
  feeType: CommissionType,
  feeValue: string,
): NetworkFeeDraft {
  return { ...draft, rates: { ...draft.rates, [op]: { feeType, feeValue } } };
}

describe('draftFromConfig', () => {
  it('starts every flow blank (not charged) on % for a company that has none', () => {
    const d = draftFromConfig(OFF);
    expect(d.enabled).toBe(false);
    for (const op of Object.values(FeeOperationType)) {
      expect(d.rates[op]).toEqual({ feeType: CommissionType.PERCENTAGE, feeValue: '' });
    }
  });

  it('carries saved rates onto their flows and leaves the rest blank', () => {
    const d = draftFromConfig(ON);
    expect(d.enabled).toBe(true);
    expect(d.rates.TRANSACTION).toEqual({ feeType: CommissionType.PERCENTAGE, feeValue: '1' });
    expect(d.rates.WITHDRAWAL).toEqual({ feeType: CommissionType.FIXED, feeValue: '2' });
    expect(d.rates.PAYOUT.feeValue).toBe('');
    expect(d.rates.LOAD.feeValue).toBe('');
  });
});

describe('rateError', () => {
  const pct = (feeValue: string) => rateError({ feeType: CommissionType.PERCENTAGE, feeValue });
  const fixed = (feeValue: string) => rateError({ feeType: CommissionType.FIXED, feeValue });

  it('accepts a blank flow (not charged)', () => {
    expect(pct('')).toBeNull();
    expect(pct('   ')).toBeNull();
  });

  it('accepts a % up to 100 with up to 8 decimals', () => {
    expect(pct('1')).toBeNull();
    expect(pct('0.125')).toBeNull();
    expect(pct('0.00000001')).toBeNull();
    expect(pct('100')).toBeNull();
  });

  it('accepts a fixed fee in cents', () => {
    expect(fixed('2')).toBeNull();
    expect(fixed('2.50')).toBeNull();
  });

  it('rejects what is not a positive decimal', () => {
    expect(pct('abc')).toMatch(/number/);
    expect(pct('-1')).toMatch(/number/);
    expect(pct('1,5')).toMatch(/number/);
    expect(pct('.5')).toMatch(/number/);
  });

  it('rejects zero, pointing at blank instead', () => {
    expect(pct('0')).toMatch(/blank/);
    expect(fixed('0.00')).toMatch(/blank/);
  });

  it('rejects a % over 100 and a fixed fee past cents', () => {
    expect(pct('100.01')).toMatch(/at most 100/);
    expect(fixed('2.005')).toMatch(/2 decimal places/);
    expect(pct('0.123456789')).toMatch(/8 decimal places/);
  });

  it('allows a fixed fee over 100 (it is an amount, not a rate)', () => {
    expect(fixed('150')).toBeNull();
  });
});

describe('buildInput', () => {
  it('maps filled flows to rates and leaves blank flows out', () => {
    let d = draftFromConfig(OFF);
    d = { ...d, enabled: true };
    d = withRate(d, FeeOperationType.TRANSACTION, CommissionType.PERCENTAGE, ' 1 ');
    d = withRate(d, FeeOperationType.LOAD, CommissionType.FIXED, '2.5');
    expect(buildInput(d)).toEqual({
      ok: true,
      value: {
        enabled: true,
        rates: [
          { operationType: 'TRANSACTION', feeType: 'PERCENTAGE', feeValue: '1' },
          { operationType: 'LOAD', feeType: 'FIXED', feeValue: '2.5' },
        ],
      },
    });
  });

  it('round-trips a saved config unchanged', () => {
    const built = buildInput(draftFromConfig(ON));
    expect(built).toEqual({ ok: true, value: ON });
  });

  it('allows switching off while keeping the rates', () => {
    const built = buildInput({ ...draftFromConfig(ON), enabled: false });
    expect(built).toEqual({ ok: true, value: { enabled: false, rates: ON.rates } });
  });

  it('allows the untouched default (off, nothing set)', () => {
    expect(buildInput(draftFromConfig(OFF))).toEqual({
      ok: true,
      value: { enabled: false, rates: [] },
    });
  });

  it('refuses switching on with no flow set, as the API does', () => {
    const built = buildInput({ ...draftFromConfig(OFF), enabled: true });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.formError).toMatch(/at least one flow/);
    expect(built.formError).toMatch(/\.$/);
    expect(built.rateErrors).toEqual({});
  });

  it('reports a bad flow on that flow only — not as "set at least one flow"', () => {
    const d = withRate(
      { ...draftFromConfig(OFF), enabled: true },
      FeeOperationType.PAYOUT,
      CommissionType.PERCENTAGE,
      '150',
    );
    const built = buildInput(d);
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(Object.keys(built.rateErrors)).toEqual(['PAYOUT']);
    expect(built.formError).toBeNull();
  });

  it('only ever produces a body the API schema accepts', () => {
    const samples = ['', '0', '1', '0.125', '100', '100.5', '2.005', 'x', '999999999999', '1e3'];
    for (const feeType of [CommissionType.PERCENTAGE, CommissionType.FIXED]) {
      for (const v of samples) {
        for (const enabled of [true, false]) {
          const d = withRate(
            { ...draftFromConfig(OFF), enabled },
            FeeOperationType.TRANSACTION,
            feeType,
            v,
          );
          const built = buildInput(d);
          if (built.ok) expect(setNetworkFeeConfigSchema.safeParse(built.value).success).toBe(true);
        }
      }
    }
  });
});

describe('exampleOn100', () => {
  it('works a % on $100, rounded to cents', () => {
    expect(exampleOn100({ feeType: CommissionType.PERCENTAGE, feeValue: '1' })).toBe(
      'On $100: $1.00',
    );
    expect(exampleOn100({ feeType: CommissionType.PERCENTAGE, feeValue: '0.125' })).toBe(
      'On $100: $0.12',
    );
    expect(exampleOn100({ feeType: CommissionType.PERCENTAGE, feeValue: '2.5' })).toBe(
      'On $100: $2.50',
    );
  });

  it('shows a fixed fee as itself', () => {
    expect(exampleOn100({ feeType: CommissionType.FIXED, feeValue: '2' })).toBe('On $100: $2.00');
    expect(exampleOn100({ feeType: CommissionType.FIXED, feeValue: '1500' })).toBe(
      'On $100: $1,500.00',
    );
  });

  it('shows nothing for a blank or unsaveable value', () => {
    expect(exampleOn100({ feeType: CommissionType.PERCENTAGE, feeValue: '' })).toBeNull();
    expect(exampleOn100({ feeType: CommissionType.PERCENTAGE, feeValue: '150' })).toBeNull();
    expect(exampleOn100({ feeType: CommissionType.FIXED, feeValue: 'abc' })).toBeNull();
  });
});

describe('isDirty', () => {
  it('is clean straight from the server', () => {
    expect(isDirty(draftFromConfig(OFF), OFF)).toBe(false);
    expect(isDirty(draftFromConfig(ON), ON)).toBe(false);
  });

  it('treats an equal value in another form as no edit', () => {
    const d = withRate(
      draftFromConfig(ON),
      FeeOperationType.TRANSACTION,
      CommissionType.PERCENTAGE,
      '1.00',
    );
    expect(isDirty(d, ON)).toBe(false);
  });

  it('ignores flipping $/% on a blank flow', () => {
    const d = withRate(draftFromConfig(ON), FeeOperationType.PAYOUT, CommissionType.FIXED, '');
    expect(isDirty(d, ON)).toBe(false);
  });

  it('sees the switch, a value, a type and a cleared flow', () => {
    expect(isDirty({ ...draftFromConfig(ON), enabled: false }, ON)).toBe(true);
    const base = draftFromConfig(ON);
    expect(
      isDirty(withRate(base, FeeOperationType.TRANSACTION, CommissionType.PERCENTAGE, '2'), ON),
    ).toBe(true);
    expect(
      isDirty(withRate(base, FeeOperationType.TRANSACTION, CommissionType.FIXED, '1'), ON),
    ).toBe(true);
    expect(isDirty(withRate(base, FeeOperationType.WITHDRAWAL, CommissionType.FIXED, ''), ON)).toBe(
      true,
    );
  });
});

describe('formatting', () => {
  it('reads a rate the way the card shows it', () => {
    expect(formatNetworkFeeRate(CommissionType.PERCENTAGE, '1')).toBe('1%');
    expect(formatNetworkFeeRate(CommissionType.PERCENTAGE, '0.125')).toBe('0.125%');
    expect(formatNetworkFeeRate(CommissionType.PERCENTAGE, '1.50')).toBe('1.5%');
    expect(formatNetworkFeeRate(CommissionType.FIXED, '2')).toBe('$2.00');
  });

  it('summarizes the charged flows in order', () => {
    expect(rateSummary(ON.rates)).toBe('Deposits 1%, Withdrawals $2.00');
  });

  it('confirms each kind of save in plain words', () => {
    expect(confirmSaveMessage('Acme', ON, false)).toBe(
      'Save the network fee for Acme? New operations will be charged Deposits 1%, Withdrawals $2.00. Existing records keep the fees they were already charged.',
    );
    expect(confirmSaveMessage('Acme', { enabled: false, rates: ON.rates }, true)).toMatch(
      /^Turn off the network fee for Acme\?.*Existing records keep/,
    );
    expect(confirmSaveMessage('Acme', { enabled: false, rates: ON.rates }, false)).toMatch(
      /stays off/,
    );
  });
});
