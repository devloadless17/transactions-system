import { UserRole } from '@app/shared';
import { getSession } from '@/lib/session';
import { CommissionsView } from '@/features/admin/commissions/commissions-view';

export const dynamic = 'force-dynamic';

export default async function Page() {
  const session = await getSession();
  return <CommissionsView canDelete={session?.role === UserRole.SUPER_ADMIN} />;
}
