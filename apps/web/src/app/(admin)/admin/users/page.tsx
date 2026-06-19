import { UserRole } from '@app/shared';
import { requireRole } from '@/lib/session';
import { AdminUsersView } from '@/features/admin/users/admin-users-view';

export const dynamic = 'force-dynamic';

export default async function AdminUsersPage() {
  // Platform-admin management is SUPER_ADMIN-only at the API; gate the page to
  // match so ADMIN_OPERATOR isn't sent to a fully interactive page that 403s.
  await requireRole([UserRole.SUPER_ADMIN]);
  return <AdminUsersView />;
}
