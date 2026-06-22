import { UserRole } from '@app/shared';
import { AdminWithdrawalsView } from '@/features/admin/withdrawals/withdrawals-view';
import {
  ADMIN_LOAD_CONFIG,
  defaultListPrefetch,
} from '@/features/admin/withdrawals/process-configs';
import { AdminLoadDialog } from '@/features/admin/loads/admin-load-dialog';
import { getSession } from '@/lib/session';
import { withListPrefetch } from '@/lib/prefetch';

export const dynamic = 'force-dynamic';

export default async function Page() {
  // Loading a company's wallet directly is a SUPER_ADMIN-only capability.
  const session = await getSession();
  const isSuperAdmin = session?.role === UserRole.SUPER_ADMIN;
  return withListPrefetch(
    [defaultListPrefetch(ADMIN_LOAD_CONFIG)],
    <AdminWithdrawalsView
      config={ADMIN_LOAD_CONFIG}
      headerAction={isSuperAdmin ? <AdminLoadDialog /> : undefined}
    />,
  );
}
