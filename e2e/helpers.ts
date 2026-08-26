import { expect, type APIRequestContext, type Page, request as pwRequest } from '@playwright/test';

export const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL ?? 'admin@example.com';
// Mirror global.setup.ts: prefer an explicit e2e override, else reuse the seeded
// admin password (loaded from .env by playwright.config.ts), else the CI default.
export const ADMIN_PASSWORD =
  process.env.E2E_ADMIN_PASSWORD ?? process.env.SEED_ADMIN_PASSWORD ?? 'loadless';
export const API_BASE = process.env.E2E_API_BASE ?? 'http://localhost:3001';

// POST /v1/auth/login is throttled to 10 req / 60s per IP. A serial suite that
// provisions several companies + owners easily exceeds that, so all API logins
// funnel through a retry that waits out the throttle window. This is a test
// orchestration concession to a real (correct) security control — not a relaxed
// assertion.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function apiLogin(api: APIRequestContext, email: string, password: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const res = await api.post('/v1/auth/login', { data: { email, password } });
    if (res.ok()) return;
    if (res.status() === 429 && attempt < 6) {
      // Throttle TTL is 60s; wait a slice of it and retry.
      await sleep(12_000);
      continue;
    }
    throw new Error(`login failed for ${email}: ${res.status()} ${await res.text()}`);
  }
}

/**
 * Sign in via the UI with arbitrary credentials. Used for non-admin flows where
 * we can't rely on the shared admin storageState. Retries through the auth
 * throttle (429 surfaces in the UI as an "Invalid credentials"/error toast and
 * the URL stays on /login).
 */
