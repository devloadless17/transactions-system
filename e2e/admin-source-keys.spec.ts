import { test, expect, request as pwRequest } from '@playwright/test';
import { API_BASE, ADMIN_EMAIL, ADMIN_PASSWORD, uniqueSlug, unwrap } from './helpers';

test.describe('admin: source API keys', () => {
  test("navigate from sources list to a source's API keys page", async ({ page }) => {
    await page.goto('/admin/sources');
    await expect(page.getByRole('heading', { name: 'Sources' })).toBeVisible();

    // Each row has an "API keys" button; click the first one.
    const firstApiKeysLink = page.getByRole('link', { name: 'API keys' }).first();
    await expect(firstApiKeysLink).toBeVisible();
    await firstApiKeysLink.click();

    await expect(page).toHaveURL(/\/admin\/sources\/[0-9a-f-]{36}\/api-keys$/);
    await expect(page.getByRole('heading', { name: /API keys/ })).toBeVisible();
  });

  test('create a source API key, then use it to ingest a transaction', async ({ page }) => {
    // Get a real source id from the API (omt is seeded).
    const api = await pwRequest.newContext({ baseURL: API_BASE });
    const login = await api.post('/v1/auth/login', {
      data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
    });
    expect(login.ok()).toBeTruthy();

    const sources = await api.get('/v1/admin/sources/all');
    expect(sources.ok()).toBeTruthy();
    const sourceList = unwrap(await sources.json()).data as Array<{ id: string; code: string }>;
    const omt = sourceList.find((s) => s.code === 'omt');
    expect(omt, 'seeded omt source not found').toBeTruthy();

    // --- UI: create the key via the admin source-keys page ---
    await page.goto(`/admin/sources/${omt!.id}/api-keys`);
    await page.getByRole('button', { name: 'New key' }).click();

    const dialog = page.getByRole('dialog');
    const keyName = `e2e-${uniqueSlug('omt')}`;
    await dialog.locator('#name').fill(keyName);
    await dialog.getByRole('button', { name: 'Create', exact: true }).click();

    // Plaintext shown only once.
    await expect(dialog.getByRole('heading', { name: 'Key created' })).toBeVisible({
      timeout: 10_000,
    });
    const plaintextEl = dialog.locator('div.font-mono').first();
    const plaintext = (await plaintextEl.textContent())?.trim();
    expect(plaintext, 'plaintext should be visible').toMatch(/^tsk_[A-Z0-9]{8}_[0-9a-f]+$/);

    // Two "Close" buttons exist in the dialog (radix's X icon + our footer button).
    // The footer button is the first match.
    await dialog.getByRole('button', { name: 'Close' }).first().click();
    await expect(page.locator('table').getByText(keyName)).toBeVisible();

    // --- API: use the new source key to ingest a transaction ---
    // Pick any existing active company.
    const companyState = await api.storageState();
    const csrf = companyState.cookies.find((c) => c.name === 'csrf-token')?.value;
    expect(csrf).toBeTruthy();

    // Provision a fresh company so we have a known id to target.
    const targetSlug = uniqueSlug('e2e-target');
    const createCo = await api.post('/v1/admin/companies', {
      headers: { 'x-csrf-token': csrf! },
      data: {
        name: `E2E Target ${targetSlug}`,
        slug: targetSlug,
        defaultCurrency: 'USD',
        ownerEmail: `owner-${targetSlug}@example.com`,
      },
    });
    expect(createCo.ok()).toBeTruthy();
    const targetId = unwrap(await createCo.json()).company.id as string;
    expect(targetId).toBeTruthy();

    // A source may only mint into companies that have OPTED IN. Enable the
    // omt source for this target before ingesting (the opt-in gate is intended
    // behaviour, not a bug). Without this the ingest is rejected with 403.
    const optIn = await api.post(`/v1/admin/sources/${omt!.id}/companies`, {
      headers: { 'x-csrf-token': csrf! },
      data: { companyId: targetId, enabled: true },
    });
    expect(optIn.status(), await optIn.text()).toBeLessThan(300);

    // Ingest with the SOURCE key — URL path now identifies the source (omt).
    const ingestRes = await pwRequest.newContext({ baseURL: API_BASE });
    const ingest = await ingestRes.post('/v1/ingest/omt/transactions', {
      headers: { Authorization: `Bearer ${plaintext}` },
      data: {
        companySlug: targetSlug,
        externalTransactionId: `e2e-${Date.now()}`,
        amount: '120.00',
        currency: 'USD',
      },
    });
    expect(ingest.status(), await ingest.text()).toBe(201);
    const body = unwrap(await ingest.json());
    expect(body.sourceCode).toBe('omt');
    expect(body.currency).toBe('USD');
    expect(body.amount).toBe('120');
    expect(body.status).toBe('COMPLETED');

    // Negative case: same key, wrong source in URL → 403.
    const mismatch = await ingestRes.post('/v1/ingest/whish/transactions', {
      headers: { Authorization: `Bearer ${plaintext}` },
      data: {
        companySlug: targetSlug,
        externalTransactionId: `e2e-mismatch-${Date.now()}`,
        amount: '10',
        currency: 'USD',
      },
    });
    expect(mismatch.status()).toBe(403);

    // Discovery: source key lists active companies and the new target is in there.
    const discover = await ingestRes.get('/v1/ingest/companies', {
      headers: { Authorization: `Bearer ${plaintext}` },
    });
    expect(discover.status()).toBe(200);
    const list = unwrap(await discover.json()).data as Array<{
      slug: string;
      name: string;
    }>;
    expect(list.some((c) => c.slug === targetSlug)).toBeTruthy();
    // Company UUIDs must never be exposed to sources.
    expect(list.every((c) => !('operatingId' in c))).toBeTruthy();

    // Unknown slug → 400 VALIDATION_ERROR (never a UUID leak, never a 500).
    const badSlug = await ingestRes.post('/v1/ingest/omt/transactions', {
      headers: { Authorization: `Bearer ${plaintext}` },
      data: {
        companySlug: 'no-such-company-slug',
        externalTransactionId: `e2e-bad-${Date.now()}`,
        amount: '10',
        currency: 'USD',
      },
    });
    expect(badSlug.status()).toBe(400);

    // --- SUPER_ADMIN renames the slug; ingest follows the new slug ---
    const renamedSlug = uniqueSlug('e2e-renamed');
    const rename = await api.patch(`/v1/admin/companies/${targetId}`, {
      headers: { 'x-csrf-token': csrf! },
      data: { slug: renamedSlug },
    });
    expect(rename.status(), await rename.text()).toBe(200);
    expect(unwrap(await rename.json()).slug).toBe(renamedSlug);

    const newSlugIngest = await ingestRes.post('/v1/ingest/omt/transactions', {
      headers: { Authorization: `Bearer ${plaintext}` },
      data: {
        companySlug: renamedSlug,
        externalTransactionId: `e2e-renamed-${Date.now()}`,
        amount: '15',
        currency: 'USD',
      },
    });
    expect(newSlugIngest.status(), await newSlugIngest.text()).toBe(201);
    expect(unwrap(await newSlugIngest.json()).companySlug).toBe(renamedSlug);

    // The old slug is gone immediately.
    const oldSlugIngest = await ingestRes.post('/v1/ingest/omt/transactions', {
      headers: { Authorization: `Bearer ${plaintext}` },
      data: {
        companySlug: targetSlug,
        externalTransactionId: `e2e-old-slug-${Date.now()}`,
        amount: '10',
        currency: 'USD',
      },
    });
    expect(oldSlugIngest.status()).toBe(400);

    await api.dispose();
    await ingestRes.dispose();
  });
});
