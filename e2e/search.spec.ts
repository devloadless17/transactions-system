import { test, type APIRequestContext } from '@playwright/test';
import {
  adminApiContext,
  createCommissionRule,
  createSourceKey,
  enableSourceForCompany,
  expect,
  findSourceId,
  getCsrf,
  ingestTransaction,
  loginAs,
  loginOwnerApiContext,
  mutate,
  provisionCompanyOwner,
  settled,
} from './helpers';

/**
 * Search finds a money row by whatever a person quotes — in the browser.
 *
 * Reported Oct 2026: searching a customer's phone showed their deposits but not
 * the withdrawal paid to that same phone, and the withdrawals page had no search
 * at all. One rule now (apps/api/src/common/search.ts): every recipient detail,
 * the reference, the id and the note, with a phone matched by its digits however
 * it is typed. The API cases are pinned in test/integration/search.int-spec.ts;
 * this pins the screens.
 */
test.describe.serial('search by phone, name or reference', () => {
  test.setTimeout(120_000);

  const local = `70${Math.floor(100_000 + Math.random() * 899_999)}`; // 70xxxxxx
  const spaced = `+961 ${local.slice(0, 2)} ${local.slice(2, 5)} ${local.slice(5)}`;
  const compact = `+961${local}`;
  const name = `Search Payee ${Date.now()}`;
  const ownerPassword = 'newpass-search-12345';

  let admin: APIRequestContext;
  let adminCsrf: string;
  let ownerEmail: string;
  let completedRef: string;

  test.beforeAll(async () => {
    test.setTimeout(180_000);
    ({ api: admin, csrf: adminCsrf } = await adminApiContext());
    const omtId = await findSourceId(admin, 'omt');
    const co = await provisionCompanyOwner({ api: admin, csrf: adminCsrf });
    ownerEmail = co.ownerEmail;
    const owner = await loginOwnerApiContext(co.ownerEmail, co.tempPassword, ownerPassword);
    const ownerCsrf = await getCsrf(owner);
    await enableSourceForCompany(admin, adminCsrf, omtId, co.companyId);
    const key = await createSourceKey(admin, adminCsrf, omtId, `e2e-search-${Date.now()}`);
    for (const operationType of ['TRANSACTION', 'WITHDRAWAL']) {
      await createCommissionRule(admin, adminCsrf, {
        companyId: co.companyId,
        operationType,
        feeApplication: 'DEDUCTED',
        commissionType: 'PERCENTAGE',
        commissionValue: '1',
        minAmount: '0.01',
        maxAmount: '100000000',
        priority: 1000,
      });
    }
    const ing = await ingestTransaction('omt', key, {
      companySlug: co.slug,
      externalTransactionId: `srch-${Date.now()}`,
      amount: '500',
      currency: 'USD',
    });
    expect(ing.status).toBe(201);

    // The same phone, stored two ways, on a completed and a pending withdrawal.
    const request = (phone: string) =>
      mutate(owner, ownerCsrf, 'post', '/v1/company/withdrawals', {
        amount: '50',
        currency: 'USD',
        payout: { method: 'WISH', recipientName: name, recipientPhone: phone },
      });
    const done = await request(spaced);
    expect(done.status, JSON.stringify(done.body)).toBe(201);
    const pending = await request(compact);
    expect(pending.status, JSON.stringify(pending.body)).toBe(201);
    completedRef = `srch-ref-${Date.now()}`;
    const approved = await mutate(
      admin,
      adminCsrf,
      'post',
      `/v1/admin/withdrawals/${done.body.id}/approve`,
      {
        externalReference: completedRef,
      },
    );
    expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    await owner.dispose();
  });

  test.afterAll(async () => {
    await admin?.dispose();
  });

  test('admin Withdrawals: the phone typed any way finds both withdrawals, any status', async ({
    page,
  }) => {
    await page.goto('/admin/withdrawals');
    await settled(page);
    // The queue opens on PENDING; show every status.
    await page
      .locator('select')
      .filter({ has: page.locator('option', { hasText: 'PROCESSING' }) })
      .first()
      .selectOption('');
    const search = page.getByRole('textbox', { name: /search by phone, recipient name/i });
    const rows = page.getByRole('row').filter({ hasText: name });
    for (const typed of [local, spaced, `00961${local}`]) {
      await search.fill(typed);
      await expect(rows, typed).toHaveCount(2, { timeout: 15_000 });
    }
    // …and by the recipient's name in any case, or the reference.
    await search.fill(name.toLowerCase());
    await expect(rows).toHaveCount(2, { timeout: 15_000 });
    await search.fill(completedRef);
    await expect(rows).toHaveCount(1, { timeout: 15_000 });
  });

  test('activity feed: the completed withdrawal is found by the phone (the reported bug)', async ({
    page,
  }) => {
    await page.goto('/admin/transactions');
    await settled(page);
    await page.getByRole('button', { name: 'Today' }).click();
    await page.getByRole('button', { name: 'All time' }).click();
    await page.keyboard.press('Escape');
    await page
      .getByRole('textbox', { name: /search by phone, name, reference or id/i })
      .fill(local);
    await expect(page.getByText(name)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Withdrawal', { exact: true }).first()).toBeVisible();
  });

  test('company Withdrawals: the owner finds their own by name, any case', async ({ browser }) => {
    const context = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const page = await context.newPage();
    try {
      await loginAs(page, ownerEmail, ownerPassword, '/app');
      await page.goto('/app/withdrawals');
      await settled(page);
      await page
        .getByRole('textbox', { name: /search by phone, recipient name/i })
        .fill(name.toUpperCase());
      await expect(page.getByRole('row').filter({ hasText: name }).first()).toBeVisible({
        timeout: 15_000,
      });
    } finally {
      await context.close();
    }
  });
});
