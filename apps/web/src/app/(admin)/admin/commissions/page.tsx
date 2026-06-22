import { UserRole } from '@app/shared';
import { requireRole } from '@/lib/session';
import { FULL_ADMIN_ROLES } from '@/features/admin/access';
import { CommissionsView } from '@/features/admin/commissions/commissions-view';
import { withListPrefetch } from '@/lib/prefetch';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const session = await requireRole(FULL_ADMIN_ROLES);
  // Server-prefetch the first page of commission rules so the list paints populated.
  return withListPrefetch(
    [
      {
        queryKey: ['admin', 'commission-rules', { page: 1 }],
        path: '/admin/commission-rules?page=1&pageSize=20',
      },
    ],
    <CommissionsView canDelete={session.role === UserRole.SUPER_ADMIN} />,
  );
}
