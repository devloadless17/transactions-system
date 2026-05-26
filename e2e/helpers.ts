import { expect, type Page, request as pwRequest } from '@playwright/test';

export const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'ali@loadless.ai';
export const ADMIN_PASSWORD = process.env.E2E_ADMIN_PASSWORD ?? 'loadless';
export const API_BASE = process.env.E2E_API_BASE ?? 'http://localhost:3001';

/**
 * Sign in with arbitrary credentials. Used for non-admin flows where
 * we can't rely on the shared admin storageState.
 */
export async function loginAs(
  page: Page,
  email: string,
  password: string,
  expectedLanding: '/admin' | '/app' | '/change-password',
) {
  // Make sure we don't bring an existing session to the login screen.
  await page.context().clearCookies();
  await page.goto('/login');
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.waitForURL(`**${expectedLanding}**`, { timeout: 10_000 });
}

export function uniqueSlug(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}`;
}

/**
 * Provision a company + owner directly through the API. Returns the
 * owner credentials so a Playwright page can then sign in as them.
 */
export async function provisionCompanyOwner() {
  const api = await pwRequest.newContext({ baseURL: API_BASE });
  const login = await api.post('/v1/auth/login', {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  if (!login.ok()) throw new Error(`admin login failed: ${login.status()} ${await login.text()}`);

  const state = await api.storageState();
  const csrf = state.cookies.find((c) => c.name === 'csrf-token')?.value;
  if (!csrf) throw new Error('csrf cookie missing after login');

  const slug = uniqueSlug('e2e-co');
  const ownerEmail = `owner-${slug}@example.com`;
  const create = await api.post('/v1/admin/companies', {
    headers: { 'x-csrf-token': csrf },
    data: {
      name: `E2E Company ${slug}`,
      slug,
      defaultCurrency: 'USD',
      ownerEmail,
    },
  });
  if (!create.ok()) {
    throw new Error(`create company failed: ${create.status()} ${await create.text()}`);
  }
  const body = await create.json();
  await api.dispose();
  return {
    slug,
    companyId: body.company.id as string,
    ownerEmail: body.owner.email as string,
    tempPassword: body.owner.temporaryPassword as string,
  };
}

export { expect };
