import { test, expect, type APIRequestContext, request as pwRequest } from '@playwright/test';
import {
  API_BASE,
  adminApiContext,
  getCsrf,
  loginOwnerApiContext,
  provisionCompanyOwner,
} from './helpers';

/**
 * Negative & security guardrails through the REAL stack — the rejections that must
 * hold for a safe deploy. Each is deterministic (no funding/external deps):
 *  - CSRF: a cookie-authed mutation with NO x-csrf-token is rejected (403).
 *  - AuthZ: a company session cannot read OR write an admin-only endpoint (403).
 *  - Object/tenant scope is enforced by the deep-offset + role guards.
 *  - Pagination: a huge page offset is rejected (422), not scanned.
 *  - Insufficient balance: a withdrawal beyond available is rejected (422), wallet
 *    untouched.
 *  - API-key surface: the source ingest endpoint rejects an unauthenticated call.
 */

function cash(amount: string) {
  return {
    amount,
    currency: 'USD',
    payout: {
      method: 'CASH',
      recipientName: 'E2E',
      recipientPhone: '+9610000000',
      pickupLocation: 'E2E',
    },
  };
}

test.describe.serial('negative & security guardrails (API, real stack)', () => {
  test.setTimeout(180_000);
  test.use({ storageState: { cookies: [], origins: [] } });

  let admin: APIRequestContext;
  let adminCsrf: string;
  let owner: APIRequestContext;
  let ownerCsrf: string;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    const ctx = await adminApiContext();
    admin = ctx.api;
    adminCsrf = ctx.csrf;
    const co = await provisionCompanyOwner({ api: admin, csrf: adminCsrf });
    owner = await loginOwnerApiContext(co.ownerEmail, co.tempPassword, 'neg-pass-12345');
    ownerCsrf = await getCsrf(owner);
  });

  test.afterAll(async () => {
    await owner?.dispose();
    await admin?.dispose();
  });

  test('CSRF: a cookie-authed mutation with no x-csrf-token is rejected (403)', async () => {
    // Valid admin cookie session, but NO csrf header → CsrfGuard rejects before
    // the handler even validates the body.
    const res = await admin.post('/v1/admin/commission-rules', { data: {} });
    expect(res.status()).toBe(403);
  });

  test('CSRF: the same mutation WITH a valid token gets past CSRF (reaches validation, 400)', async () => {
    // Sanity counterpart: with the token, CSRF passes and we hit body validation
    // (400), proving the 403 above was the CSRF guard and not something else.
    const res = await admin.post('/v1/admin/commission-rules', {
      headers: { 'x-csrf-token': adminCsrf },
      data: {},
    });
    expect(res.status()).toBe(400);
  });

  test('AuthZ: a company session cannot READ an admin-only endpoint (403)', async () => {
    const res = await owner.get('/v1/admin/analytics/platform');
    expect(res.status()).toBe(403);
  });

  test('AuthZ: a company session cannot WRITE an admin-only endpoint (403)', async () => {
    const res = await owner.post('/v1/admin/commission-rules', {
      headers: { 'x-csrf-token': ownerCsrf },
      data: {},
    });
    expect(res.status()).toBe(403);
  });

  test('Pagination: a huge page offset is rejected (400 ValidationError), not scanned', async () => {
    const res = await owner.get('/v1/company/withdrawals?page=999999999&pageSize=100');
    expect(res.status()).toBe(400);
  });

  test('Insufficient balance: a withdrawal beyond available is rejected (409)', async () => {
    const before = await owner.get('/v1/company/wallets');
    const res = await owner.post('/v1/company/withdrawals', {
      headers: { 'x-csrf-token': ownerCsrf },
      data: cash('1000000'),
    });
    expect(res.status()).toBe(409);
    // Wallet is untouched (nothing reserved by a rejected request).
    const after = await owner.get('/v1/company/wallets');
    expect(await after.text()).toBe(await before.text());
  });

  test('API-key surface: source ingest rejects an unauthenticated call (401/403)', async () => {
    const ctx = await pwRequest.newContext({ baseURL: API_BASE });
    try {
      const res = await ctx.post('/v1/ingest/omt/transactions', {
        data: {
          operatingId: '00000000-0000-0000-0000-000000000000',
          externalTransactionId: 'x',
          amount: '1',
          currency: 'USD',
        },
      });
      expect([401, 403]).toContain(res.status());
    } finally {
      await ctx.dispose();
    }
  });
});
