import { test, expect } from '@playwright/test';

const ADMIN_ROUTES: Array<{ path: string; heading: RegExp | string }> = [
  { path: '/admin', heading: /overview|dashboard/i },
  { path: '/admin/companies', heading: 'Companies' },
  { path: '/admin/sources', heading: /sources/i },
  { path: '/admin/transactions', heading: /transactions/i },
  { path: '/admin/withdrawals', heading: /withdrawals/i },
  { path: '/admin/commissions', heading: /commission/i },
  { path: '/admin/audit', heading: /audit/i },
  { path: '/admin/settings', heading: /settings/i },
];

test.describe('admin: smoke (every page loads)', () => {
  for (const { path, heading } of ADMIN_ROUTES) {
    test(`GET ${path} renders`, async ({ page }) => {
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      await expect(page).toHaveURL(new RegExp(path.replace(/\//g, '\\/') + '$'));
      const target =
        typeof heading === 'string'
          ? page.getByRole('heading', { name: heading })
          : page.locator('h1, h2').filter({ hasText: heading }).first();
      await expect(target).toBeVisible({ timeout: 8_000 });
    });
  }
});
