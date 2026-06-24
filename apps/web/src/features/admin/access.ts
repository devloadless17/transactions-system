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
  '/admin/deposits',
  '/admin/withdrawals',
  '/admin/payouts',
  '/admin/loads',
  '/admin/whish',
  '/admin/settings',
];

// Sections only SUPER_ADMIN may reach. Platform Admins management is
// SUPER_ADMIN-only at the API (`@Roles(SUPER_ADMIN)` on AdminUsersController), so
// ADMIN_OPERATOR must not even see the link — otherwise they land on a fully
// interactive page where every request 403s.
// Transfer Money sends real money out of the platform's Whish account; it's
// SUPER_ADMIN-only at the API (`@Roles(SUPER_ADMIN)` on WhishTransfersController),
// so ADMIN_OPERATOR/BACKOFFICE must not even see the link.
const SUPER_ADMIN_ONLY_HREFS: ReadonlyArray<string> = ['/admin/users', '/admin/transfer-money'];

/** Whether `role` may see/open the given admin sidebar section (exact href). */
export function canSeeAdminSection(role: UserRole, href: string): boolean {
  if (SUPER_ADMIN_ONLY_HREFS.includes(href)) return role === UserRole.SUPER_ADMIN;
  if (role === UserRole.BACKOFFICE) return BACKOFFICE_HREFS.includes(href);
  return true; // SUPER_ADMIN / ADMIN_OPERATOR: everything else
}

/** Where a freshly-authenticated admin of this role should land. */
export function adminLandingPath(role: UserRole): string {
  // Back office can't see the analytics Overview at '/admin', so send it to its
  // first real page instead (avoids an immediate guard bounce).
  return role === UserRole.BACKOFFICE ? '/admin/companies' : '/admin';
}
