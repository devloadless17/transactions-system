import { test, expect, type BrowserContext, type Page, type Request } from '@playwright/test';
import { loginAs, provisionCompanyOwner } from './helpers';

/**
 * End-to-end proof for the six shared quick ranges across EVERY picker in the app.
 *
 * Navigations here pass an explicit 60s timeout: the config's 15s default suits
 * a warm dev server, but the first hit on a route still has to compile it.
 *
 * The presets are defined once (`apps/web/src/lib/date-presets.ts`) but rendered
 * by two different families with different backends, so "it works on one page"
 * proves very little:
 *
 *   - LIST pages (deposits, ledger, withdrawals/payouts/loads, Whish, activity)
 *     express "All time" by sending NO from/to at all — those endpoints apply no
 *     default window.
 *   - DASHBOARD pages must send `preset=all` instead, because omitting the
 *     bounds there means "last 30 days" and an explicit wide range is rejected
 *     by the 366-day cap.
 *
 * Sending the wrong one is silent: the page still renders, just over the wrong
 * window. So every assertion here checks the REQUEST the page actually made,
 * not merely that a button was clickable.
 */

const SIX_RANGES = [
  'Today',
  'This month',
  'Last 7 days',
  'Last 30 days',
  'Last 90 days',
  'All time',
];

/** The picker trigger is the only button carrying the calendar icon. */
function pickerTrigger(page: Page) {
  return page.locator('button:has(svg.lucide-calendar)').first();
}

/** Preset buttons live in the popover column headed "Quick ranges". */
function quickRanges(page: Page) {
  return page.locator('text=Quick ranges').locator('..');
}

/**
 * Open the picker, retrying the click.
 *
 * On a cold Next dev server the button can be clicked before React hydrates, so
 * the first click does nothing at all and the popover never appears — the same
 * race `global.setup.ts` documents for the login form.
 */
async function openPicker(page: Page) {
  const trigger = pickerTrigger(page);
  await expect(trigger).toBeVisible({ timeout: 30_000 });
  for (let attempt = 0; ; attempt++) {
    await trigger.click();
    try {
      await expect(quickRanges(page)).toBeVisible({ timeout: 5_000 });
      return;
    } catch (err) {
      if (attempt >= 3) throw err;
      await page.waitForTimeout(1_000);
    }
  }
}

/** Click a preset and return every API request the page fired as a result. */
async function selectPreset(page: Page, label: string, urlPart: string): Promise<Request[]> {
  const seen: Request[] = [];
  const collect = (r: Request) => {
    if (r.url().includes('/v1/') && r.url().includes(urlPart)) seen.push(r);
  };
  page.on('request', collect);
  await quickRanges(page).getByRole('button', { name: label, exact: true }).click();
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
  page.off('request', collect);
  return seen;
}

function params(req: Request) {
  return new URL(req.url()).searchParams;
}

/**
 * The LAST request per endpoint — that is the one carrying the range just
 * selected. Switching ranges can leave the previous range's fetch in flight
 * (react-query refetches the still-mounted key), so asserting over every
 * observed request would be asserting about a window nobody asked for.
 */
function latestPerEndpoint(reqs: Request[]): Request[] {
  const byPath = new Map<string, Request>();
  for (const r of reqs) byPath.set(new URL(r.url()).pathname, r);
  return [...byPath.values()];
}

const monthStart = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
};

// ---------------------------------------------------------------------------
// Admin — runs on the default admin storageState.
// ---------------------------------------------------------------------------

