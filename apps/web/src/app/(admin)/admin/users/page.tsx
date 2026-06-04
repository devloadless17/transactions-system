import { requireRole } from '@/lib/session';
import { FULL_ADMIN_ROLES } from '@/features/admin/access';
import { AdminUsersView } from '@/features/admin/users/admin-users-view';

export const dynamic = 'force-dynamic';

export default async function AdminUsersPage() {
  await requireRole(FULL_ADMIN_ROLES);
  return <AdminUsersView />;
}
