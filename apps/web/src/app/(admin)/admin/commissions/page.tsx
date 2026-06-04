import { UserRole } from '@app/shared';
import { requireRole } from '@/lib/session';
import { FULL_ADMIN_ROLES } from '@/features/admin/access';
import { CommissionsView } from '@/features/admin/commissions/commissions-view';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const session = await requireRole(FULL_ADMIN_ROLES);
  return <CommissionsView canDelete={session.role === UserRole.SUPER_ADMIN} />;
}
