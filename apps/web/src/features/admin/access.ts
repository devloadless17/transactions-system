import { UserRole } from '@app/shared';

// Single source of truth for which admin roles may reach which parts of the
// /admin area. The hard security boundary is the API (`@Roles` per endpoint);
// this drives the UX layer — nav filtering, per-page redirects, and the
// post-login landing — so back-office users never see links/pages that would
// 403 or come back empty.

/** Roles with full platform-admin access (everything under /admin). */
export const FULL_ADMIN_ROLES: ReadonlyArray<UserRole> = [
  UserRole.SUPER_ADMIN,
  UserRole.ADMIN_OPERATOR,
];

// The admin sidebar hrefs a BACKOFFICE user may open. Everything else under
// /admin (Overview analytics, Sources, Commission Rules, Audit Logs, Platform
// Admins, and any company *detail* page) is full-admin only. "Settings" is the
// user's own account (password change), so it stays available.
const BACKOFFICE_HREFS: ReadonlyArray<string> = [
  '/admin/companies',
  '/admin/transactions',
  '/admin/withdrawals',
  '/admin/payouts',
  '/admin/loads',
  '/admin/whish',
  '/admin/settings',
];

/** Whether `role` may see/open the given admin sidebar section (exact href). */
export function canSeeAdminSection(role: UserRole, href: string): boolean {
  if (role === UserRole.BACKOFFICE) return BACKOFFICE_HREFS.includes(href);
  return true; // SUPER_ADMIN / ADMIN_OPERATOR: unchanged, see everything
}

/** Where a freshly-authenticated admin of this role should land. */
export function adminLandingPath(role: UserRole): string {
  // Back office can't see the analytics Overview at '/admin', so send it to its
  // first real page instead (avoids an immediate guard bounce).
  return role === UserRole.BACKOFFICE ? '/admin/companies' : '/admin';
}
