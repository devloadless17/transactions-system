import { test, expect, type BrowserContext } from '@playwright/test';
import { loginAs, provisionCompanyOwner } from './helpers';

test.use({ storageState: { cookies: [], origins: [] } });

const COMPANY_ROUTES: Array<{ path: string; heading: RegExp | string }> = [
  { path: '/app', heading: /overview|dashboard/i },
  { path: '/app/transactions', heading: /transactions/i },
  { path: '/app/wallets', heading: /wallets/i },
  { path: '/app/ledger', heading: /ledger/i },
  { path: '/app/withdrawals', heading: /withdrawals/i },
  // The docs hub opens on the "Getting started" tab by default; the other tabs
  // (Whish Pay / Company API / CRM / Sources API) each render their own h1 too.
  { path: '/app/documentation', heading: /getting started|whish pay|company api|crm|sources api/i },
  { path: '/app/sources', heading: /sources/i },
  { path: '/app/team', heading: /team|members/i },
  { path: '/app/settings', heading: /settings/i },
];

test.describe.serial('company portal: smoke', () => {
  let ownerEmail = '';
  let tempPassword = '';
  const newPassword = '123456';
  let ownerStorage: Awaited<ReturnType<BrowserContext['storageState']>> | null = null;

  test.beforeAll(async () => {
    const provisioned = await provisionCompanyOwner();
    ownerEmail = provisioned.ownerEmail;
    tempPassword = provisioned.tempPassword;
  });

  test('owner logs in with temp password and is forced to change it', async ({ page, context }) => {
    // Temp-login → forced change-password → re-login is 3 logins; under the auth
    // throttle the 12s backoffs can exceed the default 30s test timeout.
    test.setTimeout(120_000);
    await loginAs(page, ownerEmail, tempPassword, '/change-password');

    await page.locator('#currentPassword').fill(tempPassword);
    await page.locator('#newPassword').fill(newPassword);
    await page.locator('#confirmPassword').fill(newPassword);
    await page.getByRole('button', { name: /save and sign in again/i }).click();

    // Server clears cookies; client pushes to /login.
    await page.waitForURL(/\/login/, { timeout: 10_000 });

    // Re-login with the new password and capture storage so the rest of the
    // suite can reuse the session without hammering the auth endpoint.
    await loginAs(page, ownerEmail, newPassword, '/app');
    ownerStorage = await context.storageState();
  });

  for (const { path, heading } of COMPANY_ROUTES) {
    test(`GET ${path} renders`, async ({ browser }) => {
      if (!ownerStorage) test.skip(true, 'owner session not captured');
      const ctx = await browser.newContext({ storageState: ownerStorage! });
      const page = await ctx.newPage();
      try {
        await page.goto(path, { waitUntil: 'domcontentloaded' });
        const target =
          typeof heading === 'string'
            ? page.getByRole('heading', { name: heading })
            : page.locator('h1, h2').filter({ hasText: heading }).first();
        await expect(target).toBeVisible({ timeout: 8_000 });
      } finally {
        await ctx.close();
      }
    });
  }
});
