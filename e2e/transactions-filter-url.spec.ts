import { test, expect } from '@playwright/test';

// Verifies the transactions filter → URL mirroring (recent FE work). Uses the
// admin storageState. The admin page has ~200k seeded rows so the table can be
// slow; assertions target the URL + controls, never specific row data.
test.describe('admin transactions: filters mirror to the URL', () => {
  test.setTimeout(90_000);

  test('applying a status filter updates the query string', async ({ page }) => {
    await page.goto('/admin/transactions', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Transactions' })).toBeVisible({
      timeout: 30_000,
    });

    // The Status filter is a native <select> labelled "Status". There are
    // several <select>s in the filter bar (Status, Source, Company); pick the
    // one whose options include the transaction statuses.
    const statusSelect = page
      .locator('select')
      .filter({ has: page.locator('option', { hasText: 'COMPLETED' }) })
      .first();
    await expect(statusSelect).toBeVisible({ timeout: 30_000 });

    // Apply the filter.
    await statusSelect.selectOption('COMPLETED');

    // (a) URL query string now carries the filter.
    await expect(page).toHaveURL(/[?&]status=COMPLETED\b/, { timeout: 15_000 });

    // (b) It composes without error: the select still reflects the choice and
    // the page is still on /admin/transactions (no crash / navigation away).
    await expect(statusSelect).toHaveValue('COMPLETED');
    await expect(page).toHaveURL(/\/admin\/transactions(\?|$)/);

    // Changing the filter to another status keeps a single status param
    // (and never re-introduces a stale page param — page resets to 1).
    await statusSelect.selectOption('PENDING');
    await expect(page).toHaveURL(/[?&]status=PENDING\b/, { timeout: 15_000 });
    await expect(page).not.toHaveURL(/[?&]page=/);
  });

  test('changing a filter resets pagination to page 1', async ({ page }) => {
    // Land directly on page 2 via the URL, then change a filter and assert the
    // page param is dropped (page 1 is omitted from the URL by design).
    await page.goto('/admin/transactions?page=2', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Transactions' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page).toHaveURL(/[?&]page=2\b/);

    const statusSelect = page
      .locator('select')
      .filter({ has: page.locator('option', { hasText: 'COMPLETED' }) })
      .first();
    await expect(statusSelect).toBeVisible({ timeout: 30_000 });

    await statusSelect.selectOption('COMPLETED');

    // Filter applied, page reset: status present, page param gone.
    await expect(page).toHaveURL(/[?&]status=COMPLETED\b/, { timeout: 15_000 });
    await expect(page).not.toHaveURL(/[?&]page=/);
  });
});
