import { test, type Browser, type Locator, type Page } from '@playwright/test';
import {
  adminApiContext,
  createCommissionRule,
  createSourceKey,
  expect,
  findSourceId,
  getCsrf,
  getJson,
  ingestTransaction,
  loginAs,
  mutate,
  provisionCompanyOwner,
  provisionPlatformUser,
} from './helpers';

/**
 * The New deposit form, end to end in the browser: a super admin records a
 * deposit the source made but has not yet sent through its API. Covers the
 * form's guards (validation, preview, missing price, inactive company,
 * duplicate reference), what it books, the source later sending the same
 * deposit through its API (recognised — or refused and alerted when the amount
 * differs), and who may use it.
 */

type Admin = Awaited<ReturnType<typeof adminApiContext>>;
type Company = Awaited<ReturnType<typeof provisionCompanyOwner>>;

async function openForm(page: Page): Promise<Locator> {
  await page.goto('/admin/deposits');
  await page.getByRole('button', { name: 'New deposit' }).click();
  // THE deposit dialog — the company picker's popover is a role=dialog too, and
  // can still be fading out when the next step runs.
  const dialog = page
    .getByRole('dialog')
    .filter({ has: page.getByRole('heading', { name: /New deposit|Confirm deposit/ }) });
  await expect(dialog.getByRole('heading', { name: 'New deposit' })).toBeVisible();
  // The source list has loaded once the select carries a real option.
  await expect(dialog.locator('select option[value]:not([value=""])').first()).toBeAttached();
  return dialog;
}

async function fillForm(
  page: Page,
  dialog: Locator,
  f: { company: Company; ref: string; amount: string; customer?: string; note?: string },
) {
  await dialog.locator('button[role=combobox]').click();
  await page.getByPlaceholder('Search companies…').fill(f.company.slug);
  await page
    .getByRole('button', { name: new RegExp(f.company.slug) })
    .first()
    .click();
  await expect(page.getByPlaceholder('Search companies…')).toBeHidden(); // picker closed
  await dialog.getByPlaceholder("As shown in the source's records").fill(f.ref);
  await dialog.getByPlaceholder('0.00').fill(f.amount);
  if (f.customer) await field(dialog, 'Customer').fill(f.customer);
  if (f.note) await field(dialog, 'Note').fill(f.note);
}

/** The input under a form label (labels are "Customer (optional)" etc.). */
const field = (dialog: Locator, label: string) =>
  dialog.locator('label', { hasText: label }).locator('xpath=following-sibling::input');

async function depositsFor(admin: Admin, companyId: string, ref: string) {
  const list = await getJson(
    admin.api,
    `/v1/admin/transactions?companyId=${companyId}&search=${ref}`,
  );
  return (list.data as Array<Record<string, string>>).filter(
    (t) => t.externalTransactionId === ref,
  );
}

// Same base URL as playwright.config.ts — a hand-made context does not inherit `use`.
const BASE_URL = process.env.E2E_BASE_URL ?? `http://localhost:${process.env.WEB_PORT ?? '3000'}`;

async function signInAs(browser: Browser, email: string, password: string): Promise<Page> {
  const ctx = await browser.newContext({
    baseURL: BASE_URL,
    storageState: { cookies: [], origins: [] },
  });
  const page = await ctx.newPage();
  await loginAs(page, email, password, '/admin');
  return page;
}

