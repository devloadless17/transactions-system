// Headless smoke test of the refactored UI behind auth, using system Chrome.
const { chromium } = require('@playwright/test');
const path = require('node:path');

// Follow the repo-root .env (WEB_PORT / SEED_ADMIN_*) so this smoke test hits the
// same origin the dev server actually bound to. BASE_URL overrides everything.
try {
  process.loadEnvFile(path.join(__dirname, '..', '.env'));
} catch {
  /* no .env present — fall through to the defaults below */
}
const BASE = process.env.BASE_URL ?? `http://localhost:${process.env.WEB_PORT ?? '3000'}`;

(async () => {
  // Prefer system Chrome (closest to what users run), but fall back to Playwright's
  // bundled Chromium — a WSL/CI box often has no /opt/google/chrome, and a missing
  // browser shouldn't be the reason the smoke test can't run.
  const browser = await chromium
    .launch({ channel: 'chrome', headless: true })
    .catch(() => chromium.launch({ headless: true }));
  const errors = [];
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text().slice(0, 140)); });

  const report = [];
  const note = (s) => { report.push(s); console.log(s); };

  // 1. Login page renders
  await page.goto(BASE + '/login', { waitUntil: 'networkidle' });
  note('login title: ' + JSON.stringify((await page.title())));
  await page.fill('input[type="email"], #email', process.env.SEED_ADMIN_EMAIL ?? 'admin@example.com');
  await page.fill(
    'input[type="password"], #password',
    process.env.SEED_ADMIN_PASSWORD ?? 'AdminPassw0rd!',
  );
  await page.click('button[type="submit"]');
  await page.waitForURL('**/admin**', { timeout: 15000 }).catch(() => {});
  note('after login url: ' + page.url());

  // 2. Admin shell + a refactored list page (desktop)
  await page.goto(BASE + '/admin/companies', { waitUntil: 'networkidle' });
  const navVisible = await page.getByText('Companies', { exact: false }).first().isVisible().catch(() => false);
  const hasTable = (await page.locator('table').count()) > 0;
  const hasEmpty = (await page.getByText('No companies', { exact: false }).count()) > 0;
  note('admin/companies: navText=' + navVisible + ' table=' + hasTable + ' empty=' + hasEmpty);
  await page.screenshot({ path: 'scripts/_shot-admin-desktop.png' });

  // 3. Company-side refactored page
  // (still admin session; just confirm admin whish + a couple pages render)
  await page.goto(BASE + '/admin/whish', { waitUntil: 'networkidle' });
  const whishOk = (await page.getByText('Whish Pay', { exact: false }).count()) > 0;
  note('admin/whish renders: ' + whishOk);

  // 4. Mobile viewport — hamburger drawer
  await page.setViewportSize({ width: 375, height: 740 });
  await page.goto(BASE + '/admin/companies', { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  await page.screenshot({ path: 'scripts/_shot-admin-mobile.png' });
  let drawerOpened = false;
  try {
    const hamburger = page.getByRole('button', { name: 'Open navigation menu' });
    note('hamburger visible: ' + (await hamburger.isVisible()));
    await hamburger.click();
    const dialog = page.getByRole('dialog');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    drawerOpened = await dialog.getByRole('link', { name: 'Companies' }).isVisible();
    await page.screenshot({ path: 'scripts/_shot-admin-mobile-drawer.png' });
  } catch (e) {
    note('drawer error: ' + e.message.slice(0, 120));
  }
  note('mobile drawer opened + nav link visible: ' + drawerOpened);

  note('\nJS errors captured: ' + errors.length);
  errors.slice(0, 8).forEach((e) => note('  ' + e));

  await browser.close();
  process.exit(errors.some((e) => e.includes("reading 'call'") || e.includes('Cannot read properties')) ? 1 : 0);
})().catch((e) => { console.error('SMOKE HARNESS ERROR:', e.message); process.exit(2); });
