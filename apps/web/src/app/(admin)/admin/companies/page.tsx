import { UserRole } from '@app/shared';
import { getSession } from '@/lib/session';
import { FULL_ADMIN_ROLES } from '@/features/admin/access';
import { CompaniesView } from '@/features/admin/companies/companies-view';
import { withListPrefetch } from '@/lib/prefetch';

export const dynamic = 'force-dynamic';

export default async function CompaniesPage() {
  // Layout already guarantees an admin session. Back office sees a read-only
  // list (no create, no drill-in); full admins manage companies.
  const session = await getSession();
  const canManage = !!session && FULL_ADMIN_ROLES.includes(session.role);
  // Balances are SUPER_ADMIN-only. This just hides the column; the API is the
  // real gate and omits the figures entirely for anyone else.
  const canViewBalances = session?.role === UserRole.SUPER_ADMIN;
  // Server-prefetch the first page of companies so the table renders populated
  // on first paint (deterministic default key: page 1, fixed pageSize).
  // Key AND path must mirror the client query exactly, or the prefetched page
  // (without balances) would paint first and be replaced on hydration.
  return withListPrefetch(
    [
      {
        queryKey: ['admin', 'companies', { page: 1, withBalances: canViewBalances }],
        path: `/admin/companies?page=1&pageSize=20${canViewBalances ? '&withBalances=true' : ''}`,
      },
    ],
    <CompaniesView canManage={canManage} canViewBalances={canViewBalances} />,
  );
}
