import { test, expect } from '@playwright/test';
import {
  adminApiContext,
  createCommissionRule,
  createSourceKey,
  enableSourceForCompany,
  findSourceId,
  ingestTransaction,
  provisionCompanyOwner,
} from './helpers';

/**
 * Answers a recurring operator question: "is the Transactions page actually
 * live, or do I have to refresh?" An admin reported not seeing a transaction
 * appear immediately, so this drives the REAL browser (socket.io + React Query)
 * and asserts a freshly-ingested deposit shows up with NO page.reload() —
 * on BOTH admin money pages:
 *   - /admin/transactions → the unified activity feed (all four money kinds)
 *   - /admin/deposits     → the deposits-only list
 *
 * It deliberately never reloads: any `page.reload()` here would make the test
 * pass even with realtime completely broken, which is exactly the failure mode
 * being guarded.
 */
test.describe('realtime — Transactions/Deposits pages update without a refresh', () => {
  test.setTimeout(150_000);

  test('a newly ingested deposit appears live on both pages (no reload)', async ({ page }) => {
    const admin = await adminApiContext();
    const { api, csrf } = admin;
    const { companyId } = await provisionCompanyOwner(admin);
    const omtId = await findSourceId(api, 'omt');
    await enableSourceForCompany(api, csrf, omtId, companyId);
    const key = await createSourceKey(api, csrf, omtId, `rt-txn-${Date.now()}`);
    // Ingest must be priced, else it 422s before ever reaching the feed.
    await createCommissionRule(api, csrf, {
      companyId,
      operationType: 'TRANSACTION',
      feeApplication: 'DEDUCTED',
      commissionType: 'PERCENTAGE',
      commissionValue: '0',
      minAmount: '0.01',
      maxAmount: '100000000',
      priority: 1000,
    });

    // --- 1. The unified activity feed (sidebar "Transactions") ---
    await page.goto('/admin/transactions');
    await expect(page.getByRole('heading', { name: /transactions/i }).first()).toBeVisible({
      timeout: 30_000,
    });
    // Let the socket finish its handshake before mutating, so we're testing the
    // live push and not an incidental first paint.
    await page.waitForTimeout(2_000);

    const ref1 = `rt-live-${Date.now()}`;
    const ing1 = await ingestTransaction('omt', key, {
      companyId,
      externalTransactionId: ref1,
      amount: '123.45',
      currency: 'USD',
    });
    expect(ing1.status, JSON.stringify(ing1.body)).toBe(201);

    // No reload anywhere: this can only pass if the socket invalidation fired.
    await expect(page.getByText(ref1, { exact: false }).first()).toBeVisible({ timeout: 30_000 });

    // --- 2. The deposits-only list ---
    // NB: /admin/deposits reuses TransactionsView, whose <h1> also reads
    // "Transactions" (the sidebar label is "Deposits") — assert on that, not on
    // the nav label.
    await page.goto('/admin/deposits');
    await expect(page.getByRole('heading', { name: /transactions/i }).first()).toBeVisible({
      timeout: 30_000,
    });
    await page.waitForTimeout(2_000);

    const ref2 = `rt-live-dep-${Date.now()}`;
    const ing2 = await ingestTransaction('omt', key, {
      companyId,
      externalTransactionId: ref2,
      amount: '77.77',
      currency: 'USD',
    });
    expect(ing2.status, JSON.stringify(ing2.body)).toBe(201);

    await expect(page.getByText(ref2, { exact: false }).first()).toBeVisible({ timeout: 30_000 });
  });
});
