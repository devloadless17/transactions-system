import { UserRole } from '@app/shared';
import { AdminWhishView } from '@/features/admin/whish/admin-whish-view';
import { FULL_ADMIN_ROLES } from '@/features/admin/access';
import { withListPrefetch } from '@/lib/prefetch';
import { getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

export default async function AdminWhishPage() {
  // Back office views Whish payments but can't refresh them; only a super admin
  // can refund (real money leaves the platform's Whish account).
  const session = await getSession();
  const canManage = !!session && FULL_ADMIN_ROLES.includes(session.role);
  const canRefund = session?.role === UserRole.SUPER_ADMIN;
  // Prefetch the primary payments list (page 1) so the table renders populated
  // on first paint instead of flashing the client loading skeleton.
  return withListPrefetch(
    [
      {
        queryKey: ['admin', 'whish', 'payments', { page: 1 }],
        path: '/admin/whish/payments?page=1&pageSize=20',
      },
    ],
    <AdminWhishView canManage={canManage} canRefund={canRefund} />,
  );
}
