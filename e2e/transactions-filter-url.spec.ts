import { test, expect, type Locator, type Page } from '@playwright/test';

// The dev server serves the page before React hydrates it: a choice made on the
// server-rendered <select> in that window is reset and never reaches the URL
// (seen when the stack is busy). Re-apply it until the app has picked it up —
// a filter that never mirrors still fails, after 30s.
async function selectStatus(page: Page, select: Locator, status: string) {
  await expect(async () => {
    await select.selectOption(status);
    await expect(page).toHaveURL(new RegExp(`[?&]status=${status}\\b`), { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

// Verifies the transactions filter → URL mirroring (recent FE work). Uses the
// admin storageState. The admin page has ~200k seeded rows so the table can be
// slow; assertions target the URL + controls, never specific row data.
test.describe('admin transactions: filters mirror to the URL', () => {
  test.setTimeout(90_000);

  test('applying a status filter updates the query string', async ({ page }) => {
    // The status-filtered list (old "Transactions") now lives at /admin/deposits;
    // /admin/transactions is the new unified activity feed (no status select).
    await page.goto('/admin/deposits', { waitUntil: 'domcontentloaded' });
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

    // Apply the filter — (a) the URL query string now carries it.
    await selectStatus(page, statusSelect, 'COMPLETED');

    // (b) It composes without error: the select still reflects the choice and
    // the page is still on /admin/transactions (no crash / navigation away).
    await expect(statusSelect).toHaveValue('COMPLETED');
    await expect(page).toHaveURL(/\/admin\/deposits(\?|$)/);

    // Changing the filter to another status keeps a single status param
    // (and never re-introduces a stale page param — page resets to 1).
    await statusSelect.selectOption('PENDING');
    await expect(page).toHaveURL(/[?&]status=PENDING\b/, { timeout: 15_000 });
    await expect(page).not.toHaveURL(/[?&]page=/);
  });

  test('changing a filter resets pagination to page 1', async ({ page }) => {
    // Land directly on page 2 via the URL, then change a filter and assert the
    // page param is dropped (page 1 is omitted from the URL by design).
    await page.goto('/admin/deposits?page=2', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Transactions' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page).toHaveURL(/[?&]page=2\b/);

    const statusSelect = page
      .locator('select')
      .filter({ has: page.locator('option', { hasText: 'COMPLETED' }) })
      .first();
    await expect(statusSelect).toBeVisible({ timeout: 30_000 });

    // Filter applied, page reset: status present, page param gone.
    await selectStatus(page, statusSelect, 'COMPLETED');
    await expect(page).not.toHaveURL(/[?&]page=/);
  });

  // The quick ranges are defined once in `apps/web/src/lib/date-presets.ts` and
  // rendered by every picker in the app. This bar is the only one that mirrors
  // dates to the URL, which makes it the one place the selection is observable
  // from outside the component — so it guards the shared list for all of them.
  test('quick ranges offer the six shared presets, and All time clears the dates', async ({
    page,
  }) => {
    await page.goto('/admin/deposits', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Transactions' })).toBeVisible({
      timeout: 30_000,
    });

    // The picker trigger is the only button carrying the calendar icon; the
    // preset buttons inside the popover do not.
    const trigger = page.locator('button:has(svg.lucide-calendar)').first();
    await expect(trigger).toBeVisible({ timeout: 30_000 });
    await trigger.click();

    const quickRanges = page.locator('text=Quick ranges').locator('..');
    await expect(quickRanges.getByRole('button')).toHaveText([
      'Today',
      'This month',
      'Last 7 days',
      'Last 30 days',
      'Last 90 days',
      'All time',
    ]);

    // "This month" is month-to-date: the from bound is the 1st of this month.
    await quickRanges.getByRole('button', { name: 'This month', exact: true }).click();
    const firstOfMonth = new Date();
    const monthStart = `${firstOfMonth.getFullYear()}-${String(firstOfMonth.getMonth() + 1).padStart(2, '0')}-01`;
    await expect(page).toHaveURL(new RegExp(`[?&]from=${monthStart}\\b`), { timeout: 15_000 });
    await expect(page).not.toHaveURL(/[?&]page=/);

    // "All time" removes both bounds entirely — an absent from/to is what makes
    // the API return the caller's whole history (RLS still scopes it).
    await trigger.click();
    await quickRanges.getByRole('button', { name: 'All time', exact: true }).click();
    await expect(page).not.toHaveURL(/[?&](from|to)=/, { timeout: 15_000 });

    // Re-opening highlights All time. This could never happen before: the bars
    // stored cleared bounds as '' and compared them against undefined.
    await trigger.click();
    await expect(quickRanges.getByRole('button', { name: 'All time', exact: true })).toHaveClass(
      /bg-secondary/,
    );
  });
});