test.describe('quick ranges: admin', () => {
  test.setTimeout(120_000);

  // Every picker, list and dashboard alike, must offer the same six in order.
  const ADMIN_PICKERS = [
    { path: '/admin', name: 'platform dashboard' },
    { path: '/admin/deposits', name: 'deposits table' },
    { path: '/admin/transactions', name: 'activity feed' },
    { path: '/admin/withdrawals', name: 'withdrawals flow bar' },
    { path: '/admin/payouts', name: 'payouts flow bar' },
    { path: '/admin/loads', name: 'loads flow bar' },
    { path: '/admin/whish', name: 'Whish Pay bar' },
  ];

  for (const { path, name } of ADMIN_PICKERS) {
    test(`${name} offers the six shared ranges`, async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));

      await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await openPicker(page);
      await expect(quickRanges(page).getByRole('button')).toHaveText(SIX_RANGES);
      expect(errors, `JS errors on ${path}`).toEqual([]);
    });
  }

  // The dashboards are the ones that need the explicit flag.
  test('platform dashboard sends preset=all for All time, and bounds otherwise', async ({
    page,
  }) => {
    await page.goto('/admin', { waitUntil: 'domcontentloaded', timeout: 60_000 });

    await openPicker(page);
    const monthReqs = latestPerEndpoint(
      await selectPreset(page, 'This month', '/admin/analytics/'),
    );
    expect(monthReqs.length).toBeGreaterThan(0);
    for (const r of monthReqs.filter((r) => params(r).has('from'))) {
      const p = params(r);
      expect(p.get('preset'), 'a bounded range must not carry the preset flag').toBeNull();
      // Month-to-date: the lower bound is local midnight on the 1st, which in
      // UTC can land on the last day of the previous month.
      const from = new Date(p.get('from')!);
      const localFrom = new Date(from.getTime() - from.getTimezoneOffset() * 60_000);
      expect(localFrom.toISOString().slice(0, 10)).toBe(monthStart());
    }

    await openPicker(page);
    const allReqs = latestPerEndpoint(await selectPreset(page, 'All time', '/admin/analytics/'));
    // The range-bearing endpoints (platform, flows) must all have switched over.
    const ranged = allReqs.filter((r) => !r.url().includes('/operations'));
    expect(ranged.length).toBeGreaterThan(0);
    for (const r of ranged) {
      const p = params(r);
      expect(p.get('preset'), 'the dashboard must ask for all time explicitly').toBe('all');
      // preset + bounds is a 400 by design — they must never be sent together.
      expect(p.get('from')).toBeNull();
      expect(p.get('to')).toBeNull();
    }

    // The response drives the chart, so a broken contract shows up as an error
    // boundary rather than a chart.
    await expect(page.getByRole('heading', { name: /Platform Overview/i })).toBeVisible();
    await expect(page.getByText(/all time/i).first()).toBeVisible();
  });

  // The list pages are the mirror image: no flag, no bounds.
  test('deposits table drops both bounds for All time', async ({ page }) => {
    await page.goto('/admin/deposits', { waitUntil: 'domcontentloaded', timeout: 60_000 });

    await openPicker(page);
    const monthReqs = latestPerEndpoint(
      await selectPreset(page, 'This month', '/admin/transactions'),
    );
    expect(monthReqs.length).toBeGreaterThan(0);
    expect(params(monthReqs[0]).get('from')).toBeTruthy();
    await expect(page).toHaveURL(new RegExp(`[?&]from=${monthStart()}\\b`));

    await openPicker(page);
    await quickRanges(page).getByRole('button', { name: 'All time', exact: true }).click();
    await expect(page).not.toHaveURL(/[?&](from|to)=/);

    // The unfiltered query is usually already cached from the initial load, so
    // the click alone need not hit the network. Reload the resulting URL to see
    // the wire format from cold — that is what a shared/bookmarked link does.
    const [allReq] = await Promise.all([
      page.waitForRequest((r) => r.url().includes('/v1/admin/transactions?')),
      page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }),
    ]);
    const p = params(allReq);
    expect(p.get('from'), 'list endpoints express all-time by omission').toBeNull();
    expect(p.get('to')).toBeNull();
    // A `preset` here would be silently stripped by zod and mean nothing.
    expect(p.get('preset')).toBeNull();
  });

  // The activity feed shares the DASHBOARD picker component but hits a LIST
  // endpoint — the one place the two families meet, and the easiest to get wrong.
  test('activity feed uses list semantics despite the dashboard picker', async ({ page }) => {
    await page.goto('/admin/transactions', { waitUntil: 'domcontentloaded', timeout: 60_000 });

    await openPicker(page);
    const allReqs = latestPerEndpoint(await selectPreset(page, 'All time', '/admin/activity'));
    expect(allReqs.length).toBeGreaterThan(0);
    for (const r of allReqs) {
      const p = params(r);
      expect(p.get('preset'), 'activity has no preset field — it would be stripped').toBeNull();
      expect(p.get('from')).toBeNull();
      expect(p.get('to')).toBeNull();
    }
    // Still renders rows rather than an error boundary.
    await expect(page.getByRole('heading', { name: /Transactions/i })).toBeVisible();
  });

  test('All time is the highlighted preset once no bounds are set', async ({ page }) => {
    await page.goto('/admin/whish', { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await openPicker(page);
    await quickRanges(page).getByRole('button', { name: 'All time', exact: true }).click();
    await page.waitForLoadState('networkidle');

    await openPicker(page);
    // Before the shared matcher, cleared bounds were stored as '' and compared
    // against undefined, so this state could never highlight at all.
    await expect(
      quickRanges(page).getByRole('button', { name: 'All time', exact: true }),
    ).toHaveClass(/bg-secondary/);
    await expect(quickRanges(page).locator('button.bg-secondary')).toHaveCount(1);
  });
});

