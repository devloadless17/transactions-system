import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { THROTTLER_SKIP } from '@nestjs/throttler/dist/throttler.constants';
import { ApiKeyRateLimitGuard } from '../api-keys/guards/api-key-rate-limit.guard';
import { IntegrationsWhishController } from './integrations-whish.controller';
import { WhishPaymentsController } from './whish-payments.controller';

/**
 * `/v1/company/whish/payments` is the dashboard's twin of the Whish Pay API, and
 * companies call it with their API key too. A link's own calls must never be
 * refused at volume (a company's customers starting deposits at once), so they
 * carry the Whish Pay API's per-key brakes instead of the per-IP cap.
 */
const BUDGET = 'integration:rate-limit-budget';
const skipsPerIpCap = (handler: object) => Reflect.getMetadata(`${THROTTLER_SKIP}default`, handler);
const guards = (handler: object): unknown[] => Reflect.getMetadata(GUARDS_METADATA, handler) ?? [];

describe('WhishPaymentsController — the dashboard twin of the Whish Pay API', () => {
  const twin = WhishPaymentsController.prototype;

  it.each([
    ['create', twin.create, 'create'],
    ['get', twin.get, 'lookup'],
    ['refresh', twin.refresh, 'refresh'],
  ] as const)('%s: no per-IP cap — the per-key %s brake instead', (_name, handler, budget) => {
    expect(skipsPerIpCap(handler)).toBe(true);
    expect(guards(handler)).toContain(ApiKeyRateLimitGuard);
    expect(Reflect.getMetadata(BUDGET, handler)).toBe(budget);
  });

  it('the same budgets as the Whish Pay API itself', () => {
    const api = IntegrationsWhishController.prototype;
    expect(Reflect.getMetadata(BUDGET, api.create)).toBe(Reflect.getMetadata(BUDGET, twin.create));
    expect(Reflect.getMetadata(BUDGET, api.get)).toBe(Reflect.getMetadata(BUDGET, twin.get));
    expect(Reflect.getMetadata(BUDGET, api.refresh)).toBe(
      Reflect.getMetadata(BUDGET, twin.refresh),
    );
  });

  it('the list and the CSV export keep the per-IP cap', () => {
    expect(skipsPerIpCap(twin.list)).toBeUndefined();
    expect(skipsPerIpCap(twin.export)).toBeUndefined();
    expect(skipsPerIpCap(WhishPaymentsController)).toBeUndefined();
  });
});
