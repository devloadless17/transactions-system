import { test, expect } from '@playwright/test';
import { settled } from './helpers';
import fs from 'node:fs';

// Covers the Whish Pay filter bar + CSV export added for the admin/company pages.
// Runs against the admin page (admin storageState is available by default); the
// filter bar + ExportCsvButton + streaming CSV path are shared with the company
// page, so this exercises the same code.
test.describe('admin Whish Pay: filter + export', () => {
  test.setTimeout(60_000);

  test('filter bar renders and search is sent as a query param', async ({ page }) => {
    await page.goto('/admin/whish', { waitUntil: 'domcontentloaded' });
    await settled(page);
    await expect(page.getByRole('heading', { name: 'Whish Pay' })).toBeVisible({
      timeout: 30_000,
    });

    // Search box (generic placeholder — never tenant-specific copy).
    const search = page.getByPlaceholder('Search invoice, phone, or reference…');
    await expect(search).toBeVisible({ timeout: 15_000 });

    // Status filter is a native <select> that includes the Whish statuses.
    const statusSelect = page
      .locator('select')
      .filter({ has: page.locator('option', { hasText: 'PAID' }) })
      .first();
    await expect(statusSelect).toBeVisible();

    // Export button present.
    await expect(page.getByRole('button', { name: /Export CSV/i })).toBeVisible();

    // Typing in search (debounced) issues a list request carrying search=.
    const req = page.waitForRequest(
      (r) => /\/admin\/whish\/payments\?.*\bsearch=inv-e2e\b/.test(r.url()),
      { timeout: 15_000 },
    );
    await search.fill('inv-e2e');
    await req;

    // Selecting a status issues a request carrying status=.
    const statusReq = page.waitForRequest(
      (r) => /\/admin\/whish\/payments\?.*\bstatus=PAID\b/.test(r.url()),
      { timeout: 15_000 },
    );
    await statusSelect.selectOption('PAID');
    await statusReq;
  });

  test('Export CSV downloads a UTF-8 BOM file with the expected columns', async ({ page }) => {
    await page.goto('/admin/whish', { waitUntil: 'domcontentloaded' });
    await settled(page);
    await expect(page.getByRole('heading', { name: 'Whish Pay' })).toBeVisible({
      timeout: 30_000,
    });

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: /Export CSV/i }).click(),
    ]);
    const filePath = await download.path();
    expect(filePath).toBeTruthy();
    const buf = fs.readFileSync(filePath!);

    // (a) Leads with a UTF-8 BOM so Excel decodes it as UTF-8 (the "â€¢" bug fix).
    expect(buf.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBeTruthy();

    // (b) Header carries the Whish columns (skip the 3 BOM bytes before parsing).
    const header = buf.subarray(3).toString('utf8').split('\n')[0].trim();
    const cols = header.split(',');
    for (const c of ['reference', 'company_id', 'status', 'currency', 'amount', 'invoice']) {
      expect(cols).toContain(c);
    }
  });

  // The list request and the export share one params object in the view, so a
  // quick range must narrow BOTH identically. If they ever diverge, an operator
  // exports a different set of rows than the one they are looking at — which is
  // exactly the kind of quiet mismatch a reconciliation would trip over.
  test('a quick range narrows the export exactly like the list', async ({ page }) => {
    await page.goto('/admin/whish', { waitUntil: 'domcontentloaded' });
    await settled(page);
    await expect(page.getByRole('heading', { name: 'Whish Pay' })).toBeVisible({
      timeout: 30_000,
    });

    const trigger = page.locator('button:has(svg.lucide-calendar)').first();
    await expect(trigger).toBeVisible({ timeout: 15_000 });
    await trigger.click();
    const quickRanges = page.locator('text=Quick ranges').locator('..');

    const [listReq] = await Promise.all([
      page.waitForRequest((r) => r.url().includes('/whish/payments') && r.url().includes('from=')),
      quickRanges.getByRole('button', { name: 'Last 30 days', exact: true }).click(),
    ]);

    const [exportReq] = await Promise.all([
      page.waitForRequest((r) => r.url().includes('export.csv')),
      page.getByRole('button', { name: /Export CSV/i }).click(),
    ]);

    const bounds = (url: string) => {
      const p = new URL(url).searchParams;
      return { from: p.get('from'), to: p.get('to') };
    };
    const listBounds = bounds(listReq.url());
    expect(listBounds.from).toBeTruthy();
    expect(bounds(exportReq.url())).toEqual(listBounds);
  });
});
