import { test, expect, type Page } from '@playwright/test';
import { adminApiContext, provisionCompanyOwner, uniqueSlug } from './helpers';

/**
 * Company identity edits — the display name and the slug — and the audit trail
 * they leave behind.
 *
 * Both are SUPER_ADMIN-only, gated per-FIELD in `CompaniesService.update` so
 * ADMIN_OPERATOR keeps its status/visibility PATCHes. The default storage state
 * is the seeded SUPER_ADMIN, so the controls are visible without extra setup.
 *
 * The audit assertions are the point of the rename half: the row used to say
 * only that `company.updated` happened, which made a rename, a slug change and
 * a visibility toggle indistinguishable after the fact.
 */
test.describe('admin: company identity', () => {
  test.setTimeout(90_000);

  let companyId = '';
  let originalName = '';
  let originalSlug = '';

  test.beforeAll(async () => {
    const { api } = await adminApiContext();
    try {
      const provisioned = await provisionCompanyOwner();
      companyId = provisioned.companyId;
      originalSlug = provisioned.slug;
      originalName = `E2E Company ${provisioned.slug}`;
    } finally {
      await api.dispose();
    }
  });

  // Each editable identity field has its own labelled pencil button, matching
  // the icon-button pattern the commission-rule rows use.
  const renameButton = (page: Page) => page.getByRole('button', { name: 'Rename company' });
  const slugButton = (page: Page) => page.getByRole('button', { name: 'Edit slug' });

  test('renames a company, and the audit row says what changed', async ({ page }) => {
    await page.goto(`/admin/companies/${companyId}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: originalName })).toBeVisible({
      timeout: 30_000,
    });

    await renameButton(page).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Rename company' })).toBeVisible();

    const save = dialog.getByRole('button', { name: /Save name/ });

    // Unchanged → nothing to save.
    await expect(save).toBeDisabled();

    // Too short → inline error from the SHARED schema, not a post-submit toast.
    await dialog.locator('#company-name').fill('A');
    await expect(dialog.getByText(/at least 2/i)).toBeVisible();
    await expect(save).toBeDisabled();

    const newName = `Renamed ${uniqueSlug('co')}`;
    await dialog.locator('#company-name').fill(`  ${newName}  `); // padded: must be trimmed
    await expect(save).toBeEnabled();
    await save.click();

    // Header reflects the TRIMMED name.
    await expect(page.getByRole('heading', { name: newName })).toBeVisible({ timeout: 15_000 });
    await expect(dialog).toBeHidden();

    // The page's own audit card now shows the diff, old → new.
    const auditCard = page.locator('table', { hasText: 'company.updated' }).first();
    await expect(auditCard).toBeVisible({ timeout: 15_000 });
    const changesRow = auditCard.locator('tr', { hasText: 'company.updated' }).first();
    await expect(changesRow).toContainText(originalName);
    await expect(changesRow).toContainText(newName);

    originalName = newName; // keep the fixture honest for the slug test below
  });

  test('changes a slug, and that too is audited', async ({ page }) => {
    await page.goto(`/admin/companies/${companyId}`, { waitUntil: 'domcontentloaded' });
    await expect(page.getByText(originalSlug, { exact: false }).first()).toBeVisible({
      timeout: 30_000,
    });

    await slugButton(page).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: 'Edit slug' })).toBeVisible();

    const newSlug = uniqueSlug('e2e-renamed');
    await dialog.locator('#company-slug').fill(newSlug);
    // The destructive warning appears only once the value actually differs, so
    // it reads as a consequence of what was typed rather than ambient noise.
    await expect(dialog).toContainText(/will\s+start failing when you save/i);
    await expect(dialog).toContainText(originalSlug);
    await dialog.getByRole('button', { name: /Save slug/ }).click();

    await expect(page.getByText(newSlug, { exact: false }).first()).toBeVisible({
      timeout: 15_000,
    });

    const changesRow = page
      .locator('tr', { hasText: 'company.updated' })
      .filter({ hasText: newSlug })
      .first();
    await expect(changesRow).toContainText(originalSlug);
  });
});
