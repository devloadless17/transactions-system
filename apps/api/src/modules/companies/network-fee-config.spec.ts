import { describe, expect, it } from 'vitest';
import type { NetworkFeeConfigResponse } from '@app/shared';
import { recordAuditChanges } from '../audit/audit-changes';
import type { AuthenticatedRequest } from '../../common/types/request.types';
import { diffNetworkFeeConfig, toNetworkFeeConfig } from './network-fee-config';

const dec = (s: string) => ({ toString: () => s });

describe('toNetworkFeeConfig', () => {
  it('returns rates in flow order with canonical values, whatever the row order', () => {
    const cfg = toNetworkFeeConfig(true, [
      { operationType: 'LOAD', feeType: 'FIXED', feeValue: dec('2.00000000') },
      { operationType: 'TRANSACTION', feeType: 'PERCENTAGE', feeValue: dec('0.12500000') },
    ]);
    expect(cfg).toEqual({
      enabled: true,
      rates: [
        { operationType: 'TRANSACTION', feeType: 'PERCENTAGE', feeValue: '0.125' },
        { operationType: 'LOAD', feeType: 'FIXED', feeValue: '2' },
      ],
    });
  });

  it('never rounds a rate to cents (0.125% stays 0.125)', () => {
    const cfg = toNetworkFeeConfig(true, [
      { operationType: 'TRANSACTION', feeType: 'PERCENTAGE', feeValue: dec('0.125') },
    ]);
    expect(cfg.rates[0]!.feeValue).toBe('0.125');
  });

  it('an unconfigured company is OFF with no rates', () => {
    expect(toNetworkFeeConfig(false, [])).toEqual({ enabled: false, rates: [] });
  });
});

describe('diffNetworkFeeConfig', () => {
  const OFF: NetworkFeeConfigResponse = { enabled: false, rates: [] };

  it('records turning it on and each rate that appeared', () => {
    expect(
      diffNetworkFeeConfig(OFF, {
        enabled: true,
        rates: [
          { operationType: 'TRANSACTION', feeType: 'PERCENTAGE', feeValue: '1' },
          { operationType: 'WITHDRAWAL', feeType: 'FIXED', feeValue: '2' },
        ],
      }),
    ).toEqual({
      networkFeeEnabled: { from: false, to: true },
      'networkFee.TRANSACTION': { from: null, to: 'PERCENTAGE 1' },
      'networkFee.WITHDRAWAL': { from: null, to: 'FIXED 2' },
    });
  });

  it('records a changed rate and a removed one', () => {
    const before: NetworkFeeConfigResponse = {
      enabled: true,
      rates: [
        { operationType: 'TRANSACTION', feeType: 'PERCENTAGE', feeValue: '1' },
        { operationType: 'LOAD', feeType: 'FIXED', feeValue: '2' },
      ],
    };
    expect(
      diffNetworkFeeConfig(before, {
        enabled: true,
        rates: [{ operationType: 'TRANSACTION', feeType: 'PERCENTAGE', feeValue: '1.5' }],
      }),
    ).toEqual({
      'networkFee.TRANSACTION': { from: 'PERCENTAGE 1', to: 'PERCENTAGE 1.5' },
      'networkFee.LOAD': { from: 'FIXED 2', to: null },
    });
  });

  it('an identical save — even "2.00" over "2" — records nothing', () => {
    const before: NetworkFeeConfigResponse = {
      enabled: true,
      rates: [{ operationType: 'WITHDRAWAL', feeType: 'FIXED', feeValue: '2' }],
    };
    expect(
      diffNetworkFeeConfig(before, {
        enabled: true,
        rates: [{ operationType: 'WITHDRAWAL', feeType: 'FIXED', feeValue: '2.00' }],
      }),
    ).toEqual({});
  });

  it('switching the fee type is a change even at the same value', () => {
    const before: NetworkFeeConfigResponse = {
      enabled: true,
      rates: [{ operationType: 'PAYOUT', feeType: 'FIXED', feeValue: '1' }],
    };
    expect(
      diffNetworkFeeConfig(before, {
        enabled: true,
        rates: [{ operationType: 'PAYOUT', feeType: 'PERCENTAGE', feeValue: '1' }],
      }),
    ).toEqual({ 'networkFee.PAYOUT': { from: 'FIXED 1', to: 'PERCENTAGE 1' } });
  });

  // The audit writer drops any field name that looks like a credential; the
  // network-fee keys must never be mistaken for one, or the change goes unaudited.
  it('every key survives the audit writer’s sensitive-field filter', () => {
    const changes = diffNetworkFeeConfig(OFF, {
      enabled: true,
      rates: (['TRANSACTION', 'WITHDRAWAL', 'PAYOUT', 'LOAD'] as const).map((operationType) => ({
        operationType,
        feeType: 'FIXED' as const,
        feeValue: '1',
      })),
    });
    const req = {} as AuthenticatedRequest;
    recordAuditChanges(req, changes);
    expect(Object.keys(req.auditChanges ?? {}).sort()).toEqual(Object.keys(changes).sort());
    expect(Object.keys(changes)).toHaveLength(5);
  });
});
