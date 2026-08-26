import { test, expect } from '@playwright/test';
import {
  adminApiContext,
  createSourceKey,
  findSourceId,
  ingestTransaction,
  loginAs,
  provisionCompanyOwner,
  unwrap,
} from './helpers';

// Reproduces + guards the reported bug: the wallet updated live on a new
// transaction but the analytics KPIs did not (they only refreshed on a manual
// reload). These drive the REAL browser (socket + React Query) and assert the
// dashboards update live on each ingest with NO page reload — and stay live
// after a reload too. Covers the company overview (client-fetched) and the
// admin platform overview (SSR-prefetched + hydrated).
test.describe('realtime analytics — live dashboard updates', () => {
  test.setTimeout(150_000);

  test.describe('company overview', () => {
    test.use({ storageState: { cookies: [], origins: [] } });

    test('Deposits updates live on each ingest, and after a reload', async ({ page }) => {
      const fetches: string[] = [];
      page.on('response', async (r) => {
        if (r.url().includes('/analytics/overview')) {
          try {
            const j = unwrap(await r.json());
            fetches.push(`${r.status()} deposits=${j?.volume?.deposits?.completedTotal}`);
          } catch {
            fetches.push(`${r.status()} <non-json>`);
          }
        }
      });

      const admin = await adminApiContext();
      const { api, csrf } = admin;
      const { companyId, ownerEmail, tempPassword, slug } = await provisionCompanyOwner(admin);
      const omtId = await findSourceId(api, 'omt');
      const key = await createSourceKey(api, csrf, omtId, `rt-${Date.now()}`);

      const newPassword = 'newpass-123';
      await loginAs(page, ownerEmail, tempPassword, '/change-password');
      await page.locator('#currentPassword').fill(tempPassword);
      await page.locator('#newPassword').fill(newPassword);
      await page.locator('#confirmPassword').fill(newPassword);
      await page.getByRole('button', { name: /save and sign in again/i }).click();
      await page.waitForURL(/\/login/, { timeout: 15_000 });
      await loginAs(page, ownerEmail, newPassword, '/app');

      await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible({
        timeout: 30_000,
      });
      // The company overview reconciliation cards label this tile "Deposit"
      // (gross = net + fee); it updates live via the analytics invalidation.
      const deposits = page
        .getByText('Deposit', { exact: true })
        .locator('..')
        .locator('.text-2xl');
      await expect(deposits).toContainText('0', { timeout: 15_000 });

      // Live update #1: 0 → 137 (no reload).
      await ingestTransaction('omt', key, {
        companySlug: slug,
        externalTransactionId: `rt-a-${Date.now()}`,
        amount: '137',
        currency: 'USD',
      });
      await expect(deposits, `live #1 failed; fetches=[${fetches.join(' | ')}]`).toContainText(
        '137',
        {
          timeout: 20_000,
        },
      );

      // Live update #2: 137 → 337 (no reload).
      await ingestTransaction('omt', key, {
        companySlug: slug,
        externalTransactionId: `rt-b-${Date.now()}`,
        amount: '200',
        currency: 'USD',
      });
      await expect(deposits, `live #2 failed; fetches=[${fetches.join(' | ')}]`).toContainText(
        '337',
        {
          timeout: 20_000,
        },
      );

      // After a hard reload the value persists AND stays live.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible({
        timeout: 30_000,
      });
      const depositsAfter = page
        .getByText('Deposit', { exact: true })
        .locator('..')
        .locator('.text-2xl');
      await expect(depositsAfter).toContainText('337', { timeout: 20_000 });

      await ingestTransaction('omt', key, {
        companySlug: slug,
        externalTransactionId: `rt-c-${Date.now()}`,
        amount: '50',
        currency: 'USD',
      });
      await expect(depositsAfter, 'live-after-reload failed').toContainText('387', {
        timeout: 20_000,
      });

      await api.dispose();
    });
  });

  // Admin overview is SSR-prefetched + hydrated, so it exercises a different
  // path than the company view. Asserts the EXACT expected increase (catches a
  // "shows old data" regression that a mere "value changed" check would miss).
  test('admin platform "Volume in" increases by the ingested amount, live + after reload', async ({
    page,
  }) => {
    const diag: string[] = [];
    page.on('response', async (r) => {
      if (r.url().includes('/admin/analytics/platform')) {
        try {
          const j = unwrap(await r.json());
          const usd = j?.byCurrency?.find((c: { currency: string }) => c.currency === 'USD');
          diag.push(`platform.USD.volumeIn=${usd?.volumeIn}`);
        } catch {
          /* ignore */
        }
      }
    });

    const admin = await adminApiContext();
    const { api, csrf } = admin;
    const { companyId, slug } = await provisionCompanyOwner(admin);
    const omtId = await findSourceId(api, 'omt');
    const key = await createSourceKey(api, csrf, omtId, `rt-adm-${Date.now()}`);

    const parseNum = (t: string | null) => Number((t ?? '').replace(/[^0-9.]/g, ''));
    const volumeIn = () =>
      page.getByText('Volume in', { exact: true }).first().locator('..').locator('.text-2xl');

    const ingest100 = (tag: string) =>
      ingestTransaction('omt', key, {
        companySlug: slug,
        externalTransactionId: `rt-adm-${tag}-${Date.now()}`,
        amount: '100',
        currency: 'USD',
      });

    await page.goto('/admin', { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Platform Overview' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(volumeIn()).not.toHaveText('—', { timeout: 15_000 });

    // Live (no reload): "Volume in" must reach exactly before + 100.
    const before1 = parseNum(await volumeIn().textContent());
    await ingest100('a');
    await expect
      .poll(async () => parseNum(await volumeIn().textContent()), {
        timeout: 20_000,
        message: () =>
          `Volume in did not reach ${before1 + 100} live. platform fetches: [${diag.join(' | ')}]`,
      })
      .toBe(before1 + 100);

    // After a hard reload, still exact + still live.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: 'Platform Overview' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(volumeIn()).not.toHaveText('—', { timeout: 15_000 });
    const before2 = parseNum(await volumeIn().textContent());
    await ingest100('b');
    await expect
      .poll(async () => parseNum(await volumeIn().textContent()), {
        timeout: 20_000,
        message: () =>
          `Volume in did not reach ${before2 + 100} live after reload. platform fetches: [${diag.join(' | ')}]`,
      })
      .toBe(before2 + 100);

    await api.dispose();
  });
});