test.describe.serial('Manual deposits — the New deposit form', () => {
  test.setTimeout(120_000);

  let admin: Admin;
  let whishId: string;
  let priced: Company; // 2% fee
  const ref = `MAN-${Date.now().toString(36)}`;

  test.beforeAll(async () => {
    admin = await adminApiContext();
    whishId = await findSourceId(admin.api, 'whish');
    priced = await provisionCompanyOwner(admin);
    await createCommissionRule(admin.api, admin.csrf, {
      companyId: priced.companyId,
      operationType: 'TRANSACTION',
      feeApplication: 'DEDUCTED',
      minAmount: '0',
      maxAmount: null,
      commissionType: 'PERCENTAGE',
      commissionValue: '2',
    });
  });
  test.afterAll(async () => {
    await admin?.api.dispose();
  });

  test('the form opens on Whish and only lets a complete, valid deposit through', async ({
    page,
  }) => {
    const dialog = await openForm(page);
    const selected = await dialog
      .locator('select')
      .evaluate((s: HTMLSelectElement) => s.options[s.selectedIndex]?.text ?? '');
    expect(selected).toMatch(/whish/i);

    const review = dialog.getByRole('button', { name: 'Review' });
    await expect(review).toBeDisabled(); // nothing filled in yet

    await fillForm(page, dialog, { company: priced, ref, amount: '10.005' });
    await expect(review).toBeDisabled(); // sub-cent: a typo, never silently rounded
    await dialog.getByPlaceholder('0.00').fill('0');
    await expect(review).toBeDisabled(); // nothing to credit
    await dialog.getByPlaceholder('0.00').fill('25.50');
    await expect(review).toBeEnabled();
    await dialog.getByPlaceholder("As shown in the source's records").fill('   ');
    await expect(review).toBeDisabled(); // the source's reference is required
  });

  test('the review shows the exact price, and confirming books it like an API deposit', async ({
    page,
  }) => {
    const dialog = await openForm(page);
    await fillForm(page, dialog, {
      company: priced,
      ref,
      amount: '25.50',
      customer: 'Jane Payer',
      note: 'Entered by hand',
    });
    await dialog.getByRole('button', { name: 'Review' }).click();

    await expect(dialog.getByRole('heading', { name: 'Confirm deposit' })).toBeVisible();
    await expect(dialog).toContainText('25.50 USD');
    await expect(dialog).toContainText('0.51 USD'); // 2% of 25.50
    await expect(dialog).toContainText('24.99 USD'); // what the company is credited
    await dialog.getByRole('button', { name: 'Credit 24.99 USD' }).click();
    await expect(page.getByText(/Deposit recorded/)).toBeVisible();

    const [t] = await depositsFor(admin, priced.companyId, ref);
    expect(t).toMatchObject({
      sourceCode: 'whish',
      status: 'COMPLETED',
      customer: 'Jane Payer',
      note: 'Entered by hand',
    });
    expect(Number(t!.amount)).toBe(25.5);
    expect(Number(t!.commissionAmount)).toBe(0.51);
    expect(Number(t!.netAmount)).toBe(24.99);

    // Who entered it is on the record.
    const audit = await getJson(
      admin.api,
      `/v1/admin/audit-logs?action=transaction.manual_deposit&companyId=${priced.companyId}`,
    );
    expect((audit.data as Array<{ entityId: string }>).map((a) => a.entityId)).toContain(t!.id);
  });

  test('a reference already recorded is refused — nothing is booked twice', async ({ page }) => {
    const dialog = await openForm(page);
    await fillForm(page, dialog, { company: priced, ref, amount: '25.50' });
    await dialog.getByRole('button', { name: 'Review' }).click();
    await dialog.getByRole('button', { name: /^Credit / }).click();
    await expect(page.getByText(/already recorded for this source/)).toBeVisible();
    expect(await depositsFor(admin, priced.companyId, ref)).toHaveLength(1);
  });

  test('the source sending the same deposit through its API is recognised, never re-credited', async () => {
    const key = await createSourceKey(admin.api, admin.csrf, whishId, `e2e-man-${ref}`);
    const res = await ingestTransaction('whish', key, {
      companySlug: priced.slug,
      externalTransactionId: ref,
      amount: '25.5',
      currency: 'USD',
    });
    expect(res.status).toBe(201);
    expect(res.body.replayed).toBe(true);
    expect(await depositsFor(admin, priced.companyId, ref)).toHaveLength(1);
  });

  test('a different amount from the source is refused and the admins are alerted', async ({
    page,
  }) => {
    const key = await createSourceKey(admin.api, admin.csrf, whishId, `e2e-mis-${ref}`);
    const res = await ingestTransaction('whish', key, {
      companySlug: priced.slug,
      externalTransactionId: ref,
      amount: '255.00',
      currency: 'USD',
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'TRANSACTION_MISMATCH',
      details: {
        recorded: { amount: '25.50', currency: 'USD' },
        sent: { amount: '255.00', currency: 'USD' },
      },
    });
    expect(await depositsFor(admin, priced.companyId, ref)).toHaveLength(1);

    // The bell carries it, and opens the deposit.
    await page.goto('/admin/deposits');
    await page.getByRole('button', { name: /^Notifications/ }).click();
    const alert = page.getByRole('button', { name: new RegExp(`Deposit refused.*${ref}`) });
    await expect(alert.first()).toBeVisible();
    await alert.first().click();
    await expect(page).toHaveURL(new RegExp(`/admin/deposits\\?search=${ref}`));
  });

  // Where the API must book such a deposit at net 0 (it can never refuse money a
  // source already took), the form refuses it with the real reason, so the
  // price is fixed before anything is booked. A company's own rule always beats
  // the platform-wide ones, so a flat fee larger than the deposit is a price
  // that cannot book in any environment. (A company with no rule at all is the
  // same strict path — pinned by the manual-deposit integration spec.)
  test('a deposit its price cannot book is refused — never booked at net 0', async ({ page }) => {
    const mispriced = await provisionCompanyOwner(admin);
    await createCommissionRule(admin.api, admin.csrf, {
      companyId: mispriced.companyId,
      operationType: 'TRANSACTION',
      feeApplication: 'DEDUCTED',
      minAmount: '0',
      maxAmount: null,
      commissionType: 'FIXED',
      commissionValue: '50',
    });
    const dialog = await openForm(page);
    await fillForm(page, dialog, { company: mispriced, ref: `${ref}-np`, amount: '10.00' });
    await dialog.getByRole('button', { name: 'Review' }).click();
    await expect(page.getByText(/exceeds the amount/)).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'New deposit' })).toBeVisible(); // stays on the form
    expect(await depositsFor(admin, mispriced.companyId, `${ref}-np`)).toHaveLength(0);
  });

  test('a network fee and a fee charged on top preview their real price', async ({ page }) => {
    const withNetwork = await provisionCompanyOwner(admin);
    await createCommissionRule(admin.api, admin.csrf, {
      companyId: withNetwork.companyId,
      operationType: 'TRANSACTION',
      feeApplication: 'DEDUCTED',
      minAmount: '0',
      maxAmount: null,
      commissionType: 'PERCENTAGE',
      commissionValue: '2',
    });
    const set = await mutate(
      admin.api,
      admin.csrf,
      'put',
      `/v1/admin/companies/${withNetwork.companyId}/network-fee`,
      {
        enabled: true,
        rates: [{ operationType: 'TRANSACTION', feeType: 'PERCENTAGE', feeValue: '1' }],
      },
    );
    expect(set.status).toBe(200);
    let dialog = await openForm(page);
    await fillForm(page, dialog, { company: withNetwork, ref: `${ref}-nf`, amount: '100.00' });
    await dialog.getByRole('button', { name: 'Review' }).click();
    await expect(dialog).toContainText('Network fee');
    await expect(dialog).toContainText('97.00 USD'); // 100 − 2% − 1%
    await page.keyboard.press('Escape');

    const onTop = await provisionCompanyOwner(admin);
    await createCommissionRule(admin.api, admin.csrf, {
      companyId: onTop.companyId,
      operationType: 'TRANSACTION',
      feeApplication: 'ON_TOP',
      minAmount: '0',
      maxAmount: null,
      commissionType: 'PERCENTAGE',
      commissionValue: '2',
    });
    dialog = await openForm(page);
    await fillForm(page, dialog, { company: onTop, ref: `${ref}-ot`, amount: '100.00' });
    await dialog.getByRole('button', { name: 'Review' }).click();
    await expect(dialog).toContainText('Fee (charged on top)');
    await expect(dialog.getByRole('button', { name: 'Credit 100.00 USD' })).toBeVisible();
  });

  test('a deactivated company is refused', async ({ page }) => {
    const inactive = await provisionCompanyOwner(admin);
    await createCommissionRule(admin.api, admin.csrf, {
      companyId: inactive.companyId,
      operationType: 'TRANSACTION',
      feeApplication: 'DEDUCTED',
      minAmount: '0',
      maxAmount: null,
      commissionType: 'PERCENTAGE',
      commissionValue: '2',
    });
    const off = await mutate(
      admin.api,
      admin.csrf,
      'post',
      `/v1/admin/companies/${inactive.companyId}/disable`,
    );
    expect(off.status).toBeLessThan(300);
    const dialog = await openForm(page);
    await fillForm(page, dialog, { company: inactive, ref: `${ref}-off`, amount: '10.00' });
    await dialog.getByRole('button', { name: 'Review' }).click();
    await expect(page.getByText(/is inactive/)).toBeVisible();
    expect(await depositsFor(admin, inactive.companyId, `${ref}-off`)).toHaveLength(0);
  });

  test('operators and back office cannot record a deposit — no button, and the API refuses', async ({
    browser,
  }) => {
    for (const role of ['ADMIN_OPERATOR', 'BACKOFFICE'] as const) {
      const user = await provisionPlatformUser(admin, role, `E2e!${role}-pass-123`);
      const page = await signInAs(browser, user.email, user.password);
      await page.goto('/admin/deposits');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByRole('button', { name: 'New deposit' })).toHaveCount(0);

      const attempt = await mutate(
        user.api,
        await getCsrf(user.api),
        'post',
        '/v1/admin/deposits',
        {
          sourceId: whishId,
          companyId: priced.companyId,
          externalTransactionId: `${ref}-${role}`,
          amount: '10.00',
          currency: 'USD',
        },
      );
      expect(attempt.status, role).toBe(403);
      await user.api.dispose();
      await page.context().close();
    }
    expect(await depositsFor(admin, priced.companyId, `${ref}-ADMIN_OPERATOR`)).toHaveLength(0);
  });
});