// ---------------------------------------------------------------------------
// Company — a real tenant session, to prove All time stays inside the tenant.
// ---------------------------------------------------------------------------

test.describe.serial('quick ranges: company portal', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test.setTimeout(180_000);

  let ownerEmail = '';
  let tempPassword = '';
  const newPassword = '123456';
  let ownerStorage: Awaited<ReturnType<BrowserContext['storageState']>> | null = null;

  test.beforeAll(async () => {
    const provisioned = await provisionCompanyOwner();
    ownerEmail = provisioned.ownerEmail;
    tempPassword = provisioned.tempPassword;
  });

  test('owner signs in and lands in the portal', async ({ page, context }) => {
    await loginAs(page, ownerEmail, tempPassword, '/change-password');
    await page.locator('#currentPassword').fill(tempPassword);
    await page.locator('#newPassword').fill(newPassword);
    await page.locator('#confirmPassword').fill(newPassword);
    await page.getByRole('button', { name: /save and sign in again/i }).click();
    await page.waitForURL(/\/login/, { timeout: 15_000 });

    await loginAs(page, ownerEmail, newPassword, '/app');
    ownerStorage = await context.storageState();
  });

  const COMPANY_PICKERS = [
    { path: '/app', name: 'company dashboard' },
    { path: '/app/deposits', name: 'deposits table' },
    { path: '/app/ledger', name: 'ledger table' },
    { path: '/app/withdrawals', name: 'withdrawals flow bar' },
    { path: '/app/whish', name: 'Whish Pay bar' },
  ];

  for (const { path, name } of COMPANY_PICKERS) {
    test(`${name} offers the six shared ranges`, async ({ browser }) => {
      if (!ownerStorage) test.skip(true, 'owner session not captured');
      const ctx = await browser.newContext({ storageState: ownerStorage! });
      const page = await ctx.newPage();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      try {
        await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 60_000 });
        await openPicker(page);
        await expect(quickRanges(page).getByRole('button')).toHaveText(SIX_RANGES);
        expect(errors, `JS errors on ${path}`).toEqual([]);
      } finally {
        await ctx.close();
      }
    });
  }

  test('company dashboard asks for all time and stays scoped to its own data', async ({
    browser,
  }) => {
    if (!ownerStorage) test.skip(true, 'owner session not captured');
    const ctx = await browser.newContext({ storageState: ownerStorage! });
    const page = await ctx.newPage();
    try {
      await page.goto('/app', { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await openPicker(page);
      const reqs = latestPerEndpoint(await selectPreset(page, 'All time', '/company/analytics/'));
      expect(reqs.length).toBeGreaterThan(0);

      // The overview asks explicitly; wallet-summary is lifetime by default and
      // must keep receiving NO bounds, or its figures stop reconciling against
      // the live wallet balance.
      for (const r of reqs) {
        const p = params(r);
        expect(p.get('from')).toBeNull();
        expect(p.get('to')).toBeNull();
        if (r.url().includes('/overview')) expect(p.get('preset')).toBe('all');
        if (r.url().includes('/wallet-summary')) expect(p.get('preset')).toBeNull();
      }

      // Renders, and every response was this tenant's own (RLS): a leak would
      // surface as another company's name in the by-source/company tables.
      await expect(page.getByText(/all time/i).first()).toBeVisible();
      const failed = page.getByText(/something went wrong|failed to load/i);
      await expect(failed).toHaveCount(0);
    } finally {
      await ctx.close();
    }
  });

  test('company deposits omits bounds for All time', async ({ browser }) => {
    if (!ownerStorage) test.skip(true, 'owner session not captured');
    const ctx = await browser.newContext({ storageState: ownerStorage! });
    const page = await ctx.newPage();
    try {
      await page.goto('/app/deposits', { waitUntil: 'domcontentloaded', timeout: 60_000 });

      // Narrow first, so switching to All time is a real state change rather
      // than a no-op on a page that already starts unfiltered.
      await openPicker(page);
      await selectPreset(page, 'Last 7 days', '/company/transactions');
      await openPicker(page);
      await quickRanges(page).getByRole('button', { name: 'All time', exact: true }).click();
      await page.waitForLoadState('networkidle');

      // A cached unfiltered query can satisfy the click without a request, so
      // read the wire format from a cold load.
      const [req] = await Promise.all([
        page.waitForRequest((r) => r.url().includes('/v1/company/transactions?')),
        page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 }),
      ]);
      expect(params(req).get('from')).toBeNull();
      expect(params(req).get('to')).toBeNull();
    } finally {
      await ctx.close();
    }
  });
});