export async function loginAs(
  page: Page,
  email: string,
  password: string,
  expectedLanding: '/admin' | '/app' | '/change-password',
) {
  for (let attempt = 0; ; attempt++) {
    // Make sure we don't bring an existing session to the login screen.
    await page.context().clearCookies();
    await page.goto('/login');
    await page.locator('#email').fill(email);
    await page.locator('#password').fill(password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    try {
      await page.waitForURL(`**${expectedLanding}**`, { timeout: 12_000 });
      return;
    } catch (err) {
      // If we were throttled, the URL stays on /login. Wait out a slice of the
      // 60s window and retry a couple of times before giving up.
      if (attempt < 4 && /\/login/.test(page.url())) {
        await sleep(12_000);
        continue;
      }
      throw err;
    }
  }
}

export function uniqueSlug(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}`;
}

/**
 * Unwrap the API response envelope `{ success, statusCode, data }`. Returns the
 * inner `data` on a success body, and the body untouched for an error body or
 * the few endpoints kept outside the envelope. Mirrors the web client so specs
 * read payloads the same way the app does.
 *
 * Note for list endpoints: the payload is itself `{ data: [...], meta }`, so the
 * array is at `unwrap(body).data`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function unwrap<T = any>(body: any): T {
  if (body !== null && typeof body === 'object' && 'success' in body && 'data' in body) {
    return body.data as T;
  }
  return body as T;
}

/**
 * Provision a company + owner directly through the API. Returns the
 * owner credentials so a Playwright page can then sign in as them.
 *
 * Pass an existing admin context (from adminApiContext) to avoid burning a
 * fresh admin login against the auth throttle.
 */
export async function provisionCompanyOwner(admin?: { api: APIRequestContext; csrf: string }) {
  const owned = !admin;
  const { api, csrf } = admin ?? (await adminApiContext());

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
  const body = unwrap(await create.json());
  if (owned) await api.dispose();
  return {
    slug,
    companyId: body.company.id as string,
    ownerEmail: body.owner.email as string,
    tempPassword: body.owner.temporaryPassword as string,
  };
}

/**
 * Open an admin API request context and return it plus the csrf token.
 * Caller is responsible for disposing the context.
 */
export async function adminApiContext(): Promise<{ api: APIRequestContext; csrf: string }> {
  const api = await pwRequest.newContext({ baseURL: API_BASE });
  await apiLogin(api, ADMIN_EMAIL, ADMIN_PASSWORD);
  const state = await api.storageState();
  const csrf = state.cookies.find((c) => c.name === 'csrf-token')?.value;
  if (!csrf) throw new Error('csrf cookie missing after login');
  return { api, csrf };
}

/** Read the csrf-token cookie from an authed context (needed on mutations). */
export async function getCsrf(api: APIRequestContext): Promise<string> {
  const state = await api.storageState();
  const csrf = state.cookies.find((c) => c.name === 'csrf-token')?.value;
  if (!csrf) throw new Error('csrf cookie missing on context');
  return csrf;
}

/**
 * Create a commission rule (admin). `data` is either a full rule-group body or
 * the legacy flat shape { companyId?, sourceId?, operationType, feeApplication,
 * minAmount, maxAmount, commissionType, commissionValue, priority?, active? }.
 * Returns the rule.
 */
export async function createCommissionRule(
  api: APIRequestContext,
  csrf: string,
  data: Record<string, unknown>,
): Promise<{ id: string }> {
  // The endpoint takes the rule-GROUP shape (companyIds[] / operations[]), where
  // each operation carries its own fee application AND its own tier ladder.
  // Specs still pass the legacy flat shape ({operationType, feeApplication,
  // min/max, type, value}), so translate a flat rule into a single-operation,
  // single-tier group here — keeps every caller working unchanged.
  const body =
    'operations' in data
      ? data
      : {
          name: (data.name as string | null) ?? null,
          companyIds: data.companyId != null ? [data.companyId] : null,
          operations: [
            {
              operationType: data.operationType ?? 'TRANSACTION',
              feeApplication: data.feeApplication ?? 'DEDUCTED',
              tiers: [
                {
                  minAmount: data.minAmount,
                  maxAmount: data.maxAmount ?? null,
                  commissionType: data.commissionType,
                  commissionValue: data.commissionValue,
                },
              ],
            },
          ],
          priority: data.priority ?? 100,
          active: data.active ?? true,
        };
  const res = await api.post('/v1/admin/commission-rules', {
    headers: { 'x-csrf-token': csrf },
    data: body,
  });
  if (!res.ok())
    throw new Error(`create commission rule failed: ${res.status()} ${await res.text()}`);
  return unwrap(await res.json());
}

/** Find the seeded source id by code (e.g. 'omt'). */
export async function findSourceId(api: APIRequestContext, code: string): Promise<string> {
  const res = await api.get('/v1/admin/sources/all');
  if (!res.ok()) throw new Error(`sources/all failed: ${res.status()} ${await res.text()}`);
  // Envelope unwraps to the list payload { data: [...] }; the array is its .data.
  const list = unwrap<{ data: Array<{ id: string; code: string }> }>(await res.json()).data;
  const found = list.find((s) => s.code === code);
  if (!found) throw new Error(`seeded source '${code}' not found`);
  return found.id;
}

/** Opt a company in to a source so its source keys may ingest for it. */
export async function enableSourceForCompany(
  api: APIRequestContext,
  csrf: string,
  sourceId: string,
  companyId: string,
): Promise<void> {
  const res = await api.post(`/v1/admin/sources/${sourceId}/companies`, {
    headers: { 'x-csrf-token': csrf },
    data: { companyId, enabled: true },
  });
  if (!res.ok()) {
    throw new Error(`enable source failed: ${res.status()} ${await res.text()}`);
  }
}

/** Mint a plaintext source API key (returned once). */
export async function createSourceKey(
  api: APIRequestContext,
  csrf: string,
  sourceId: string,
  name: string,
): Promise<string> {
  const res = await api.post(`/v1/admin/sources/${sourceId}/api-keys`, {
    headers: { 'x-csrf-token': csrf },
    data: { name },
  });
  if (!res.ok()) throw new Error(`create source key failed: ${res.status()} ${await res.text()}`);
  const body = unwrap(await res.json());
  return (body.plaintext ?? body.apiKey) as string;
}

/** Ingest a transaction with a source key. Returns the parsed response body. */
export async function ingestTransaction(
  sourceCode: string,
  plaintext: string,
  data: { companySlug: string; externalTransactionId: string; amount: string; currency: string },
): Promise<{ status: number; body: any }> {
  const ctx = await pwRequest.newContext({ baseURL: API_BASE });
  try {
    // The source-facing API identifies the company by `companySlug` — UUIDs
    // are never exposed to sources.
    const res = await ctx.post(`/v1/ingest/${sourceCode}/transactions`, {
      headers: { Authorization: `Bearer ${plaintext}` },
      data,
    });
    const text = await res.text();
    // unwrap returns the inner transaction on 201, or the error body on 4xx.
    return { status: res.status(), body: text ? unwrap(JSON.parse(text)) : null };
  } finally {
    await ctx.dispose();
  }
}

/**
 * Log in as a company owner who still has a temp password: walk through the
 * forced /change-password flow, re-login, and return a context whose
 * storageState carries the authenticated company session. Mirrors
 * company-smoke.spec.ts.
 */
export async function loginOwnerApiContext(
  ownerEmail: string,
  tempPassword: string,
  newPassword: string,
): Promise<APIRequestContext> {
  const api = await pwRequest.newContext({ baseURL: API_BASE });
  await apiLogin(api, ownerEmail, tempPassword);
  // mustChangePassword users get a session that can only hit change-password.
  const state = await api.storageState();
  const csrf = state.cookies.find((c) => c.name === 'csrf-token')?.value;
  if (!csrf) throw new Error('csrf cookie missing after owner login');
  const change = await api.post('/v1/auth/change-password', {
    headers: { 'x-csrf-token': csrf },
    data: { currentPassword: tempPassword, newPassword },
  });
  if (!change.ok()) {
    throw new Error(`change-password failed: ${change.status()} ${await change.text()}`);
  }
  await api.dispose();
  // Re-login fresh with the new password into a clean context.
  const fresh = await pwRequest.newContext({ baseURL: API_BASE });
  await apiLogin(fresh, ownerEmail, newPassword);
  return fresh;
}

export { expect };
