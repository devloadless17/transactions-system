import { test, expect } from '@playwright/test';
import { uniqueSlug } from './helpers';

test.describe('admin: companies', () => {
  test('list page renders', async ({ page }) => {
    await page.goto('/admin/companies');
    // exact: true so the page heading isn't ambiguous with the empty-state
    // "No companies yet" heading on a fresh DB (strict-mode would match both).
    await expect(page.getByRole('heading', { name: 'Companies', exact: true })).toBeVisible();
    // .first(): on an empty DB the empty-state renders a second "New company" CTA
    // (besides the header button), so an unscoped locator is ambiguous.
    await expect(page.getByRole('button', { name: 'New company' }).first()).toBeVisible();
  });

  test('create a company via the dialog', async ({ page }) => {
    await page.goto('/admin/companies');

    const slug = uniqueSlug('e2e-acme');
    const name = `E2E Acme ${slug}`;
    const ownerEmail = `owner-${slug}@example.com`;

    // .first(): same empty-state ambiguity — the header CTA opens the dialog, and
    // on a fresh DB the empty-state CTA would otherwise make this locator strict-fail.
    await page.getByRole('button', { name: 'New company' }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Create company' })).toBeVisible();

    await dialog.locator('#name').fill(name);
    await dialog.locator('#slug').fill(slug);
    await dialog.locator('#ownerEmail').fill(ownerEmail);

    // Pricing defaults to "Set now" (the starter-commission-rule onboarding). This
    // test only verifies company creation, so skip pricing — a platform-wide rule
    // (or a later per-company rule) covers the company.
    await dialog.getByRole('button', { name: 'Skip for now' }).click();

    await dialog.getByRole('button', { name: 'Create', exact: true }).click();

    // Success view shows the just-created credentials.
    await expect(dialog.getByRole('heading', { name: 'Company created' })).toBeVisible({
      timeout: 10_000,
    });
    await expect(dialog.getByText(ownerEmail)).toBeVisible();

    await dialog.getByRole('button', { name: 'Done' }).click();

    // Table refreshes with the new row (scope to the table to avoid the toast).
    await expect(page.locator('table').getByText(name)).toBeVisible({ timeout: 5_000 });
  });

  test('row click opens the company detail page', async ({ page }) => {
    await page.goto('/admin/companies');
    await expect(page.getByRole('button', { name: 'New company' })).toBeVisible();

    const dataRows = page
      .locator('table tbody tr')
      .filter({ hasNot: page.getByText(/Loading|No companies/) });
    const count = await dataRows.count();
    if (count === 0)
      test.skip(true, 'no companies to click — create-company test should run first');

    await dataRows.first().click();
    await expect(page).toHaveURL(/\/admin\/companies\/[0-9a-f-]{36}$/);
  });
});
