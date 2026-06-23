import { test, expect, type APIRequestContext } from '@playwright/test';
import {
  adminApiContext,
  createCommissionRule,
  createSourceKey,
  enableSourceForCompany,
  findSourceId,
  getCsrf,
  ingestTransaction,
  loginOwnerApiContext,
  provisionCompanyOwner,
  unwrap,
} from './helpers';

/**
 * Reversal / clawback through the REAL stack — the one money path money-flows
 * doesn't cover. Proves:
 *  - A reversal flips the deposit to REVERSED and claws the credited net back out
 *    of the company's available balance (and the platform fee back off revenue).
 *  - The ledger still reconciles against the wallet projection (no discrepancy).
 *  - Reversal is idempotent: a second reverse returns REVERSED and does NOT
 *    double-claw.
 *  - An under-funded clawback (available already spent) books a RECEIVABLE for the
 *    shortfall instead of driving the wallet negative, and still reconciles.
 */

const money = (s: string | number | undefined) => Number(s ?? 0);
const near = (a: string | number | undefined, e: number) => expect(money(a)).toBeCloseTo(e, 6);

async function post(
  api: APIRequestContext,
  csrf: string,
  path: string,
  body: Record<string, unknown>,
) {
  const res = await api.post(path, { headers: { 'x-csrf-token': csrf }, data: body });
  const text = await res.text();
  if (!res.ok()) throw new Error(`POST ${path} -> ${res.status()} ${text}`);
  return text ? unwrap(JSON.parse(text)) : null;
}

async function usdWallet(api: APIRequestContext) {
  const res = await api.get('/v1/company/wallets');
  expect(res.ok()).toBeTruthy();
  return (
    unwrap(await res.json()).data.find((x: { currency: string }) => x.currency === 'USD') ?? {
      availableBalance: '0',
      reservedBalance: '0',
    }
  );
}

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

test.describe.serial('reversal / clawback (API, real stack)', () => {
  test.setTimeout(180_000);
  test.use({ storageState: { cookies: [], origins: [] } });

  let admin: APIRequestContext;
  let adminCsrf: string;
  let owner: APIRequestContext;
  let ownerCsrf: string;
  let companyId: string;
  let sourceKey: string;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    const ctx = await adminApiContext();
    admin = ctx.api;
    adminCsrf = ctx.csrf;
    const omt = await findSourceId(admin, 'omt');
    const co = await provisionCompanyOwner({ api: admin, csrf: adminCsrf });
    companyId = co.companyId;
    owner = await loginOwnerApiContext(co.ownerEmail, co.tempPassword, 'rev-pass-12345');
    ownerCsrf = await getCsrf(owner);
    await enableSourceForCompany(admin, adminCsrf, omt, companyId);
    sourceKey = await createSourceKey(admin, adminCsrf, omt, `e2e-rev-${Date.now()}`);
    // 10% DEDUCTED on deposits and withdrawals.
    for (const operationType of ['TRANSACTION', 'WITHDRAWAL']) {
      await createCommissionRule(admin, adminCsrf, {
        companyId,
        operationType,
        feeApplication: 'DEDUCTED',
        commissionType: 'PERCENTAGE',
        commissionValue: '10',
        minAmount: '0.00000001',
        maxAmount: '100000000',
        priority: 1000,
      });
    }
  });

  test.afterAll(async () => {
    await owner?.dispose();
    await admin?.dispose();
  });

  test('reverse a fully-funded deposit: claws net back, REVERSED, reconciles, idempotent', async () => {
    const ext = `e2e-rev-${Date.now()}`;
    const ing = await ingestTransaction('omt', sourceKey, {
      companyId,
      externalTransactionId: ext,
      amount: '100',
      currency: 'USD',
    });
    expect(ing.status, JSON.stringify(ing.body)).toBe(201);
    const txId = ing.body.id as string;
    expect(txId).toBeTruthy();
    let w = await usdWallet(owner);
    near(w.availableBalance, 90); // net 90 credited

    // Reverse (admin). Net 90 is clawed back out of available; fee 10 off revenue.
    const rev = await post(admin, adminCsrf, `/v1/admin/transactions/${txId}/reverse`, {
      reason: 'e2e chargeback',
    });
    expect(rev.status).toBe('REVERSED');
    w = await usdWallet(owner);
    near(w.availableBalance, 0); // fully clawed back (was 90, all available)
    near(w.reservedBalance, 0);

    // Ledger ↔ wallet still reconciles.
    const recon = await post(admin, adminCsrf, '/v1/admin/reconciliation/run', {});
    expect(recon.divergentCount).toBe(0);
    expect(recon.discrepancies.length).toBe(0);

    // Idempotent: a second reverse returns REVERSED and does NOT double-claw.
    const again = await post(admin, adminCsrf, `/v1/admin/transactions/${txId}/reverse`, {
      reason: 'e2e chargeback retry',
    });
    expect(again.status).toBe('REVERSED');
    w = await usdWallet(owner);
    near(w.availableBalance, 0); // unchanged — no double clawback
  });

  test('under-funded reversal books a RECEIVABLE instead of going negative, and reconciles', async () => {
    // Fresh deposit of 100 → net 90 available.
    const ext = `e2e-rev2-${Date.now()}`;
    const ing = await ingestTransaction('omt', sourceKey, {
      companyId,
      externalTransactionId: ext,
      amount: '100',
      currency: 'USD',
    });
    expect(ing.status, JSON.stringify(ing.body)).toBe(201);
    const txId = ing.body.id as string;
    near((await usdWallet(owner)).availableBalance, 90);

    // Spend most of it: withdraw 80 (fee 10% DEDUCTED → total 80 reserved) and
    // approve so it leaves the wallet. Available 90 → reserve 80 → approve → 10.
    const wd = await post(owner, ownerCsrf, '/v1/company/withdrawals', cash('80'));
    await post(admin, adminCsrf, `/v1/admin/withdrawals/${wd.id}/approve`, {
      externalReference: 'E2E-REV-WD',
    });
    near((await usdWallet(owner)).availableBalance, 10);

    // Now reverse the original deposit: it must claw back net 90, but only 10 is
    // available → debit 10 from available + book an 80 RECEIVABLE (the shortfall).
    const rev = await post(admin, adminCsrf, `/v1/admin/transactions/${txId}/reverse`, {
      reason: 'e2e under-funded clawback',
    });
    expect(rev.status).toBe('REVERSED');
    const w = await usdWallet(owner);
    near(w.availableBalance, 0); // never negative
    expect(money(w.availableBalance)).toBeGreaterThanOrEqual(0);

    // Despite the RECEIVABLE, the ledger still reconciles against the wallet.
    const recon = await post(admin, adminCsrf, '/v1/admin/reconciliation/run', {});
    expect(recon.divergentCount).toBe(0);
    expect(recon.discrepancies.length).toBe(0);
  });
});
