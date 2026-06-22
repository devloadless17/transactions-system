import { UserRole } from '@app/shared';
import { requireRole } from '@/lib/session';
import { AdminUsersView } from '@/features/admin/users/admin-users-view';
import { withListPrefetch } from '@/lib/prefetch';

export const dynamic = 'force-dynamic';

export default async function AdminUsersPage() {
  // Platform-admin management is SUPER_ADMIN-only at the API; gate the page to
  // match so ADMIN_OPERATOR isn't sent to a fully interactive page that 403s.
  await requireRole([UserRole.SUPER_ADMIN]);
  // Server-prefetch the first page of admins so the table paints populated.
  return withListPrefetch(
    [{ queryKey: ['admin', 'users', { page: 1 }], path: '/admin/users?page=1&pageSize=20' }],
    <AdminUsersView />,
  );
}
