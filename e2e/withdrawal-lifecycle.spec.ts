import { test, expect, request as pwRequest } from '@playwright/test';
import {
  API_BASE,
  adminApiContext,
  createSourceKey,
  enableSourceForCompany,
  findSourceId,
  ingestTransaction,
  loginAs,
  provisionCompanyOwner,
  unwrap,
} from './helpers';

// Money-OUT journey: ingest credits available → owner requests a withdrawal
// through the UI → admin approves it through the UI → available decreases.
//
// The withdrawal REQUEST (company UI) and the ADMIN APPROVE (admin UI) both go
// through the real UI. Setup (provision, opt-in, key, ingest) and the final
// balance/status checks are done via the API. No step here is stubbed.

test.describe('withdrawal lifecycle (request + approve through the UI)', () => {
  // Owner UI walk-through (change-password) + slow first dev compiles need room.
  test.setTimeout(120_000);
  // This test owns its own sessions (company owner + admin via storageState).
  test.use({ storageState: { cookies: [], origins: [] } });

  test('owner requests a withdrawal and admin approves it', async ({ page, browser }) => {
    // --- Setup (API) ---
    const { api, csrf } = await adminApiContext();
    // Reuse the admin context for provisioning to spare the auth throttle.
    const provisioned = await provisionCompanyOwner({ api, csrf });
    const { companyId, ownerEmail, tempPassword, slug } = provisioned;
    const companyName = `E2E Company ${slug}`;
    const newPassword = 'newpass-123';

    const omtId = await findSourceId(api, 'omt');
    await enableSourceForCompany(api, csrf, omtId, companyId);
    const sourceKey = await createSourceKey(api, csrf, omtId, `e2e-wd-${Date.now()}`);

    // Ingest 100 → $1 fixed fee → net 99 credited to available.
    const ingest = await ingestTransaction('omt', sourceKey, {
      companySlug: slug,
      externalTransactionId: `e2e-wd-${Date.now()}`,
      amount: '100',
      currency: 'USD',
    });
    expect(ingest.status, JSON.stringify(ingest.body)).toBe(201);

    // --- UI (company owner): change the temp password, then request a
    // withdrawal. Mirror company-smoke: login on the temp password → forced
    // /change-password → set a new one → re-login to /app. Both logins go
    // through the real UI. ---
    await loginAs(page, ownerEmail, tempPassword, '/change-password');
    await page.locator('#currentPassword').fill(tempPassword);
    await page.locator('#newPassword').fill(newPassword);
    await page.locator('#confirmPassword').fill(newPassword);
    await page.getByRole('button', { name: /save and sign in again/i }).click();
    await page.waitForURL(/\/login/, { timeout: 15_000 });
    await loginAs(page, ownerEmail, newPassword, '/app');

    // Build an owner API context from the now-authenticated browser session so
    // the wallet assertions reuse the UI's cookies (no extra login).
    const owner = await pwRequest.newContext({
      baseURL: API_BASE,
      storageState: await page.context().storageState(),
    });

    // Confirm available ~99 before withdrawing.
    const walletsBefore = await owner.get('/v1/company/wallets');
    expect(walletsBefore.ok()).toBeTruthy();
    const usdBefore = unwrap(await walletsBefore.json()).data.find(
      (w: { currency: string }) => w.currency === 'USD',
    );
    expect(usdBefore, 'USD wallet should exist').toBeTruthy();
    expect(Number(usdBefore.availableBalance)).toBeCloseTo(99, 2);

    await page.goto('/app/withdrawals', { waitUntil: 'domcontentloaded' });
    await expect(
      page
        .locator('h1, h2')
        .filter({ hasText: /withdrawals/i })
        .first(),
    ).toBeVisible({
      timeout: 30_000,
    });

    // Open the request dialog (CTA is the page's "New ..." button).
    await page.getByRole('button', { name: /new/i }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    // Amount.
    await dialog.locator('#amount').fill('40');

    // The request dialog defaults to CASH; switch to Crypto for this test.
    await dialog.getByRole('button', { name: 'Crypto', exact: true }).click();

    // Fill network + a >=20 char wallet address. The CryptoFields labels aren't
    // wired to inputs via htmlFor, so target by placeholder (Network) and by
    // class (the wallet address is the only font-mono input in the crypto group).
    await dialog.getByPlaceholder('BTC, ETH, TRC20, SOL, …').fill('TRC20');
    await dialog.locator('input.font-mono').fill('TQ1234567890ABCDEFGHIJ1234567890XYZ');

    await dialog.getByRole('button', { name: 'Request', exact: true }).click();

    // Dialog closes and a toast confirms; the new PENDING row appears.
    await expect(dialog).toBeHidden({ timeout: 15_000 });
    await expect(page.locator('table').getByText('PENDING').first()).toBeVisible({
      timeout: 15_000,
    });

    // Find the just-created withdrawal id via the owner API (for the final
    // assertion and to locate the right admin row).
    const listRes = await owner.get('/v1/company/withdrawals?pageSize=50');
    expect(listRes.ok()).toBeTruthy();
    const withdrawals = unwrap(await listRes.json()).data as Array<{
      id: string;
      amount: string;
      status: string;
    }>;
    const pending = withdrawals.find((w) => w.status === 'PENDING' && Number(w.amount) === 40);
    expect(pending, 'a PENDING withdrawal of 40 should exist').toBeTruthy();
    const withdrawalId = pending!.id;

    // --- UI (admin): approve the PENDING withdrawal ---
    const adminCtx = await browser.newContext({ storageState: 'e2e/.auth/admin.json' });
    const adminPage = await adminCtx.newPage();
    try {
      await adminPage.goto('/admin/withdrawals', { waitUntil: 'domcontentloaded' });
      await expect(
        adminPage
          .locator('h1, h2')
          .filter({ hasText: /withdrawals/i })
          .first(),
      ).toBeVisible({ timeout: 30_000 });

      // The list defaults to the PENDING filter. The company is brand-new so it
      // has exactly one withdrawal; scope to its row. The admin table shows the
      // company name when it's in the first 100 companies, otherwise the
      // companyId's first 8 chars — match either.
      const row = adminPage
        .locator('table tbody tr')
        .filter({
          hasText: new RegExp(`${escapeRe(companyName)}|${escapeRe(companyId.slice(0, 8))}`),
        })
        .first();
      await expect(row).toBeVisible({ timeout: 30_000 });
      await expect(row).toContainText('40');
      await row.getByRole('button', { name: 'Approve' }).click();

      const approveDialog = adminPage.getByRole('dialog');
      await expect(approveDialog.getByText(/External reference/i)).toBeVisible({ timeout: 10_000 });
      await approveDialog.locator('#reference').fill(`E2E-REF-${Date.now()}`);
      await approveDialog.getByRole('button', { name: /confirm approve/i }).click();

      // Dialog closes on success.
      await expect(approveDialog).toBeHidden({ timeout: 15_000 });
    } finally {
      await adminPage.close();
      await adminCtx.close();
    }

    // --- Assert (API): withdrawal COMPLETED + available dropped by 40 ---
    const finalWd = await api.get(`/v1/admin/withdrawals/${withdrawalId}`);
    expect(finalWd.ok()).toBeTruthy();
    const finalWdBody = unwrap(await finalWd.json());
    expect(finalWdBody.status).toBe('COMPLETED');
    expect(finalWdBody.externalReference, 'external reference recorded').toBeTruthy();

    const walletsAfter = await owner.get('/v1/company/wallets');
    expect(walletsAfter.ok()).toBeTruthy();
    const usdAfter = unwrap(await walletsAfter.json()).data.find(
      (w: { currency: string }) => w.currency === 'USD',
    );
    // Started at 99, withdrew 40 (crypto has no extra fee in the seed rules) → 59.
    expect(Number(usdAfter.availableBalance)).toBeCloseTo(59, 2);

    await owner.dispose();
    await api.dispose();
  });
});

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
