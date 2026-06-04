import 'server-only';
import { redirect } from 'next/navigation';
import type { MeResponse, UserRole } from '@app/shared';
import { ADMIN_ROLES, COMPANY_ROLES } from '@app/shared';
import { adminLandingPath } from '@/features/admin/access';
import { apiServer } from './api.server';
import { ApiClientError } from './api';

/**
 * Return the current user, or null if not authenticated.
 * Server-component-safe (uses next/headers cookies under the hood).
 */
export async function getSession(): Promise<MeResponse | null> {
  try {
    return await apiServer<MeResponse>('/auth/me');
  } catch (err) {
    // 401 = no/invalid token. 403 on /auth/me means the session is valid but the
    // company is no longer ACTIVE (suspended, or deleted out from under a live
    // cookie) — assertCompanyActive throws ForbiddenError. Either way there's no
    // usable session, so degrade to the login flow instead of crashing the
    // server-rendered page. (Anything else — e.g. a 5xx — is a real error and
    // still propagates.)
    if (err instanceof ApiClientError && (err.status === 401 || err.status === 403)) {
      return null;
    }
    throw err;
  }
}

/** Require an authenticated session, else redirect to /login. */
export async function requireSession(redirectTo = '/login'): Promise<MeResponse> {
  const session = await getSession();
  if (!session) redirect(redirectTo);
  return session;
}

/** Require one of the listed roles; otherwise redirect to a safe page. */
export async function requireRole(
  roles: ReadonlyArray<UserRole>,
  redirectTo = '/login',
): Promise<MeResponse> {
  const session = await requireSession(redirectTo);
  // Force a password change before any role-gated page is reachable.
  if (session.mustChangePassword) redirect('/change-password');
  if (!roles.includes(session.role)) {
    // Send users to wherever their role naturally lives. Admins go to their
    // role's landing (back office can't see the Overview, so it lands deeper).
    if (ADMIN_ROLES.includes(session.role)) redirect(adminLandingPath(session.role));
    if (COMPANY_ROLES.includes(session.role)) redirect('/app');
    redirect(redirectTo);
  }
  return session;
}
